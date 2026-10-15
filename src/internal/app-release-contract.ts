import type { AppDeclaration } from "../app-vocabulary.js";
import type { CairnId } from "@fungi.computer/cairn/id";

/** Opaque Global App identifier. */
export type AppId = string & { readonly appReleaseKind: "AppId" };

/** Opaque immutable Release identifier. */
export type ReleaseId = string & { readonly appReleaseKind: "ReleaseId" };

/** Opaque anonymous public-Surface identifier. */
export type PublicSurfaceId = string & {
  readonly appReleaseKind: "PublicSurfaceId";
};

/** Opaque, bounded artifact locator for an injected reader. */
export type ArtifactRef = string & { readonly appReleaseKind: "ArtifactRef" };

/** Caller-provided idempotency key for one control-plane operation. */
export type IdempotencyKey = string & {
  readonly appReleaseKind: "IdempotencyKey";
};

/** Pinned lowercase Git source revision. */
export type SourceRevision = string & {
  readonly appReleaseKind: "SourceRevision";
};

/** Lowercase SHA-256 digest with its `sha256:` prefix. */
export type Sha256Digest = string & {
  readonly appReleaseKind: "Sha256Digest";
};

/** Canonical, local origin-relative stable route for a public Surface. */
export type StableRoute = string & {
  readonly appReleaseKind: "StableRoute";
};

/** Cairn-issued opaque identity for one owner-issued App transition. */
export type AppTransitionId = CairnId<"app-release", "transition">;

/** Immutable artifact bytes exposed only through fresh copies. */
export type ImmutableArtifactBytes = {
  /** The immutable snapshot's bounded byte length. */
  readonly byteLength: number;

  /** Return an independently mutable copy of the immutable snapshot. */
  copy(): Uint8Array;
};

/** Source and build facts permanently bound to a Release artifact. */
export type ArtifactProvenance = {
  /** Pinned source revision from which the artifact was built. */
  readonly sourceRevision: SourceRevision;

  /** Digest of the source tree used for the build. */
  readonly sourceTreeDigest: Sha256Digest;

  /** Digest of the deterministic build recipe. */
  readonly buildRecipeDigest: Sha256Digest;
};

/** Immutable artifact identity and provenance bound to a Release. */
export type ReleaseArtifact = {
  /** Opaque reference resolved only by the injected reader. */
  readonly artifactRef: ArtifactRef;

  /** Digest expected from the resolved artifact bytes. */
  readonly artifactDigest: Sha256Digest;

  /** Write-once source and build provenance. */
  readonly provenance: ArtifactProvenance;
};

/** Global App record owned by the catalog. */
export type App = {
  /** Opaque App identity. */
  readonly appId: AppId;
};

/** Immutable App Release record. */
export type Release = {
  /** Opaque immutable Release identity. */
  readonly releaseId: ReleaseId;

  /** App that owns this Release. */
  readonly appId: AppId;

  /** Immutable artifact identity and provenance. */
  readonly artifact: ReleaseArtifact;
};

/** Anonymous website Surface and its explicit App owner. */
export type PublicSurface = {
  /** Opaque public-Surface identity. */
  readonly publicSurfaceId: PublicSurfaceId;

  /** App that owns this Surface. */
  readonly appId: AppId;

  /** Canonical local route locator for this Surface. */
  readonly stableRoute: StableRoute;
};

/** Admitted publisher identity retained separately from public Surface metadata. */
export type PublicSurfacePublisher = Readonly<{
  kind: "customer" | "platform";
  teamId: string;
  userId: string;
  requestKey: string;
}>;

/** Creation requires explicit publisher custody; an ID is never authority. */
export type PublicSurfaceDefinition = PublicSurface &
  Readonly<{
    publisher: PublicSurfacePublisher;
  }>;

/** Supported immutable artifact representation formats. */
export type ArtifactMediaType =
  | "text/html; charset=utf-8"
  | "application/vnd.fungi.app-backend+json"
  | "application/vnd.fungi.app-assets+json"
  | "application/vnd.fungi.app+json";

/** One immutable child reference retained after App publication verification. */
export type VerifiedAppArtifactReference = Readonly<{
  readonly artifactRef: ArtifactRef;
  readonly digest: Sha256Digest;
  readonly mediaType: Exclude<
    ArtifactMediaType,
    "application/vnd.fungi.app+json"
  >;
  readonly version: string;
  readonly byteLength: number;
}>;

