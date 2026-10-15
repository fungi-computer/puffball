import type * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import {
  readAppDescription,
  readVerifiedAppDescription,
} from "./internal/app-description.js";
import type { ResolvedApp } from "./app.js";
import * as Result from "effect/Result";
import { CairnGenerationError } from "@fungi.computer/cairn/id";

import type {
  App,
  StableRoute,
  AppTransitionId,
  PublicSurface,
  PublicSurfaceDefinition,
  PublicWebsiteRepresentation,
  Release,
  ReleaseId,
  ReleaseTransition,
  TransitionReceipt,
  VerifiedArtifactRead,
  ResolvedAppMetadata,
} from "./internal/app-release-contract.js";
import {
  AppReleaseImmutableConflictError,
  AppReleaseArtifactDigestMismatchError,
  AppReleaseArtifactInvalidSnapshotError,
  AppReleaseCommandInputError,
  AppReleaseInvalidStoreResultError,
  AppReleaseArtifactMissingError,
  AppReleaseArtifactUnavailableError,
  AppReleaseTransitionIdempotencyConflictError,
  AppReleaseTransitionOwnershipConflictError,
  AppReleaseTransitionReleaseAbsentError,
  AppReleaseTransitionReleaseRevokedError,
  AppReleaseTransitionReleaseUnverifiedError,
  AppReleaseTransitionArtifactIncompatibleError,
  AppReleaseTransitionSurfaceAbsentError,
  AppReleaseOwnerAppAbsentError,
  AppReleaseSurfaceOwnerAppAbsentError,
  AppReleaseReleaseAbsentError,
  AppReleaseStoreUnavailableError,
  AppReleaseTransitionIdUnavailableError,
  AppReleasePublicWebsiteNotFoundError,
  AppReleasePublicWebsiteUnavailableError,
} from "./internal/app-release-contract.js";
import {
  decodeApp,
  decodePublicSurfaceDefinition,
  decodeRelease,
  decodeReleaseId,
  decodeReleaseTransition,
  decodeStableRoute,
  appTransitionIdCodec,
} from "./internal/app-release-schema.js";
import type {
  AppReleaseStore,
  AppReleaseStorePortFailure,
} from "./internal/app-release-store.js";
import type { AppReleaseArtifactReader } from "./internal/app-release-artifact-reader.js";
import {
  createArtifactSnapshotPolicy,
  DEFAULT_ARTIFACT_SNAPSHOT_POLICY,
  readVerifiedArtifactSnapshot,
  type ArtifactSnapshotPolicy,
  type VerifiedArtifactSnapshotFailure,
} from "./internal/verified-artifact-snapshot.js";
import {
  createEligibleSurfaceReleaseResolver,
  createEligibleSurfaceReleasesResolver,
  createEligibleSurfaceVersionResolver,
  createPublicSurfaceAuthorityResolver,
  createPublicSurfaceAuthorityVersionResolver,
  createPublicSurfaceResolver,
  createPublicWebsiteResolver,
  createPublicWebsiteVersionResolver,
  type EligibleSurfaceRelease,
} from "./internal/public-website-delivery.js";
import { sameImmutableReleaseMaterial } from "./internal/immutable-release-material.js";

