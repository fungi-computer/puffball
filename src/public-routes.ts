import * as Schema from "effect/Schema";
import {
  appIdSchema,
  publicSurfaceIdSchema,
  releaseIdSchema,
  stableRouteSchema,
} from "./internal/app-release-schema.js";
import type { AppReleaseD1Database } from "./cloudflare.js";
import {
  capturePublicRoutePolicy,
  publicRouteKey,
  publicRoutePolicy,
} from "./public-route-policy.js";

export type CapturedPublicRoutePolicy = Awaited<
  ReturnType<typeof capturePublicRoutePolicy>
>;
const policyRowSchema = Schema.Struct({
  version: Schema.Number,
  digest: Schema.String,
});

/** Fail closed until the operator has installed this exact deployment policy. */
export async function publicRoutePolicyReady(
  database: AppReleaseD1Database,
  policy: CapturedPublicRoutePolicy,
): Promise<boolean> {
  const row = await database
    .prepare(
      "SELECT version,digest FROM app_release_route_policy WHERE singleton=1",
    )
    .first();
  if (row === null) return false;
  const found = Schema.decodeUnknownSync(policyRowSchema)(row);
  return found.version === policy.version && found.digest === policy.digest;
}

/** Operator composition only; values come from its captured deployment, not a request. */
export async function configureD1PublicRoutes(
  database: AppReleaseD1Database,
  policy: CapturedPublicRoutePolicy,
): Promise<void> {
  if (await publicRoutePolicyReady(database, policy)) return;
  const exact = new Map<string, string>();
  for (const word of [
    ...publicRoutePolicy.reservedWords,
    ...policy.configuration.structuralRoutes,
  ])
    exact.set(publicRouteKey(word), word);
  const statements = [
    database.prepare("DELETE FROM app_release_reserved_route_keys"),
    database.prepare("DELETE FROM app_release_route_brand_exceptions"),
    database.prepare("DELETE FROM app_release_platform_routes"),
    ...[...exact].map(([key, word]) =>
      database
        .prepare(
          "INSERT INTO app_release_reserved_route_keys(word,route_key,match_kind) VALUES (?,?,'exact')",
        )
        .bind(word, key),
    ),
    ...publicRoutePolicy.brandPrefixes.map((word) =>
      database
        .prepare(
          "INSERT INTO app_release_reserved_route_keys(word,route_key,match_kind) VALUES (?,?,'prefix')",
        )
        .bind(word, publicRouteKey(word)),
    ),
    ...publicRoutePolicy.brandWordExceptions.map((word) =>
      database
        .prepare(
          "INSERT INTO app_release_route_brand_exceptions(word,route_key) VALUES (?,?)",
        )
        .bind(word, publicRouteKey(word)),
    ),
    ...policy.configuration.platformRoutes.map(({ appId, stableRoute }) =>
      database
        .prepare(
          "INSERT INTO app_release_platform_routes(stable_route,route_key,app_id) VALUES (?,?,?)",
        )
        .bind(stableRoute, publicRouteKey(stableRoute), appId),
    ),
    database
      .prepare(
        `INSERT INTO app_release_route_policy
      (singleton,version,digest,config_json,max_team_routes,max_unused_surfaces_per_app)
      VALUES (1,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET
      version=excluded.version,digest=excluded.digest,config_json=excluded.config_json,
      max_team_routes=excluded.max_team_routes,max_unused_surfaces_per_app=excluded.max_unused_surfaces_per_app`,
      )
      .bind(
        policy.version,
        policy.digest,
        policy.json,
        publicRoutePolicy.maxPublicRoutesPerTeam,
        publicRoutePolicy.maxUnusedSurfacesPerApp,
      ),
  ];
  const result = await database.batch(statements);
  if (result.length !== statements.length || result.some((row) => !row.success))
    throw new Error("Public route policy projection unavailable");
}

const heldClaimSchema = Schema.Struct({
  app_id: Schema.String,
  public_surface_id: Schema.String,
  team_id: Schema.String,
  user_id: Schema.String,
  stable_route: Schema.String,
});

const sellerRouteJoins = `FROM app_release_route_claims c
    JOIN app_release_public_surfaces s ON s.public_surface_id=c.public_surface_id
    JOIN app_release_team_publishers p ON p.app_id=s.app_id AND p.team_id=c.team_id`;