/** Executable descriptor decoded from one verified backend child artifact. */
export type DurableBackend = Readonly<{
  readonly runtime: Readonly<{
    readonly kind: "durable-facet";
    readonly stateSchema: number;
  }>;
  readonly compatibilityDate: string;
  readonly exportName: string;
  readonly code: string;
}>;

/** Backend facts needed for admission, with executable code deliberately absent. */
export type VerifiedBackendProfile = Omit<DurableBackend, "code">;

/** Normalized immutable App description persisted by the verification owner. */
export type VerifiedAppDescription = Readonly<{
  readonly format: "fungi-app-v1";
  readonly ui: VerifiedAppArtifactReference | null;
  readonly backend: Readonly<{
    readonly artifact: VerifiedAppArtifactReference;
    readonly profile: VerifiedBackendProfile;
  }> | null;
  /** The App's digest-covered request; never a grant. */
  readonly declaration: AppDeclaration;
}>;

/** Verified metadata returned without reading any artifact body. */
export type ResolvedAppMetadata = Readonly<{
  readonly release: Release;
  readonly digest: Sha256Digest;
  readonly description: VerifiedAppDescription;
}>;

/** Current metadata-only authority for one selected public Surface. */
export type PublicSurfaceAuthority = Readonly<{
  /** Surface default observed atomically with this eligible, possibly pinned Release. */
  readonly currentReleaseId: ReleaseId;
  /** Catalog transition that selected this Release on this Surface. */
  readonly sequence: number;
  readonly app: App;
  readonly release: Release;
  readonly surface: PublicSurface;
  readonly digest: Sha256Digest;
  readonly revocation: ReleaseRevocation;
  readonly description: VerifiedAppDescription;
}>;

/** Successful, verified artifact read. */
export type VerifiedArtifactRead = {
  /** Discriminant for a verified immutable representation snapshot. */
  readonly kind: "verified";

  /** Computed digest matching the requested digest. */
  readonly digest: Sha256Digest;

  /** Explicit artifact formats; an asset root is never interpreted as HTML or backend code. */
  readonly mediaType: ArtifactMediaType;

  /** Immutable representation byte snapshot. */
  readonly bytes: ImmutableArtifactBytes;

  /** Byte length matching the immutable snapshot. */
  readonly byteLength: number;
};

/** Verified UI representation; selection authority remains with its host. */
export type AppUi = Omit<VerifiedArtifactRead, "kind" | "mediaType"> & {
  readonly mediaType:
    "text/html; charset=utf-8" | "application/vnd.fungi.app-assets+json";
};

/** Normalized immutable code description shared by Surface and facet consumers. */
export type AppDescription = Readonly<{
  readonly ui: AppUi | null;
  readonly backend: Readonly<{
    readonly digest: Sha256Digest;
    readonly descriptor: DurableBackend;
  }> | null;
}>;

/** One eligible Release with all declared executable parts resolved. */
export type ResolvedApp = AppDescription &
  Readonly<{
    readonly release: Release;
    readonly digest: Sha256Digest;
  }>;

/** Closed result union returned by an injected artifact reader. */
export type ArtifactReadResult =
  | VerifiedArtifactRead
  | { readonly kind: "unavailable" }
  | { readonly kind: "missing" }
  | { readonly kind: "digest-mismatch"; readonly actualDigest: Sha256Digest };

/** Names the owner-controlled verification work requested for one read. */
export type ArtifactVerificationIntent = "publication";

/** Storage-neutral port that resolves an opaque reference and verifies bytes. */
export type ArtifactReader = {
  /** Resolve and verify exactly one expected immutable artifact. */
  read(input: {
    /** Opaque artifact reference; never a storage capability. */
    readonly artifactRef: ArtifactRef;

    /** Digest that the resolved bytes must match. */
    readonly expectedDigest: Sha256Digest;

    /** Child reference pins the native object version as well as its content. */
    readonly expectedObject?: {
      readonly version: string;
      readonly byteLength: number;
    };

    /**
     * Publication asks the reader to verify every object named by an asset
     * manifest. Omitted for ordinary delivery, which verifies one requested
     * object at the asset handler boundary.
     */
    readonly verification?: ArtifactVerificationIntent;
  }): Promise<ArtifactReadResult>;
};

/** Closed infrastructure failure projected by an App Release store. */
export type AppReleaseStoreFailure = { readonly kind: "unavailable" };