export type {
  AppReleaseStore,
  AppReleaseStorePortFailure,
} from "./internal/app-release-store.js";
export { createDeterministicMemoryAppReleaseStore } from "./internal/deterministic-memory-app-release-store.js";
export { adaptPromiseAppReleaseStore } from "./internal/promise-app-release-store-adapter.js";
export type {
  AppReleaseArtifactReader,
  AppReleaseArtifactReaderUnavailable,
} from "./internal/app-release-artifact-reader.js";
export { adaptPromiseArtifactReader } from "./internal/promise-artifact-reader-adapter.js";
export {
  appIdSchema,
  appReadStoreResultSchema,
  appReadSchema,
  appCreateStoreResultSchema,
  appCreateSchema,
  appReleaseStoreFailureSchema,
  appSchema,
  appTransitionIdSchema,
  artifactProvenanceSchema,
  artifactReadResultSchema,
  artifactRefSchema,
  decodeApp,
  decodeAppCreateStoreResult,
  decodeAppId,
  decodeAppTransitionId,
  decodeAppReadStoreResult,
  decodeArtifactReadResult,
  decodeArtifactRef,
  decodeIdempotencyKey,
  decodePublicSurface,
  decodePublicSurfaceCreateStoreResult,
  decodePublicSurfaceId,
  decodePublicSurfaceReadStoreResult,
  decodeRelease,
  decodeReleaseCreateStoreResult,
  decodeReleaseId,
  decodeReleaseReadStoreResult,
  decodeSha256Digest,
  decodeSourceRevision,
  decodeStableRoute,
  idempotencyKeySchema,
  publicSurfaceCreateSchema,
  publicSurfaceCreateStoreResultSchema,
  publicSurfaceIdSchema,
  publicSurfaceReadSchema,
  publicSurfaceReadStoreResultSchema,
  publicSurfaceSchema,
  releaseArtifactSchema,
  releaseCreateSchema,
  releaseCreateStoreResultSchema,
  releaseIdSchema,
  releaseReadSchema,
  releaseReadStoreResultSchema,
  releaseSchema,
  sha256DigestSchema,
  sourceRevisionSchema,
  stableRouteSchema,
  verifiedArtifactReadSchema,
} from "./internal/app-release-schema.js";

/** Closed domain failures that the core maps from store outcomes. */
export type AppReleaseCoreFailure =
  | AppReleaseImmutableConflictError
  | AppReleaseOwnerAppAbsentError
  | AppReleaseSurfaceOwnerAppAbsentError
  | AppReleaseStoreUnavailableError
  | AppReleaseReleaseAbsentError
  | AppReleaseArtifactUnavailableError
  | AppReleaseArtifactMissingError
  | AppReleaseArtifactDigestMismatchError
  | AppReleaseArtifactInvalidSnapshotError
  | AppReleaseCommandInputError
  | AppReleaseInvalidStoreResultError
  | AppReleaseTransitionIdempotencyConflictError
  | AppReleaseTransitionOwnershipConflictError
  | AppReleaseTransitionReleaseAbsentError
  | AppReleaseTransitionReleaseRevokedError
  | AppReleaseTransitionReleaseUnverifiedError
  | AppReleaseTransitionArtifactIncompatibleError
  | AppReleaseTransitionSurfaceAbsentError
  | AppReleaseTransitionIdUnavailableError
  | AppReleasePublicWebsiteNotFoundError
  | AppReleasePublicWebsiteUnavailableError;

