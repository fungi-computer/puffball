import * as Schema from "effect/Schema";
import type { AppReleaseD1Database } from "./cloudflare.js";
import {
  appIdSchema,
  publicSurfaceIdSchema,
  stableRouteSchema,
} from "./internal/app-release-schema.js";
import { publicRouteKey, publicRoutePolicy } from "./public-route-policy.js";
import { reportFailure } from "./internal/failure.js";

const identity = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256)),
);
const commandSchema = Schema.Struct({
  operationId: identity,
  operatorId: identity,
  reason: Schema.String.pipe(
    Schema.check(Schema.isPattern(/\S/u)),
    Schema.check(Schema.isMaxLength(1000)),
  ),
  target: Schema.Struct({
    publicSurfaceId: publicSurfaceIdSchema,
    appId: appIdSchema,
    teamId: identity,
    stableRoute: stableRouteSchema,
  }),
});
export type PublicRouteRemoval = Schema.Schema.Type<typeof commandSchema>;
const operationSchema = Schema.Struct({
  operation_id: identity,
  kind: Schema.Literals(["unlist-and-release", "re-allow"]),
  public_surface_id: publicSurfaceIdSchema,
  app_id: appIdSchema,
  team_id: identity,
  stable_route: stableRouteSchema,
  route_key: Schema.String,
  reason: Schema.String,
  initiated_by: identity,
  created_at: Schema.Number,
  removal_operation_id: Schema.NullOr(identity),
  state: Schema.Literals(["pending", "complete", "superseded-by-erasure"]),
  completed_at: Schema.NullOr(Schema.Number),
});
export type PublicRouteOperation = Schema.Schema.Type<typeof operationSchema>;
export type PublicRouteModerationResult =
  | { readonly kind: "recorded"; readonly operation: PublicRouteOperation }
  | { readonly kind: "conflict" | "unavailable" };