/** Closed successful outcome for one App Release store operation. */
export type AppReleaseStoreSuccess<Value> = {
  readonly kind: "success";
  readonly value: Value;
};

/** Closed failed outcome for one App Release store operation. */
export type AppReleaseStoreOperationFailure = {
  readonly kind: "failure";
  readonly failure: AppReleaseStoreFailure;
};

/** Closed envelope returned by every App Release store operation. */
export type AppReleaseStoreResult<Value> =
  AppReleaseStoreSuccess<Value> | AppReleaseStoreOperationFailure;

/** Explicit result of looking up one Global App. */
export type AppRead =
  { readonly kind: "found"; readonly app: App } | { readonly kind: "absent" };

/** Explicit result of atomically creating or observing one Global App. */
export type AppCreate =
  | { readonly kind: "created"; readonly app: App }
  | { readonly kind: "existing"; readonly app: App };

/** Explicit result of looking up one immutable Release. */
export type ReleaseRead =
  | { readonly kind: "found"; readonly release: Release }
  | { readonly kind: "absent" };

/** Explicit result of atomically creating or observing one immutable Release. */
export type ReleaseCreate =
  | { readonly kind: "created"; readonly release: Release }
  | { readonly kind: "existing"; readonly release: Release };

/** Explicit result of looking up one App-owned anonymous public Surface. */
export type PublicSurfaceRead =
  | { readonly kind: "found"; readonly surface: PublicSurface }
  | { readonly kind: "absent" };

/** Explicit result of atomically creating or observing one public Surface. */
export type PublicSurfaceCreate =
  | { readonly kind: "created"; readonly surface: PublicSurface }
  | { readonly kind: "existing"; readonly surface: PublicSurface }
  | { readonly kind: "conflict" };

/** Verification fact retained after a valid immutable artifact snapshot. */
export type ReleaseVerification =
  | {
      readonly kind: "verified";
      readonly digest: Sha256Digest;
      readonly mediaType: "application/vnd.fungi.app+json";
      readonly description: VerifiedAppDescription;
    }
  | { readonly kind: "unverified" };

/** Revocation fact retained independently from immutable Release bytes. */
export type ReleaseRevocation =
  { readonly kind: "active" } | { readonly kind: "revoked" };

/** Durable Release facts observed by transition policy. */
export type ReleaseLifecycle =
  | {
      readonly kind: "found";
      readonly release: Release;
      readonly verification: ReleaseVerification;
      readonly revocation: ReleaseRevocation;
    }
  | { readonly kind: "absent" };

/** Durable public-Surface selection fact observed by transition policy. */
export type PublicSurfaceLifecycle =
  | {
      readonly kind: "found";
      readonly surface: PublicSurface;
      readonly selection:
        | { readonly kind: "none" }
        | { readonly kind: "selected"; readonly releaseId: ReleaseId };
    }
  | { readonly kind: "absent" };

/** Safe immutable website bytes selected by the current Surface authority. */
export type PublicWebsiteRepresentation = Readonly<{
  readonly releaseId: ReleaseId;
  readonly digest: Sha256Digest;
  readonly mediaType: "text/html; charset=utf-8";
  readonly byteLength: number;
  readonly bytes: ImmutableArtifactBytes;
}>;

/** Verified root manifest selected by the existing public Surface owner. */
export type PublicAssetBuildRepresentation = Omit<
  PublicWebsiteRepresentation,
  "mediaType"
> & { readonly mediaType: "application/vnd.fungi.app-assets+json" };

/** Result of looking up an operation-scoped idempotency key. */
export type TransitionLookup =
  | { readonly kind: "absent" }
  | { readonly kind: "found"; readonly receipt: TransitionReceipt }
  | { readonly kind: "conflict" };

/** Result of atomically recording one transition and its receipt. */
export type TransitionPersistence =
  | { readonly kind: "created"; readonly receipt: TransitionReceipt }
  | { readonly kind: "existing"; readonly receipt: TransitionReceipt }
  | { readonly kind: "conflict" }
  | { readonly kind: "identity-collision" }
  | { readonly kind: "lifecycle-conflict" };

