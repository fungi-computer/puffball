import * as Effect from "effect/Effect";

import type {
  App,
  AppCreate,
  AppId,
  AppRead,
  AppReleaseStoreFailure,
  ReleaseLifecycle,
  PublicSurfaceDefinition,
  PublicSurfaceCreate,
  PublicSurfaceId,
  PublicSurfaceRead,
  Release,
  ReleaseCreate,
  ReleaseId,
  ReleaseRead,
  ReleaseTransition,
  Sha256Digest,
  VerifiedAppDescription,
  TransitionLookup,
  TransitionPersistence,
  TransitionReceipt,
} from "./app-release-contract.js";

/**
 * Closed failures emitted by the owned Effect Store port.
 *
 * The invalid-result sentinel lets the outer Promise adapter fail closed when
 * a foreign fulfilled value is not one of the catalog's durable outcomes.
 */
export type AppReleaseStorePortFailure =
  AppReleaseStoreFailure | { readonly kind: "invalid-store-result" };

/**
 * Canonical Effect-owned persistence port for the narrow App/Release catalog.
 *
 * Implementations own atomicity; the catalog owns the interpretation of these
 * explicit outcomes. This port intentionally has no generic query or mutation
 * escape hatch.
 */
export type AppReleaseStore = {
  /** Look up exactly one Global App. */
  readApp(appId: AppId): Effect.Effect<AppRead, AppReleaseStorePortFailure>;

  /** Atomically create or observe exactly one Global App. */
  createAppIfAbsent(
    app: App,
  ): Effect.Effect<AppCreate, AppReleaseStorePortFailure>;

  /** Look up exactly one immutable Release. */
  readRelease(
    releaseId: ReleaseId,
  ): Effect.Effect<ReleaseRead, AppReleaseStorePortFailure>;

  /** Atomically create or observe exactly one immutable Release. */
  createReleaseIfAbsent(
    release: Release,
  ): Effect.Effect<ReleaseCreate, AppReleaseStorePortFailure>;

  /** Look up exactly one App-owned anonymous public Surface. */
  readPublicSurface(
    publicSurfaceId: PublicSurfaceId,
  ): Effect.Effect<PublicSurfaceRead, AppReleaseStorePortFailure>;

  /** Atomically create or observe one App-owned anonymous public Surface. */
  createPublicSurfaceIfAbsent(
    surface: PublicSurfaceDefinition,
  ): Effect.Effect<PublicSurfaceCreate, AppReleaseStorePortFailure>;

  /** Read the Release facts relevant to transition eligibility. */
  readonly readReleaseLifecycle?: (
    releaseId: ReleaseId,
  ) => Effect.Effect<ReleaseLifecycle, AppReleaseStorePortFailure>;

  /** Retain a verified artifact fact after core validation succeeds. */
  readonly recordReleaseVerification?: (input: {
    readonly releaseId: ReleaseId;
    readonly digest: Sha256Digest;
    readonly mediaType: "application/vnd.fungi.app+json";
    readonly description: VerifiedAppDescription;
  }) => Effect.Effect<
    { readonly kind: "recorded" },
    AppReleaseStorePortFailure
  >;

  /** Read a receipt or idempotency conflict before transition policy. */
  readonly readTransition?: (
    request: ReleaseTransition,
  ) => Effect.Effect<TransitionLookup, AppReleaseStorePortFailure>;

  /** Atomically persist a policy-approved transition and receipt. */
  readonly persistTransition?: (
    request: ReleaseTransition,
    receipt: TransitionReceipt,
  ) => Effect.Effect<TransitionPersistence, AppReleaseStorePortFailure>;
};