/** Effect-native core for the narrow App and immutable Release catalog facts. */
export type AppReleaseCore = {
  /** Create or observe one Global App through the owned store port. */
  createApp(app: App): Effect.Effect<App, AppReleaseCoreFailure>;

  /** Create or observe one immutable Release through the owned store port. */
  createRelease(
    release: Release,
  ): Effect.Effect<Release, AppReleaseCoreFailure>;

  /** Verify the immutable artifact bound to one Release. */
  verifyReleaseArtifact(
    releaseId: ReleaseId,
  ): Effect.Effect<VerifiedArtifactRead, AppReleaseCoreFailure>;

  /** Read and recheck one eligible snapshot before each authorized use. */
  resolveEligibleReleaseArtifact(
    releaseId: ReleaseId,
  ): Effect.Effect<
    VerifiedArtifactRead & { readonly release: Release },
    AppReleaseCoreFailure
  >;

  /** Resolve UI and backend together, checking eligibility around all child reads. */
  resolveEligibleApp(
    releaseId: ReleaseId,
  ): Effect.Effect<ResolvedApp, AppReleaseCoreFailure>;

  /** Resolve verified App metadata without reading any artifact body. */
  resolveEligibleAppMetadata(
    releaseId: ReleaseId,
  ): Effect.Effect<ResolvedAppMetadata, AppReleaseCoreFailure>;

  /** Resolve one selected Surface's current metadata authority without bodies. */
  resolvePublicSurfaceAuthority(
    stableRoute: StableRoute,
  ): Effect.Effect<
    import("./internal/app-release-contract.js").PublicSurfaceAuthority,
    AppReleaseCoreFailure
  >;

  /** Resolve one previously selected Release's current metadata authority. */
  resolvePublicSurfaceAuthorityVersion(
    stableRoute: StableRoute,
    releaseId: ReleaseId,
  ): Effect.Effect<
    import("./internal/app-release-contract.js").PublicSurfaceAuthority,
    AppReleaseCoreFailure
  >;

  /** Resolve a multi-file root through existing Surface selection and eligibility. */
  resolvePublicAssetBuild(
    stableRoute: StableRoute,
  ): Effect.Effect<
    import("./internal/app-release-contract.js").PublicAssetBuildRepresentation,
    AppReleaseCoreFailure
  >;

  /** Create or observe one App-owned anonymous public Surface. */
  createPublicSurface(
    surface: PublicSurfaceDefinition,
  ): Effect.Effect<PublicSurface, AppReleaseCoreFailure>;

  /** Apply one owner-issued transition with an idempotent terminal receipt. */
  transition(
    request: ReleaseTransition,
  ): Effect.Effect<TransitionReceipt, AppReleaseCoreFailure>;

  /** Resolve the current eligible Surface Release without reading artifact bytes. */
  resolveEligibleSurfaceRelease(
    stableRoute: StableRoute,
  ): Effect.Effect<
    EligibleSurfaceRelease,
    | AppReleasePublicWebsiteNotFoundError
    | AppReleasePublicWebsiteUnavailableError
  >;

  /**
   * Read up to 100 current Surface selections in one atomic metadata batch.
   * Each entry reports its eligibility; failure of the read fails the Effect.
   */
  resolveEligibleSurfaceReleases(
    stableRoutes: readonly StableRoute[],
  ): Effect.Effect<
    readonly Result.Result<
      EligibleSurfaceRelease,
      | AppReleasePublicWebsiteNotFoundError
      | AppReleasePublicWebsiteUnavailableError
    >[],
    | AppReleasePublicWebsiteNotFoundError
    | AppReleasePublicWebsiteUnavailableError
  >;

  /** Resolve one eligible Release previously selected on this Surface. */
  resolveEligibleSurfaceVersion(
    stableRoute: StableRoute,
    releaseId: ReleaseId,
  ): Effect.Effect<
    EligibleSurfaceRelease,
    | AppReleasePublicWebsiteNotFoundError
    | AppReleasePublicWebsiteUnavailableError
  >;

  /** Resolve one stable route's immutable Surface owner without selecting a Release. */
  resolvePublicSurface(
    stableRoute: StableRoute,
  ): Effect.Effect<
    PublicSurface,
    | AppReleasePublicWebsiteNotFoundError
    | AppReleasePublicWebsiteUnavailableError
  >;

  /** Resolve the current eligible immutable website representation. */
  resolvePublicWebsite(
    stableRoute: import("./internal/app-release-contract.js").StableRoute,
  ): Effect.Effect<
    PublicWebsiteRepresentation,
    | AppReleasePublicWebsiteNotFoundError
    | AppReleasePublicWebsiteUnavailableError
  >;

  /** Resolve a pinned eligible immutable website representation. */
  resolvePublicWebsiteVersion(
    stableRoute: import("./internal/app-release-contract.js").StableRoute,
    releaseId: ReleaseId,
  ): Effect.Effect<
    PublicWebsiteRepresentation,
    | AppReleasePublicWebsiteNotFoundError
    | AppReleasePublicWebsiteUnavailableError
  >;

  /** Resolve a pinned asset-build root through Surface authority. */
  resolvePublicAssetBuildVersion(
    stableRoute: import("./internal/app-release-contract.js").StableRoute,
    releaseId: ReleaseId,
  ): Effect.Effect<
    import("./internal/app-release-contract.js").PublicAssetBuildRepresentation,
    | AppReleasePublicWebsiteNotFoundError
    | AppReleasePublicWebsiteUnavailableError
  >;
};

/**
 * Compose the Effect-native App Release core.
 *
 * A Release is first compared with its existing immutable record. Only an
 * absent Release requires an owner App lookup and an atomic create-or-observe.
 * Every closed store failure is mapped at this boundary.
 */