/** Effect-free projection of the App Release store boundary. */
export type PromiseAppReleaseStore = {
  /** Look up one App by its opaque identifier. */
  readApp(appId: AppId): Promise<AppReleaseStoreResult<AppRead>>;

  /** Create an App if absent, or return the immutable existing record. */
  createAppIfAbsent(app: App): Promise<AppReleaseStoreResult<AppCreate>>;

  /** Look up one immutable Release by its opaque identifier. */
  readRelease(
    releaseId: ReleaseId,
  ): Promise<AppReleaseStoreResult<ReleaseRead>>;

  /** Create a Release if absent, or return the immutable existing record. */
  createReleaseIfAbsent(
    release: Release,
  ): Promise<AppReleaseStoreResult<ReleaseCreate>>;

  /** Look up one public Surface by its opaque identifier. */
  readPublicSurface(
    publicSurfaceId: PublicSurfaceId,
  ): Promise<AppReleaseStoreResult<PublicSurfaceRead>>;

  /** Create a public Surface if absent, or return the immutable existing record. */
  createPublicSurfaceIfAbsent(
    surface: PublicSurfaceDefinition,
  ): Promise<AppReleaseStoreResult<PublicSurfaceCreate>>;

  /** Read immutable Release facts needed by owner-issued transitions. */
  readonly readReleaseLifecycle?: (
    releaseId: ReleaseId,
  ) => Promise<AppReleaseStoreResult<ReleaseLifecycle>>;

  /** Atomically retain that one Release artifact was successfully verified. */
  readonly recordReleaseVerification?: (input: {
    readonly releaseId: ReleaseId;
    readonly digest: Sha256Digest;
    readonly mediaType: "application/vnd.fungi.app+json";
    readonly description: VerifiedAppDescription;
  }) => Promise<AppReleaseStoreResult<{ readonly kind: "recorded" }>>;

  /** Read one operation-scoped transition receipt before policy checks. */
  readonly readTransition?: (
    request: ReleaseTransition,
  ) => Promise<AppReleaseStoreResult<TransitionLookup>>;

  /** Atomically persist a validated transition and its terminal receipt. */
  readonly persistTransition?: (
    request: ReleaseTransition,
    receipt: TransitionReceipt,
  ) => Promise<AppReleaseStoreResult<TransitionPersistence>>;
};

/** Owner-issued transition request. */
export type ReleaseTransition =
  | {
      readonly kind: "promotion";
      readonly publicSurfaceId: PublicSurfaceId;
      readonly releaseId: ReleaseId;
      readonly idempotencyKey: IdempotencyKey;
    }
  | {
      readonly kind: "rollback";
      readonly publicSurfaceId: PublicSurfaceId;
      readonly releaseId: ReleaseId;
      readonly idempotencyKey: IdempotencyKey;
    }
  | {
      readonly kind: "revocation";
      readonly releaseId: ReleaseId;
      readonly idempotencyKey: IdempotencyKey;
    };

/** Terminal receipt for an owner-issued transition. */
export type TransitionReceipt = {
  readonly transition: ReleaseTransition;
  readonly transitionId: AppTransitionId;
};

/** Inputs for the catalog factory. */
export type AppReleaseCatalogOptions = {
  readonly artifactReader: ArtifactReader;
  readonly store: PromiseAppReleaseStore;
  readonly artifactPolicy?: {
    readonly maxBytes: number;
    readonly maxManifestBytes?: number;
  };
};

