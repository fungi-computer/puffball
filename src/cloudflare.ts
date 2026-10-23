import {
  artifactDispositionSchemaSql,
  artifactDispositionReadbackSchema,
  createD1ArtifactDispositions,
} from "./artifact-dispositions.js";
import {
  buyerReferenceSchemaSql,
  createD1BuyerReferences,
} from "./buyer-references.js";
import {
  publicSurfaceTableSql,
  publicRouteSchemaSql,
  platformOwnerReplaySchemaSql,
  insertPublicSurfaceSql,
} from "./internal/public-route-sql.js";
import { publicRouteKey, publicRoutePolicy } from "./public-route-policy.js";
import { safetyTakedownSchemaSql } from "./safety-takedown.js";
import { assetBuildMediaType, type AssetBuildPolicy } from "./assets.js";
import { decodeAssetBuild } from "./assets.js";
import { appMediaType } from "./app.js";
import type { AssetR2Bucket } from "./cloudflare-assets.js";
export type { AssetR2Bucket, AssetR2Object } from "./cloudflare-assets.js";
import * as Schema from "effect/Schema";
export type { ArtifactSnapshotPolicy } from "./internal/verified-artifact-snapshot.js";
import {
  createArtifactSnapshotPolicy,
  DEFAULT_ARTIFACT_SNAPSHOT_POLICY,
  type ArtifactSnapshotPolicy,
} from "./internal/verified-artifact-snapshot.js";

import type {
  App,
  AppCreate,
  AppReleaseStoreResult,
  AppTransitionId,
  ArtifactMediaType,
  ArtifactReader,
  IdempotencyKey,
  PublicSurfaceCreate,
  PublicSurface,
  Release,
  ReleaseCreate,
  ReleaseLifecycle,
  ReleaseVerification,
  ReleaseTransition,
  TransitionLookup,
  TransitionPersistence,
  TransitionReceipt,
} from "./internal/app-release-contract.js";
import type { PromiseAppReleaseStore } from "./internal/app-release-contract.js";
import {
  parseAppId,
  parseAppTransitionId,
  parseArtifactRef,
  parseIdempotencyKey,
  parseReleaseId,
  parseSha256Digest,
  parseSourceRevision,
  parsePublicSurfaceId,
  parseStableRoute,
} from "./index.js";
import type {
  AppId,
  PublicSurfaceId,
  ReleaseId,
} from "./internal/app-release-contract.js";
import { sameReleaseTransitionMaterial } from "./internal/release-transition-material.js";
import type { PublicWebsiteAuthority } from "./internal/public-website-authority.js";
import {
  teamAppPublisherRegistrationSchema,
  type TeamAppPublisherRegistration,
  type TeamAppPublisherRegistry,
} from "./publisher.js";
import { registerPromisePublicWebsiteAuthorityReader } from "./internal/public-website-authority.js";
import { reportFailure } from "./internal/failure.js";
import {
  appIdSchema,
  appErasureIdCodec,
  artifactMediaTypeSchema,
  appTransitionIdSchema,
  publicSurfaceIdSchema,
  releaseIdSchema,
  stableRouteSchema,
  sourceRevisionSchema,
  verifiedAppDescriptionSchema,
} from "./internal/app-release-schema.js";

/** Durable catalog-scoped fact awaiting delivery to a separately owned Team. */
export type AppReleaseTransitionObligation = {
  readonly sequence: number;
  readonly transition: ReleaseTransition;
  readonly transitionId: AppTransitionId;
  readonly affectedPublicSurfaceIds: readonly PublicSurfaceId[];
  /** Catalog-owned material needed by a Team without a second catalog read. */
  readonly affectedSurfaces: readonly AppReleaseAffectedSurface[];
  readonly affectedBuyerApps: readonly AppId[];
  /** The last opaque Global Team cursor and whether enumeration is complete. */
  readonly enumeration: {
    readonly cursor: string | null;
    readonly complete: boolean;
  };
  readonly state: "pending" | "acknowledged";
};

/** Catalog-owned public-Surface material carried with a transition obligation. */
export type AppReleaseAffectedSurface = {
  readonly publicSurfaceId: PublicSurfaceId;
  readonly appId: AppId;
  readonly stableRoute: import("./internal/app-release-contract.js").StableRoute;
};

/** Durable delivery state for one Team recipient of a transition obligation. */
export type AppReleaseTeamRecipient = {
  readonly teamId: string;
  readonly state: "pending" | "applied" | "no-op" | "expired";
};

/** One ordered page of Team IDs returned by the separately owned Team directory. */
export type AppReleaseTeamRecipientPage = {
  /** Null identifies the first page; all later cursors remain opaque strings. */
  readonly cursor?: string | null | undefined;
  readonly nextCursor?: string | null | undefined;
  readonly teamIds: readonly string[];
  readonly complete: boolean;
};

/** Terminal delivery outcome recorded for one Team recipient. */
export type AppReleaseTeamRecipientOutcome = "applied" | "no-op" | "expired";

/** D1-only at-least-once read/ack seam; Team routing remains outside App Release. */
export type AppReleaseTransitionObligationStore = {
  /** Read one obligation by its immutable transition identity, or report it absent. */
  readByTransitionId(
    transitionId: AppTransitionId,
  ): Promise<
    AppReleaseStoreResult<
      AppReleaseTransitionObligation | { readonly kind: "absent" }
    >
  >;
  /** Read pending obligations after a sequence cursor in ascending sequence order. */
  read(options: {
    readonly afterSequence?: number | undefined;
    readonly limit?: number | undefined;
  }): Promise<AppReleaseStoreResult<readonly AppReleaseTransitionObligation[]>>;
  /** Persist the next ordered Team-recipient page; identical replays are idempotent. */
  recordTeamRecipientPage(
    sequence: number,
    page: AppReleaseTeamRecipientPage,
  ): Promise<
    AppReleaseStoreResult<
      AppReleaseTransitionObligation | { readonly kind: "absent" }
    >
  >;
  /** Read pending recipients for one obligation in stable Team-ID order. */
  readPendingTeamRecipients(options: {
    readonly sequence: number;
    readonly limit?: number | undefined;
  }): Promise<AppReleaseStoreResult<readonly AppReleaseTeamRecipient[]>>;
  /** Record a pending recipient's terminal outcome; conflicting replays fail. */
  recordTeamRecipientOutcome(
    sequence: number,
    teamId: string,
    outcome: AppReleaseTeamRecipientOutcome,
  ): Promise<
    AppReleaseStoreResult<AppReleaseTeamRecipient | { readonly kind: "absent" }>
  >;
  /** Acknowledge only after enumeration is complete and no recipients remain pending. */
  acknowledge(
    sequence: number,
  ): Promise<
    AppReleaseStoreResult<
      AppReleaseTransitionObligation | { readonly kind: "absent" }
    >
  >;
};

/** Selected Release basis from the same D1 authority snapshot, including its transition sequence. */
export type AppReleaseSurfaceTransitionBasis =
  | { readonly kind: "absent" }
  | { readonly kind: "ambiguous" }
  | {
      readonly kind: "none";
      readonly appId: AppId;
      readonly publicSurfaceId: PublicSurfaceId;
    }
  | {
      readonly kind: "selected";
      readonly appId: AppId;
      readonly publicSurfaceId: PublicSurfaceId;
      readonly releaseId: ReleaseId;
      readonly sequence: number;
      readonly eligibility: "eligible" | "ineligible";
      /** Authority-read start time; consumers may only shorten its horizon. */
      readonly checkedAt: number;
    };

const transitionObligationReadOptionsSchema = Schema.Struct({
  afterSequence: Schema.optional(
    Schema.Number.pipe(
      Schema.check(Schema.isInt()),
      Schema.check(Schema.isGreaterThanOrEqualTo(0)),
    ),
  ),
  limit: Schema.optional(
    Schema.Number.pipe(
      Schema.check(Schema.isInt()),
      Schema.check(Schema.isBetween({ minimum: 1, maximum: 256 })),
    ),
  ),
});
const teamRecipientIdSchema = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256)),
);
const opaqueCursorSchema = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(4096)),
);
const teamRecipientPageSchema = Schema.Struct({
  cursor: Schema.optional(Schema.NullOr(opaqueCursorSchema)),
  nextCursor: Schema.optional(Schema.NullOr(opaqueCursorSchema)),
  teamIds: Schema.Array(teamRecipientIdSchema).pipe(
    Schema.check(Schema.isMaxLength(256)),
    Schema.check(
      Schema.makeFilter((teamIds) => new Set(teamIds).size === teamIds.length, {
        message: "Team recipient page contains duplicate IDs",
      }),
    ),
  ),
  complete: Schema.Boolean,
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (page) =>
        page.complete ===
        (page.nextCursor === null || page.nextCursor === undefined),
      {
        message: "Team recipient page completion must match its next cursor",
      },
    ),
  ),
);
const pendingTeamRecipientsReadOptionsSchema = Schema.Struct({
  sequence: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThan(0)),
  ),
  limit: Schema.optional(
    Schema.Number.pipe(
      Schema.check(Schema.isInt()),
      Schema.check(Schema.isBetween({ minimum: 1, maximum: 256 })),
    ),
  ),
});
const teamRecipientOutcomeSchema = Schema.Literals([
  "applied",
  "no-op",
  "expired",
]);
const teamRecipientStateSchema = Schema.Literals([
  "pending",
  "applied",
  "no-op",
  "expired",
]);
const teamIdsJsonSchema = Schema.fromJsonString(
  Schema.Array(teamRecipientIdSchema).pipe(
    Schema.check(Schema.isMaxLength(256)),
  ),
);
const transitionObligationValueSchema = Schema.Struct({
  sequence: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThan(0)),
  ),
  transitionId: appTransitionIdSchema,
  affectedPublicSurfaceIds: Schema.Array(publicSurfaceIdSchema),
  affectedSurfaces: Schema.Array(
    Schema.Struct({
      publicSurfaceId: publicSurfaceIdSchema,
      appId: appIdSchema,
      stableRoute: stableRouteSchema,
    }),
  ),
  affectedBuyerApps: Schema.Array(appIdSchema).pipe(
    Schema.check(Schema.isMaxLength(1)),
  ),
  enumeration: Schema.Struct({
    cursor: Schema.NullOr(opaqueCursorSchema),
    complete: Schema.Boolean,
  }),
  state: Schema.Literals(["pending", "acknowledged"]),
});
const decodeTransitionObligationReadOptions = Schema.decodeUnknownResult(
  transitionObligationReadOptionsSchema,
  { onExcessProperty: "error" },
);
const decodeTeamRecipientPage = Schema.decodeUnknownResult(
  teamRecipientPageSchema,
  { onExcessProperty: "error" },
);
const decodePendingTeamRecipientsReadOptions = Schema.decodeUnknownResult(
  pendingTeamRecipientsReadOptionsSchema,
  { onExcessProperty: "error" },
);

/** Structural result returned by the D1 operations used by App Release. */
export type AppReleaseD1QueryResult = {
  /** Whether D1 completed the operation successfully. */
  readonly success: boolean;
  /** Untrusted row values returned by the operation. */
  readonly results: readonly unknown[];
};

/** Structural prepared-statement surface needed by the D1-backed store. */
export type AppReleaseD1PreparedStatement = {
  /** Bind positional values and return the statement to execute. */
  bind(...values: unknown[]): AppReleaseD1PreparedStatement;
  /** Read the first untrusted row, or `null` when none exists. */
  first(): Promise<object | null>;
  /** Read all matching rows. */
  all(): Promise<AppReleaseD1QueryResult>;
  /** Execute a mutating statement. */
  run(): Promise<AppReleaseD1QueryResult>;
};

const appRowSchema = Schema.Struct({ app_id: Schema.String });
const releaseRowSchema = Schema.Struct({
  release_id: Schema.String,
  app_id: Schema.String,
  artifact_ref: Schema.String,
  artifact_digest: Schema.String,
  source_revision: Schema.String,
  source_tree_digest: Schema.String,
  build_recipe_digest: Schema.String,
});
const releaseLifecycleRowSchema = Schema.Struct({
  ...releaseRowSchema.fields,
  verification_digest: Schema.NullOr(Schema.String),
  verification_media_type: Schema.NullOr(Schema.String),
  verification_metadata_digest: Schema.NullOr(Schema.String),
  verification_description_json: Schema.NullOr(Schema.String),
  release_is_revoked: Schema.Literals([0, 1]),
});
const releaseVerificationMetadataRowSchema = Schema.Struct({
  verification_artifact_digest: Schema.String,
  media_type: Schema.String,
  metadata_artifact_digest: Schema.String,
  description_json: Schema.String,
});
const publicSurfaceRowSchema = Schema.Struct({
  public_surface_id: Schema.String,
  app_id: Schema.String,
  stable_route: Schema.String,
});
const publicSurfaceDefinitionRowSchema = Schema.Struct({
  ...publicSurfaceRowSchema.fields,
  publisher_team_id: Schema.String,
  publisher_user_id: Schema.String,
  authority_kind: Schema.Literals(["customer", "platform"]),
  request_key: Schema.String,
});
const publicWebsiteAuthorityRowSchema = Schema.Struct({
  app_id: Schema.NullOr(Schema.String),
  public_surface_id: Schema.String,
  surface_app_id: Schema.String,
  stable_route: Schema.String,
  selected_release_id: Schema.NullOr(Schema.String),
  current_release_id: Schema.NullOr(Schema.String),
  selected_transition_sequence: Schema.NullOr(Schema.Number),
  release_id: Schema.NullOr(Schema.String),
  release_app_id: Schema.NullOr(Schema.String),
  artifact_ref: Schema.NullOr(Schema.String),
  artifact_digest: Schema.NullOr(Schema.String),
  source_revision: Schema.NullOr(Schema.String),
  source_tree_digest: Schema.NullOr(Schema.String),
  build_recipe_digest: Schema.NullOr(Schema.String),
  verification_digest: Schema.NullOr(Schema.String),
  verification_media_type: Schema.NullOr(Schema.String),
  verification_metadata_digest: Schema.NullOr(Schema.String),
  verification_description_json: Schema.NullOr(Schema.String),
  release_is_revoked: Schema.Number,
});
const transitionRowSchema = Schema.Struct({
  transition_id: Schema.String,
  operation_kind: Schema.String,
  idempotency_key: Schema.String,
  release_id: Schema.String,
  public_surface_id: Schema.NullOr(Schema.String),
});
const transitionObligationRowSchema = Schema.Struct({
  sequence: Schema.Number,
  transition_id: Schema.String,
  operation_kind: Schema.String,
  idempotency_key: Schema.String,
  release_id: Schema.String,
  public_surface_id: Schema.NullOr(Schema.String),
  state: Schema.String,
});
const transitionObligationEnumerationRowSchema = Schema.Struct({
  sequence: Schema.Number,
  cursor: Schema.NullOr(opaqueCursorSchema),
  started: Schema.Number,
  complete: Schema.Number,
});
const transitionObligationPageRowSchema = Schema.Struct({
  sequence: Schema.Number,
  cursor: Schema.NullOr(opaqueCursorSchema),
  cursor_is_initial: Schema.Number,
  next_cursor: Schema.NullOr(Schema.String),
  complete: Schema.Number,
  team_ids_json: Schema.String,
});
const transitionObligationRecipientRowSchema = Schema.Struct({
  team_id: teamRecipientIdSchema,
  state: teamRecipientStateSchema,
});
type AppRow = Schema.Schema.Type<typeof appRowSchema>;
type ReleaseRow = Schema.Schema.Type<typeof releaseRowSchema>;
type PublicSurfaceRow = Schema.Schema.Type<typeof publicSurfaceRowSchema>;
type TransitionRow = Schema.Schema.Type<typeof transitionRowSchema>;
type TransitionObligationRow = Schema.Schema.Type<
  typeof transitionObligationRowSchema