/** Publisher phases only. Its Operator composes the Marketplace phase between prepare and complete. */
export function createD1PublicRouteModeration(
  database: AppReleaseD1Database,
  now: () => number = Date.now,
) {
  const read = async (operationId: string) => {
    const row = await database
      .prepare(
        "SELECT * FROM app_release_route_operations WHERE operation_id=?",
      )
      .bind(operationId)
      .first();
    return row === null ? null : Schema.decodeUnknownSync(operationSchema)(row);
  };
  const protect = async (
    action: () => Promise<PublicRouteModerationResult>,
  ): Promise<PublicRouteModerationResult> => {
    try {
      return await action();
    } catch (cause) {
      reportFailure("public route moderation", cause);
      return { kind: "unavailable" };
    }
  };
  const matches = (
    operation: PublicRouteOperation,
    input: PublicRouteRemoval,
    kind: PublicRouteOperation["kind"],
    removalId: string | null,
  ) =>
    operation.kind === kind &&
    operation.public_surface_id === input.target.publicSurfaceId &&
    operation.app_id === input.target.appId &&
    operation.team_id === input.target.teamId &&
    operation.stable_route === input.target.stableRoute &&
    operation.reason === input.reason &&
    operation.removal_operation_id === removalId;
  const prepare = (
    raw: PublicRouteRemoval,
    removalId: string | null,
  ): Promise<PublicRouteModerationResult> =>
    protect(async () => {
      const input = Schema.decodeUnknownSync(commandSchema, {
        onExcessProperty: "error",
      })(raw);
      const kind = removalId === null ? "unlist-and-release" : "re-allow";
      const existing = await read(input.operationId);
      if (existing)
        return matches(existing, input, kind, removalId) &&
          existing.state !== "superseded-by-erasure"
          ? { kind: "recorded", operation: existing }
          : { kind: "conflict" };
      const at = Math.floor(now() / 1000);
      const key = publicRouteKey(input.target.stableRoute);
      const material = [
        input.operationId,
        kind,
        input.target.publicSurfaceId,
        input.target.appId,
        input.target.teamId,
        input.target.stableRoute,
        key,
        input.reason,
        input.operatorId,
        at,
        removalId,
      ];
      const eligible =
        removalId === null
          ? `EXISTS (SELECT 1 FROM app_release_route_claims c
         JOIN app_release_public_surfaces s ON s.public_surface_id=c.public_surface_id
         WHERE c.public_surface_id=? AND s.app_id=? AND c.team_id=? AND c.stable_route=? AND c.state='held')`
          : `EXISTS (SELECT 1 FROM app_release_team_route_blocks b
         JOIN app_release_route_operations removal ON removal.operation_id=b.removal_operation_id
         WHERE removal.public_surface_id=? AND removal.app_id=? AND b.team_id=? AND removal.stable_route=?
           AND b.removal_operation_id=? AND removal.state='complete')`;
      const guardValues = [
        input.target.publicSurfaceId,
        input.target.appId,
        input.target.teamId,
        input.target.stableRoute,
        ...(removalId === null ? [] : [removalId]),
      ];
      // Every mutation joins the full bound material, so a racing changed-ID replay cannot advance it.
      const guard = `SELECT operation_id FROM app_release_route_operations
      WHERE operation_id=? AND kind=? AND public_surface_id=? AND app_id=? AND team_id=?
        AND stable_route=? AND route_key=? AND reason=? AND state='pending'
        AND removal_operation_id IS ?`;
      const guardBindings = [...material.slice(0, 8), removalId];
      const statements = [
        database
          .prepare(
            `INSERT INTO app_release_route_operations
      (operation_id,kind,public_surface_id,app_id,team_id,stable_route,route_key,reason,initiated_by,created_at,removal_operation_id,state)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,'pending' WHERE ${eligible} ON CONFLICT DO NOTHING`,
          )
          .bind(...material, ...guardValues),
      ];
      if (removalId === null)
        statements.push(
          database
            .prepare(
              `UPDATE app_release_route_claims SET state='removing',removal_operation_id=?
        WHERE public_surface_id=? AND state='held' AND EXISTS (${guard})`,
            )
            .bind(
              input.operationId,
              input.target.publicSurfaceId,
              ...guardBindings,
            ),
          database
            .prepare(
              `INSERT INTO app_release_surface_retirements(public_surface_id,operation_id)
        SELECT public_surface_id,operation_id FROM app_release_route_operations WHERE operation_id IN (${guard})
        ON CONFLICT DO NOTHING`,
            )
            .bind(...guardBindings),
          database
            .prepare(
              `INSERT INTO app_release_team_route_blocks(team_id,route_key,stable_route,removal_operation_id)
        SELECT team_id,route_key,stable_route,operation_id FROM app_release_route_operations WHERE operation_id IN (${guard})
        ON CONFLICT(team_id,route_key) DO UPDATE SET removal_operation_id=excluded.removal_operation_id,stable_route=excluded.stable_route`,
            )
            .bind(...guardBindings),
        );
      statements.push(
        database
          .prepare(
            `INSERT INTO app_release_route_operation_steps(operation_id,phase,operator_id,recorded_at)
      SELECT operation_id,'prepared',?,? FROM app_release_route_operations WHERE operation_id IN (${guard}) ON CONFLICT DO NOTHING`,
          )
          .bind(input.operatorId, at, ...guardBindings),
      );
      const results = await database.batch(statements);
      if (
        results.length !== statements.length ||
        results.some((result) => !result.success)
      )
        throw new Error("Route moderation batch unavailable");
      const operation = await read(input.operationId);
      return operation && matches(operation, input, kind, removalId)
        ? { kind: "recorded", operation }
        : { kind: "conflict" };
    });

  /** Call only after the corresponding Marketplace owner returns its committed phase. */
  const complete = (
    operationId: string,
    operatorId: string,
  ): Promise<PublicRouteModerationResult> =>
    protect(async () => {
      const id = Schema.decodeUnknownSync(identity)(operationId);
      const actor = Schema.decodeUnknownSync(identity)(operatorId);
      const operation = await read(id);
      if (!operation || operation.state === "superseded-by-erasure")
        return { kind: "conflict" };
      if (operation.state === "complete")
        return { kind: "recorded", operation };
      const at = Math.floor(now() / 1000);
      const statements = [];
      if (operation.kind === "unlist-and-release") {
        // The exact still-removing claim is the only source of a new hold. A stale replay cannot freeze a later claimant.
        statements.push(
          database
            .prepare(
              `INSERT INTO app_release_route_holds(route_key,stable_route,until_s,cause,operation_id)
        SELECT c.route_key,c.stable_route,?,'operator-release',o.operation_id
        FROM app_release_route_claims c JOIN app_release_route_operations o
          ON o.operation_id=c.removal_operation_id AND o.public_surface_id=c.public_surface_id
        WHERE o.operation_id=? AND o.state='pending' AND c.state='removing'
        ON CONFLICT(route_key) DO UPDATE SET until_s=max(until_s,excluded.until_s),
          cause=CASE WHEN cause='erasure' THEN cause ELSE excluded.cause END,
          operation_id=CASE WHEN cause='erasure' THEN operation_id ELSE excluded.operation_id END`,
            )
            .bind(at + publicRoutePolicy.releaseCooldownSeconds, id),
        );
        statements.push(
          database
            .prepare(
              `DELETE FROM app_release_route_claims
        WHERE public_surface_id=? AND state='removing' AND removal_operation_id=?
          AND EXISTS (SELECT 1 FROM app_release_route_holds h WHERE h.route_key=app_release_route_claims.route_key AND h.until_s>=?)`,
            )
            .bind(
              operation.public_surface_id,
              id,
              at + publicRoutePolicy.releaseCooldownSeconds,
            ),
        );
      } else
        statements.push(
          database
            .prepare(
              `DELETE FROM app_release_team_route_blocks
      WHERE team_id=? AND route_key=? AND removal_operation_id=?`,
            )
            .bind(
              operation.team_id,
              operation.route_key,
              operation.removal_operation_id,
            ),
        );
      const completed =
        operation.kind === "unlist-and-release"
          ? `NOT EXISTS (SELECT 1 FROM app_release_route_claims c WHERE c.public_surface_id=app_release_route_operations.public_surface_id)
         AND EXISTS (SELECT 1 FROM app_release_route_holds h WHERE h.route_key=app_release_route_operations.route_key AND h.operation_id=app_release_route_operations.operation_id)`
          : `NOT EXISTS (SELECT 1 FROM app_release_team_route_blocks b WHERE b.team_id=app_release_route_operations.team_id AND b.route_key=app_release_route_operations.route_key)`;
      statements.push(
        database
          .prepare(
            `UPDATE app_release_route_operations SET state='complete',completed_at=?
      WHERE operation_id=? AND state='pending' AND ${completed}`,
          )
          .bind(at, id),
      );
      statements.push(
        database
          .prepare(
            `INSERT INTO app_release_route_operation_steps(operation_id,phase,operator_id,recorded_at)
      SELECT operation_id,'completed',?,? FROM app_release_route_operations WHERE operation_id=? AND state='complete'
      ON CONFLICT DO NOTHING`,
          )
          .bind(actor, at, id),
      );
      const results = await database.batch(statements);
      if (
        results.length !== statements.length ||
        results.some((result) => !result.success)
      )
        throw new Error("Route moderation batch unavailable");
      const result = await read(id);
      return result?.state === "complete"
        ? { kind: "recorded", operation: result }
        : { kind: "conflict" };
    });
  const pending = async (after = "") => {
    const cursor = Schema.decodeUnknownSync(
      Schema.String.pipe(Schema.check(Schema.isMaxLength(256))),
    )(after);
    const result = await database
      .prepare(
        "SELECT * FROM app_release_route_operations WHERE state='pending' AND operation_id>? ORDER BY operation_id LIMIT 100",
      )
      .bind(cursor)
      .all();
    return result.results.map((row) =>
      Schema.decodeUnknownSync(operationSchema)(row),
    );
  };
  return {
    prepareRemoval: (input: PublicRouteRemoval) => prepare(input, null),
    prepareReallow: (input: PublicRouteRemoval, removalId: string) =>
      prepare(input, Schema.decodeUnknownSync(identity)(removalId)),
    complete,
    pending,
    read,
  };
}

