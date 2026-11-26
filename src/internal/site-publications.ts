import { createHash, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import type { SiteMutationRequest } from "../site-publication.js";
import { reportFailure } from "./failure.js";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { nanoid } from "@fungi.computer/cairn";
import {
  issuePublicSurfaceId,
  parseAppId,
  parsePublicSurfaceId,
  parseReleaseId,
  parseStableRoute,
} from "../index.js";
import {
  appIdentityCodec,
  appReleaseIdentityCodec,
  sha256DigestSchema,
} from "./app-release-schema.js";
import {
  publicSurfaceIdSchema,
  appIdSchema,
  stableRouteSchema,
  releaseIdSchema,
} from "./app-release-schema.js";
import { SitePublicationError, siteTrafficDay } from "../site-publication.js";
import { insertPublicSurfaceSql } from "./public-route-sql.js";
import { publicRouteKey } from "../public-route-policy.js";
import type { AppReleaseD1Database } from "../cloudflare.js";
import type {
  PublicSurface,
  ReleaseId,
  Sha256Digest,
} from "./app-release-contract.js";

const deliverySchema = Schema.Struct({
  public_surface_id: publicSurfaceIdSchema,
  app_id: appIdSchema,
  stable_route: stableRouteSchema,
  publisher_team_id: Schema.String,
  site_name: Schema.String,
  site_revision: Schema.Number,
  site_visibility: Schema.Literals(["public", "unlisted", "private"]),
  release_id: releaseIdSchema,
  site_link_digest: Schema.NullOr(sha256DigestSchema),
});
/** One current, eligible Site selection, read in one native snapshot. */
export type SiteDelivery = Readonly<{
  public_surface_id: PublicSurface["publicSurfaceId"];
  app_id: PublicSurface["appId"];
  stable_route: PublicSurface["stableRoute"];
  publisher_team_id: string;
  site_name: string;
  site_revision: number;
  site_visibility: "public" | "unlisted" | "private";
  release_id: ReleaseId;
  site_link_digest: Sha256Digest | null;
}>;
const siteRecordSchema = Schema.Struct({
  ...deliverySchema.fields,
  release_id: Schema.NullOr(releaseIdSchema),
  site_deleted: Schema.Literals([0, 1]),
  site_link_sealed: Schema.NullOr(Schema.String),
});
/** Host-only Site state; its capability is encrypted, never plaintext. */
export type SiteRecord = Omit<SiteDelivery, "release_id"> &
  Readonly<{
    release_id: ReleaseId | null;
    site_deleted: 0 | 1;
    site_link_sealed: string | null;
  }>;
const readSiteSql = `SELECT s.public_surface_id,s.app_id,s.stable_route,s.publisher_team_id,s.site_name,
  s.site_revision,s.site_visibility,s.site_deleted,s.site_link_digest,s.site_link_sealed,
  (SELECT CASE WHEN EXISTS(SELECT 1 FROM app_release_selection_ready e WHERE e.public_surface_id=s.public_surface_id AND e.release_id=t.release_id) THEN t.release_id ELSE NULL END FROM app_release_transitions t WHERE t.public_surface_id=s.public_surface_id
   AND t.operation_kind IN ('promotion','rollback') ORDER BY t.sequence DESC LIMIT 1) AS release_id
  FROM app_release_public_surfaces s WHERE s.site_name IS NOT NULL`;

/** Site Surface and immutable Release identity reserved by a request. */
export type SitePublicationReservation = Readonly<{
  surface: PublicSurface;
  releaseId: ReleaseId;
}>;
const rowSchema = Schema.Struct({
  public_surface_id: Schema.String,
  app_id: Schema.String,
  stable_route: Schema.String,
  site_name: Schema.String,
  publisher_team_id: Schema.String,
});
const surfaceOf = (
  row: Schema.Schema.Type<typeof rowSchema>,
): PublicSurface => ({
  publicSurfaceId: parsePublicSurfaceId(row.public_surface_id),
  appId: parseAppId(row.app_id),
  stableRoute: parseStableRoute(row.stable_route),
  site: { name: row.site_name },
});
const failure = (cause: unknown) => {
  if (cause instanceof SitePublicationError) return cause;
  reportFailure("sites.catalog", cause);
  return new SitePublicationError({ code: "unavailable" });
};

/** Native reservation only. Releases and promotions still use the catalog owner. */
export function createD1SitePublications(database: AppReleaseD1Database) {
  return {
    /** Current Site selection only; ordinary and historical App routes grant no Site access. */
    delivery(
      input:
        | { kind: "public"; route: string }
        | { kind: "unlisted"; capability: string }
        | { kind: "surface"; siteId: string },
    ): Effect.Effect<SiteDelivery | null, SitePublicationError> {
      return Effect.tryPromise({
        catch: failure,
        try: async () => {
          let key: string;
          if (input.kind === "public") key = input.route;
          else if (input.kind === "surface") key = input.siteId;
          else {
            if (!/^[A-Za-z0-9_-]{43}$/u.test(input.capability)) return null;
            const decoded = Buffer.from(input.capability, "base64url");
            if (
              decoded.length !== 32 ||
              decoded.toString("base64url") !== input.capability
            )
              return null;
            key =
              "sha256:" +
              createHash("sha256").update(input.capability).digest("hex");
          }
          const clauses = {
            surface:
              "s.public_surface_id=? AND s.site_visibility IN ('public','unlisted')",
            public: "s.stable_route=? AND s.site_visibility='public'",
            unlisted: "s.site_link_digest=? AND s.site_visibility='unlisted'",
          };
          const match = clauses[input.kind];
          const row = await database
            .prepare(
              `SELECT s.public_surface_id,s.app_id,s.stable_route,s.publisher_team_id,
            s.site_name,s.site_revision,s.site_visibility,s.site_link_digest,t.release_id
            FROM app_release_public_surfaces s
            JOIN app_release_route_claims c ON c.public_surface_id=s.public_surface_id AND c.state='held'
            JOIN app_release_transitions t ON t.public_surface_id=s.public_surface_id AND t.operation_kind IN ('promotion','rollback')
              AND t.sequence=(SELECT MAX(latest.sequence) FROM app_release_transitions latest WHERE latest.public_surface_id=s.public_surface_id AND latest.operation_kind IN ('promotion','rollback'))
            JOIN app_release_selection_ready e ON e.public_surface_id=s.public_surface_id AND e.release_id=t.release_id
            WHERE ${match} AND s.site_name IS NOT NULL AND s.site_deleted=0`,
            )
            .bind(key)
            .first();
          if (row === null) return null;
          const found = Schema.decodeUnknownSync(deliverySchema)(row);
          if (
            input.kind === "unlisted" &&
            (found.site_link_digest === null ||
              !timingSafeEqual(
                Buffer.from(key),
                Buffer.from(found.site_link_digest),
              ))
          )
            return null;
          return found;
        },
      });
    },
    /**
     * Count one visitor request against the Site's UTC-day cap in a single
     * statement. False means the cap is already spent and nothing was counted.
     */
    admitTraffic(input: {
      siteId: string;
      now: number;
      limit: number;
    }): Effect.Effect<boolean, SitePublicationError> {
      return Effect.tryPromise({
        catch: failure,
        try: async () => {
          const row = await database
            .prepare(
              `INSERT INTO app_release_site_traffic(public_surface_id,day,requests) VALUES(?,?,1)
              ON CONFLICT(public_surface_id,day) DO UPDATE SET requests=requests+1 WHERE requests<?
              RETURNING requests`,
            )
            .bind(input.siteId, siteTrafficDay(input.now), input.limit)
            .first();
          return row !== null;
        },
      });
    },
    /** Page views counted on `now`'s UTC day for each Site, in one query; a Site with none is absent. */
    traffic(
      siteIds: readonly string[],
      now: number,
    ): Effect.Effect<ReadonlyMap<string, number>, SitePublicationError> {
      return Effect.tryPromise({
        catch: failure,
        try: async () => {
          if (siteIds.length === 0) return new Map<string, number>();
          const rows = await database
            .prepare(
              `SELECT public_surface_id,requests FROM app_release_site_traffic WHERE day=? AND public_surface_id IN (${siteIds.map(() => "?").join(",")})`,
            )
            .bind(siteTrafficDay(now), ...siteIds)
            .all();
          if (!rows.success) throw new Error("Site traffic unavailable");
          return new Map(
            Schema.decodeUnknownSync(
              Schema.Array(
                Schema.Struct({
                  public_surface_id: Schema.String,
                  requests: Schema.Number,
                }),
              ),
            )(rows.results).map((row) => [row.public_surface_id, row.requests]),
          );
        },
      });
    },
    /** Drop daily counts older than `keepDays` UTC days; billing never reads them. */
    pruneTraffic(
      now: number,
      keepDays: number,
    ): Effect.Effect<void, SitePublicationError> {
      return Effect.tryPromise({
        catch: failure,
        try: async () => {
          await database
            .prepare("DELETE FROM app_release_site_traffic WHERE day<?")
            .bind(siteTrafficDay(now - keepDays * 24 * 60 * 60 * 1000))
            .run();
        },
      });
    },
    /** A Team-scoped administrative read; deleted names remain tombstones. */
    read(
      teamId: string,
      siteId: string,
    ): Effect.Effect<SiteRecord | null, SitePublicationError> {
      return Effect.tryPromise({
        catch: failure,
        try: async () => {
          const row = await database
            .prepare(
              readSiteSql +
                " AND s.publisher_team_id=? AND s.public_surface_id=?",
            )
            .bind(teamId, siteId)
            .first();
          return row === null
            ? null
            : Schema.decodeUnknownSync(siteRecordSchema)(row);
        },
      });
    },
    /** Active reservations and published Sites, bounded by the native Team cap. */
    list(
      teamId: string,
    ): Effect.Effect<readonly SiteRecord[], SitePublicationError> {
      return Effect.tryPromise({
        catch: failure,
        try: async () => {
          const rows = await database
            .prepare(
              readSiteSql +
                " AND s.publisher_team_id=? AND s.site_deleted=0 ORDER BY s.site_name",
            )
            .bind(teamId)
            .all();
          if (!rows.success) throw new Error("Site listing unavailable");
          return Schema.decodeUnknownSync(Schema.Array(siteRecordSchema))(
            rows.results,
          );
        },
      });
    },
    /** CAS plus append-only receipt is one D1 transaction. Retries never reissue an old capability. */
    mutate(input: {
      teamId: string;
      actorId: string;
      operation: SiteMutationRequest;
      requestDigest: Sha256Digest;
      link: { digest: Sha256Digest; sealed: string } | null;
    }): Effect.Effect<SiteRecord, SitePublicationError> {
      return Effect.gen(function* () {
        const operation = input.operation;
        const sites = createD1SitePublications(database);
        const before = yield* sites.read(input.teamId, operation.siteId);
        if (before === null)
          return yield* Effect.fail(
            new SitePublicationError({ code: "denied" }),
          );
        const receipt = () =>
          database
            .prepare(
              "SELECT request_digest,public_surface_id FROM app_release_site_operations WHERE team_id=? AND request_id=?",
            )
            .bind(input.teamId, operation.requestId)
            .first();
        const readReceipt = () =>
          Effect.tryPromise({ catch: failure, try: receipt });
        const matches = (raw: unknown) => {
          const row = Schema.decodeUnknownSync(
            Schema.Struct({
              request_digest: Schema.String,
              public_surface_id: Schema.String,
            }),
          )(raw);
          if (
            row.request_digest !== input.requestDigest ||
            row.public_surface_id !== operation.siteId
          )
            throw new SitePublicationError({ code: "conflict" });
        };
        const prior = yield* readReceipt();
        if (prior !== null) {
          yield* Effect.try({
            try: () => {
              matches(prior);
            },
            catch: failure,
          });
          return before;
        }
        if (before.site_deleted === 1 && operation.kind !== "delete")
          return yield* Effect.fail(
            new SitePublicationError({ code: "denied" }),
          );
        if (
          operation.kind === "visibility" &&
          operation.visibility === "private"
        )
          return yield* Effect.fail(
            new SitePublicationError({ code: "private_unavailable" }),
          );
        if (
          operation.kind === "rotate" &&
          before.site_visibility !== "unlisted"
        )
          return yield* Effect.fail(
            new SitePublicationError({ code: "invalid" }),
          );
        const visibility =
          operation.kind === "visibility"
            ? operation.visibility
            : before.site_visibility;
        const link =
          operation.kind === "delete" || visibility !== "unlisted"
            ? null
            : input.link;
        if (
          operation.kind !== "delete" &&
          visibility === "unlisted" &&
          link === null
        )
          return yield* Effect.fail(
            new SitePublicationError({ code: "unavailable" }),
          );
        yield* Effect.tryPromise({
          catch: failure,
          try: async () => {
            const results = await database.batch([
              database
                .prepare(
                  `UPDATE app_release_public_surfaces SET site_visibility=?,site_deleted=?,site_link_digest=?,site_link_sealed=?,site_revision=site_revision+1,site_last_request=?
              WHERE public_surface_id=? AND publisher_team_id=? AND site_revision=? AND (site_deleted=0 OR ?=1)
              AND NOT EXISTS(SELECT 1 FROM app_release_site_operations WHERE team_id=? AND request_id=?)`,
                )
                .bind(
                  visibility,
                  operation.kind === "delete" ? 1 : 0,
                  link?.digest ?? null,
                  link?.sealed ?? null,
                  operation.requestId,
                  operation.siteId,
                  input.teamId,
                  before.site_revision,
                  operation.kind === "delete" ? 1 : 0,
                  input.teamId,
                  operation.requestId,
                ),
              database
                .prepare(
                  `INSERT INTO app_release_site_operations(team_id,request_id,public_surface_id,request_digest,actor_id)
              SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM app_release_public_surfaces WHERE public_surface_id=? AND publisher_team_id=? AND site_last_request=?) ON CONFLICT DO NOTHING`,
                )
                .bind(
                  input.teamId,
                  operation.requestId,
                  operation.siteId,
                  input.requestDigest,
                  input.actorId,
                  operation.siteId,
                  input.teamId,
                  operation.requestId,
                ),
            ]);
            if (results.length !== 2 || results.some((row) => !row.success))
              throw new Error("Site mutation unavailable");
          },
        });
        const committed = yield* readReceipt();
        if (committed === null)
          return yield* Effect.fail(
            new SitePublicationError({ code: "conflict" }),
          );
        yield* Effect.try({
          try: () => {
            matches(committed);
          },
          catch: failure,
        });
        const after = yield* sites.read(input.teamId, operation.siteId);
        if (after === null)
          return yield* Effect.fail(
            new SitePublicationError({ code: "denied" }),
          );
        return after;
      });
    },
    /** Refuse a new Team/name before capture; reserve still enforces the cap atomically. */
    checkCapacity(input: {
      teamId: string;
      name: string;
      limit: number;
    }): Effect.Effect<void, SitePublicationError> {
      return Effect.tryPromise({
        catch: failure,
        try: async () => {
          const row = Schema.decodeUnknownSync(
            Schema.Struct({
              existing: Schema.Number,
              deleted: Schema.Number,
              total: Schema.Number,
            }),
          )(
            await database
              .prepare(
                `SELECT EXISTS(SELECT 1 FROM app_release_public_surfaces WHERE publisher_team_id=? AND site_name=?) AS existing,
              EXISTS(SELECT 1 FROM app_release_public_surfaces WHERE publisher_team_id=? AND site_name=? AND site_deleted=1) AS deleted,
              (SELECT count(*) FROM app_release_public_surfaces WHERE publisher_team_id=? AND site_name IS NOT NULL AND site_deleted=0) AS total`,
              )
              .bind(
                input.teamId,
                input.name,
                input.teamId,
                input.name,
                input.teamId,
              )
              .first(),
          );
          if (row.deleted === 1)
            throw new SitePublicationError({ code: "denied" });
          if (row.existing === 0 && row.total >= input.limit)
            throw new SitePublicationError({ code: "limit" });
        },
      });
    },
    /** Read a completed request without rereading Computer output or R2 objects. */
    completed(input: {
      teamId: string;
      requestId: string;
      intentDigest: Sha256Digest;
    }): Effect.Effect<SitePublicationReservation | null, SitePublicationError> {
      return Effect.tryPromise({
        catch: failure,
        try: async () => {
          const found = await database
            .prepare(
              `SELECT s.*,p.release_id,p.intent_digest,
          EXISTS(SELECT 1 FROM app_release_transitions t WHERE t.operation_kind='promotion' AND t.public_surface_id=p.public_surface_id AND t.release_id=p.release_id) AS published
          FROM app_release_site_publications p JOIN app_release_public_surfaces s ON s.public_surface_id=p.public_surface_id
          WHERE p.team_id=? AND p.request_id=?`,
            )
            .bind(input.teamId, input.requestId)
            .first();
          if (found === null) return null;
          const row = Schema.decodeUnknownSync(
            Schema.Struct({
              ...rowSchema.fields,
              release_id: Schema.String,
              intent_digest: Schema.String,
              published: Schema.Literals([0, 1]),
            }),
          )(found);
          if (row.intent_digest !== input.intentDigest)
            throw new SitePublicationError({ code: "conflict" });
          return row.published === 0
            ? null
            : {
                surface: surfaceOf(row),
                releaseId: parseReleaseId(row.release_id),
              };
        },
      });
    },
    /** Atomically reserve a Team/name Surface and the request's immutable Release identity. */
    reserve(input: {
      teamId: string;
      actorId: string;
      name: string;
      requestId: string;
      inputDigest: Sha256Digest;
      intentDigest: Sha256Digest;
      limit: number;
    }): Effect.Effect<SitePublicationReservation, SitePublicationError> {
      return Effect.tryPromise({
        catch: failure,
        try: async () => {
          const prior = await database
            .prepare(
              `SELECT input_digest FROM app_release_site_publications WHERE team_id=? AND request_id=?`,
            )
            .bind(input.teamId, input.requestId)
            .first();
          if (
            prior !== null &&
            Schema.decodeUnknownSync(
              Schema.Struct({ input_digest: Schema.String }),
            )(prior).input_digest !== input.inputDigest
          )
            throw new SitePublicationError({ code: "conflict" });
          const tombstone = await database
            .prepare(
              "SELECT 1 FROM app_release_public_surfaces WHERE publisher_team_id=? AND site_name=? AND site_deleted=1",
            )
            .bind(input.teamId, input.name)
            .first();
          if (tombstone !== null)
            throw new SitePublicationError({ code: "denied" });
          const appId = parseAppId(appIdentityCodec.generate());
          const surfaceId = issuePublicSurfaceId();
          const route = parseStableRoute(`/site-${nanoid(32)}`);
          const requestKey = `site:${surfaceId}`;
          // D1 batch is atomic. A concurrent publication of the same name sees
          // the first Surface; it cannot leave a second, orphaned App behind.
          const statements = [
            database
              .prepare(
                `INSERT INTO app_release_apps(app_id)
            SELECT ? WHERE EXISTS(SELECT 1 FROM app_release_route_policy WHERE singleton=1) AND NOT EXISTS(SELECT 1 FROM app_release_public_surfaces WHERE publisher_team_id=? AND site_name=?)
            AND (SELECT count(*) FROM app_release_public_surfaces WHERE publisher_team_id=? AND site_name IS NOT NULL AND site_deleted=0) < ?
            AND NOT EXISTS(SELECT 1 FROM app_release_site_publications WHERE team_id=? AND request_id=?)
            ON CONFLICT DO NOTHING`,
              )
              .bind(
                appId,
                input.teamId,
                input.name,
                input.teamId,
                input.limit,
                input.teamId,
                input.requestId,
              ),
            database
              .prepare(
                `INSERT INTO app_release_team_publishers(app_id,team_id,source_provider,source_repository,source_branch)
              SELECT app_id,?,'captured-output',NULL,NULL FROM app_release_apps WHERE app_id=? ON CONFLICT DO NOTHING`,
              )
              .bind(input.teamId, appId),
            database
              .prepare(insertPublicSurfaceSql)
              .bind(
                surfaceId,
                appId,
                route,
                publicRouteKey(route),
                input.teamId,
                input.actorId,
                "customer",
                requestKey,
                input.name,
              ),
            database
              .prepare(
                `INSERT INTO app_release_site_publications(team_id,request_id,public_surface_id,release_id,input_digest,intent_digest)
              VALUES (?,?,(SELECT public_surface_id FROM app_release_public_surfaces WHERE publisher_team_id=? AND site_name=? AND site_deleted=0),?,?,?)
              ON CONFLICT(team_id,request_id) DO NOTHING`,
              )
              .bind(
                input.teamId,
                input.requestId,
                input.teamId,
                input.name,
                parseReleaseId(appReleaseIdentityCodec.generate()),
                input.inputDigest,
                input.intentDigest,
              ),
          ];
          try {
            const batch = await database.batch(statements);
            if (
              batch.length !== statements.length ||
              batch.some((row) => !row.success)
            )
              throw new SitePublicationError({ code: "unavailable" });
          } catch (cause) {
            const conflict = await database
              .prepare(
                "SELECT input_digest FROM app_release_site_publications WHERE team_id=? AND request_id=?",
              )
              .bind(input.teamId, input.requestId)
              .first();
            if (
              conflict !== null &&
              Schema.decodeUnknownSync(
                Schema.Struct({ input_digest: Schema.String }),
              )(conflict).input_digest !== input.inputDigest
            )
              throw new SitePublicationError({ code: "conflict" });
            const count = Schema.decodeUnknownSync(
              Schema.Struct({ total: Schema.Number }),
            )(
              await database
                .prepare(
                  "SELECT count(*) AS total FROM app_release_public_surfaces WHERE publisher_team_id=? AND site_name IS NOT NULL AND site_deleted=0",
                )
                .bind(input.teamId)
                .first(),
            );
            if (count.total >= input.limit)
              throw new SitePublicationError({ code: "limit" });
            throw cause;
          }
          const reserved = await database
            .prepare(
              `SELECT s.*,p.release_id,p.input_digest FROM app_release_site_publications p JOIN app_release_public_surfaces s ON s.public_surface_id=p.public_surface_id WHERE p.team_id=? AND p.request_id=?`,
            )
            .bind(input.teamId, input.requestId)
            .first();
          const receipt = Schema.decodeUnknownSync(
            Schema.Struct({
              ...rowSchema.fields,
              release_id: Schema.String,
              input_digest: Schema.String,
            }),
          )(reserved);
          if (
            receipt.site_name !== input.name ||
            receipt.input_digest !== input.inputDigest
          )
            throw new SitePublicationError({ code: "conflict" });
          return {
            surface: surfaceOf(receipt),
            releaseId: parseReleaseId(receipt.release_id),
          };
        },
      });
    },
  };
}