export function createAppReleaseCore(options: {
  readonly store: AppReleaseStore;
  readonly artifactReader: AppReleaseArtifactReader;
  readonly artifactPolicy?: ArtifactSnapshotPolicy;
}): AppReleaseCore {
  const artifactPolicy =
    options.artifactPolicy === undefined
      ? DEFAULT_ARTIFACT_SNAPSHOT_POLICY
      : createArtifactSnapshotPolicy(
          options.artifactPolicy.maxBytes,
          options.artifactPolicy.maxManifestBytes,
        );
  const generateTransitionId = (): AppTransitionId =>
    appTransitionIdCodec.generate();
  const resolvePublicWebsite = createPublicWebsiteResolver({
    mediaType: "text/html; charset=utf-8",
    ...options,
    artifactPolicy,
  });
  const resolvePublicWebsiteVersion = createPublicWebsiteVersionResolver({
    mediaType: "text/html; charset=utf-8",
    ...options,
    artifactPolicy,
  });
  const resolveEligibleSurfaceRelease = createEligibleSurfaceReleaseResolver({
    store: options.store,
  });
  const resolvePublicSurfaceAuthority = createPublicSurfaceAuthorityResolver({
    store: options.store,
  });
  const resolvePublicSurfaceAuthorityVersion =
    createPublicSurfaceAuthorityVersionResolver({ store: options.store });
  const resolvePublicAssetBuild = createPublicWebsiteResolver({
    store: options.store,
    artifactReader: options.artifactReader,
    artifactPolicy,
    mediaType: "application/vnd.fungi.app-assets+json",
  });
  const resolvePublicAssetBuildVersion = createPublicWebsiteVersionResolver({
    store: options.store,
    artifactReader: options.artifactReader,
    artifactPolicy,
    mediaType: "application/vnd.fungi.app-assets+json",
  });

  return {
    createApp: (app) =>
      decodeCommand(decodeApp(app), "createApp").pipe(
        Effect.flatMap((decoded) =>
          options.store.createAppIfAbsent(decoded).pipe(
            Effect.mapError(storePortFailure),
            Effect.map((outcome) => outcome.app),
          ),
        ),
      ),
    createRelease: (release) =>
      decodeCommand(decodeRelease(release), "createRelease").pipe(
        Effect.flatMap((decoded) => createRelease(options.store, decoded)),
      ),
    verifyReleaseArtifact: (releaseId) =>
      decodeCommand(decodeReleaseId(releaseId), "verifyReleaseArtifact").pipe(
        Effect.flatMap((decoded) =>
          verifyReleaseArtifact(
            options.store,
            options.artifactReader,
            decoded,
            artifactPolicy,
          ),
        ),
      ),
    resolveEligibleReleaseArtifact: (releaseId) =>
      resolveEligibleArtifact(options, releaseId, artifactPolicy, (snapshot) =>
        Effect.succeed({ kind: "verified" as const, ...snapshot }),
      ),
    resolveEligibleApp: (releaseId) =>
      resolveEligibleArtifact(options, releaseId, artifactPolicy, (snapshot) =>
        readAppDescription(
          options.artifactReader,
          snapshot,
          artifactPolicy,
        ).pipe(
          Effect.map((description) => ({
            ...description,
            digest: snapshot.digest,
          })),
        ),
      ),
    resolveEligibleAppMetadata: (releaseId) =>
      decodeCommand(
        decodeReleaseId(releaseId),
        "resolveEligibleAppMetadata",
      ).pipe(
        Effect.flatMap((decoded) =>
          resolveEligibleAppMetadata(options.store, decoded),
        ),
      ),
    resolvePublicSurfaceAuthority: (stableRoute) =>
      decodeCommand(
        decodeStableRoute(stableRoute),
        "resolvePublicSurfaceAuthority",
      ).pipe(
        Effect.flatMap((decoded) => resolvePublicSurfaceAuthority(decoded)),
      ),
    resolvePublicSurfaceAuthorityVersion: (stableRoute, releaseId) =>
      decodeCommand(
        decodeStableRoute(stableRoute),
        "resolvePublicSurfaceAuthorityVersion",
      ).pipe(
        Effect.flatMap((decodedRoute) =>
          decodeCommand(
            decodeReleaseId(releaseId),
            "resolvePublicSurfaceAuthorityVersion",
          ).pipe(
            Effect.flatMap((decodedRelease) =>
              resolvePublicSurfaceAuthorityVersion(
                decodedRoute,
                decodedRelease,
              ),
            ),
          ),
        ),
      ),
    createPublicSurface: (surface) =>
      decodeCommand(
        decodePublicSurfaceDefinition(surface),
        "createPublicSurface",
      ).pipe(
        Effect.flatMap((decoded) =>
          createPublicSurface(options.store, decoded),
        ),
      ),
    transition: (request) =>
      decodeCommand(decodeReleaseTransition(request), "transition").pipe(
        Effect.flatMap((decoded) =>
          applyTransition(
            options.store,
            options.artifactReader,
            artifactPolicy,
            decoded,
            generateTransitionId,
          ),
        ),
      ),
    resolveEligibleSurfaceRelease,
    resolveEligibleSurfaceReleases: createEligibleSurfaceReleasesResolver({
      store: options.store,
    }),
    resolveEligibleSurfaceVersion: createEligibleSurfaceVersionResolver({
      store: options.store,
    }),
    resolvePublicSurface: createPublicSurfaceResolver({
      store: options.store,
    }),
    resolvePublicWebsite,
    resolvePublicWebsiteVersion,
    resolvePublicAssetBuild,
    resolvePublicAssetBuildVersion,
  };
}