>;
type TransitionObligationEnumerationRow = Schema.Schema.Type<
  typeof transitionObligationEnumerationRowSchema
>;
type TransitionObligationPageRow = Schema.Schema.Type<
  typeof transitionObligationPageRowSchema
>;
type TransitionObligationRecipientRow = Schema.Schema.Type<
  typeof transitionObligationRecipientRowSchema
>;

/** Structural D1 surface kept independent of Cloudflare vendor declarations. */
export type AppReleaseD1Database = {
  /** Prepare one SQL statement for binding and execution. */
  prepare(query: string): AppReleaseD1PreparedStatement;
  /** Execute a group of statements atomically in native D1. */
  batch(
    statements: readonly AppReleaseD1PreparedStatement[],
  ): Promise<readonly AppReleaseD1QueryResult[]>;
};

/** Structural R2 object surface needed by the artifact reader. */
export type AppReleaseR2Object = {
  /** Native immutable object version checked for referenced App children. */
  readonly version: string;
  /** Object size in bytes, checked before the body is buffered. */
  readonly size: number;
  /** HTTP metadata retained with the object, when present. */
  readonly httpMetadata?: {
    /** Declared media type for the stored object. */
    readonly contentType?: string;
  };
  /** Read the immutable object body. */
  arrayBuffer(): Promise<ArrayBuffer>;
};

/** Structural R2 surface kept independent of Cloudflare vendor declarations. */
export type AppReleaseR2Bucket = {
  /** Read one object by its opaque storage key. */
  get(key: string): Promise<AppReleaseR2Object | null>;
};

/** R2 operations used by the scoped Team erasure owner. */
export type ErasureBucket = AppReleaseR2Bucket & {
  /** Read the metadata for an exact object key. */
  head(key: string): Promise<object | null>;
  /** Delete an exact object key after catalog references are checked. */
  delete(key: string): Promise<void>;
};

const erasureAppRow = Schema.Struct({ app_id: Schema.String });
const erasurePublisherRow = Schema.Struct({
  app_id: Schema.String,
  source_provider: Schema.Literals(["artifacts", "github"]),
  source_repository: Schema.String,
});
const erasureReleaseRow = Schema.Struct({
  description_json: Schema.NullOr(Schema.String),
  app_id: Schema.String,
  artifact_ref: Schema.String,
  media_type: Schema.NullOr(Schema.String),
});
const erasureJobRow = Schema.Struct({
  app_id: Schema.String,
  object_keys_json: Schema.String,
  repository_name: Schema.NullOr(Schema.String),
});