/** Public App Release catalog and public-website resolution seam. */
export type AppReleaseCatalog = {
  /** Create an App once and return the canonical stored record. */
  createApp(app: App): Promise<App>;

  /** Create a Release once and return the canonical stored record. */
  createRelease(release: Release): Promise<Release>;

  /** Resolve and verify the immutable artifact bound to a Release. */
  verifyReleaseArtifact(releaseId: ReleaseId): Promise<VerifiedArtifactRead>;

  /**
   * Read one verified, active Release snapshot and recheck its lifecycle.
   * The caller owns selection authorization and must resolve before each use.
   */
  resolveEligibleReleaseArtifact(
    releaseId: ReleaseId,
  ): Promise<VerifiedArtifactRead & { readonly release: Release }>;

  /** Resolve the UI and backend bound by one eligible immutable Release. */
  resolveEligibleApp(releaseId: ReleaseId): Promise<ResolvedApp>;

  /** Resolve verified App metadata without reading any artifact body. */
  resolveEligibleAppMetadata(
    releaseId: ReleaseId,
  ): Promise<ResolvedAppMetadata>;

  /** Resolve one selected Surface's current metadata authority without bodies. */
  resolvePublicSurfaceAuthority(
    stableRoute: StableRoute,
  ): Promise<PublicSurfaceAuthority>;

  /** Resolve one previously selected Release's current metadata authority. */
  resolvePublicSurfaceAuthorityVersion(
    stableRoute: StableRoute,
    releaseId: ReleaseId,
  ): Promise<PublicSurfaceAuthority>;

  /** Create a public Surface once and return the canonical stored record. */
  createPublicSurface(surface: PublicSurfaceDefinition): Promise<PublicSurface>;

  /** Apply one owner-issued promotion, rollback, or revocation request. */
  transition(request: ReleaseTransition): Promise<TransitionReceipt>;

  /** Resolve an asset-build root through the same current Surface authority. */
  resolvePublicAssetBuild(
    stableRoute: StableRoute,
  ): Promise<PublicAssetBuildRepresentation>;

  /** Resolve a pinned asset-build root through Surface authority. */
  resolvePublicAssetBuildVersion(
    stableRoute: StableRoute,
    releaseId: ReleaseId,
  ): Promise<PublicAssetBuildRepresentation>;

  /** Resolve the current eligible immutable website representation. */
  resolvePublicWebsite(
    stableRoute: StableRoute,
  ): Promise<PublicWebsiteRepresentation>;

  /** Resolve a pinned eligible immutable website representation. */
  resolvePublicWebsiteVersion(
    stableRoute: StableRoute,
    releaseId: ReleaseId,
  ): Promise<PublicWebsiteRepresentation>;
};

/** Names the parser boundary that rejected an untrusted value. */
export type AppReleaseParserName =
  | "AppId"
  | "ReleaseId"
  | "PublicSurfaceId"
  | "ArtifactRef"
  | "IdempotencyKey"
  | "SourceRevision"
  | "Sha256Digest"
  | "StableRoute"
  | "AppTransitionId";

/** Names a public catalog command whose hostile input was rejected. */
export type AppReleaseCommandName =
  | "createApp"
  | "createRelease"
  | "verifyReleaseArtifact"
  | "resolveEligibleReleaseArtifact"
  | "resolveEligibleAppMetadata"
  | "resolvePublicSurfaceAuthority"
  | "resolvePublicSurfaceAuthorityVersion"
  | "createPublicSurface"
  | "transition";

/** Fixed, non-leaking input failure for one public parser boundary. */
export class AppReleaseInputError extends Error {
  readonly parserName: AppReleaseParserName;

  constructor(parserName: AppReleaseParserName) {
    super(`Invalid ${parserName}`);
    this.name = "AppReleaseInputError";
    this.parserName = parserName;
  }
}

/** Fixed non-leaking input failure for one public catalog command. */
export class AppReleaseCommandInputError extends Error {
  readonly commandName: AppReleaseCommandName;

  constructor(commandName: AppReleaseCommandName) {
    super(`Invalid ${commandName} input`);
    this.name = "AppReleaseCommandInputError";
    this.commandName = commandName;
  }
}

/** Fixed non-leaking failure when a foreign Store success is structurally invalid. */
export class AppReleaseInvalidStoreResultError extends Error {
  constructor() {
    super("App Release store result is invalid");
    this.name = "AppReleaseInvalidStoreResultError";
  }
}

/** Fixed conflict when one Release ID receives changed immutable input. */
export class AppReleaseImmutableConflictError extends Error {
  constructor() {
    super("Release immutable input conflicts with its existing record");
    this.name = "AppReleaseImmutableConflictError";
  }
}

/** Fixed failure when a new Release references an App that does not exist. */
export class AppReleaseOwnerAppAbsentError extends Error {
  readonly appId: AppId;

  constructor(appId: AppId) {
    super("Release owner App does not exist");
    this.name = "AppReleaseOwnerAppAbsentError";
    this.appId = appId;
  }
}

/** Fixed failure when a new public Surface references an App that does not exist. */
export class AppReleaseSurfaceOwnerAppAbsentError extends Error {
  readonly appId: AppId;

  constructor(appId: AppId) {
    super("Public Surface owner App does not exist");
    this.name = "AppReleaseSurfaceOwnerAppAbsentError";
    this.appId = appId;
  }
}

/** Fixed non-leaking failure when the injected App Release store is unavailable. */
export class AppReleaseStoreUnavailableError extends Error {
  constructor() {
    super("App Release store is unavailable");
    this.name = "AppReleaseStoreUnavailableError";
  }
}

