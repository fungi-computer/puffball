import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import type {
  PublicSurface,
  PublicSurfaceAuthority,
  PublicWebsiteRepresentation,
  Release,
  ReleaseLifecycle,
  Sha256Digest,
  StableRoute,
  VerifiedArtifactRead,
  VerifiedAppArtifactReference,
} from "./app-release-contract.js";
import {
  AppReleasePublicWebsiteNotFoundError,
  AppReleasePublicWebsiteUnavailableError,
} from "./app-release-contract.js";
import type { AppReleaseArtifactReader } from "./app-release-artifact-reader.js";
import { decodeStableRoute } from "./app-release-schema.js";
import type { AppReleaseStore } from "./app-release-store.js";
import {
  getEffectPublicWebsiteAuthorityReader,
  type PublicWebsiteAuthority,
} from "./public-website-authority.js";
import { sameImmutableReleaseMaterial } from "./immutable-release-material.js";
import {
  readVerifiedArtifactSnapshot,
  type ArtifactSnapshotPolicy,
  DEFAULT_ARTIFACT_SNAPSHOT_POLICY,
} from "./verified-artifact-snapshot.js";

export type PublicWebsiteFailure =
  | AppReleasePublicWebsiteNotFoundError
  | AppReleasePublicWebsiteUnavailableError;

export type EligibleSurfaceRelease = Readonly<{
  appId: Release["appId"];
  releaseId: Release["releaseId"];
  stableRoute: StableRoute;
  artifactDigest: Sha256Digest;
  mediaType: "application/vnd.fungi.app+json";
}>;

/** Resolve the selected Surface's persisted metadata without loading bytes. */
export function createPublicSurfaceAuthorityResolver(options: {
  readonly store: AppReleaseStore;
}): (
  stableRoute: StableRoute,
) => Effect.Effect<PublicSurfaceAuthority, PublicWebsiteFailure> {
  return (stableRoute) =>
    decodeRoute(stableRoute).pipe(
      Effect.flatMap((route) =>
        readAuthority(options.store, route).pipe(
          Effect.flatMap((authority) =>
            resolveSurfaceAuthority(authority, route),
          ),
        ),
      ),
    );
}

/** Resolve one previously selected Release's current metadata authority. */
export function createPublicSurfaceAuthorityVersionResolver(options: {
  readonly store: AppReleaseStore;
}): (
  stableRoute: StableRoute,
  releaseId: Release["releaseId"],
) => Effect.Effect<PublicSurfaceAuthority, PublicWebsiteFailure> {
  return (stableRoute, releaseId) =>
    decodeRoute(stableRoute).pipe(
      Effect.flatMap((route) =>
        readAuthority(options.store, route, releaseId).pipe(
          Effect.flatMap((authority) =>
            resolveSurfaceAuthority(authority, route),
          ),
        ),
      ),
    );
}

/** Resolve the immutable owner of one stable route without selecting a Release. */
export function createPublicSurfaceResolver(options: {
  readonly store: AppReleaseStore;
}): (
  stableRoute: StableRoute,
) => Effect.Effect<PublicSurface, PublicWebsiteFailure> {
  return (stableRoute) =>
    decodeRoute(stableRoute).pipe(
      Effect.flatMap((route) =>
        readAuthority(options.store, route).pipe(
          Effect.flatMap((authority) => {
            if (authority.kind === "absent") return Effect.fail(notFound());
            if (
              authority.kind === "ambiguous" ||
              authority.surface.stableRoute !== route
            )
              return Effect.fail(unavailable());
            return Effect.succeed(authority.surface);
          }),
        ),
      ),
    );
}

/** Read current eligible Surface authority without loading executable bytes. */
export function createEligibleSurfaceReleaseResolver(options: {
  readonly store: AppReleaseStore;
}): (
  stableRoute: StableRoute,
) => Effect.Effect<EligibleSurfaceRelease, PublicWebsiteFailure> {
  const resolve = createEligibleSurfaceReleasesResolver(options);
  return (route) =>
    resolve([route]).pipe(
      Effect.flatMap((selections) => {
        const selection = selections[0];
        return selection === undefined
          ? Effect.fail(unavailable())
          : Effect.fromResult(selection);
      }),
    );
}

/** Read one atomic directory; eligibility failures belong to individual entries. */
export function createEligibleSurfaceReleasesResolver(options: {
  readonly store: AppReleaseStore;
}): (
  routes: readonly StableRoute[],
) => Effect.Effect<
  readonly Result.Result<EligibleSurfaceRelease, PublicWebsiteFailure>[],
  PublicWebsiteFailure