/** Read every catalog reference before deleting content-addressed R2 objects. */
export function createTeamAppReleaseErasure(
  database: AppReleaseD1Database,
  bucket: ErasureBucket,
  assetPolicy?: AssetBuildPolicy,
  now: () => number = Date.now,
) {
  const rows = async <A>(
    sql: string,
    schema: Schema.Codec<A>,
    ...values: unknown[]
  ) => {
    const result = await database
      .prepare(sql)
      .bind(...values)
      .all();
    if (!result.success) throw new Error("App Release erasure read failed");
    return result.results.map((row) =>
      Schema.decodeUnknownSync(schema)(row, { onExcessProperty: "error" }),
    );
  };
  const catalogReferences = async (retainedForSeller: string | null = null) => {
    const releases = await rows(
      `SELECT release.app_id,release.artifact_ref,format.media_type,metadata.description_json
       FROM app_release_releases AS release
       LEFT JOIN app_release_release_verification_formats AS format USING(release_id)
       LEFT JOIN app_release_release_verification_metadata AS metadata USING(release_id)
       WHERE (? IS NULL OR EXISTS (SELECT 1 FROM app_release_buyer_references b WHERE b.release_id=release.release_id AND b.buyer_team_id<>?))
       ORDER BY release.release_id LIMIT 10001`,
      erasureReleaseRow,
      retainedForSeller,
      retainedForSeller,
    );
    if (releases.length > 10_000)
      throw new Error("App Release erasure reference inventory exceeds bound");
    const references = new Map<string, Set<string>>();
    for (const release of releases) {
      const owned = references.get(release.artifact_ref) ?? new Set<string>();
      owned.add(release.app_id);
      references.set(release.artifact_ref, owned);
      const description =
        release.description_json === null
          ? null
          : Schema.decodeUnknownSync(
              Schema.fromJsonString(verifiedAppDescriptionSchema),
            )(release.description_json);
      const children =
        description === null
          ? []
          : [description.ui, description.backend?.artifact ?? null].filter(
              (child) => child !== null,
            );
      for (const child of children) {
        const owners = references.get(child.artifactRef) ?? new Set<string>();
        owners.add(release.app_id);
        references.set(child.artifactRef, owners);
      }
      const manifests = [
        ...(release.media_type === assetBuildMediaType
          ? [release.artifact_ref]
          : []),
        ...children
          .filter((child) => child.mediaType === assetBuildMediaType)
          .map((child) => child.artifactRef),
      ];
      for (const manifest of manifests) {
        if (!assetPolicy)
          throw new Error(
            "App Release asset policy required for erasure inventory",
          );
        const object = await bucket.get(manifest);
        if (!object || object.size > assetPolicy.maxManifestBytes)
          throw new Error("App Release asset manifest is unavailable");
        const build = decodeAssetBuild(
          new Uint8Array(await object.arrayBuffer()),
          assetPolicy,
        );
        for (const asset of build.assets) {
          const owners = references.get(asset.artifactRef) ?? new Set<string>();
          owners.add(release.app_id);
          references.set(asset.artifactRef, owners);
        }
      }
    }
    return references;
  };
  const jobs = (teamId: string) =>
    rows(
      "SELECT app_id,object_keys_json,repository_name FROM app_release_erasure_jobs WHERE team_id=? ORDER BY app_id",
      erasureJobRow,
      teamId,
    );
  return {
    /** Reject any live App or R2 key outside this Team's current or retry scope. */
    async verifyManifest(
      teamId: string,
      appIds: readonly string[],
      keys: readonly string[],
    ) {
      const plan = await this.preflight(teamId);
      const plannedIds = new Set(plan.apps.map(({ appId }) => appId));
      const plannedKeys = new Set(
        plan.apps.flatMap(({ keys: appKeys }) => appKeys),
      );
      if (plan.apps.some(({ appId }) => !appIds.includes(appId)))
        throw new Error("App Release manifest omits a Team App");
      for (const appId of appIds) {
        if (plannedIds.has(appId)) continue;
        if (
          (
            await rows(
              "SELECT app_id FROM app_release_apps WHERE app_id=?",
              erasureAppRow,
              appId,
            )
          ).length
        )
          throw new Error("App Release manifest names an unscoped App");
      }
      const references = await catalogReferences();
      for (const key of keys) {
        if (plannedKeys.has(key)) continue;
        if (references.has(key) || (await bucket.head(key)))
          throw new Error("App Release manifest names an unscoped R2 object");
      }
      return plan;
    },
    /** Inventory Team catalog rows, exclusive objects, and source repositories. */
    async preflight(teamId: string) {
      const scope = await rows(
        "SELECT app_id FROM app_release_erasure_scope",
        erasureAppRow,
      );
      if (scope.length !== 0)
        throw new Error("App Release erasure scope is not empty");
      const apps = await rows(
        "SELECT app_id,source_provider,source_repository FROM app_release_team_publishers WHERE team_id=? ORDER BY app_id",
        erasurePublisherRow,
        teamId,
      );
      const references = await catalogReferences();
      const retainedReferences = await catalogReferences(teamId);
      const pending = await jobs(teamId);
      const appIds = [
        ...new Set([...apps, ...pending].map(({ app_id }) => app_id)),
      ];
      const planned = appIds.map((appId) => {
        const existing = pending.find((row) => row.app_id === appId);
        const keys = existing
          ? Schema.decodeUnknownSync(
              Schema.fromJsonString(Schema.Array(Schema.String)),
            )(existing.object_keys_json)
          : [...references.entries()]
              .filter(
                ([key, owners]) =>
                  owners.has(appId) &&
                  owners.size === 1 &&
                  !retainedReferences.has(key),
              )
              .map(([key]) => key)
              .sort();
        return { appId, keys };
      });
      for (const app of planned)
        for (const key of app.keys)
          if (
            !(await bucket.head(key)) &&
            apps.some((row) => row.app_id === app.appId)
          )
            throw new Error("App Release R2 object is missing before erasure");
      const repositories = [
        ...new Set([
          ...apps
            .filter((app) => app.source_provider === "artifacts")
            .map((app) => app.source_repository),
          ...pending.flatMap((job) =>
            job.repository_name === null ? [] : [job.repository_name],
          ),
        ]),
      ].sort();
      for (const repository of repositories) {
        const users = await rows(
          "SELECT app_id FROM app_release_team_publishers WHERE source_provider='artifacts' AND source_repository=?",
          erasureAppRow,
          repository,
        );
        if (users.some(({ app_id }) => !appIds.includes(app_id)))
          throw new Error("Artifacts repository is shared with another Team");
        const children = await rows(
          "SELECT repository_name AS app_id FROM publisher_artifacts_repositories WHERE parent_repository=?",
          erasureAppRow,
          repository,
        );
        if (children.length)
          throw new Error("Artifacts repository has descendant forks");
      }
      return { teamId, apps: planned, repositories };
    },
    /** Remove one Team's catalog and exclusive objects, resuming pending jobs. */
    async erase(teamId: string) {
      const plan = await this.preflight(teamId);
      const teamErasureId = appErasureIdCodec.generate();
      const obligationCleanup = await database.batch([
        database
          .prepare("DELETE FROM app_release_team_route_blocks WHERE team_id=?")
          .bind(teamId),
        database
          .prepare(
            "UPDATE app_release_route_operation_steps SET operator_id=? WHERE operation_id IN (SELECT operation_id FROM app_release_route_operations WHERE team_id=?)",
          )
          .bind(teamErasureId, teamId),
        database
          .prepare(
            "UPDATE app_release_route_operations SET team_id=?,initiated_by=?,reason='Erased',state=CASE WHEN state='pending' THEN 'superseded-by-erasure' ELSE state END WHERE team_id=?",
          )
          .bind(teamErasureId, teamErasureId, teamId),
        database
          .prepare(
            `UPDATE app_release_artifact_notice_recipients
           SET buyer_team_id=NULL,receipt=NULL,erased_by=COALESCE(erased_by,'team-erasure'),erased_at=COALESCE(erased_at,?)
           WHERE buyer_team_id=?`,
          )
          .bind(now(), teamId),
        database
          .prepare(
            "DELETE FROM app_release_buyer_references WHERE buyer_team_id=?",
          )
          .bind(teamId),
        database
          .prepare(
            "DELETE FROM app_release_transition_obligation_teams WHERE team_id=?",
          )
          .bind(teamId),
        database
          .prepare(
            `UPDATE app_release_transition_obligation_pages
            SET team_ids_json=(SELECT json_group_array(value) FROM json_each(team_ids_json) WHERE value<>?)
            WHERE EXISTS (SELECT 1 FROM json_each(team_ids_json) WHERE value=?)`,
          )
          .bind(teamId, teamId),
      ]);
      if (obligationCleanup.some((result) => !result.success))
        throw new Error("App Release Team obligation erasure failed");
      for (const app of plan.apps) {
        const existing = (await jobs(teamId)).find(
          (row) => row.app_id === app.appId,
        );
        if (!existing) {
          const statement = (sql: string, ...values: unknown[]) =>
            database.prepare(sql).bind(...values);
          const appId = app.appId;
          const erasureId = appErasureIdCodec.generate();
          const erasedAtMs = now();
          const erasedAt = Math.floor(erasedAtMs / 1000);
          const transaction = [
            statement(
              "INSERT INTO app_release_erasure_jobs(app_id,team_id,object_keys_json,repository_name) SELECT app_id,?,?,CASE WHEN source_provider='artifacts' THEN source_repository ELSE NULL END FROM app_release_team_publishers WHERE app_id=? AND team_id=?",
              teamId,
              JSON.stringify(app.keys),
              appId,
              teamId,
            ),
            statement(
              "INSERT INTO app_release_erasure_scope(singleton,app_id) SELECT 1,app_id FROM app_release_team_publishers WHERE team_id=? AND app_id=?",
              teamId,
              appId,
            ),
            statement(
              `INSERT INTO app_release_artifact_dispositions(disposition_id,app_id,release_ids_json,artifact_roots_json,created_at,state)
               SELECT ?,?,json_group_array(DISTINCT r.release_id),json_group_array(DISTINCT r.artifact_ref),?,'pending'
               FROM app_release_releases r WHERE r.app_id=? AND EXISTS (
                 SELECT 1 FROM app_release_buyer_references b WHERE b.release_id=r.release_id AND b.buyer_team_id<>?)
               HAVING count(*)>0 ON CONFLICT DO NOTHING`,
              erasureId,
              appId,
              erasedAtMs,
              appId,
              teamId,
            ),
            statement(
              `INSERT INTO app_release_artifact_notice_recipients(disposition_id,buyer_team_id)
               SELECT d.disposition_id,b.buyer_team_id FROM app_release_artifact_dispositions d
               JOIN app_release_buyer_references b ON b.app_id=d.app_id
               WHERE d.app_id=? AND b.buyer_team_id<>? AND d.state='pending'
               ON CONFLICT DO NOTHING`,
              appId,
              teamId,
            ),
            statement(
              `INSERT INTO app_release_route_holds(route_key,stable_route,until_s,cause,operation_id)
               SELECT s.route_key,s.stable_route,?,'erasure',? FROM app_release_public_surfaces s
               WHERE s.app_id=? AND (
                 EXISTS (SELECT 1 FROM app_release_route_claims c WHERE c.public_surface_id=s.public_surface_id)
                 OR EXISTS (SELECT 1 FROM app_release_surface_retirements x WHERE x.public_surface_id=s.public_surface_id))
               AND NOT EXISTS (SELECT 1 FROM app_release_route_claims c WHERE c.route_key=s.route_key AND c.public_surface_id<>s.public_surface_id)
               ON CONFLICT(route_key) DO UPDATE SET until_s=max(until_s,excluded.until_s),cause='erasure',operation_id=excluded.operation_id`,
              erasedAt + publicRoutePolicy.erasureTombstoneSeconds,
              erasureId,
              appId,
            ),
            statement(
              "DELETE FROM app_release_route_claims WHERE public_surface_id IN (SELECT public_surface_id FROM app_release_public_surfaces WHERE app_id=?)",
              appId,
            ),
            statement(
              "DELETE FROM app_release_surface_retirements WHERE public_surface_id IN (SELECT public_surface_id FROM app_release_public_surfaces WHERE app_id=?)",
              appId,
            ),
            statement(
              "DELETE FROM app_release_team_route_blocks WHERE team_id=?",
              teamId,
            ),
            statement(
              "UPDATE app_release_route_operation_steps SET operator_id=? WHERE operation_id IN (SELECT operation_id FROM app_release_route_operations WHERE team_id=? OR app_id=?)",
              erasureId,
              teamId,
              appId,
            ),
            statement(
              "UPDATE app_release_route_operations SET team_id=?,initiated_by=?,reason='Erased',state=CASE WHEN state='pending' THEN 'superseded-by-erasure' ELSE state END WHERE team_id=? OR app_id=?",
              erasureId,
              erasureId,
              teamId,
              appId,
            ),
            statement(
              "DELETE FROM app_release_transition_obligation_teams WHERE sequence IN (SELECT transition.sequence FROM app_release_transitions AS transition JOIN app_release_releases AS release ON release.release_id=transition.release_id WHERE release.app_id=? AND (transition.operation_kind<>'revocation' OR NOT EXISTS (SELECT 1 FROM app_release_buyer_references b WHERE b.release_id=transition.release_id)))",
              appId,
            ),
            statement(
              "DELETE FROM app_release_platform_owner_replays WHERE app_id=?",
              appId,
            ),
            ...[
              "app_release_transition_obligation_pages",
              "app_release_transition_obligation_enumeration",
              "app_release_transition_obligations",
            ].map((table) =>
              statement(
                `DELETE FROM ${table} WHERE sequence IN (SELECT transition.sequence FROM app_release_transitions AS transition JOIN app_release_releases AS release ON release.release_id=transition.release_id WHERE release.app_id=? AND (transition.operation_kind<>'revocation' OR NOT EXISTS (SELECT 1 FROM app_release_buyer_references b WHERE b.release_id=transition.release_id)))`,
                appId,
              ),
            ),
            statement(
              "DELETE FROM app_release_transitions WHERE release_id IN (SELECT release_id FROM app_release_releases WHERE app_id=?) AND (operation_kind<>'revocation' OR NOT EXISTS (SELECT 1 FROM app_release_buyer_references b WHERE b.release_id=app_release_transitions.release_id))",
              appId,
            ),
            ...[
              "app_release_release_verification_metadata",
              "app_release_release_verification_formats",
              "app_release_release_verifications",
            ].map((table) =>
              statement(
                `DELETE FROM ${table} WHERE release_id IN (SELECT release_id FROM app_release_releases WHERE app_id=?) AND NOT EXISTS (SELECT 1 FROM app_release_buyer_references b WHERE b.release_id=${table}.release_id)`,
                appId,
              ),
            ),
            statement(
              "DELETE FROM app_release_public_surfaces WHERE app_id=?",
              appId,
            ),
            statement(
              "DELETE FROM publisher_artifacts_repositories_pending WHERE repository_name=(SELECT source_repository FROM app_release_team_publishers WHERE app_id=? AND source_provider='artifacts')",
              appId,
            ),
            statement(
              "DELETE FROM publisher_artifacts_repositories WHERE repository_name=(SELECT source_repository FROM app_release_team_publishers WHERE app_id=? AND source_provider='artifacts')",
              appId,
            ),
            statement(
              "DELETE FROM app_release_team_publishers WHERE app_id=?",
              appId,
            ),
            statement(
              "DELETE FROM app_release_releases WHERE app_id=? AND NOT EXISTS (SELECT 1 FROM app_release_buyer_references b WHERE b.release_id=app_release_releases.release_id)",
              appId,
            ),
            statement(
              "DELETE FROM app_release_apps WHERE app_id=? AND NOT EXISTS (SELECT 1 FROM app_release_releases r WHERE r.app_id=app_release_apps.app_id) AND NOT EXISTS (SELECT 1 FROM app_release_artifact_dispositions d WHERE d.app_id=app_release_apps.app_id)",
              appId,
            ),
            statement(
              "DELETE FROM app_release_erasure_scope WHERE singleton=1",
            ),
          ];
          const results = await database.batch(transaction);
          if (
            results.length !== transaction.length ||
            results.some((row) => !row.success)
          )
            throw new Error("App Release erasure transaction failed");
          if (!(await jobs(teamId)).some((row) => row.app_id === appId))
            throw new Error("App Release erasure scope changed before commit");
        }
        const currentReferences = await catalogReferences();
        for (const key of app.keys) {
          if (currentReferences.has(key)) continue;
          await bucket.delete(key);
          if (await bucket.head(key))
            throw new Error("App Release R2 object remains after delete");
        }
        const removed = await database
          .prepare(
            "DELETE FROM app_release_erasure_jobs WHERE app_id=? AND team_id=?",
          )
          .bind(app.appId, teamId)
          .run();
        if (!removed.success)
          throw new Error("App Release erasure job remains");
      }
      return { apps: plan.apps.length };
    },
    /** Verify the named Apps, pending jobs, obligations and exclusive objects. */
    async readback(
      teamId: string,
      appIds: readonly string[],
      keys: readonly string[],
    ) {
      const remaining = await rows(
        "SELECT app_id FROM app_release_team_publishers WHERE team_id=?",
        erasureAppRow,
        teamId,
      );
      const pending = await jobs(teamId);
      const obligationTeams = await rows(
        "SELECT team_id AS app_id FROM app_release_transition_obligation_teams WHERE team_id=?",
        erasureAppRow,
        teamId,
      );
      const obligationPages = await rows(
        "SELECT CAST(sequence AS TEXT) AS app_id FROM app_release_transition_obligation_pages WHERE EXISTS (SELECT 1 FROM json_each(team_ids_json) WHERE value=?)",
        erasureAppRow,
        teamId,
      );
      const buyerReferences = await rows(
        "SELECT installation_id AS app_id FROM app_release_buyer_references WHERE buyer_team_id=?",
        erasureAppRow,
        teamId,
      );
      const noticeRecipients = await rows(
        "SELECT disposition_id AS app_id FROM app_release_artifact_notice_recipients WHERE buyer_team_id=?",
        erasureAppRow,
        teamId,
      );
      const routeIdentities = await rows(
        "SELECT operation_id AS app_id FROM app_release_route_operations WHERE team_id=? UNION SELECT removal_operation_id AS app_id FROM app_release_team_route_blocks WHERE team_id=?",
        erasureAppRow,
        teamId,
        teamId,
      );
      const references = await catalogReferences();
      const objects = [];
      for (const key of keys)
        if (!references.has(key) && (await bucket.head(key))) objects.push(key);
      const retained = [];
      const dispositions = createD1ArtifactDispositions(database);
      for (const appId of appIds) {
        const row = await database
          .prepare(
            "SELECT disposition_id FROM app_release_artifact_dispositions WHERE app_id=? AND state IN ('pending','retaining','revoking')",
          )
          .bind(appId)
          .first();
        if (row !== null) {
          const identity = Schema.decodeUnknownSync(
            Schema.Struct({ disposition_id: Schema.String }),
          )(row);
          const disposition = await dispositions.read(identity.disposition_id);
          if (disposition !== null) retained.push(disposition);
        }
      }
      const personalRows = await Promise.all(
        appIds.map((appId) =>
          database
            .prepare(
              `
        SELECT a.app_id FROM app_release_apps a WHERE a.app_id=? AND (
          NOT EXISTS (SELECT 1 FROM app_release_artifact_dispositions d WHERE d.app_id=a.app_id)
          OR EXISTS (SELECT 1 FROM app_release_public_surfaces s WHERE s.app_id=a.app_id)
          OR EXISTS (SELECT 1 FROM app_release_platform_owner_replays replay WHERE replay.app_id=a.app_id)
          OR EXISTS (SELECT 1 FROM app_release_team_publishers p WHERE p.app_id=a.app_id)
          OR EXISTS (SELECT 1 FROM app_release_releases r WHERE r.app_id=a.app_id AND NOT EXISTS (
            SELECT 1 FROM app_release_artifact_dispositions d,json_each(d.release_ids_json) held
            WHERE d.app_id=a.app_id AND held.value=r.release_id))) LIMIT 1`,
            )
            .bind(appId)
            .first(),
        ),
      );
      const personalClear =
        remaining.length === 0 &&
        pending.length === 0 &&
        obligationTeams.length === 0 &&
        obligationPages.length === 0 &&
        buyerReferences.length === 0 &&
        noticeRecipients.length === 0 &&
        routeIdentities.length === 0 &&
        objects.length === 0 &&
        personalRows.every((row) => row === null);
      return {
        clear: personalClear && retained.length === 0,
        personalClear,
        retainedArtifacts: retained,
        remaining: remaining.map(({ app_id }) => app_id),
        pending: pending.map(({ app_id }) => app_id),
        obligationTeams: obligationTeams.map(({ app_id }) => app_id),
        obligationPages: obligationPages.map(({ app_id }) => app_id),
        objects,
      };
    },
  };
}

/** The erasure coordinator consumes this owner-issued readback, including outstanding buyer custody. */
export const appArtifactErasureReadbackSchema = Schema.Struct({
  clear: Schema.Boolean,
  personalClear: Schema.Boolean,
  retainedArtifacts: Schema.Array(artifactDispositionReadbackSchema).pipe(
    Schema.check(Schema.isMaxLength(10000)),
  ),
  remaining: Schema.Array(Schema.String),
  pending: Schema.Array(Schema.String),
  obligationTeams: Schema.Array(Schema.String),
  obligationPages: Schema.Array(Schema.String),
  objects: Schema.Array(Schema.String),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (value) =>
        value.clear ===
        (value.personalClear && value.retainedArtifacts.length === 0),
      { message: "App artifact erasure readback contradicts its held custody" },
    ),
  ),
);