function resolveEligibleArtifact<Value>(
  options: {
    readonly store: AppReleaseStore;
    readonly artifactReader: AppReleaseArtifactReader;
  },
  releaseId: ReleaseId,
  artifactPolicy: ArtifactSnapshotPolicy,
  resolve: (
    snapshot: import("./internal/verified-artifact-snapshot.js").VerifiedArtifactSnapshot,
  ) => Effect.Effect<Value, VerifiedArtifactSnapshotFailure>,
): Effect.Effect<Value & { readonly release: Release }, AppReleaseCoreFailure> {
  return Effect.gen(function* () {
    const decoded = yield* decodeCommand(
      decodeReleaseId(releaseId),
      "resolveEligibleReleaseArtifact",
    );
    const readLifecycle = options.store.readReleaseLifecycle;
    if (readLifecycle === undefined)
      return yield* Effect.fail(storeUnavailable());
    const eligibleRelease = Effect.gen(function* () {
      const lifecycle = yield* readLifecycle(decoded).pipe(
        Effect.mapError(storePortFailure),
      );
      if (lifecycle.kind === "absent")
        return yield* Effect.fail(new AppReleaseReleaseAbsentError());
      if (lifecycle.release.releaseId !== decoded)
        return yield* Effect.fail(invalidStoreResult());
      if (
        lifecycle.verification.kind !== "verified" ||
        lifecycle.verification.digest !==
          lifecycle.release.artifact.artifactDigest
      )
        return yield* Effect.fail(
          new AppReleaseTransitionReleaseUnverifiedError(),
        );
      if (lifecycle.revocation.kind !== "active")
        return yield* Effect.fail(
          new AppReleaseTransitionReleaseRevokedError(),
        );
      return lifecycle.release;
    });
    const first = yield* eligibleRelease;

    const snapshot = yield* readVerifiedArtifactSnapshot(
      options.artifactReader,
      {
        artifactRef: first.artifact.artifactRef,
        expectedDigest: first.artifact.artifactDigest,
      },
      artifactPolicy,
    ).pipe(Effect.mapError(artifactSnapshotFailure));
    const value = yield* resolve(snapshot).pipe(
      Effect.mapError(artifactSnapshotFailure),
    );
    // Both observations must be verified with the exact digest and active;
    // comparing immutable material then compares the entire eligible lifecycle.
    const second = yield* eligibleRelease;
    if (!sameImmutableReleaseMaterial(first, second)) {
      return yield* Effect.fail(new AppReleaseImmutableConflictError());
    }
    return { ...value, release: first };
  });
}