const sellerRouteCustody = `c.state='held' AND s.authority_kind='customer'
      AND p.source_provider='artifacts' AND p.source_repository=p.app_id
      AND p.template_app_id IS NOT NULL AND p.template_app_id<>p.app_id
      AND p.template_seed_revision IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM app_release_surface_retirements r WHERE r.public_surface_id=c.public_surface_id)
      AND NOT EXISTS (SELECT 1 FROM app_release_team_route_blocks b WHERE b.team_id=c.team_id AND b.route_key=c.route_key)`;

/** Live seller custody; a buyer entitlement or a historical Surface is never ownership. */
export async function ownsD1PublicRoute(
  database: AppReleaseD1Database,
  input: {
    readonly teamId: string;
    readonly appId: string;
    readonly stableRoute: string;
  },
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT s.app_id,c.public_surface_id,c.team_id,c.user_id,c.stable_route
    ${sellerRouteJoins}
    WHERE c.route_key=? AND c.stable_route=? AND c.team_id=? AND s.app_id=?
      AND ${sellerRouteCustody}`,
    )
    .bind(
      publicRouteKey(input.stableRoute),
      input.stableRoute,
      input.teamId,
      input.appId,
    )
    .first();
  if (row === null) return false;
  Schema.decodeUnknownSync(heldClaimSchema)(row);
  return true;
}

const ownedPublicRouteSchema = Schema.Struct({
  appId: appIdSchema,
  publicSurfaceId: publicSurfaceIdSchema,
  stableRoute: stableRouteSchema,
  releaseId: releaseIdSchema,
});
export type OwnedPublicRoute = Schema.Schema.Type<
  typeof ownedPublicRouteSchema
>;

/** Published customer Surfaces still held by this Team, with their current promotion or rollback. */
export async function listD1OwnedPublicRoutes(
  database: AppReleaseD1Database,
  teamId: string,
): Promise<readonly OwnedPublicRoute[]> {
  const { results } = await database
    .prepare(
      `SELECT s.app_id AS appId,c.public_surface_id AS publicSurfaceId,
      c.stable_route AS stableRoute,t.release_id AS releaseId
    ${sellerRouteJoins}
    JOIN app_release_transitions t ON t.public_surface_id=c.public_surface_id
    WHERE c.team_id=? AND ${sellerRouteCustody}
      AND t.operation_kind IN ('promotion','rollback')
      AND t.sequence=(SELECT MAX(latest.sequence) FROM app_release_transitions latest
        WHERE latest.public_surface_id=c.public_surface_id AND latest.operation_kind IN ('promotion','rollback'))
    ORDER BY s.app_id,c.public_surface_id`,
    )
    .bind(teamId)
    .all();
  return Schema.decodeUnknownSync(Schema.Array(ownedPublicRouteSchema))(
    results,
  );
}

/** Catalog-local irreversible closure; public admission never depends on Global availability. */
export async function closedD1PublicRoute(input: {
  catalog: AppReleaseD1Database;
  route: string;
}): Promise<boolean> {
  const row = await input.catalog
    .prepare(
      `SELECT c.team_id FROM app_release_route_claims c
    JOIN app_release_public_surfaces s ON s.public_surface_id=c.public_surface_id
    JOIN app_release_closed_sellers closed ON closed.team_id=c.team_id
    WHERE c.route_key=? AND c.stable_route=? AND c.state='held' AND s.authority_kind='customer'`,
    )
    .bind(publicRouteKey(input.route), input.route)
    .first();
  if (row === null) return false;
  Schema.decodeUnknownSync(Schema.Struct({ team_id: Schema.String }))(row);
  return true;
}

/** A platform artifact keeps its public mount; a customer claim never qualifies. */
export async function platformD1PublicRoute(
  database: AppReleaseD1Database,
  input: { appId: string; stableRoute: string },
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT s.app_id FROM app_release_public_surfaces s
    JOIN app_release_platform_routes p ON p.app_id=s.app_id AND p.stable_route=s.stable_route
    JOIN app_release_route_claims c ON c.public_surface_id=s.public_surface_id
    WHERE s.app_id=? AND s.stable_route=? AND c.route_key=? AND c.stable_route=s.stable_route
      AND c.state='held' AND s.authority_kind='platform'`,
    )
    .bind(input.appId, input.stableRoute, publicRouteKey(input.stableRoute))
    .first();
  if (row === null) return false;
  Schema.decodeUnknownSync(Schema.Struct({ app_id: Schema.String }))(row);
  return true;
}