/** The one current App Release D1 schema for an empty catalog. */
export const APP_RELEASE_D1_FRESH_SCHEMA = `
CREATE TABLE app_release_apps (app_id TEXT PRIMARY KEY) STRICT;
CREATE TABLE app_release_releases (release_id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES app_release_apps(app_id), artifact_ref TEXT NOT NULL, artifact_digest TEXT NOT NULL, source_revision TEXT NOT NULL, source_tree_digest TEXT NOT NULL, build_recipe_digest TEXT NOT NULL) STRICT;
CREATE TABLE app_release_release_verifications (release_id TEXT PRIMARY KEY REFERENCES app_release_releases(release_id), artifact_digest TEXT NOT NULL) STRICT;
CREATE TABLE app_release_release_verification_formats (release_id TEXT PRIMARY KEY REFERENCES app_release_releases(release_id), media_type TEXT NOT NULL) STRICT;
${publicSurfaceTableSql}
CREATE TABLE app_release_transitions (sequence INTEGER PRIMARY KEY AUTOINCREMENT, transition_id TEXT NOT NULL UNIQUE, operation_kind TEXT NOT NULL, idempotency_key TEXT NOT NULL, release_id TEXT NOT NULL, public_surface_id TEXT, UNIQUE (operation_kind, idempotency_key)) STRICT;
CREATE INDEX app_release_public_surfaces_stable_route_idx ON app_release_public_surfaces (stable_route, public_surface_id);
CREATE INDEX app_release_transitions_selected_surface_idx ON app_release_transitions (public_surface_id, operation_kind, sequence DESC) WHERE operation_kind IN ('promotion', 'rollback');
CREATE INDEX app_release_transitions_revoked_release_idx ON app_release_transitions (release_id, operation_kind) WHERE operation_kind = 'revocation';
CREATE TABLE app_release_transition_obligations (sequence INTEGER PRIMARY KEY REFERENCES app_release_transitions(sequence), transition_id TEXT NOT NULL UNIQUE, operation_kind TEXT NOT NULL, idempotency_key TEXT NOT NULL, release_id TEXT NOT NULL, public_surface_id TEXT, state TEXT NOT NULL CHECK(state IN ('pending','acknowledged'))) STRICT;
CREATE INDEX app_release_transition_obligations_pending_idx ON app_release_transition_obligations(state, sequence);
CREATE TABLE app_release_transition_obligation_enumeration (sequence INTEGER PRIMARY KEY REFERENCES app_release_transition_obligations(sequence), cursor TEXT, started INTEGER NOT NULL DEFAULT 0 CHECK(started IN (0, 1)), complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0, 1))) STRICT;
CREATE TABLE app_release_transition_obligation_pages (sequence INTEGER NOT NULL REFERENCES app_release_transition_obligations(sequence), cursor TEXT, cursor_is_initial INTEGER NOT NULL CHECK(cursor_is_initial IN (0, 1)), cursor_key TEXT NOT NULL, next_cursor TEXT, complete INTEGER NOT NULL CHECK(complete IN (0, 1)), team_ids_json TEXT NOT NULL CHECK(json_valid(team_ids_json)), PRIMARY KEY(sequence, cursor_is_initial, cursor_key)) STRICT;
CREATE TABLE app_release_transition_obligation_teams (sequence INTEGER NOT NULL REFERENCES app_release_transition_obligations(sequence), team_id TEXT NOT NULL CHECK(length(team_id) BETWEEN 1 AND 256), state TEXT NOT NULL CHECK(state IN ('pending', 'applied', 'no-op', 'expired')), PRIMARY KEY(sequence, team_id)) STRICT;
CREATE INDEX app_release_transition_obligation_teams_pending_idx ON app_release_transition_obligation_teams(sequence, state, team_id);
CREATE TABLE app_release_team_publishers (app_id TEXT PRIMARY KEY REFERENCES app_release_apps(app_id), team_id TEXT NOT NULL CHECK(length(team_id) BETWEEN 1 AND 256), source_provider TEXT NOT NULL CHECK(source_provider IN ('artifacts','github')), source_repository TEXT NOT NULL CHECK(length(source_repository) BETWEEN 1 AND 1024), source_branch TEXT NOT NULL CHECK(source_branch = 'main'), template_app_id TEXT, template_seed_revision TEXT, CHECK((template_app_id IS NULL) = (template_seed_revision IS NULL))) STRICT;
CREATE INDEX app_release_team_publishers_team_idx ON app_release_team_publishers(team_id, app_id);
CREATE TABLE app_release_release_verification_metadata (release_id TEXT PRIMARY KEY REFERENCES app_release_release_verifications(release_id), artifact_digest TEXT NOT NULL, description_json TEXT NOT NULL CHECK(json_valid(description_json))) STRICT;
CREATE TABLE publisher_template_seed_receipts (template_repository TEXT NOT NULL, seed_revision TEXT NOT NULL, platform_app_id TEXT NOT NULL, source_revision TEXT NOT NULL, source_tree_digest TEXT NOT NULL, recipe_json TEXT CHECK(recipe_json IS NULL OR json_valid(recipe_json)), build_recipe_digest TEXT CHECK(build_recipe_digest IS NULL OR (length(build_recipe_digest) = 71 AND substr(build_recipe_digest, 1, 7) = 'sha256:' AND substr(build_recipe_digest, 8) NOT GLOB '*[^0-9a-f]*')), CHECK((recipe_json IS NULL) = (build_recipe_digest IS NULL)), PRIMARY KEY (template_repository, seed_revision)) STRICT;
CREATE TABLE publisher_artifacts_repositories (repository_name TEXT PRIMARY KEY CHECK(length(repository_name) BETWEEN 1 AND 128), provider_id TEXT NOT NULL CHECK(length(provider_id) > 0), default_branch TEXT NOT NULL CHECK(default_branch = 'main'), remote TEXT NOT NULL CHECK(length(remote) > 0), parent_repository TEXT REFERENCES publisher_artifacts_repositories(repository_name), CHECK(parent_repository IS NULL OR parent_repository <> repository_name)) STRICT;
CREATE TABLE app_release_boot_results (release_id TEXT NOT NULL REFERENCES app_release_releases(release_id), check_version TEXT NOT NULL CHECK(length(check_version) BETWEEN 1 AND 64), outcome_json TEXT NOT NULL CHECK(json_valid(outcome_json) AND length(outcome_json) <= 65536), checked_at INTEGER NOT NULL, PRIMARY KEY (release_id, check_version)) STRICT;
CREATE TRIGGER app_release_boot_results_write_once BEFORE UPDATE ON app_release_boot_results BEGIN SELECT RAISE(ABORT, 'App Release boot results are write-once'); END;
CREATE TABLE app_release_boot_capabilities (token_digest TEXT PRIMARY KEY CHECK(length(token_digest) = 64 AND token_digest NOT GLOB '*[^0-9a-f]*'), lease_id TEXT NOT NULL UNIQUE CHECK(length(lease_id) BETWEEN 1 AND 128), release_id TEXT NOT NULL REFERENCES app_release_releases(release_id), lease_json TEXT NOT NULL CHECK(json_valid(lease_json) AND length(lease_json) <= 262144), expires_at INTEGER NOT NULL) STRICT;
CREATE INDEX app_release_boot_capabilities_expiry_idx ON app_release_boot_capabilities(expires_at);
CREATE TRIGGER app_release_boot_capabilities_write_once BEFORE UPDATE ON app_release_boot_capabilities BEGIN SELECT RAISE(ABORT, 'Boot capability leases are write-once'); END;
${publicRouteSchemaSql}
${platformOwnerReplaySchemaSql}
${buyerReferenceSchemaSql}
${safetyTakedownSchemaSql}
${artifactDispositionSchemaSql}
CREATE TRIGGER app_release_apps_write_once BEFORE UPDATE ON app_release_apps BEGIN SELECT RAISE(ABORT, 'App Release apps are write-once'); END;
CREATE TRIGGER app_release_releases_write_once BEFORE UPDATE ON app_release_releases BEGIN SELECT RAISE(ABORT, 'App Release releases are write-once'); END;
CREATE TRIGGER app_release_verifications_write_once BEFORE UPDATE ON app_release_release_verifications BEGIN SELECT RAISE(ABORT, 'App Release verifications are write-once'); END;
CREATE TRIGGER app_release_verification_formats_write_once BEFORE UPDATE ON app_release_release_verification_formats BEGIN SELECT RAISE(ABORT, 'App Release verification formats are write-once'); END;
CREATE TRIGGER app_release_public_surfaces_write_once BEFORE UPDATE ON app_release_public_surfaces BEGIN SELECT RAISE(ABORT, 'App Release public Surfaces are write-once'); END;
CREATE TRIGGER app_release_transitions_write_once BEFORE UPDATE ON app_release_transitions BEGIN SELECT RAISE(ABORT, 'App Release transitions are write-once'); END;
CREATE TRIGGER app_release_transition_obligation_enumeration_after_insert AFTER INSERT ON app_release_transition_obligations BEGIN INSERT OR IGNORE INTO app_release_transition_obligation_enumeration(sequence) VALUES (NEW.sequence); END;
CREATE TRIGGER app_release_transition_obligation_after_insert AFTER INSERT ON app_release_transitions WHEN NEW.operation_kind = 'revocation' BEGIN INSERT INTO app_release_transition_obligations (sequence, transition_id, operation_kind, idempotency_key, release_id, public_surface_id, state) VALUES (NEW.sequence, NEW.transition_id, NEW.operation_kind, NEW.idempotency_key, NEW.release_id, NEW.public_surface_id, 'pending'); END;
CREATE TRIGGER app_release_team_publishers_write_once BEFORE UPDATE ON app_release_team_publishers BEGIN SELECT RAISE(ABORT, 'App publisher registrations are write-once'); END;
CREATE TRIGGER app_release_verification_metadata_write_once BEFORE UPDATE ON app_release_release_verification_metadata BEGIN SELECT RAISE(ABORT, 'App Release verification metadata is write-once'); END;
CREATE TRIGGER app_release_team_publishers_template_seed_pair BEFORE INSERT ON app_release_team_publishers WHEN (NEW.template_app_id IS NULL) != (NEW.template_seed_revision IS NULL) BEGIN SELECT RAISE(ABORT, 'App publisher template seed pointer is incomplete'); END;
CREATE TRIGGER app_release_team_publishers_artifacts_seed_required BEFORE INSERT ON app_release_team_publishers WHEN NEW.source_provider = 'artifacts' AND NEW.template_app_id IS NULL BEGIN SELECT RAISE(ABORT, 'Artifacts App publisher requires verified template seed provenance'); END;
CREATE TRIGGER app_release_team_publishers_artifacts_seed_verified BEFORE INSERT ON app_release_team_publishers WHEN NEW.source_provider = 'artifacts' AND NOT EXISTS (SELECT 1 FROM publisher_template_seed_receipts WHERE platform_app_id = NEW.template_app_id AND seed_revision = NEW.template_seed_revision AND recipe_json IS NOT NULL AND build_recipe_digest IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Artifacts App publisher template seed is not verified'); END;
CREATE TRIGGER publisher_template_seed_receipts_write_once BEFORE UPDATE ON publisher_template_seed_receipts BEGIN SELECT RAISE(ABORT, 'Publisher template seed receipts are write-once'); END;
CREATE TRIGGER publisher_template_seed_receipts_append_only BEFORE DELETE ON publisher_template_seed_receipts BEGIN SELECT RAISE(ABORT, 'Publisher template seed receipts are append-only'); END;
CREATE TRIGGER publisher_template_seed_recipe_required BEFORE INSERT ON publisher_template_seed_receipts WHEN NEW.recipe_json IS NULL OR json_valid(NEW.recipe_json) = 0 OR NEW.build_recipe_digest IS NULL BEGIN SELECT RAISE(ABORT, 'Publisher template seed recipe proof is incomplete'); END;
CREATE TRIGGER publisher_artifacts_repositories_write_once BEFORE UPDATE ON publisher_artifacts_repositories BEGIN SELECT RAISE(ABORT, 'Publisher Artifacts repository metadata is write-once'); END;
CREATE TABLE publisher_artifacts_repositories_pending (repository_name TEXT PRIMARY KEY CHECK(length(repository_name) BETWEEN 1 AND 128), provider_id TEXT NOT NULL CHECK(length(provider_id) > 0), default_branch TEXT NOT NULL CHECK(default_branch = 'main'), remote TEXT NOT NULL CHECK(length(remote) > 0), parent_repository TEXT REFERENCES publisher_artifacts_repositories(repository_name), initial_token TEXT NOT NULL CHECK(length(initial_token) > 0), CHECK(parent_repository IS NULL OR parent_repository <> repository_name)) STRICT;
CREATE TRIGGER publisher_artifacts_repositories_pending_write_once BEFORE UPDATE ON publisher_artifacts_repositories_pending BEGIN SELECT RAISE(ABORT, 'Publisher Artifacts recovery state is write-once'); END;
CREATE TABLE publisher_tracker_grants (team_id TEXT PRIMARY KEY, repository TEXT NOT NULL UNIQUE, provider TEXT NOT NULL, generation TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), owner_user_id TEXT, consented_at INTEGER, state TEXT NOT NULL CHECK(state IN ('authorizing','active','revoking','revoked','erasing','erased')), credential_json TEXT CHECK(credential_json IS NULL OR json_valid(credential_json)), pending_id TEXT, pending_credential_json TEXT CHECK(pending_credential_json IS NULL OR json_valid(pending_credential_json)), CHECK(pending_id IS NOT NULL OR pending_credential_json IS NULL)) STRICT;
CREATE TABLE publisher_tracker_capabilities (token_hash TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES publisher_tracker_grants(team_id), user_id TEXT NOT NULL, client_id TEXT NOT NULL, login_id TEXT NOT NULL, generation TEXT NOT NULL, permission TEXT NOT NULL CHECK(permission IN ('read','write')), expires_at INTEGER NOT NULL) STRICT;
CREATE INDEX publisher_tracker_capabilities_expiry ON publisher_tracker_capabilities(expires_at);
CREATE INDEX publisher_tracker_capabilities_team ON publisher_tracker_capabilities(team_id);
CREATE TABLE app_release_erasure_scope (singleton INTEGER PRIMARY KEY CHECK(singleton=1), app_id TEXT NOT NULL) STRICT;
CREATE TABLE app_release_erasure_jobs (app_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, object_keys_json TEXT NOT NULL CHECK(json_valid(object_keys_json)), repository_name TEXT) STRICT;
CREATE TRIGGER app_release_apps_append_only BEFORE DELETE ON app_release_apps WHEN NOT EXISTS (SELECT 1 FROM app_release_erasure_scope WHERE app_id=OLD.app_id) BEGIN SELECT RAISE(ABORT, 'App Release apps are append-only'); END;
CREATE TRIGGER app_release_releases_append_only BEFORE DELETE ON app_release_releases WHEN NOT EXISTS (SELECT 1 FROM app_release_erasure_scope WHERE app_id=OLD.app_id) BEGIN SELECT RAISE(ABORT, 'App Release releases are append-only'); END;
CREATE TRIGGER app_release_verifications_append_only BEFORE DELETE ON app_release_release_verifications WHEN NOT EXISTS (SELECT 1 FROM app_release_erasure_scope WHERE app_id=(SELECT app_id FROM app_release_releases WHERE release_id=OLD.release_id)) BEGIN SELECT RAISE(ABORT, 'App Release verifications are append-only'); END;
CREATE TRIGGER app_release_verification_formats_append_only BEFORE DELETE ON app_release_release_verification_formats WHEN NOT EXISTS (SELECT 1 FROM app_release_erasure_scope WHERE app_id=(SELECT app_id FROM app_release_releases WHERE release_id=OLD.release_id)) BEGIN SELECT RAISE(ABORT, 'App Release verification formats are append-only'); END;
CREATE TRIGGER app_release_public_surfaces_append_only BEFORE DELETE ON app_release_public_surfaces WHEN NOT EXISTS (SELECT 1 FROM app_release_erasure_scope WHERE app_id=OLD.app_id) BEGIN SELECT RAISE(ABORT, 'App Release public Surfaces are append-only'); END;
CREATE TRIGGER app_release_transitions_append_only BEFORE DELETE ON app_release_transitions WHEN NOT EXISTS (SELECT 1 FROM app_release_erasure_scope WHERE app_id=(SELECT app_id FROM app_release_releases WHERE release_id=OLD.release_id)) BEGIN SELECT RAISE(ABORT, 'App Release transitions are append-only'); END;
CREATE TRIGGER app_release_team_publishers_append_only BEFORE DELETE ON app_release_team_publishers WHEN NOT EXISTS (SELECT 1 FROM app_release_erasure_scope WHERE app_id=OLD.app_id) BEGIN SELECT RAISE(ABORT, 'App publisher registrations are append-only'); END;
CREATE TRIGGER app_release_verification_metadata_append_only BEFORE DELETE ON app_release_release_verification_metadata WHEN NOT EXISTS (SELECT 1 FROM app_release_erasure_scope WHERE app_id=(SELECT app_id FROM app_release_releases WHERE release_id=OLD.release_id)) BEGIN SELECT RAISE(ABORT, 'App Release verification metadata is append-only'); END;
CREATE TRIGGER publisher_artifacts_repositories_append_only BEFORE DELETE ON publisher_artifacts_repositories WHEN NOT EXISTS (SELECT 1 FROM app_release_erasure_scope WHERE app_id=(SELECT app_id FROM app_release_team_publishers WHERE source_provider='artifacts' AND source_repository=OLD.repository_name)) AND NOT EXISTS (SELECT 1 FROM publisher_tracker_grants WHERE repository=OLD.repository_name AND state='erasing') BEGIN SELECT RAISE(ABORT, 'Publisher Artifacts repository metadata is append-only'); END;
CREATE TABLE app_release_closed_sellers (team_id TEXT PRIMARY KEY CHECK(length(team_id) BETWEEN 1 AND 256), request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 256), closed_at INTEGER NOT NULL CHECK(closed_at >= 0 AND closed_at <= 9007199254740991)) STRICT;
CREATE TRIGGER app_release_closed_sellers_no_update BEFORE UPDATE ON app_release_closed_sellers BEGIN SELECT RAISE(ABORT, 'Seller closure is irreversible'); END;
CREATE TRIGGER app_release_closed_sellers_no_delete BEFORE DELETE ON app_release_closed_sellers BEGIN SELECT RAISE(ABORT, 'Seller closure is irreversible'); END;
`;