function verifyReleaseArtifact(
  store: AppReleaseStore,
  artifactReader: AppReleaseArtifactReader,
  releaseId: ReleaseId,
  artifactPolicy: ArtifactSnapshotPolicy,
): Effect.Effect<VerifiedArtifactRead, AppReleaseCoreFailure> {
  return store.readRelease(releaseId).pipe(
    Effect.mapError(storePortFailure),
    Effect.flatMap((read) => {
      if (read.kind === "absent") {
        return Effect.fail(new AppReleaseReleaseAbsentError());
      }

      const expectedDigest = read.release.artifact.artifactDigest;
      return readVerifiedArtifactSnapshot(
        artifactReader,
        {
          artifactRef: read.release.artifact.artifactRef,
          expectedDigest,
          verification: "publication",
        },
        artifactPolicy,
      ).pipe(
        Effect.mapError(artifactSnapshotFailure),
        Effect.flatMap((snapshot) =>
          readVerifiedAppDescription(
            artifactReader,
            snapshot,
            artifactPolicy,
            "publication",
          ).pipe(
            Effect.mapError(artifactSnapshotFailure),
            Effect.flatMap(({ metadata }) =>
              store.recordReleaseVerification === undefined
                ? Effect.fail(storeUnavailable())
                : store
                    .recordReleaseVerification({
                      releaseId,
                      digest: snapshot.digest,
                      mediaType: "application/vnd.fungi.app+json",
                      description: metadata,
                    })
                    .pipe(
                      Effect.mapError(storePortFailure),
                      Effect.map(() => ({
                        kind: "verified" as const,
                        ...snapshot,
                      })),
                    ),
            ),
          ),
        ),
      );
    }),
  );
}

function resolveEligibleAppMetadata(
  store: AppReleaseStore,
  releaseId: ReleaseId,
): Effect.Effect<ResolvedAppMetadata, AppReleaseCoreFailure> {
  const readLifecycle = store.readReleaseLifecycle;
  if (readLifecycle === undefined) return Effect.fail(storeUnavailable());
  return readLifecycle(releaseId).pipe(
    Effect.mapError(storePortFailure),
    Effect.flatMap((lifecycle) => {
      if (lifecycle.kind === "absent") {
        return Effect.fail(new AppReleaseReleaseAbsentError());
      }
      if (lifecycle.release.releaseId !== releaseId) {
        return Effect.fail(invalidStoreResult());
      }
      if (
        lifecycle.verification.kind !== "verified" ||
        lifecycle.verification.digest !==
          lifecycle.release.artifact.artifactDigest
      ) {
        return Effect.fail(new AppReleaseTransitionReleaseUnverifiedError());
      }
      if (lifecycle.revocation.kind !== "active") {
        return Effect.fail(new AppReleaseTransitionReleaseRevokedError());
      }
      return Effect.succeed({
        release: lifecycle.release,
        digest: lifecycle.verification.digest,
        description: lifecycle.verification.description,
      });
    }),
  );
}

function createRelease(
  store: AppReleaseStore,
  requested: Release,
): Effect.Effect<Release, AppReleaseCoreFailure> {
  return store.readRelease(requested.releaseId).pipe(
    Effect.mapError(storePortFailure),
    Effect.flatMap((read) => {
      if (read.kind === "found")
        return compareImmutable(requested, read.release);

      return store.readApp(requested.appId).pipe(
        Effect.mapError(storePortFailure),
        Effect.flatMap((owner) => {
          if (owner.kind === "absent") {
            return Effect.fail(
              new AppReleaseOwnerAppAbsentError(requested.appId),
            );
          }

          return store.createReleaseIfAbsent(requested).pipe(
            Effect.mapError(storePortFailure),
            Effect.flatMap((created) =>
              compareImmutable(requested, created.release),
            ),
          );
        }),
      );
    }),
  );
}