const platformReplaySchema = Schema.Struct({
  publicSurfaceId: publicSurfaceIdSchema,
  appId: appIdSchema,
  stableRoute: stableRouteSchema,
  teamId: identity,
  operatorId: identity,
});
export type PlatformOwnerReplay = Schema.Schema.Type<
  typeof platformReplaySchema
>;

/** Private Operator door only: Hub supplies the resolved System Team and admitted actor. */
export async function recordD1PlatformOwnerReplay(
  database: AppReleaseD1Database,
  raw: PlatformOwnerReplay,
): Promise<boolean> {
  const input = Schema.decodeUnknownSync(platformReplaySchema)(raw);
  const row = await database
    .prepare(
      `
    INSERT INTO app_release_platform_owner_replays
      (public_surface_id,app_id,stable_route,owner_team_id,publisher_user_id,operator_user_id,recorded_at)
    SELECT s.public_surface_id,s.app_id,s.stable_route,s.publisher_team_id,s.publisher_user_id,?,unixepoch()
    FROM app_release_public_surfaces s
    JOIN app_release_route_claims c ON c.public_surface_id=s.public_surface_id AND c.route_key=s.route_key
    JOIN app_release_platform_routes p ON p.app_id=s.app_id AND p.stable_route=s.stable_route AND p.route_key=s.route_key
    WHERE s.public_surface_id=? AND s.app_id=? AND s.stable_route=?
      AND s.publisher_team_id=? AND c.team_id=s.publisher_team_id
      AND c.user_id=s.publisher_user_id AND c.state='held' AND s.authority_kind='platform'
      AND s.publisher_user_id<>?
      AND NOT EXISTS (SELECT 1 FROM app_release_surface_retirements x WHERE x.public_surface_id=s.public_surface_id)
    RETURNING public_surface_id`,
    )
    .bind(
      input.operatorId,
      input.publicSurfaceId,
      input.appId,
      input.stableRoute,
      input.teamId,
      input.operatorId,
    )
    .first();
  return row !== null;
}
