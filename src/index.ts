import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import {
  adaptPromiseAppReleaseStore,
  adaptPromiseArtifactReader,
  createAppReleaseCore,
  decodeAppId,
  decodeAppTransitionId,
  decodeArtifactRef,
  decodeIdempotencyKey,
  decodePublicSurfaceId,
  decodeReleaseId,
  decodeSha256Digest,
  decodeSourceRevision,
  decodeStableRoute,
} from "./effect.js";
import type { AppReleaseCoreFailure } from "./effect.js";
import { AppReleaseInputError } from "./internal/app-release-contract.js";
import { appSurfaceIdCodec } from "./internal/app-release-schema.js";
import type {
  AppReleaseCatalog,
  AppReleaseCatalogOptions,
  AppReleaseParserName,
} from "./internal/app-release-contract.js";

export * from "./internal/app-release-contract.js";
export {
  appCapabilityIds,
  appHandlers,
  appRoles,
  appStorageScopes,
  emptyAppDeclaration,
  isEmptyAppDeclaration,
} from "./app-vocabulary.js";
export type {
  AppApi,
  AppBackendBinding,
  AppCapabilityId,
  AppDeclaration,
  AppDeclaredCommand,
  AppHandler,
  AppRole,
  AppStorageScope,
  AppStorageKey,
} from "./app-vocabulary.js";

/** Structural subset of one canonical decoder result. */
type DecoderResult<Output> =
  | { readonly _tag: "Failure" }
  | { readonly _tag: "Success"; readonly success: Output };

/** Canonical decoder whose input and output remain private to the default root. */
type CanonicalDecoder<Input, Output> = (input: Input) => DecoderResult<Output>;

/**
 * Adapt one canonical decoder to the fixed public parser error boundary.
 *
 * The Effect-facing decoder remains the grammar authority; this root only
 * projects its success value or replaces every rejection with a fixed error.
 */
function makeParser<Input, Output>(
  parserName: AppReleaseParserName,
  decode: CanonicalDecoder<Input, Output>,
): (input: Input) => Output {
  return (input) => {
    const decoded = decode(input);
    if (decoded._tag === "Success") return decoded.success;
    throw new AppReleaseInputError(parserName);
  };
}

/** Parse an opaque Global App identifier. */
export const parseAppId = makeParser("AppId", decodeAppId);

/** Parse a Cairn-issued App transition identity. */
export const parseAppTransitionId = makeParser(
  "AppTransitionId",
  decodeAppTransitionId,
);

/** Parse an opaque immutable Release identifier. */
export const parseReleaseId = makeParser("ReleaseId", decodeReleaseId);

/** Parse an opaque anonymous public-Surface identifier. */
export const parsePublicSurfaceId = makeParser(
  "PublicSurfaceId",
  decodePublicSurfaceId,
);

/** Publisher issues customer Surface identities through Cairn, never from slugs. */
export const issuePublicSurfaceId = () =>
  parsePublicSurfaceId(appSurfaceIdCodec.generate());

/** Parse an opaque bounded artifact reference. */
export const parseArtifactRef = makeParser("ArtifactRef", decodeArtifactRef);

/** Parse a caller-provided idempotency key. */
export const parseIdempotencyKey = makeParser(
  "IdempotencyKey",
  decodeIdempotencyKey,
);

/** Parse a pinned lowercase Git source revision. */
export const parseSourceRevision = makeParser(
  "SourceRevision",
  decodeSourceRevision,
);

/** Parse a lowercase SHA-256 digest. */
export const parseSha256Digest = makeParser("Sha256Digest", decodeSha256Digest);

/** Parse a canonical local origin-relative stable route. */
export const parseStableRoute = makeParser("StableRoute", decodeStableRoute);

/**
 * Create the App Release catalog.
 *
 * The default Promise facade adapts each foreign port once before calling the
 * same Effect-native core.
 */
export function createAppReleaseCatalog(
  options: AppReleaseCatalogOptions,
): AppReleaseCatalog {
  const store = adaptPromiseAppReleaseStore(options.store);
  const artifactReader = adaptPromiseArtifactReader(options.artifactReader);
  const core =
    options.artifactPolicy === undefined
      ? createAppReleaseCore({ store, artifactReader })
      : createAppReleaseCore({
          store,
          artifactReader,
          artifactPolicy: options.artifactPolicy,
        });

  return {
    createApp: (app) => runDefault(core.createApp(app)),
    createRelease: (release) => runDefault(core.createRelease(release)),
    verifyReleaseArtifact: (releaseId) =>
      runDefault(core.verifyReleaseArtifact(releaseId)),
    resolveEligibleReleaseArtifact: (releaseId) =>
      runDefault(core.resolveEligibleReleaseArtifact(releaseId)),
    resolveEligibleApp: (releaseId) =>
      runDefault(core.resolveEligibleApp(releaseId)),
    resolveEligibleAppMetadata: (releaseId) =>
      runDefault(core.resolveEligibleAppMetadata(releaseId)),
    resolvePublicSurfaceAuthority: (stableRoute) =>
      runDefault(core.resolvePublicSurfaceAuthority(stableRoute)),
    resolvePublicSurfaceAuthorityVersion: (stableRoute, releaseId) =>
      runDefault(
        core.resolvePublicSurfaceAuthorityVersion(stableRoute, releaseId),
      ),
    createPublicSurface: (surface) =>
      runDefault(core.createPublicSurface(surface)),
    transition: (request) => runDefault(core.transition(request)),
    resolvePublicAssetBuild: (stableRoute) =>
      runDefault(core.resolvePublicAssetBuild(stableRoute)),
    resolvePublicAssetBuildVersion: (stableRoute, releaseId) =>
      runDefault(core.resolvePublicAssetBuildVersion(stableRoute, releaseId)),
    resolvePublicWebsite: (stableRoute) =>
      runDefault(core.resolvePublicWebsite(stableRoute)),
    resolvePublicWebsiteVersion: (stableRoute, releaseId) =>
      runDefault(core.resolvePublicWebsiteVersion(stableRoute, releaseId)),
  };
}

function runDefault<Value>(
  program: Effect.Effect<Value, AppReleaseCoreFailure>,
): Promise<Value> {
  return Effect.runPromiseExit(program).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    const error = failure ?? Cause.squash(exit.cause);
    return Promise.reject(
      error instanceof Error ? error : new Error(String(error)),
    );
  });
}