function createPublicSurface(
  store: AppReleaseStore,
  surface: PublicSurfaceDefinition,
): Effect.Effect<PublicSurface, AppReleaseCoreFailure> {
  return store.readApp(surface.appId).pipe(
    Effect.mapError(storePortFailure),
    Effect.flatMap((owner) => {
      if (owner.kind === "absent") {
        return Effect.fail(
          new AppReleaseSurfaceOwnerAppAbsentError(surface.appId),
        );
      }

      return store.createPublicSurfaceIfAbsent(surface).pipe(
        Effect.mapError(storePortFailure),
        Effect.flatMap((outcome) =>
          outcome.kind === "conflict"
            ? Effect.fail(new AppReleaseImmutableConflictError())
            : comparePublicSurface(surface, outcome.surface),
        ),
      );
    }),
  );
}

function applyTransition(
  store: AppReleaseStore,
  artifactReader: AppReleaseArtifactReader,
  artifactPolicy: ArtifactSnapshotPolicy,
  request: ReleaseTransition,
  nextTransitionId: () => AppTransitionId,
): Effect.Effect<TransitionReceipt, AppReleaseCoreFailure> {
  const readTransition = store.readTransition;
  if (readTransition === undefined) return Effect.fail(storeUnavailable());

  return readTransition(request).pipe(
    Effect.mapError(storePortFailure),
    Effect.flatMap((lookup) => {
      if (lookup.kind === "found") return Effect.succeed(lookup.receipt);
      if (lookup.kind === "conflict") {
        return Effect.fail(new AppReleaseTransitionIdempotencyConflictError());
      }

      const readLifecycle = store.readReleaseLifecycle;
      if (readLifecycle === undefined) return Effect.fail(storeUnavailable());
      return readLifecycle(request.releaseId).pipe(
        Effect.mapError(storePortFailure),
        Effect.flatMap((releaseLifecycle) => {
          if (releaseLifecycle.kind === "absent") {
            return Effect.fail(new AppReleaseTransitionReleaseAbsentError());
          }

          if (request.kind !== "revocation") {
            if (releaseLifecycle.verification.kind !== "verified") {
              return Effect.fail(
                new AppReleaseTransitionReleaseUnverifiedError(),
              );
            }
            if (
              releaseLifecycle.verification.digest !==
              releaseLifecycle.release.artifact.artifactDigest
            ) {
              return Effect.fail(
                new AppReleaseTransitionReleaseUnverifiedError(),
              );
            }
            if (releaseLifecycle.revocation.kind === "revoked") {
              return Effect.fail(new AppReleaseTransitionReleaseRevokedError());
            }
          }

          if (request.kind === "revocation") {
            return persistTransition(store, request, nextTransitionId);
          }

          return store.readPublicSurface(request.publicSurfaceId).pipe(
            Effect.mapError(storePortFailure),
            Effect.flatMap((surface) => {
              if (surface.kind === "absent") {
                return Effect.fail(
                  new AppReleaseTransitionSurfaceAbsentError(),
                );
              }
              if (surface.surface.appId !== releaseLifecycle.release.appId) {
                return Effect.fail(
                  new AppReleaseTransitionOwnershipConflictError(),
                );
              }
              return readVerifiedArtifactSnapshot(
                artifactReader,
                {
                  artifactRef: releaseLifecycle.release.artifact.artifactRef,
                  expectedDigest:
                    releaseLifecycle.release.artifact.artifactDigest,
                  verification: "publication",
                },
                artifactPolicy,
              ).pipe(
                Effect.mapError(artifactSnapshotFailure),
                Effect.flatMap((artifact) => {
                  if (artifact.mediaType === "application/vnd.fungi.app+json") {
                    return readAppDescription(
                      artifactReader,
                      artifact,
                      artifactPolicy,
                      "publication",
                    ).pipe(
                      Effect.mapError(artifactSnapshotFailure),
                      Effect.flatMap((app) =>
                        app.ui === null
                          ? Effect.fail(
                              new AppReleaseTransitionArtifactIncompatibleError(),
                            )
                          : persistTransition(store, request, nextTransitionId),
                      ),
                    );
                  }
                  return artifact.mediaType === "text/html; charset=utf-8" ||
                    artifact.mediaType ===
                      "application/vnd.fungi.app-assets+json"
                    ? persistTransition(store, request, nextTransitionId)
                    : Effect.fail(
                        new AppReleaseTransitionArtifactIncompatibleError(),
                      );
                }),
              );
            }),
          );
        }),
      );
    }),
  );
}