> {
  return (routes) =>
    Effect.gen(function* () {
      if (routes.length > 100) return yield* Effect.fail(unavailable());
      const parsed = yield* Effect.forEach(routes, decodeRoute);
      if (parsed.length === 0) return [];
      const read = getEffectPublicWebsiteAuthorityReader(options.store);
      if (read === undefined) return yield* Effect.fail(unavailable());
      const authorities = yield* read(
        parsed.map((stableRoute) => ({ stableRoute })),
      ).pipe(Effect.mapError(unavailable));
      if (authorities.length !== parsed.length)
        return yield* Effect.fail(unavailable());
      return yield* Effect.forEach(parsed, (route, index) => {
        const authority = authorities[index];
        if (authority === undefined) return Effect.fail(unavailable());
        return resolveEligibleAuthority(authority, route).pipe(
          Effect.map(
            ({ release }) =>
              ({
                appId: release.appId,
                releaseId: release.releaseId,
                stableRoute: route,
                artifactDigest: release.artifact.artifactDigest,
                mediaType: "application/vnd.fungi.app+json",
              }) satisfies EligibleSurfaceRelease,
          ),
          Effect.result,
        );
      });
    });
}

/** Resolve one eligible Release that has previously been selected on this Surface. */
export function createEligibleSurfaceVersionResolver(options: {
  readonly store: AppReleaseStore;
}): (
  stableRoute: StableRoute,
  releaseId: Release["releaseId"],
) => Effect.Effect<EligibleSurfaceRelease, PublicWebsiteFailure> {
  return (stableRoute, releaseId) =>
    createPublicSurfaceAuthorityVersionResolver(options)(
      stableRoute,
      releaseId,
    ).pipe(
      Effect.flatMap((authority) =>
        authority.revocation.kind === "active"
          ? Effect.succeed({
              appId: authority.release.appId,
              releaseId: authority.release.releaseId,
              stableRoute: authority.surface.stableRoute,
              artifactDigest: authority.digest,
              mediaType: "application/vnd.fungi.app+json" as const,
            })
          : Effect.fail(unavailable()),
      ),
    );
}

/** Media types accepted by the public website representation resolvers. */
export type PublicWebsiteMediaType =
  "text/html; charset=utf-8" | "application/vnd.fungi.app-assets+json";
type WebsiteSnapshot<MediaType extends PublicWebsiteMediaType> = Omit<
  VerifiedArtifactRead,
  "kind" | "mediaType"
> & {
  readonly mediaType: MediaType;
};

type CachedSnapshot<MediaType extends PublicWebsiteMediaType> = Readonly<{
  readonly digest: Sha256Digest;
  readonly artifact: WebsiteSnapshot<MediaType>;
}>;

/** Compose the one deep public delivery operation and its private cache. */
export function createPublicWebsiteResolver<
  MediaType extends PublicWebsiteMediaType,
>(options: {
  readonly mediaType: MediaType;
  readonly store: AppReleaseStore;
  readonly artifactReader: AppReleaseArtifactReader;
  readonly artifactPolicy?: ArtifactSnapshotPolicy;
}): (stableRoute: StableRoute) => Effect.Effect<
  Omit<PublicWebsiteRepresentation, "mediaType"> & {
    readonly mediaType: MediaType;
  },
  PublicWebsiteFailure