const teamAppPublisherRowSchema = Schema.Struct({
  app_id: appIdSchema,
  team_id: Schema.String,
  source_provider: Schema.Literals(["artifacts", "github"]),
  source_repository: Schema.String,
  source_branch: Schema.Literal("main"),
  template_app_id: Schema.NullOr(appIdSchema),
  template_seed_revision: Schema.NullOr(sourceRevisionSchema),
});

function registrationFromRow(
  value: Schema.Schema.Type<typeof teamAppPublisherRowSchema>,
): TeamAppPublisherRegistration {
  const registration = {
    appId: value.app_id,
    teamId: value.team_id,
    source: {
      provider: value.source_provider,
      repository: value.source_repository,
      branch: value.source_branch,
    },
  };
  return Schema.decodeUnknownSync(teamAppPublisherRegistrationSchema)(
    value.template_app_id !== null && value.template_seed_revision !== null
      ? {
          ...registration,
          templateSeed: {
            appId: value.template_app_id,
            revision: value.template_seed_revision,
          },
        }
      : registration,
  );
}

/** Create the native registry that joins a Team publisher to one App/source. */
export function createD1TeamAppPublisherRegistry(
  database: AppReleaseD1Database,
): TeamAppPublisherRegistry {
  const read = async (appId: AppId) => {
    const row = await database
      .prepare(
        `SELECT app_id, team_id, source_provider, source_repository, source_branch,
                template_app_id, template_seed_revision
         FROM app_release_team_publishers WHERE app_id = ?`,
      )
      .bind(appId)
      .first();
    return row === null
      ? ({ kind: "absent" } as const)
      : ({
          kind: "found",
          registration: registrationFromRow(
            Schema.decodeUnknownSync(teamAppPublisherRowSchema)(row),
          ),
        } as const);
  };
  return {
    read,
    register: async (input) => {
      const registration = Schema.decodeUnknownSync(
        teamAppPublisherRegistrationSchema,
      )(input);
      const [appResult, publisherResult] = await database.batch([
        database
          .prepare(
            "INSERT INTO app_release_apps (app_id) VALUES (?) ON CONFLICT (app_id) DO NOTHING",
          )
          .bind(registration.appId),
        database
          .prepare(
            `INSERT INTO app_release_team_publishers
               (app_id, team_id, source_provider, source_repository, source_branch,
                template_app_id, template_seed_revision)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (app_id) DO NOTHING
             RETURNING app_id`,
          )
          .bind(
            registration.appId,
            registration.teamId,
            registration.source.provider,
            registration.source.repository,
            registration.source.branch,
            registration.templateSeed?.appId ?? null,
            registration.templateSeed?.revision ?? null,
          ),
      ]);
      if (appResult === undefined || publisherResult === undefined)
        throw new Error("App publisher registration was not retained");
      const current = await read(registration.appId);
      if (current.kind === "absent")
        throw new Error("App publisher registration was not retained");
      const matches =
        current.registration.teamId === registration.teamId &&
        current.registration.source.provider === registration.source.provider &&
        current.registration.source.repository ===
          registration.source.repository &&
        current.registration.templateSeed?.appId ===
          registration.templateSeed?.appId &&
        current.registration.templateSeed?.revision ===
          registration.templateSeed?.revision;
      if (!matches) return { kind: "conflict" } as const;
      return {
        kind: publisherResult.results.length === 0 ? "existing" : "created",
        registration: current.registration,
      } as const;
    },
    authorize: async (appId, teamId) => {
      const current = await read(appId);
      if (current.kind === "absent") return current;
      return current.registration.teamId === teamId
        ? ({ kind: "authorized", registration: current.registration } as const)
        : ({ kind: "denied" } as const);
    },
  };
}

/** One boot result's identity: the Release and the version of the check that judged it. */
export type ReleaseBootResultKey = Readonly<{
  releaseId: string;
  checkVersion: string;
}>;

/** A recorded boot result, opaque JSON owned by the boot gate that wrote it. */
export type ReleaseBootResultRecord = Readonly<{
  kind: "recorded";
  result: Schema.Json;
  checkedAt: number;
}>;

/**
 * One boot result per Release and check version, beside the Release in the
 * global catalog. Whoever checks first (the publisher at submission or a
 * Team's first install) records it; everyone reads it; nobody rechecks.
 * The catalog owns identity and write-once storage; the boot gate owns the
 * result's meaning and parses it on read.
 *
 * Writers are host-run checkers only, recording only definitive outcomes
 * (never an inconclusive or "not checked" run) with sanitized diagnostics;
 * the result covers the UI page check alone, not backend construction.
 */
export type ReleaseBootResults = Readonly<{
  /** The recorded result for this Release and check version, if any. */
  read: (
    key: ReleaseBootResultKey,
  ) => Promise<Readonly<{ kind: "absent" }> | ReleaseBootResultRecord>;
  /** Record a result unless one exists; always answers with the stored one. */
  recordIfAbsent: (
    input: ReleaseBootResultKey &
      Readonly<{ result: Schema.Json; checkedAt: number }>,
  ) => Promise<ReleaseBootResultRecord>;
}>;

const bootResultRowSchema = Schema.Struct({
  outcome_json: Schema.fromJsonString(Schema.Json),
  checked_at: Schema.Number,
});

/** The catalog's write-once boot results, over the same App Release D1. */
export function createD1ReleaseBootResults(
  database: AppReleaseD1Database,
): ReleaseBootResults {
  const read: ReleaseBootResults["read"] = async (key) => {
    const row = await database
      .prepare(
        `SELECT outcome_json, checked_at FROM app_release_boot_results
         WHERE release_id = ? AND check_version = ?`,
      )
      .bind(parseReleaseId(key.releaseId), key.checkVersion)
      .first();
    if (row === null) return { kind: "absent" };
    const decoded = Schema.decodeUnknownSync(bootResultRowSchema)(row);
    return {
      kind: "recorded",
      result: decoded.outcome_json,
      checkedAt: decoded.checked_at,
    };
  };
  return {
    read,
    recordIfAbsent: async (input) => {
      await database
        .prepare(
          `INSERT INTO app_release_boot_results
             (release_id, check_version, outcome_json, checked_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (release_id, check_version) DO NOTHING`,
        )
        .bind(
          parseReleaseId(input.releaseId),
          input.checkVersion,
          JSON.stringify(input.result),
          input.checkedAt,
        )
        .run();
      const stored = await read(input);
      if (stored.kind === "absent")
        throw new Error("The boot result was not recorded");
      return stored;
    },
  };
}

/** The longest a boot capability lease may live: one boot check plus cleanup. */
export const BOOT_CAPABILITY_MAX_LIFETIME_MS = 60_000;

const tokenDigestSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
);
const bootCapabilityRowSchema = Schema.Struct({ lease_json: Schema.String });

/**
 * The catalog storage behind a host's boot `BootCapabilityStore`: one
 * short-lived row per issued lease, keyed by the token's digest (never the
 * token). The lease itself is opaque JSON owned by the boot capability
 * contract, which parses it on resolve. Expired rows are deleted on resolve
 * and purged on every issue; revoke deletes.
 */
export type BootCapabilityRows = Readonly<{
  /** Store one lease; refuses a raw token or a lifetime beyond the maximum. */
  issue: (
    input: Readonly<{
      tokenDigest: string;
      leaseId: string;
      releaseId: string;
      leaseJson: string;
      expiresAt: number;
      now: number;
    }>,
  ) => Promise<void>;
  /** The live lease's JSON for this digest, or `null` when absent or expired. */
  resolve: (tokenDigest: string, now: number) => Promise<string | null>;
  /** Delete one lease once its check is done. */
  revoke: (leaseId: string) => Promise<void>;
}>;