function persistTransition(
  store: AppReleaseStore,
  request: ReleaseTransition,
  nextTransitionId: () => AppTransitionId,
): Effect.Effect<TransitionReceipt, AppReleaseCoreFailure> {
  const persist = store.persistTransition;
  if (persist === undefined) return Effect.fail(storeUnavailable());
  return Effect.try({
    try: nextTransitionId,
    catch: (error) => {
      if (error instanceof CairnGenerationError) {
        return new AppReleaseTransitionIdUnavailableError();
      }
      throw error;
    },
  }).pipe(
    Effect.flatMap((transitionId) =>
      persist(request, { transition: request, transitionId }).pipe(
        Effect.mapError(storePortFailure),
        Effect.flatMap((outcome) => {
          if (outcome.kind === "conflict") {
            return Effect.fail(
              new AppReleaseTransitionIdempotencyConflictError(),
            );
          }
          if (outcome.kind === "identity-collision") {
            return Effect.fail(new AppReleaseTransitionIdUnavailableError());
          }
          if (outcome.kind === "lifecycle-conflict") {
            return Effect.fail(new AppReleaseTransitionReleaseRevokedError());
          }
          return Effect.succeed(outcome.receipt);
        }),
      ),
    ),
  );
}

function compareImmutable(
  requested: Release,
  existing: Release,
): Effect.Effect<Release, AppReleaseImmutableConflictError> {
  return sameImmutableReleaseMaterial(requested, existing)
    ? Effect.succeed(existing)
    : Effect.fail(new AppReleaseImmutableConflictError());
}

function comparePublicSurface(
  requested: PublicSurface,
  existing: PublicSurface,
): Effect.Effect<PublicSurface, AppReleaseImmutableConflictError> {
  return requested.appId === existing.appId &&
    requested.stableRoute === existing.stableRoute
    ? Effect.succeed(existing)
    : Effect.fail(new AppReleaseImmutableConflictError());
}

function storeUnavailable(): AppReleaseStoreUnavailableError {
  return new AppReleaseStoreUnavailableError();
}

function invalidStoreResult(): AppReleaseInvalidStoreResultError {
  return new AppReleaseInvalidStoreResultError();
}

function storePortFailure(
  failure: AppReleaseStorePortFailure,
): AppReleaseStoreUnavailableError | AppReleaseInvalidStoreResultError {
  return failure.kind === "unavailable"
    ? storeUnavailable()
    : invalidStoreResult();
}

function artifactUnavailable(): AppReleaseArtifactUnavailableError {
  return new AppReleaseArtifactUnavailableError();
}

function artifactInvalidSnapshot(): AppReleaseArtifactInvalidSnapshotError {
  return new AppReleaseArtifactInvalidSnapshotError();
}

function artifactSnapshotFailure(
  failure: VerifiedArtifactSnapshotFailure,
):
  | AppReleaseArtifactUnavailableError
  | AppReleaseArtifactMissingError
  | AppReleaseArtifactDigestMismatchError
  | AppReleaseArtifactInvalidSnapshotError {
  switch (failure.kind) {
    case "unavailable":
      return artifactUnavailable();
    case "missing":
      return new AppReleaseArtifactMissingError();
    case "digest-mismatch":
      return new AppReleaseArtifactDigestMismatchError();
    case "invalid-snapshot":
      return artifactInvalidSnapshot();
  }
}

function commandInput(
  commandName: AppReleaseCommandInputError["commandName"],
): AppReleaseCommandInputError {
  return new AppReleaseCommandInputError(commandName);
}

function decodeCommand<Value>(
  decoded: Result.Result<Value, Schema.SchemaError>,
  commandName: AppReleaseCommandInputError["commandName"],
): Effect.Effect<Value, AppReleaseCommandInputError> {
  return Result.match(decoded, {
    onFailure: () => Effect.fail(commandInput(commandName)),
    onSuccess: Effect.succeed,
  });
}
