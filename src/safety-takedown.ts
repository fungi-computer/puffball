import * as Schema from "effect/Schema";
import type { AppReleaseD1Database } from "./cloudflare.js";
import {
  appIdSchema,
  releaseIdSchema,
  stableRouteSchema,
} from "./internal/app-release-schema.js";
import { reportFailure } from "./internal/failure.js";

const identity = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(128)),
);
const safetyTakedownSchema = Schema.Struct({
  operationId: identity,
  operatorId: identity,
  appId: appIdSchema,
  stableRoute: stableRouteSchema,
  reason: Schema.String.pipe(
    Schema.check(Schema.isPattern(/\S/u)),
    Schema.check(Schema.isMaxLength(1000)),
  ),
});
export type SafetyTakedown = Schema.Schema.Type<typeof safetyTakedownSchema>;
const operationSchema = Schema.Struct({
  operation_id: identity,
  app_id: appIdSchema,
  stable_route: stableRouteSchema,
  reason: Schema.String,
  operator_id: identity,
  recorded_at: Schema.Number,
  state: Schema.Literals(["pending", "complete"]),
  completed_at: Schema.NullOr(Schema.Number),
});

/** Audited intent precedes the maintained revocation path; a pending action is discoverable and retryable. */
export function createD1SafetyTakedowns(
  database: AppReleaseD1Database,
  now: () => number = Date.now,
) {
  const read = async (operationId: string) => {
    const row = await database
      .prepare(
        "SELECT * FROM app_release_safety_takedowns WHERE operation_id=?",
      )
      .bind(operationId)
      .first();
    return row === null ? null : Schema.decodeUnknownSync(operationSchema)(row);
  };
  const releasePage = async (operationId: string) => {
    const rows = await database
      .prepare(
        `SELECT r.release_id FROM app_release_safety_takedown_releases r
      WHERE r.operation_id=? AND NOT EXISTS (
        SELECT 1 FROM app_release_transitions t JOIN app_release_transition_obligations o USING(sequence)
        WHERE t.release_id=r.release_id AND t.operation_kind='revocation' AND o.state='acknowledged')
      ORDER BY r.release_id LIMIT 1000`,
      )
      .bind(operationId)
      .all();
    return rows.results.map(
      (row) =>
        Schema.decodeUnknownSync(
          Schema.Struct({ release_id: releaseIdSchema }),
        )(row).release_id,
    );
  };
  const capturedReleasePage = async (operationId: string, after = "") => {
    Schema.decodeUnknownSync(identity)(operationId);
    Schema.decodeUnknownSync(
      Schema.Union([Schema.Literal(""), releaseIdSchema]),
    )(after);
    const rows = await database
      .prepare(
        `SELECT release_id FROM app_release_safety_takedown_releases
      WHERE operation_id=? AND release_id>? ORDER BY release_id LIMIT 1001`,
      )
      .bind(operationId, after)
      .all();
    const ids = rows.results.map(
      (row) =>
        Schema.decodeUnknownSync(
          Schema.Struct({ release_id: releaseIdSchema }),
        )(row).release_id,
    );
    return {
      releaseIds: ids.slice(0, 1000),
      next: ids.length > 1000 ? (ids[999] ?? null) : null,
    };
  };
  const prepare = async (raw: SafetyTakedown) => {
    try {
      const input = Schema.decodeUnknownSync(safetyTakedownSchema, {
        onExcessProperty: "error",
      })(raw);
      // Snapshot all Releases in child rows; bounded delivery pages no longer cap an App's history.
      const recipients = `SELECT t.release_id FROM app_release_transitions t JOIN app_release_public_surfaces s USING(public_surface_id)
        WHERE s.app_id=? AND s.stable_route=? AND t.operation_kind IN ('promotion','rollback')
        UNION SELECT release_id FROM app_release_buyer_references WHERE app_id=? AND stable_route=?`;
      const results = await database.batch([
        database
          .prepare(
            `INSERT INTO app_release_safety_takedowns(operation_id,app_id,stable_route,reason,operator_id,recorded_at,state)
          SELECT ?,?,?,?,?,?,'pending' WHERE EXISTS (${recipients}) ON CONFLICT DO NOTHING`,
          )
          .bind(
            input.operationId,
            input.appId,
            input.stableRoute,
            input.reason,
            input.operatorId,
            now(),
            input.appId,
            input.stableRoute,
            input.appId,
            input.stableRoute,
          ),
        database
          .prepare(
            `INSERT INTO app_release_safety_takedown_releases(operation_id,release_id)
          SELECT ?,r.release_id FROM (${recipients}) r
          WHERE EXISTS (SELECT 1 FROM app_release_safety_takedowns a WHERE a.operation_id=? AND a.app_id=? AND a.stable_route=? AND a.reason=?)
          AND NOT EXISTS (SELECT 1 FROM app_release_safety_takedown_releases frozen WHERE frozen.operation_id=?)
          ON CONFLICT DO NOTHING`,
          )
          .bind(
            input.operationId,
            input.appId,
            input.stableRoute,
            input.appId,
            input.stableRoute,
            input.operationId,
            input.appId,
            input.stableRoute,
            input.reason,
            input.operationId,
          ),
      ]);
      if (results.some((result) => !result.success))
        throw new Error("Safety snapshot unavailable");
      const saved = await read(input.operationId);
      if (
        saved?.app_id !== input.appId ||
        saved.stable_route !== input.stableRoute ||
        saved.reason !== input.reason
      )
        return { kind: "conflict" as const };
      await database
        .prepare(
          `INSERT INTO app_release_safety_takedown_steps(operation_id,phase,operator_id,recorded_at)
        VALUES(?,'prepared',?,?)`,
        )
        .bind(input.operationId, input.operatorId, now())
        .run();
      return {
        kind: "recorded" as const,
        operation: saved,
        releaseIds: await releasePage(input.operationId),
      };
    } catch (cause) {
      reportFailure("safety takedown preparation", cause);
      return { kind: "unavailable" as const };
    }
  };
  const complete = async (operationId: string, operatorId: string) => {
    for (const value of [operationId, operatorId])
      Schema.decodeUnknownSync(identity)(value);
    const operation = await read(operationId);
    if (operation === null) return { kind: "conflict" as const };
    const results = await database.batch([
      database
        .prepare(
          `INSERT INTO app_release_safety_takedown_steps(operation_id,phase,operator_id,recorded_at)
        SELECT ?,'completed',?,? WHERE EXISTS (SELECT 1 FROM app_release_safety_takedowns a WHERE a.operation_id=? AND a.state IN ('pending','complete')
          AND NOT EXISTS (SELECT 1 FROM app_release_safety_takedown_releases r WHERE r.operation_id=a.operation_id AND NOT EXISTS (
            SELECT 1 FROM app_release_transitions t JOIN app_release_transition_obligations o ON o.sequence=t.sequence
            WHERE t.release_id=r.release_id AND t.operation_kind='revocation' AND o.state='acknowledged')))
        ON CONFLICT DO NOTHING`,
        )
        .bind(operationId, operatorId, now(), operationId),
      database
        .prepare(
          `UPDATE app_release_safety_takedowns SET state='complete',completed_at=? WHERE operation_id=? AND state='pending'
        AND EXISTS (SELECT 1 FROM app_release_safety_takedown_steps WHERE operation_id=? AND phase='completed')`,
        )
        .bind(now(), operationId, operationId),
    ]);
    if (results.some((result) => !result.success))
      throw new Error("Safety audit unavailable");
    return (await read(operationId))?.state === "complete"
      ? { kind: "recorded" as const }
      : { kind: "conflict" as const };
  };
  const pending = async () => {
    const result = await database
      .prepare(
        "SELECT * FROM app_release_safety_takedowns WHERE state='pending' ORDER BY operation_id LIMIT 100",
      )
      .all();
    return result.results.map((row) =>
      Schema.decodeUnknownSync(operationSchema)(row),
    );
  };
  return { prepare, complete, pending, capturedReleasePage };
}

export const safetyTakedownSchemaSql = [
  `CREATE TABLE app_release_safety_takedowns(operation_id TEXT PRIMARY KEY,app_id TEXT NOT NULL,stable_route TEXT NOT NULL,
    reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),operator_id TEXT NOT NULL,recorded_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','complete')),completed_at INTEGER) STRICT;`,
  `CREATE TABLE app_release_safety_takedown_releases(operation_id TEXT NOT NULL REFERENCES app_release_safety_takedowns(operation_id),release_id TEXT NOT NULL,PRIMARY KEY(operation_id,release_id)) STRICT;`,
  `CREATE INDEX app_release_safety_takedowns_pending ON app_release_safety_takedowns(state,operation_id);`,
  `CREATE TABLE app_release_safety_takedown_steps(step_id INTEGER PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES app_release_safety_takedowns(operation_id),
    phase TEXT NOT NULL CHECK(phase IN ('prepared','completed')),operator_id TEXT NOT NULL,recorded_at INTEGER NOT NULL) STRICT;`,
  `CREATE INDEX app_release_safety_takedown_steps_by_action ON app_release_safety_takedown_steps(operation_id,phase);`,
]
  .map((statement) => statement.replaceAll("\n", " "))
  .join("\n");