/** The catalog's short-lived boot capability rows, over the same App Release D1. */
export function createD1BootCapabilityRows(
  database: AppReleaseD1Database,
): BootCapabilityRows {
  return {
    issue: async (input) => {
      const tokenDigest = Schema.decodeUnknownSync(tokenDigestSchema)(
        input.tokenDigest,
      );
      if (
        input.expiresAt <= input.now ||
        input.expiresAt - input.now > BOOT_CAPABILITY_MAX_LIFETIME_MS
      )
        throw new RangeError("Boot capability lifetime is out of bounds");
      await database.batch([
        database
          .prepare(
            "DELETE FROM app_release_boot_capabilities WHERE expires_at <= ?",
          )
          .bind(input.now),
        database
          .prepare(
            `INSERT INTO app_release_boot_capabilities
               (token_digest, lease_id, release_id, lease_json, expires_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(
            tokenDigest,
            input.leaseId,
            parseReleaseId(input.releaseId),
            input.leaseJson,
            input.expiresAt,
          ),
      ]);
    },
    resolve: async (tokenDigest, now) => {
      const digest = Schema.decodeUnknownSync(tokenDigestSchema)(tokenDigest);
      await database
        .prepare(
          "DELETE FROM app_release_boot_capabilities WHERE token_digest = ? AND expires_at <= ?",
        )
        .bind(digest, now)
        .run();
      const row = await database
        .prepare(
          "SELECT lease_json FROM app_release_boot_capabilities WHERE token_digest = ? AND expires_at > ?",
        )
        .bind(digest, now)
        .first();
      return row === null
        ? null
        : Schema.decodeUnknownSync(bootCapabilityRowSchema)(row).lease_json;
    },
    revoke: async (leaseId) => {
      await database
        .prepare("DELETE FROM app_release_boot_capabilities WHERE lease_id = ?")
        .bind(leaseId)
        .run();
    },
  };
}

/** Create the D1-backed App Release store with private public-website authority. */
export function createD1AppReleaseStore(
  database: AppReleaseD1Database,
): PromiseAppReleaseStore & {
  readonly transitionObligations: AppReleaseTransitionObligationStore;
} {
  const transitionObligations: AppReleaseTransitionObligationStore = {
    readByTransitionId: (transitionId) =>
      storeOperation(async () => {
        const decodedTransitionId = Schema.decodeUnknownResult(
          appTransitionIdSchema,
        )(transitionId);
        if (decodedTransitionId._tag === "Failure")
          throw new Error("Invalid transition obligation identity");
        const row = await readTransitionObligationByTransitionId(
          database,
          decodedTransitionId.success,
        );
        if (row === null) return { kind: "absent" } as const;
        return transitionObligationFromRow(database, row);
      }),
    read: (options) =>
      storeOperation(async () => {
        const decodedOptions = decodeTransitionObligationReadOptions(options);
        if (decodedOptions._tag === "Failure")
          throw new Error("Invalid transition obligation read options");
        const afterSequence = decodedOptions.success.afterSequence ?? 0;
        const limit = decodedOptions.success.limit ?? 16;
        const result = await database
          .prepare(
            `SELECT sequence, transition_id, operation_kind, idempotency_key,
                  release_id, public_surface_id, state
             FROM app_release_transition_obligations
             WHERE sequence > ? AND state = 'pending'
             ORDER BY sequence LIMIT ?`,
          )
          .bind(afterSequence, limit)
          .all();
        return Promise.all(
          result.results.map((row) =>
            transitionObligationFromRow(
              database,
              Schema.decodeUnknownSync(transitionObligationRowSchema)(row),
            ),
          ),
        );
      }),
    recordTeamRecipientPage: (sequence, page) =>
      storeOperation(async () => {
        const decodedPage = decodeTeamRecipientPage(page);
        if (decodedPage._tag === "Failure")
          throw new Error("Invalid Team recipient page");
        const value = decodedPage.success;
        const cursor = value.cursor ?? null;
        const nextCursor = value.nextCursor ?? null;
        if (!value.complete && nextCursor === null)
          throw new Error("Incomplete Team recipient page needs a next cursor");

        const obligation = await readTransitionObligationRow(
          database,
          sequence,
        );
        if (obligation === null) return { kind: "absent" } as const;
        if (obligation.state !== "pending")
          throw new Error("Acknowledged transition obligation is immutable");
        const enumeration = await readTransitionObligationEnumerationRow(
          database,
          sequence,
        );
        if (enumeration === null)
          throw new Error("Transition obligation enumeration was absent");

        const pageKey = recipientPageKey(cursor);
        const existingPage = await readTransitionObligationPage(
          database,
          sequence,
          cursor === null ? 1 : 0,
          pageKey,
        );
        if (existingPage !== null) {
          const existingTeamIds = Schema.decodeUnknownSync(teamIdsJsonSchema)(
            existingPage.team_ids_json,
          );
          if (
            existingPage.next_cursor !== nextCursor ||
            existingPage.complete !== (value.complete ? 1 : 0) ||
            !sameStringArray(existingTeamIds, value.teamIds)
          )
            throw new Error("Conflicting Team recipient page replay");
          return await transitionObligationFromRow(database, obligation);
        }

        const cursorIsInitial = cursor === null ? 1 : 0;
        if (
          (enumeration.started === 0 && cursor !== null) ||
          (enumeration.started === 1 &&
            (enumeration.complete !== 0 || enumeration.cursor !== cursor))
        )
          throw new Error("Team recipient page cursor is out of order");

        const serializedTeamIds = JSON.stringify(value.teamIds);
        const statements: AppReleaseD1PreparedStatement[] = [
          database
            .prepare(
              `INSERT INTO app_release_transition_obligation_pages
               (sequence, cursor, cursor_is_initial, cursor_key, next_cursor, complete, team_ids_json)
               SELECT ?, ?, ?, ?, ?, ?, ?
               WHERE EXISTS (
                 SELECT 1 FROM app_release_transition_obligations
                 WHERE sequence = ? AND state = 'pending'
               )`,
            )
            .bind(
              sequence,
              cursor,
              cursorIsInitial,
              pageKey,
              nextCursor,
              value.complete ? 1 : 0,
              serializedTeamIds,
              sequence,
            ),
        ];
        statements.push(
          database
            .prepare(
              `INSERT OR IGNORE INTO app_release_transition_obligation_teams
               (sequence, team_id, state)
               SELECT sequence, json_each.value, 'pending'
               FROM app_release_transition_obligation_pages, json_each(team_ids_json)
               WHERE app_release_transition_obligation_pages.sequence = ?
                 AND cursor_is_initial = ? AND cursor_key = ?`,
            )
            .bind(sequence, cursorIsInitial, pageKey),
        );
        statements.push(
          database
            .prepare(
              `UPDATE app_release_transition_obligation_enumeration
               SET cursor = ?, started = 1, complete = ?
               WHERE sequence = ? AND started = ? AND complete = ?
                 AND cursor IS ?
                 AND EXISTS (
                   SELECT 1 FROM app_release_transition_obligation_pages
                   WHERE sequence = ? AND cursor_is_initial = ? AND cursor_key = ?
                 )`,
            )
            .bind(
              nextCursor,
              value.complete ? 1 : 0,
              sequence,
              enumeration.started,
              enumeration.complete,
              enumeration.cursor,
              sequence,
              cursorIsInitial,
              pageKey,
            ),
        );
        await database.batch(statements);
        const retained = await readTransitionObligationRow(database, sequence);
        if (retained === null)
          throw new Error("Transition obligation disappeared");
        const retainedEnumeration =
          await readTransitionObligationEnumerationRow(database, sequence);
        if (
          retainedEnumeration?.started !== 1 ||
          retainedEnumeration.cursor !== nextCursor ||
          retainedEnumeration.complete !== (value.complete ? 1 : 0)
        )
          throw new Error("Team recipient page was not retained");
        return await transitionObligationFromRow(database, retained);
      }),
    readPendingTeamRecipients: (options) =>
      storeOperation(async () => {
        const decodedOptions = decodePendingTeamRecipientsReadOptions(options);
        if (decodedOptions._tag === "Failure")
          throw new Error("Invalid pending Team recipient read options");
        const { sequence, limit = 16 } = decodedOptions.success;
        const result = await database
          .prepare(
            `SELECT team_id, state
             FROM app_release_transition_obligation_teams
             WHERE sequence = ? AND state = 'pending'
             ORDER BY team_id LIMIT ?`,
          )
          .bind(sequence, limit)
          .all();
        return result.results.map((row) =>
          teamRecipientFromRow(
            Schema.decodeUnknownSync(transitionObligationRecipientRowSchema)(
              row,
            ),
          ),
        );
      }),
    recordTeamRecipientOutcome: (sequence, teamId, outcome) =>
      storeOperation(async () => {
        const decodedTeamId = Schema.decodeUnknownResult(teamRecipientIdSchema)(
          teamId,
        );
        const decodedOutcome = Schema.decodeUnknownResult(
          teamRecipientOutcomeSchema,
        )(outcome);
        if (
          decodedTeamId._tag === "Failure" ||
          decodedOutcome._tag === "Failure"
        )
          throw new Error("Invalid Team recipient outcome");
        const parsedTeamId = decodedTeamId.success;
        const parsedOutcome = decodedOutcome.success;
        const updated = await database
          .prepare(
            `UPDATE app_release_transition_obligation_teams
             SET state = ?
             WHERE sequence = ? AND team_id = ? AND state = 'pending'
             RETURNING team_id, state`,
          )
          .bind(parsedOutcome, sequence, parsedTeamId)
          .first();
        if (updated !== null) {
          return teamRecipientFromRow(
            Schema.decodeUnknownSync(transitionObligationRecipientRowSchema)(
              updated,
            ),
          );
        }
        const current = await database
          .prepare(
            `SELECT team_id, state
             FROM app_release_transition_obligation_teams
             WHERE sequence = ? AND team_id = ?`,
          )
          .bind(sequence, parsedTeamId)
          .first();
        if (current === null) return { kind: "absent" } as const;
        const recipient = teamRecipientFromRow(
          Schema.decodeUnknownSync(transitionObligationRecipientRowSchema)(
            current,
          ),
        );
        if (recipient.state !== parsedOutcome)
          throw new Error("Conflicting Team recipient outcome replay");
        return recipient;
      }),
    acknowledge: (sequence) =>
      storeOperation(async () => {
        const acknowledged = await database
          .prepare(
            `UPDATE app_release_transition_obligations
             SET state = 'acknowledged'
             WHERE sequence = ? AND state = 'pending'
               AND EXISTS (
                 SELECT 1
                 FROM app_release_transition_obligation_enumeration
                 WHERE sequence = ? AND complete = 1
               )
               AND NOT EXISTS (
                 SELECT 1
                 FROM app_release_transition_obligation_teams
                 WHERE sequence = ? AND state = 'pending'
               )
             RETURNING sequence, transition_id, operation_kind, idempotency_key,
                       release_id, public_surface_id, state`,
          )
          .bind(sequence, sequence, sequence)
          .first();
        if (acknowledged !== null) {
          return await transitionObligationFromRow(
            database,
            Schema.decodeUnknownSync(transitionObligationRowSchema)(
              acknowledged,
            ),
          );
        }
        const current = await readTransitionObligationRow(database, sequence);
        if (current === null) return { kind: "absent" } as const;
        return await transitionObligationFromRow(database, current);
      }),
  };
  const store: PromiseAppReleaseStore = {
    readApp: (appId) =>
      storeOperation(async () => {
        const app = await readApp(database, appId);
        return app === null ? { kind: "absent" } : { kind: "found", app };
      }),
    createAppIfAbsent: (app) =>
      storeOperation(async () => {
        const inserted = await database
          .prepare(
            "INSERT INTO app_release_apps (app_id) VALUES (?) ON CONFLICT (app_id) DO NOTHING RETURNING app_id",
          )
          .bind(app.appId)
          .first();
        const canonical =
          inserted === null
            ? await readApp(database, app.appId)
            : appFromRow(Schema.decodeUnknownSync(appRowSchema)(inserted));
        if (canonical === null) throw new Error("App insert was not retained");
        return {
          kind: inserted === null ? "existing" : "created",
          app: canonical,
        } satisfies AppCreate;
      }),
    readRelease: (releaseId) =>
      storeOperation(async () => {
        const release = await readRelease(database, releaseId);
        return release === null
          ? { kind: "absent" }
          : { kind: "found", release };
      }),
    createReleaseIfAbsent: (release) =>
      storeOperation(async () => {
        const inserted = await database
          .prepare(
            `INSERT INTO app_release_releases (
              release_id,
              app_id,
              artifact_ref,
              artifact_digest,
              source_revision,
              source_tree_digest,
              build_recipe_digest
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (release_id) DO NOTHING
            RETURNING release_id, app_id, artifact_ref, artifact_digest,
              source_revision, source_tree_digest, build_recipe_digest`,
          )
          .bind(
            release.releaseId,
            release.appId,
            release.artifact.artifactRef,
            release.artifact.artifactDigest,
            release.artifact.provenance.sourceRevision,
            release.artifact.provenance.sourceTreeDigest,
            release.artifact.provenance.buildRecipeDigest,
          )
          .first();
        const canonical =
          inserted === null
            ? await readRelease(database, release.releaseId)
            : releaseFromRow(
                Schema.decodeUnknownSync(releaseRowSchema)(inserted),
              );
        if (canonical === null)
          throw new Error("Release insert was not retained");
        return {
          kind: inserted === null ? "existing" : "created",
          release: canonical,
        } satisfies ReleaseCreate;
      }),
    readPublicSurface: (publicSurfaceId) =>
      storeOperation(async () => {
        const surface = await readPublicSurface(database, publicSurfaceId);
        return surface === null
          ? { kind: "absent" }
          : { kind: "found", surface };
      }),
    createPublicSurfaceIfAbsent: (surface) =>
      storeOperation(async () => {
        const inserted = await database
          .prepare(insertPublicSurfaceSql)
          .bind(
            surface.publicSurfaceId,
            surface.appId,
            surface.stableRoute,
            publicRouteKey(surface.stableRoute),
            surface.publisher.teamId,
            surface.publisher.userId,
            surface.publisher.kind,
            surface.publisher.requestKey,
          )
          .first();
        const row =
          inserted ??
          (await database
            .prepare(
              `SELECT * FROM app_release_public_surfaces
           WHERE publisher_team_id=? AND request_key=?`,
            )
            .bind(surface.publisher.teamId, surface.publisher.requestKey)
            .first());
        if (row === null)
          return { kind: "conflict" } satisfies PublicSurfaceCreate;
        const canonical = Schema.decodeUnknownSync(
          publicSurfaceDefinitionRowSchema,
        )(row);
        if (
          canonical.app_id !== surface.appId ||
          canonical.stable_route !== surface.stableRoute ||
          canonical.authority_kind !== surface.publisher.kind ||
          canonical.publisher_user_id !== surface.publisher.userId
        )
          return { kind: "conflict" } satisfies PublicSurfaceCreate;
        return {
          kind: inserted === null ? "existing" : "created",
          surface: publicSurfaceFromRow(canonical),
        } satisfies PublicSurfaceCreate;
      }),
    readReleaseLifecycle: (releaseId) =>
      storeOperation(async () => {
        const stored = await database
          .prepare(
            `SELECT release.release_id, release.app_id, release.artifact_ref,
                    release.artifact_digest, release.source_revision,
                    release.source_tree_digest, release.build_recipe_digest,
                    verification.artifact_digest AS verification_digest,
                    format.media_type AS verification_media_type,
                    metadata.artifact_digest AS verification_metadata_digest,
                    metadata.description_json AS verification_description_json,
                    CASE WHEN EXISTS (
                      SELECT 1 FROM app_release_transitions AS revocation
                      WHERE revocation.operation_kind = 'revocation'
                        AND revocation.release_id = release.release_id
                    ) THEN 1 ELSE 0 END AS release_is_revoked
             FROM app_release_releases AS release
             LEFT JOIN app_release_release_verifications AS verification
               ON verification.release_id = release.release_id
             LEFT JOIN app_release_release_verification_formats AS format
               ON format.release_id = release.release_id
             LEFT JOIN app_release_release_verification_metadata AS metadata
               ON metadata.release_id = release.release_id
             WHERE release.release_id = ?`,
          )
          .bind(releaseId)
          .first();
        if (stored === null)
          return { kind: "absent" } satisfies ReleaseLifecycle;
        const row = Schema.decodeUnknownSync(releaseLifecycleRowSchema)(stored);
        const release = releaseFromRow(row);
        const verification =
          row.verification_digest === null
            ? { kind: "unverified" as const }
            : releaseVerificationFromStored(
                row.verification_digest,
                row.verification_media_type,
                row.verification_metadata_digest,
                row.verification_description_json,
              );
        return {
          kind: "found",
          release,
          verification,
          revocation:
            row.release_is_revoked === 1
              ? { kind: "revoked" }
              : { kind: "active" },
        } satisfies ReleaseLifecycle;
      }),
    recordReleaseVerification: (input) =>
      storeOperation(async () => {
        const description = Schema.decodeUnknownSync(
          verifiedAppDescriptionSchema,
        )(input.description);
        const descriptionJson = JSON.stringify(description);
        await database.batch([
          database
            .prepare(
              `INSERT INTO app_release_release_verifications (release_id, artifact_digest)
               VALUES (?, ?)
               ON CONFLICT (release_id) DO NOTHING`,
            )
            .bind(input.releaseId, input.digest),
          database
            .prepare(
              `INSERT INTO app_release_release_verification_formats (release_id, media_type)
               VALUES (?, ?)
               ON CONFLICT (release_id) DO NOTHING`,
            )
            .bind(input.releaseId, input.mediaType),
          database
            .prepare(
              `INSERT INTO app_release_release_verification_metadata
                 (release_id, artifact_digest, description_json)
               VALUES (?, ?, ?)
               ON CONFLICT (release_id) DO NOTHING`,
            )
            .bind(input.releaseId, input.digest, descriptionJson),
        ]);
        const current = await database
          .prepare(
            `SELECT verification.artifact_digest AS verification_artifact_digest,
                    format.media_type,
                    metadata.artifact_digest AS metadata_artifact_digest,
                    metadata.description_json
             FROM app_release_release_verifications AS verification
             LEFT JOIN app_release_release_verification_formats AS format
               ON format.release_id = verification.release_id
             LEFT JOIN app_release_release_verification_metadata AS metadata
               ON metadata.release_id = verification.release_id
             WHERE verification.release_id = ?`,
          )
          .bind(input.releaseId)
          .first();
        if (current === null)
          throw new Error("Release verification was not retained");
        const decoded = Schema.decodeUnknownSync(
          releaseVerificationMetadataRowSchema,
        )(current);
        if (
          decoded.verification_artifact_digest !== input.digest ||
          decoded.metadata_artifact_digest !== input.digest ||
          decoded.media_type !== input.mediaType ||
          decoded.description_json !== descriptionJson
        ) {
          throw new Error(
            "Release verification conflicts with existing metadata",
          );
        }
        return { kind: "recorded" as const };
      }),
    readTransition: (request) =>
      storeOperation(async () => {
        const row = await readTransitionRow(database, request);
        if (row === null) return { kind: "absent" } satisfies TransitionLookup;
        const receipt = transitionReceiptFromRow(row);
        return sameReleaseTransitionMaterial(request, receipt.transition)
          ? { kind: "found", receipt }
          : { kind: "conflict" };
      }),
    persistTransition: (request, receipt) =>
      storeOperation(async () => {
        const insert =
          request.kind === "revocation"
            ? `INSERT INTO app_release_transitions
                (transition_id, operation_kind, idempotency_key, release_id, public_surface_id)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT DO NOTHING
               RETURNING transition_id, operation_kind, idempotency_key, release_id, public_surface_id`
            : `INSERT INTO app_release_transitions
                (transition_id, operation_kind, idempotency_key, release_id, public_surface_id)
               SELECT ?, ?, ?, ?, ?
               FROM app_release_selection_ready e
               WHERE e.public_surface_id=? AND e.release_id=?
                 AND (?='promotion' OR (e.already_held=1 AND EXISTS (
                   SELECT 1 FROM app_release_transitions prior
                   WHERE prior.public_surface_id=e.public_surface_id AND prior.release_id=e.release_id
                     AND prior.operation_kind IN ('promotion','rollback')
                 )))
                 AND NOT EXISTS (SELECT 1 FROM app_release_transitions t
                   WHERE (t.operation_kind=? AND t.idempotency_key=?) OR t.transition_id=?)
               ON CONFLICT DO NOTHING
               RETURNING transition_id, operation_kind, idempotency_key, release_id, public_surface_id`;
        const values = [
          receipt.transitionId,
          request.kind,
          request.idempotencyKey,
          request.releaseId,
          request.kind === "revocation" ? null : request.publicSurfaceId,
          ...(request.kind === "revocation"
            ? []
            : [
                request.publicSurfaceId,
                request.releaseId,
                request.kind,
                request.kind,
                request.idempotencyKey,
                receipt.transitionId,
              ]),
        ];
        const inserted = await database
          .prepare(insert)
          .bind(...values)
          .first();
        if (inserted !== null) {
          return {
            kind: "created",
            receipt: transitionReceiptFromRow(
              Schema.decodeUnknownSync(transitionRowSchema)(inserted),
            ),
          } satisfies TransitionPersistence;
        }

        const byKey = await readTransitionRow(database, request);
        if (byKey !== null) {
          const existing = transitionReceiptFromRow(byKey);
          return sameReleaseTransitionMaterial(request, existing.transition)
            ? { kind: "existing", receipt: existing }
            : { kind: "conflict" };
        }

        if (request.kind !== "revocation") {
          const revocation = await database
            .prepare(
              `SELECT transition_id, operation_kind, idempotency_key, release_id,
                      public_surface_id
               FROM app_release_transitions
               WHERE operation_kind = 'revocation' AND release_id = ?`,
            )
            .bind(request.releaseId)
            .first();
          if (revocation !== null) {
            transitionReceiptFromRow(
              Schema.decodeUnknownSync(transitionRowSchema)(revocation),
            );
            return { kind: "lifecycle-conflict" };
          }
        }

        const byIdentity = await database
          .prepare(
            "SELECT transition_id, operation_kind, idempotency_key, release_id, public_surface_id FROM app_release_transitions WHERE transition_id = ?",
          )
          .bind(receipt.transitionId)
          .first();
        if (byIdentity !== null) return { kind: "identity-collision" };
        return { kind: "lifecycle-conflict" } satisfies TransitionPersistence;
      }),
  };
  const result = { ...store, transitionObligations };
  registerPromisePublicWebsiteAuthorityReader(result, (requests) =>
    storeOperation(async () => {
      if (requests.length === 0) return [];
      const results = await database.batch(
        requests.map((request) =>
          publicWebsiteAuthorityStatement(
            database,
            request.stableRoute,
            request.expectedReleaseId,
          ),
        ),
      );
      if (results.length !== requests.length)
        throw new Error("Incomplete route authority batch");
      return results.map(publicWebsiteAuthorityResult);
    }),
  );
  return result;
}

/**
 * Create the R2-backed artifact reader for opaque artifact references.
 *
 * Asset manifests are verified cheaply for delivery: the root bytes are
 * digest-checked here, while the asset handler checks the requested object.
 * Publication callers pass `verification: "publication"` to retain the
 * complete manifest object sweep.
 */
export function createR2ArtifactReader(
  bucket: AppReleaseR2Bucket,
  policy: ArtifactSnapshotPolicy = DEFAULT_ARTIFACT_SNAPSHOT_POLICY,
  assets?: {
    readonly bucket: Pick<AssetR2Bucket, "head">;
    readonly policy: AssetBuildPolicy;
  },
): ArtifactReader {
  const snapshotPolicy = createArtifactSnapshotPolicy(
    policy.maxBytes,
    policy.maxManifestBytes,
  );
  return {
    read: (input) => readR2Artifact(bucket, input, snapshotPolicy, assets),
  };
}

async function readApp(
  database: AppReleaseD1Database,
  appId: AppId,
): Promise<App | null> {
  const row = await database
    .prepare("SELECT app_id FROM app_release_apps WHERE app_id = ?")
    .bind(appId)
    .first();
  return row === null
    ? null
    : appFromRow(Schema.decodeUnknownSync(appRowSchema)(row));
}

async function readRelease(
  database: AppReleaseD1Database,
  releaseId: ReleaseId,
): Promise<Release | null> {
  const row = await database
    .prepare(
      `SELECT release_id, app_id, artifact_ref, artifact_digest,
              source_revision, source_tree_digest, build_recipe_digest
       FROM app_release_releases WHERE release_id = ?`,
    )
    .bind(releaseId)
    .first();
  return row === null
    ? null
    : releaseFromRow(Schema.decodeUnknownSync(releaseRowSchema)(row));
}

async function readPublicSurface(
  database: AppReleaseD1Database,
  publicSurfaceId: PublicSurfaceId,
): Promise<PublicSurface | null> {
  const row = await database
    .prepare(
      `SELECT public_surface_id, app_id, stable_route
       FROM app_release_public_surfaces WHERE public_surface_id = ?`,
    )
    .bind(publicSurfaceId)
    .first();
  return row === null
    ? null
    : publicSurfaceFromRow(
        Schema.decodeUnknownSync(publicSurfaceRowSchema)(row),
      );
}

/**
 * Read the route, selection, and selected Release lifecycle in one D1 snapshot.
 * The route CTE deliberately caps its result at two rows: absence, one authority,
 * or the fail-closed ambiguous condition are the only A1.2 observations.
 */
async function readPublicWebsiteAuthority(
  database: AppReleaseD1Database,
  stableRoute: import("./internal/app-release-contract.js").StableRoute,
  expectedReleaseId?: ReleaseId,
): Promise<PublicWebsiteAuthority> {
  return publicWebsiteAuthorityResult(
    await publicWebsiteAuthorityStatement(
      database,
      stableRoute,
      expectedReleaseId,
    ).all(),
  );
}

function publicWebsiteAuthorityStatement(
  database: AppReleaseD1Database,
  stableRoute: import("./internal/app-release-contract.js").StableRoute,
  expectedReleaseId?: ReleaseId,
): AppReleaseD1PreparedStatement {
  return database
    .prepare(
      `WITH matching_surfaces AS MATERIALIZED (
         SELECT s.public_surface_id, s.app_id, s.stable_route
         FROM app_release_route_claims c
         JOIN app_release_public_surfaces s ON s.public_surface_id=c.public_surface_id
         WHERE c.route_key = ? AND c.stable_route = ? AND c.state='held'
           AND NOT EXISTS (SELECT 1 FROM app_release_surface_retirements x WHERE x.public_surface_id=s.public_surface_id)
         LIMIT 2
       ), selected_transitions AS (
         SELECT transition.public_surface_id, transition.release_id,
                transition.sequence
         FROM app_release_transitions AS transition
         INNER JOIN matching_surfaces AS surface
           ON surface.public_surface_id = transition.public_surface_id
         WHERE transition.operation_kind IN ('promotion', 'rollback')
           AND transition.sequence = (
             SELECT MAX(latest.sequence)
             FROM app_release_transitions AS latest
             WHERE latest.public_surface_id = transition.public_surface_id
               AND latest.operation_kind IN ('promotion', 'rollback')
               AND (? IS NULL OR latest.release_id = ?)
           )
       )
       SELECT
         app.app_id,
         surface.public_surface_id,
         surface.app_id AS surface_app_id,
         surface.stable_route,
         selection.release_id AS selected_release_id,
         (SELECT latest.release_id FROM app_release_transitions AS latest
          WHERE latest.public_surface_id = surface.public_surface_id
            AND latest.operation_kind IN ('promotion', 'rollback')
          ORDER BY latest.sequence DESC LIMIT 1) AS current_release_id,
         selection.sequence AS selected_transition_sequence,
         release.release_id,
         release.app_id AS release_app_id,
         release.artifact_ref,
         release.artifact_digest,
         release.source_revision,
         release.source_tree_digest,
         release.build_recipe_digest,
         verification.artifact_digest AS verification_digest,
         format.media_type AS verification_media_type,
         metadata.artifact_digest AS verification_metadata_digest,
         metadata.description_json AS verification_description_json,
         CASE WHEN EXISTS (
           SELECT 1
           FROM app_release_transitions AS revocation
           WHERE revocation.operation_kind = 'revocation'
             AND revocation.release_id = selection.release_id
         ) THEN 1 ELSE 0 END AS release_is_revoked
       FROM matching_surfaces AS surface
       INNER JOIN app_release_apps AS app
         ON app.app_id = surface.app_id
       LEFT JOIN selected_transitions AS selection
         ON selection.public_surface_id = surface.public_surface_id
       LEFT JOIN app_release_releases AS release
         ON release.release_id = selection.release_id
       LEFT JOIN app_release_release_verifications AS verification
         ON verification.release_id = release.release_id
       LEFT JOIN app_release_release_verification_formats AS format
         ON format.release_id = release.release_id
       LEFT JOIN app_release_release_verification_metadata AS metadata
         ON metadata.release_id = release.release_id`,
    )
    .bind(
      publicRouteKey(stableRoute),
      stableRoute,
      expectedReleaseId ?? null,
      expectedReleaseId ?? null,
    );
}

function publicWebsiteAuthorityResult(
  result: AppReleaseD1QueryResult,
): PublicWebsiteAuthority {
  const reportedSuccess: unknown = result.success;
  if (reportedSuccess !== true) {
    throw new Error("Public website authority query was unsuccessful");
  }
  const rows = result.results.map((row) =>
    Schema.decodeUnknownSync(publicWebsiteAuthorityRowSchema)(row),
  );
  if (rows.length > 1) return { kind: "ambiguous" };
  const row = rows[0];
  return row === undefined
    ? { kind: "absent" }
    : publicWebsiteAuthorityFromRow(row);
}

function publicWebsiteAuthorityFromRow(
  row: Schema.Schema.Type<typeof publicWebsiteAuthorityRowSchema>,
): PublicWebsiteAuthority {
  const surface = publicSurfaceFromRow({
    public_surface_id: row.public_surface_id,
    app_id: row.surface_app_id,
    stable_route: row.stable_route,
  });
  if (row.app_id === null) {
    throw new Error("Malformed public website authority App row");
  }
  const app = appFromRow({ app_id: row.app_id });
  if (row.selected_release_id === null) {
    return unselectedPublicWebsiteAuthority(app, surface);
  }

  const releaseId = parseReleaseId(row.selected_release_id);
  const sequence = Schema.decodeUnknownSync(
    Schema.Number.pipe(
      Schema.check(Schema.isInt()),
      Schema.check(Schema.isGreaterThan(0)),
    ),
  )(row.selected_transition_sequence);
  if (row.release_id === null) {
    return {
      kind: "selected",
      app,
      surface,
      releaseId,
      currentReleaseId: Schema.decodeUnknownSync(releaseIdSchema)(
        row.current_release_id,
      ),
      sequence,
      release: { kind: "absent" },
    };
  }
  const stored = decodeCompleteRelease(row);
  if (stored?.release_id !== row.selected_release_id) {
    throw new Error("Malformed public website authority row");
  }

  return selectedPublicWebsiteAuthority(
    row,
    app,
    surface,
    releaseId,
    sequence,
    stored,
  );
}

function unselectedPublicWebsiteAuthority(
  app: App,
  surface: PublicSurface,
): PublicWebsiteAuthority {
  return { kind: "unselected", app, surface };
}

function decodeCompleteRelease(
  row: Schema.Schema.Type<typeof publicWebsiteAuthorityRowSchema>,
) {
  const decoded = Schema.decodeUnknownResult(
    Schema.Struct({
      release_id: Schema.String,
      release_app_id: Schema.String,
      artifact_ref: Schema.String,
      artifact_digest: Schema.String,
      source_revision: Schema.String,
      source_tree_digest: Schema.String,
      build_recipe_digest: Schema.String,
      release_is_revoked: Schema.Literals([0, 1]),
    }),
  )(row);
  return decoded._tag === "Success" ? decoded.success : null;
}

function selectedPublicWebsiteAuthority(
  row: Schema.Schema.Type<typeof publicWebsiteAuthorityRowSchema>,
  app: App,
  surface: PublicSurface,
  releaseId: ReleaseId,
  sequence: number,
  stored: NonNullable<ReturnType<typeof decodeCompleteRelease>>,
): PublicWebsiteAuthority {
  return {
    kind: "selected",
    app,
    surface,
    releaseId,
    currentReleaseId: Schema.decodeUnknownSync(releaseIdSchema)(
      row.current_release_id,
    ),
    sequence,
    release: {
      kind: "found",
      release: releaseFromRow({
        release_id: stored.release_id,
        app_id: stored.release_app_id,
        artifact_ref: stored.artifact_ref,
        artifact_digest: stored.artifact_digest,
        source_revision: stored.source_revision,
        source_tree_digest: stored.source_tree_digest,
        build_recipe_digest: stored.build_recipe_digest,
      }),
      verification:
        row.verification_digest === null
          ? { kind: "unverified" }
          : releaseVerificationFromStored(
              row.verification_digest,
              row.verification_media_type,
              row.verification_metadata_digest,
              row.verification_description_json,
            ),
      revocation:
        stored.release_is_revoked === 1
          ? { kind: "revoked" }
          : { kind: "active" },
    },
  };
}

function decodeStoredMediaType(
  value: string | null,
): ArtifactMediaType | undefined {
  const decoded = Schema.decodeUnknownResult(artifactMediaTypeSchema)(value);
  return decoded._tag === "Success" ? decoded.success : undefined;
}

function releaseVerificationFromStored(
  digest: string,
  storedMediaType: string | null,
  metadataDigest: string | null,
  descriptionJson: string | null,
): ReleaseVerification {
  const parsedDigest = parseSha256Digest(digest);
  const mediaType = decodeStoredMediaType(storedMediaType);
  if (
    mediaType !== "application/vnd.fungi.app+json" ||
    metadataDigest !== digest ||
    descriptionJson === null
  ) {
    return { kind: "unverified" };
  }
  const decoded = Schema.decodeUnknownResult(verifiedAppDescriptionSchema)(
    JSON.parse(descriptionJson),
  );
  return decoded._tag === "Success"
    ? {
        kind: "verified",
        digest: parsedDigest,
        mediaType,
        description: decoded.success,
      }
    : { kind: "unverified" };
}

function appFromRow(row: AppRow): App {
  return { appId: parseAppId(row.app_id) };
}

function releaseFromRow(row: ReleaseRow): Release {
  return {
    releaseId: parseReleaseId(row.release_id),
    appId: parseAppId(row.app_id),
    artifact: {
      artifactRef: parseArtifactRef(row.artifact_ref),
      artifactDigest: parseSha256Digest(row.artifact_digest),
      provenance: {
        sourceRevision: parseSourceRevision(row.source_revision),
        sourceTreeDigest: parseSha256Digest(row.source_tree_digest),
        buildRecipeDigest: parseSha256Digest(row.build_recipe_digest),
      },
    },
  };
}

function publicSurfaceFromRow(row: PublicSurfaceRow): PublicSurface {
  return {
    publicSurfaceId: parsePublicSurfaceId(row.public_surface_id),
    appId: parseAppId(row.app_id),
    stableRoute: parseStableRoute(row.stable_route),
  };
}

async function readTransitionRow(
  database: AppReleaseD1Database,
  request: ReleaseTransition,
): Promise<TransitionRow | null> {
  const row = await database
    .prepare(
      `SELECT transition_id, operation_kind, idempotency_key, release_id,
              public_surface_id
       FROM app_release_transitions
       WHERE operation_kind = ? AND idempotency_key = ?`,
    )
    .bind(request.kind, request.idempotencyKey)
    .first();
  return row === null
    ? null
    : Schema.decodeUnknownSync(transitionRowSchema)(row);
}

function transitionReceiptFromRow(row: TransitionRow): TransitionReceipt {
  const transitionId: AppTransitionId = parseAppTransitionId(row.transition_id);
  const releaseId = parseReleaseId(row.release_id);
  const idempotencyKey: IdempotencyKey = parseIdempotencyKey(
    row.idempotency_key,
  );

  switch (row.operation_kind) {
    case "revocation":
      if (row.public_surface_id !== null)
        throw new Error("Malformed transition row");
      return {
        transition: { kind: "revocation", releaseId, idempotencyKey },
        transitionId,
      };
    case "promotion":
    case "rollback":
      if (row.public_surface_id === null)
        throw new Error("Malformed transition row");
      return {
        transition: {
          kind: row.operation_kind,
          publicSurfaceId: parsePublicSurfaceId(row.public_surface_id),
          releaseId,
          idempotencyKey,
        },
        transitionId,
      };
    default:
      throw new Error("Malformed transition row");
  }
}

async function readTransitionObligationRow(
  database: AppReleaseD1Database,
  sequence: number,
): Promise<TransitionObligationRow | null> {
  const row = await database
    .prepare(
      `SELECT sequence, transition_id, operation_kind, idempotency_key,
              release_id, public_surface_id, state
       FROM app_release_transition_obligations WHERE sequence = ?`,
    )
    .bind(sequence)
    .first();
  return row === null
    ? null
    : Schema.decodeUnknownSync(transitionObligationRowSchema)(row);
}

async function readTransitionObligationByTransitionId(
  database: AppReleaseD1Database,
  transitionId: AppTransitionId,
): Promise<TransitionObligationRow | null> {
  const row = await database
    .prepare(
      `SELECT sequence, transition_id, operation_kind, idempotency_key,
              release_id, public_surface_id, state
       FROM app_release_transition_obligations WHERE transition_id = ?`,
    )
    .bind(transitionId)
    .first();
  return row === null
    ? null
    : Schema.decodeUnknownSync(transitionObligationRowSchema)(row);
}

async function readTransitionObligationEnumerationRow(
  database: AppReleaseD1Database,
  sequence: number,
): Promise<TransitionObligationEnumerationRow | null> {
  const row = await database
    .prepare(
      `SELECT sequence, cursor, started, complete
       FROM app_release_transition_obligation_enumeration WHERE sequence = ?`,
    )
    .bind(sequence)
    .first();
  return row === null
    ? null
    : Schema.decodeUnknownSync(transitionObligationEnumerationRowSchema)(row);
}

function recipientPageKey(cursor: string | null): string {
  return cursor ?? "";
}

async function readTransitionObligationPage(
  database: AppReleaseD1Database,
  sequence: number,
  cursorIsInitial: number,
  cursorKey: string,
): Promise<TransitionObligationPageRow | null> {
  const row = await database
    .prepare(
      `SELECT sequence, cursor, cursor_is_initial, next_cursor, complete, team_ids_json
       FROM app_release_transition_obligation_pages
       WHERE sequence = ? AND cursor_is_initial = ? AND cursor_key = ?`,
    )
    .bind(sequence, cursorIsInitial, cursorKey)
    .first();
  return row === null
    ? null
    : Schema.decodeUnknownSync(transitionObligationPageRowSchema)(row);
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function teamRecipientFromRow(
  row: TransitionObligationRecipientRow,
): AppReleaseTeamRecipient {
  const state = Schema.decodeUnknownSync(teamRecipientStateSchema)(row.state);
  return { teamId: row.team_id, state };
}

async function transitionObligationFromRow(
  database: AppReleaseD1Database,
  row: TransitionObligationRow,
): Promise<AppReleaseTransitionObligation> {
  const receipt = transitionReceiptFromRow(row);
  const affectedSurfaces = await readAffectedPublicSurfaces(
    database,
    receipt.transition,
    row.sequence,
  );
  const enumeration = await readTransitionObligationEnumerationRow(
    database,
    row.sequence,
  );
  if (enumeration === null)
    throw new Error("Transition enumeration was absent");
  const valueInput = {
    sequence: row.sequence,
    transitionId: receipt.transitionId,
    affectedPublicSurfaceIds: affectedSurfaces.map(
      (surface) => surface.publicSurfaceId,
    ),
    affectedSurfaces,
    affectedBuyerApps:
      receipt.transition.kind === "revocation"
        ? await createD1BuyerReferences(database).affectedApps(
            receipt.transition.releaseId,
          )
        : [],
    enumeration: {
      cursor: enumeration.cursor,
      complete: enumeration.complete === 1,
    },
    state: row.state,
  };
  const value = Schema.decodeUnknownSync(transitionObligationValueSchema)(
    valueInput,
  );
  return { ...value, transition: receipt.transition };
}

async function readAffectedPublicSurfaces(
  database: AppReleaseD1Database,
  transition: ReleaseTransition,
  sequence: number,
): Promise<readonly AppReleaseAffectedSurface[]> {
  const surfaceIds =
    transition.kind !== "revocation" ? [transition.publicSurfaceId] : undefined;
  const result = await database
    .prepare(
      surfaceIds === undefined
        ? `SELECT DISTINCT current.public_surface_id, surface.app_id, surface.stable_route
           FROM app_release_transitions AS current
           INNER JOIN app_release_public_surfaces AS surface
             ON surface.public_surface_id = current.public_surface_id
           WHERE current.operation_kind IN ('promotion', 'rollback')
             AND current.release_id = ?
             AND current.sequence <= ?
           ORDER BY current.public_surface_id`
        : `SELECT public_surface_id, app_id, stable_route
           FROM app_release_public_surfaces WHERE public_surface_id = ?`,
    )
    .bind(
      ...(surfaceIds === undefined
        ? [transition.releaseId, sequence]
        : [surfaceIds[0]]),
    )
    .all();
  return result.results.map((row) => {
    const decoded = Schema.decodeUnknownSync(publicSurfaceRowSchema)(row);
    return {
      publicSurfaceId: parsePublicSurfaceId(decoded.public_surface_id),
      appId: parseAppId(decoded.app_id),
      stableRoute: parseStableRoute(decoded.stable_route),
    };
  });
}

/**
 * Open the D1-only obligation adjunct for a future owner-driven dispatcher.
 * The ordinary App Release store contract intentionally does not expose it.
 */
export function createD1TransitionObligationStore(
  database: AppReleaseD1Database,
): AppReleaseTransitionObligationStore {
  return createD1AppReleaseStore(database).transitionObligations;
}

/**
 * Resolve one previously selected Release on a Surface and retain the exact
 * transition sequence. The Release need not remain the Surface's current
 * default, but it must still be verified, active, and owned by that Surface.
 */
export function readD1SurfaceTransitionBasis(
  database: AppReleaseD1Database,
  stableRoute: import("./internal/app-release-contract.js").StableRoute,
  releaseId: ReleaseId,
  now: () => number = Date.now,
): Promise<AppReleaseStoreResult<AppReleaseSurfaceTransitionBasis>> {
  return storeOperation(async () => {
    const checkedAt = now();
    const authority = await readPublicWebsiteAuthority(
      database,
      stableRoute,
      releaseId,
    );
    if (authority.kind === "absent" || authority.kind === "ambiguous") {
      return authority;
    }
    if (authority.kind === "unselected") {
      return {
        kind: "none",
        appId: authority.surface.appId,
        publicSurfaceId: authority.surface.publicSurfaceId,
      };
    }
    const lifecycle = authority.release;
    if (lifecycle.kind === "absent")
      throw new Error("Selected Release is missing from the catalog");
    return {
      kind: "selected",
      appId: authority.surface.appId,
      publicSurfaceId: authority.surface.publicSurfaceId,
      releaseId,
      sequence: authority.sequence,
      checkedAt,
      eligibility:
        lifecycle.release.appId === authority.surface.appId &&
        lifecycle.verification.kind === "verified" &&
        lifecycle.verification.digest ===
          lifecycle.release.artifact.artifactDigest &&
        lifecycle.revocation.kind === "active"
          ? "eligible"
          : "ineligible",
    };
  });
}

/** Match one eligible selected Release without leaking store-result branching to consumers. */
export function matchEligibleSurfaceTransitionBasis(
  result: AppReleaseStoreResult<AppReleaseSurfaceTransitionBasis>,
  expected: Readonly<{
    appId: AppId;
    releaseId: ReleaseId;
    sequence?: number;
  }>,
): Extract<AppReleaseSurfaceTransitionBasis, { kind: "selected" }> | null {
  if (result.kind !== "success" || result.value.kind !== "selected")
    return null;
  const basis = result.value;
  if (
    basis.eligibility !== "eligible" ||
    basis.appId !== expected.appId ||
    basis.releaseId !== expected.releaseId ||
    (expected.sequence !== undefined && basis.sequence !== expected.sequence)
  )
    return null;
  return basis;
}

async function readR2Artifact(
  bucket: AppReleaseR2Bucket,
  input: Parameters<ArtifactReader["read"]>[0],
  policy: ArtifactSnapshotPolicy,
  assets?: {
    readonly bucket: Pick<AssetR2Bucket, "head">;
    readonly policy: AssetBuildPolicy;
  },
): Promise<Awaited<ReturnType<ArtifactReader["read"]>>> {
  try {
    const object = await bucket.get(input.artifactRef);
    if (object === null) return { kind: "missing" };
    if (
      !matchesExpectedObject(object.version, object.size, input.expectedObject)
    ) {
      return { kind: "unavailable" };
    }
    const format = Schema.decodeUnknownResult(artifactMediaTypeSchema)(
      object.httpMetadata?.contentType,
    );
    if (format._tag === "Failure") return { kind: "unavailable" };
    const mediaType = format.success;
    const isManifest =
      mediaType === assetBuildMediaType || mediaType === appMediaType;
    const maxBytes = isManifest
      ? (policy.maxManifestBytes ?? policy.maxBytes)
      : policy.maxBytes;
    if (!isAllowedObjectSize(object.size, maxBytes)) {
      return { kind: "unavailable" };
    }

    const bytes = new Uint8Array(await object.arrayBuffer());
    const digest = parseSha256Digest(
      `sha256:${bytesToHex(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      )}`,
    );
    if (digest !== input.expectedDigest) {
      return { kind: "digest-mismatch", actualDigest: digest };
    }

    if (bytes.byteLength !== object.size) return { kind: "unavailable" };
    if (
      mediaType === assetBuildMediaType &&
      input.verification === "publication"
    ) {
      if (!assets) return { kind: "unavailable" };
      const { verifyAssetBuildObjects } =
        await import("./cloudflare-assets.js");
      await verifyAssetBuildObjects(bytes, assets.bucket, assets.policy);
    }
    const snapshot = bytes.slice();
    return {
      kind: "verified",
      digest,
      mediaType,
      bytes: {
        byteLength: snapshot.byteLength,
        copy: () => snapshot.slice(),
      },
      byteLength: snapshot.byteLength,
    };
  } catch (cause) {
    reportFailure("read R2 artifact", cause);
    return { kind: "unavailable" };
  }
}

function matchesExpectedObject(
  version: string,
  byteLength: number,
  expected: Parameters<ArtifactReader["read"]>[0]["expectedObject"],
): boolean {
  return (
    expected === undefined ||
    (version === expected.version && byteLength === expected.byteLength)
  );
}

function isAllowedObjectSize(
  byteLength: number,
  maxBytes: number | undefined,
): boolean {
  return (
    maxBytes !== undefined &&
    Number.isSafeInteger(byteLength) &&
    byteLength >= 1 &&
    byteLength <= maxBytes
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function storeOperation<Value>(
  operation: () => Promise<Value>,
): Promise<AppReleaseStoreResult<Value>> {
  return operation()
    .then((value) => ({ kind: "success" as const, value }))
    .catch((cause: unknown) => {
      reportFailure("persist App Release operation", cause);
      return unavailableValue<Value>();
    });
}

function unavailableValue<Value>(): AppReleaseStoreResult<Value> {
  return { kind: "failure", failure: { kind: "unavailable" } };
}