> {
  let cache: CachedSnapshot<MediaType> | undefined;
  const artifactPolicy =
    options.artifactPolicy ?? DEFAULT_ARTIFACT_SNAPSHOT_POLICY;

  return (stableRoute) =>
    decodeRoute(stableRoute).pipe(
      Effect.flatMap((route) =>
        readAuthority(options.store, route).pipe(
          Effect.map((authority) => ({ authority, route })),
        ),
      ),
      Effect.flatMap(({ authority, route }) =>
        resolveEligibleAuthority(authority, route).pipe(
          Effect.flatMap((eligible) =>
            readVerifiedArtifact(
              options.artifactReader,
              eligible.ui,
              artifactPolicy,
              options.mediaType,
            ).pipe(
              Effect.flatMap((artifact) =>
                readAuthority(options.store, route).pipe(
                  Effect.flatMap((second) =>
                    sameAuthority(authority, second)
                      ? Effect.succeed(
                          representation(
                            eligible.release.releaseId,
                            selectCache(cache, eligible.ui.digest, artifact),
                          ),
                        ).pipe(
                          Effect.tap((result) => {
                            cache = {
                              digest: result.digest,
                              artifact: {
                                digest: result.digest,
                                mediaType: result.mediaType,
                                byteLength: result.byteLength,
                                bytes: result.bytes,
                              },
                            };
                            return Effect.void;
                          }),
                        )
                      : Effect.fail(unavailable()),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
}

/** Compose pinned public delivery for a Release previously selected by a Surface. */
export function createPublicWebsiteVersionResolver<
  MediaType extends PublicWebsiteMediaType,
>(options: {
  readonly mediaType: MediaType;
  readonly store: AppReleaseStore;
  readonly artifactReader: AppReleaseArtifactReader;
  readonly artifactPolicy?: ArtifactSnapshotPolicy;
}): (
  stableRoute: StableRoute,
  releaseId: Release["releaseId"],
) => Effect.Effect<
  Omit<PublicWebsiteRepresentation, "mediaType"> & {
    readonly mediaType: MediaType;
  },
  PublicWebsiteFailure
> {
  let cache: CachedSnapshot<MediaType> | undefined;
  const artifactPolicy =
    options.artifactPolicy ?? DEFAULT_ARTIFACT_SNAPSHOT_POLICY;

  return (stableRoute, releaseId) =>
    decodeRoute(stableRoute).pipe(
      Effect.flatMap((route) =>
        readAuthority(options.store, route, releaseId).pipe(
          Effect.map((authority) => ({ authority, route })),
        ),
      ),
      Effect.flatMap(({ authority, route }) =>
        resolveEligibleAuthority(authority, route).pipe(
          Effect.flatMap((eligible) =>
            readVerifiedArtifact(
              options.artifactReader,
              eligible.ui,
              artifactPolicy,
              options.mediaType,
            ).pipe(
              Effect.flatMap((artifact) =>
                readAuthority(options.store, route, releaseId).pipe(
                  Effect.flatMap((second) => {
                    if (!sameAuthority(authority, second))
                      return Effect.fail(unavailable());
                    const selected = selectCache(
                      cache,
                      eligible.ui.digest,
                      artifact,
                    );
                    cache = { digest: selected.digest, artifact: selected };
                    return Effect.succeed(
                      representation(eligible.release.releaseId, selected),
                    );
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    );
}

function decodeRoute(
  input: StableRoute,
): Effect.Effect<StableRoute, AppReleasePublicWebsiteNotFoundError> {
  return Result.match(decodeStableRoute(input), {
    onFailure: () => Effect.fail(notFound()),
    onSuccess: Effect.succeed,
  });
}

function readAuthority(
  store: AppReleaseStore,
  stableRoute: StableRoute,
  expectedReleaseId?: Release["releaseId"],
): Effect.Effect<PublicWebsiteAuthority, AppReleasePublicWebsiteFailure> {
  const read = getEffectPublicWebsiteAuthorityReader(store);
  const request =
    expectedReleaseId === undefined
      ? { stableRoute }
      : { stableRoute, expectedReleaseId };
  return read === undefined
    ? Effect.fail(unavailable())
    : read([request]).pipe(
        Effect.mapError(unavailable),
        Effect.flatMap((values) =>
          values[0] === undefined
            ? Effect.fail(unavailable())
            : Effect.succeed(values[0]),
        ),
      );
}

type AppReleasePublicWebsiteFailure = AppReleasePublicWebsiteUnavailableError;

function resolveEligibleAuthority(
  authority: PublicWebsiteAuthority,
  requestedRoute: StableRoute,
): Effect.Effect<
  { readonly release: Release; readonly ui: VerifiedAppArtifactReference },
  PublicWebsiteFailure
> {
  return resolveSurfaceAuthority(authority, requestedRoute).pipe(
    Effect.flatMap((resolved) =>
      resolved.revocation.kind === "active"
        ? resolvePublishedUi(resolved)
        : Effect.fail(unavailable()),
    ),
  );
}

function resolveSurfaceAuthority(
  authority: PublicWebsiteAuthority,
  requestedRoute: StableRoute,
): Effect.Effect<PublicSurfaceAuthority, PublicWebsiteFailure> {
  if (authority.kind === "absent") return Effect.fail(notFound());
  if (authority.kind === "ambiguous") return Effect.fail(unavailable());
  if (authority.kind === "unselected") return Effect.fail(notFound());
  if (authority.surface.stableRoute !== requestedRoute)
    return Effect.fail(unavailable());
  if (authority.release.kind !== "found") return Effect.fail(unavailable());
  const release = authority.release.release;
  const verification = authority.release.verification;
  if (verification.kind !== "verified") return Effect.fail(unavailable());
  const coherent = [
    authority.releaseId === release.releaseId,
    authority.app.appId === authority.surface.appId,
    release.appId === authority.surface.appId,
    verification.digest === release.artifact.artifactDigest,
  ].every(Boolean);
  if (!coherent) return Effect.fail(unavailable());
  return Effect.succeed({
    app: authority.app,
    sequence: authority.sequence,
    currentReleaseId: authority.currentReleaseId,
    release,
    surface: authority.surface,
    digest: verification.digest,
    revocation: authority.release.revocation,
    description: verification.description,
  });
}

function resolvePublishedUi(
  authority: PublicSurfaceAuthority,
): Effect.Effect<
  { readonly release: Release; readonly ui: VerifiedAppArtifactReference },
  AppReleasePublicWebsiteUnavailableError
> {
  if (authority.description.ui === null) return Effect.fail(unavailable());
  return Effect.succeed({
    release: authority.release,
    ui: authority.description.ui,
  });
}

function readVerifiedArtifact<MediaType extends PublicWebsiteMediaType>(
  artifactReader: AppReleaseArtifactReader,
  artifactReference: VerifiedAppArtifactReference,
  artifactPolicy: ArtifactSnapshotPolicy,
  mediaType: MediaType,
): Effect.Effect<
  WebsiteSnapshot<MediaType>,
  AppReleasePublicWebsiteUnavailableError
> {
  return readVerifiedArtifactSnapshot(
    artifactReader,
    {
      artifactRef: artifactReference.artifactRef,
      expectedDigest: artifactReference.digest,
      expectedObject: {
        version: artifactReference.version,
        byteLength: artifactReference.byteLength,
      },
    },
    artifactPolicy,
  ).pipe(
    Effect.mapError(unavailable),
    Effect.flatMap((artifact) =>
      artifact.mediaType === mediaType
        ? Effect.succeed({
            ...artifact,
            mediaType,
          })
        : Effect.fail(unavailable()),
    ),
  );
}

function selectCache<MediaType extends PublicWebsiteMediaType>(
  cache: CachedSnapshot<MediaType> | undefined,
  expectedDigest: Sha256Digest,
  artifact: WebsiteSnapshot<MediaType>,
): WebsiteSnapshot<MediaType> {
  return cache?.digest === expectedDigest && artifact.digest === expectedDigest
    ? cache.artifact
    : artifact;
}

function representation<MediaType extends PublicWebsiteMediaType>(
  releaseId: Release["releaseId"],
  artifact: WebsiteSnapshot<MediaType>,
): Omit<PublicWebsiteRepresentation, "mediaType"> & {
  readonly mediaType: MediaType;
} {
  return {
    releaseId,
    digest: artifact.digest,
    mediaType: artifact.mediaType,
    byteLength: artifact.byteLength,
    bytes: {
      byteLength: artifact.byteLength,
      copy: () => artifact.bytes.copy(),
    },
  };
}

function sameAuthority(
  left: PublicWebsiteAuthority,
  right: PublicWebsiteAuthority,
): boolean {
  if (left.kind !== "selected" || right.kind !== "selected") return false;
  if (
    left.surface.publicSurfaceId !== right.surface.publicSurfaceId ||
    left.surface.appId !== right.surface.appId ||
    left.surface.stableRoute !== right.surface.stableRoute
  ) {
    return false;
  }
  return (
    left.releaseId === right.releaseId &&
    sameLifecycle(left.release, right.release)
  );
}

function sameLifecycle(
  left: ReleaseLifecycle,
  right: ReleaseLifecycle,
): boolean {
  if (left.kind !== "found" || right.kind !== "found")
    return left.kind === right.kind;
  const leftRelease = left.release;
  const rightRelease = right.release;
  return (
    sameImmutableReleaseMaterial(leftRelease, rightRelease) &&
    left.verification.kind === right.verification.kind &&
    (left.verification.kind !== "verified" ||
      right.verification.kind !== "verified" ||
      left.verification.digest === right.verification.digest) &&
    left.revocation.kind === right.revocation.kind
  );
}

function notFound(): AppReleasePublicWebsiteNotFoundError {
  return new AppReleasePublicWebsiteNotFoundError();
}

function unavailable(): AppReleasePublicWebsiteUnavailableError {
  return new AppReleasePublicWebsiteUnavailableError();
}