/** Fixed failure when artifact verification names no stored Release. */
export class AppReleaseReleaseAbsentError extends Error {
  constructor() {
    super("Release does not exist");
    this.name = "AppReleaseReleaseAbsentError";
  }
}

/** Fixed non-leaking failure when the injected artifact reader is unavailable. */
export class AppReleaseArtifactUnavailableError extends Error {
  constructor() {
    super("Release artifact is unavailable");
    this.name = "AppReleaseArtifactUnavailableError";
  }
}

/** Fixed failure when the requested artifact cannot be found. */
export class AppReleaseArtifactMissingError extends Error {
  constructor() {
    super("Release artifact is missing");
    this.name = "AppReleaseArtifactMissingError";
  }
}

/** Fixed failure when resolved artifact bytes do not match the expected digest. */
export class AppReleaseArtifactDigestMismatchError extends Error {
  constructor() {
    super("Release artifact digest does not match");
    this.name = "AppReleaseArtifactDigestMismatchError";
  }
}

/** Fixed failure when a hostile artifact read cannot form a valid snapshot. */
export class AppReleaseArtifactInvalidSnapshotError extends Error {
  constructor() {
    super("Release artifact snapshot is invalid");
    this.name = "AppReleaseArtifactInvalidSnapshotError";
  }
}

/** Error thrown when a catalog operation is not implemented in this slice. */
export class AppReleaseUnimplementedError extends Error {
  constructor() {
    super("App Release operation is not implemented");
    this.name = "AppReleaseUnimplementedError";
  }
}

/** Fixed failure when a transition names no stored Release. */
export class AppReleaseTransitionReleaseAbsentError extends Error {
  constructor() {
    super("Transition Release does not exist");
    this.name = "AppReleaseTransitionReleaseAbsentError";
  }
}

/** Fixed failure when promotion or rollback names an unverified Release. */
export class AppReleaseTransitionReleaseUnverifiedError extends Error {
  constructor() {
    super("Transition Release is not verified");
    this.name = "AppReleaseTransitionReleaseUnverifiedError";
  }
}

/** Fixed failure when a website selection names a non-HTML artifact. */
export class AppReleaseTransitionArtifactIncompatibleError extends Error {
  constructor() {
    super("Transition artifact is not compatible with a public website");
    this.name = "AppReleaseTransitionArtifactIncompatibleError";
  }
}

/** Fixed failure when promotion or rollback names a revoked Release. */
export class AppReleaseTransitionReleaseRevokedError extends Error {
  constructor() {
    super("Transition Release is revoked");
    this.name = "AppReleaseTransitionReleaseRevokedError";
  }
}

/** Fixed failure when a transition names no stored public Surface. */
export class AppReleaseTransitionSurfaceAbsentError extends Error {
  constructor() {
    super("Transition public Surface does not exist");
    this.name = "AppReleaseTransitionSurfaceAbsentError";
  }
}

/** Fixed failure when a Release is owned by another App than its Surface. */
export class AppReleaseTransitionOwnershipConflictError extends Error {
  constructor() {
    super("Transition Release is not owned by the public Surface App");
    this.name = "AppReleaseTransitionOwnershipConflictError";
  }
}

/** Fixed failure when an idempotency key is reused for changed material input. */
export class AppReleaseTransitionIdempotencyConflictError extends Error {
  constructor() {
    super("Transition idempotency key conflicts with its original request");
    this.name = "AppReleaseTransitionIdempotencyConflictError";
  }
}

/** Fixed, non-leaking failure when Cairn cannot issue a transition identity. */
export class AppReleaseTransitionIdUnavailableError extends Error {
  constructor() {
    super("App Release transition identity is unavailable");
    this.name = "AppReleaseTransitionIdUnavailableError";
  }
}

/** Fixed non-leaking failure for malformed, absent, or unselected routes. */
export class AppReleasePublicWebsiteNotFoundError extends Error {
  constructor() {
    super("Public website was not found");
    this.name = "AppReleasePublicWebsiteNotFoundError";
  }
}

/** Fixed non-leaking failure when public delivery cannot be proven safe. */
export class AppReleasePublicWebsiteUnavailableError extends Error {
  constructor() {
    super("Public website is unavailable");
    this.name = "AppReleasePublicWebsiteUnavailableError";
  }
}
