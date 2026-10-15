import * as Schema from "effect/Schema";
import {
  isReservedPublicRoute,
  publicRouteKey,
  publicRoutePolicy,
  publicRouteConfigurationSchema,
  type PublicRouteConfiguration,
} from "../public-route-policy.js";
import type { TeamAppPublisherRegistration } from "../publisher.js";
import type {
  App,
  AppTransitionId,
  AppReleaseStoreResult,
  PublicSurface,
  PublicSurfaceDefinition,
  PromiseAppReleaseStore,
  ReleaseLifecycle,
  ReleaseTransition,
  Release,
  Sha256Digest,
  StableRoute,
  TransitionLookup,
  TransitionPersistence,
  TransitionReceipt,
  VerifiedAppDescription,
} from "./app-release-contract.js";
import type { PublicWebsiteAuthority } from "./public-website-authority.js";
import { registerPromisePublicWebsiteAuthorityReader } from "./public-website-authority.js";
import { sameReleaseTransitionMaterial } from "./release-transition-material.js";

function copyApp(app: App): App {
  return { appId: app.appId };
}

function copyRelease(release: Release): Release {
  return {
    releaseId: release.releaseId,
    appId: release.appId,
    artifact: {
      artifactRef: release.artifact.artifactRef,
      artifactDigest: release.artifact.artifactDigest,
      provenance: {
        sourceRevision: release.artifact.provenance.sourceRevision,
        sourceTreeDigest: release.artifact.provenance.sourceTreeDigest,
        buildRecipeDigest: release.artifact.provenance.buildRecipeDigest,
      },
    },
  };
}

function copyPublicSurface(surface: PublicSurface): PublicSurface {
  return {
    publicSurfaceId: surface.publicSurfaceId,
    appId: surface.appId,
    stableRoute: surface.stableRoute,
  };
}

function copyTransition(transition: ReleaseTransition): ReleaseTransition {
  return { ...transition };
}

function copyReceipt(receipt: TransitionReceipt): TransitionReceipt {
  return {
    transition: copyTransition(receipt.transition),
    transitionId: receipt.transitionId,
  };
}

function copyVerifiedAppDescription(
  description: VerifiedAppDescription,
): VerifiedAppDescription {
  return structuredClone(description);
}

function transitionKey(transition: ReleaseTransition): string {
  return `${transition.kind}:${transition.idempotencyKey}`;
}

type StoredTransition = Readonly<{
  request: ReleaseTransition;
  receipt: TransitionReceipt;
}>;

function transitionLookup(
  stored: StoredTransition | undefined,
  request: ReleaseTransition,
): TransitionLookup {
  if (stored === undefined) return { kind: "absent" };
  if (!sameReleaseTransitionMaterial(request, stored.request))
    return { kind: "conflict" };
  return { kind: "found", receipt: copyReceipt(stored.receipt) };
}

function successful<Value>(value: Value): AppReleaseStoreResult<Value> {
  return { kind: "success", value };
}

/**
 * Compose an in-process deterministic store for the narrow App/Release port.
 *
 * Store methods mutate only the private collections below. Decisions remain in
 * pure helpers, and every returned record is copied, so callers cannot mutate
 * retained state after an atomic create-or-observe operation.
 */
export function createDeterministicMemoryAppReleaseStore(
  options: {
    readonly routes: PublicRouteConfiguration;
    readonly publishers?: readonly TeamAppPublisherRegistration[];
  } = { routes: { platformRoutes: [], structuralRoutes: [] } },
): PromiseAppReleaseStore {
  const routes = Schema.decodeUnknownSync(publicRouteConfigurationSchema, {
    onExcessProperty: "error",
  })(options.routes);
  const apps = new Map<string, App>();
  const releases = new Map<string, Release>();
  const publicSurfaces = new Map<string, PublicSurfaceDefinition>();
  const claims = new Map<string, PublicSurfaceDefinition>();
  const eligibleSurface = (surface: PublicSurfaceDefinition): boolean => {
    const key = publicRouteKey(surface.stableRoute);
    const held = claims.get(key);
    if (held && held.publicSurfaceId !== surface.publicSurfaceId) return false;
    if (surface.publisher.kind === "platform")
      return routes.platformRoutes.some(
        (route) =>
          route.appId === surface.appId &&
          route.stableRoute === surface.stableRoute,
      );
    const publisher = options.publishers?.find(
      (value) => value.appId === surface.appId,
    );
    if (
      publisher?.teamId !== surface.publisher.teamId ||
      publisher.source.provider !== "artifacts" ||
      publisher.source.repository !== surface.appId ||
      !publisher.templateSeed ||
      publisher.templateSeed.appId === surface.appId
    )
      return false;
    if (held) return true;
    if (
      [...claims.values()].filter(
        (value) =>
          value.publisher.kind === "customer" &&
          value.publisher.teamId === surface.publisher.teamId,
      ).length >= publicRoutePolicy.maxPublicRoutesPerTeam
    )
      return false;
    return (
      !isReservedPublicRoute(surface.stableRoute, routes.structuralRoutes) &&
      !routes.platformRoutes.some(
        (value) => publicRouteKey(value.stableRoute) === key,
      )
    );
  };
  const verifications = new Map<
    string,
    Readonly<{
      digest: Sha256Digest;
      mediaType: "application/vnd.fungi.app+json";
      description: VerifiedAppDescription;
    }>
  >();
  const revokedReleases = new Set<string>();
  const selectedReleases = new Map<string, Release["releaseId"]>();
  const surfaceReleaseHistory = new Map<
    string,
    Map<Release["releaseId"], number>
  >();
  const transitions = new Map<string, StoredTransition>();
  const transitionIds = new Set<AppTransitionId>();

  const readMemoryReleaseLifecycle = (
    releaseId: Release["releaseId"],
  ): ReleaseLifecycle => {
    const release = releases.get(releaseId);
    const verification = verifications.get(releaseId);
    return release === undefined
      ? { kind: "absent" }
      : {
          kind: "found",
          release: copyRelease(release),
          verification:
            verification === undefined
              ? { kind: "unverified" }
              : {
                  kind: "verified",
                  digest: verification.digest,
                  mediaType: verification.mediaType,
                  description: copyVerifiedAppDescription(
                    verification.description,
                  ),
                },
          revocation: revokedReleases.has(releaseId)
            ? { kind: "revoked" }
            : { kind: "active" },
        };
  };

  const readPublicWebsiteAuthority = (request: {
    readonly stableRoute: StableRoute;
    readonly expectedReleaseId?: Release["releaseId"];
  }): Promise<AppReleaseStoreResult<PublicWebsiteAuthority>> => {
    const matches = [...claims.values()]
      .filter((surface) => surface.stableRoute === request.stableRoute)
      .slice(0, 2);
    if (matches.length === 0)
      return Promise.resolve(successful({ kind: "absent" }));
    if (matches.length === 2)
      return Promise.resolve(successful({ kind: "ambiguous" }));

    const surface = matches[0];
    if (surface === undefined) {
      return Promise.resolve({
        kind: "failure",
        failure: { kind: "unavailable" },
      });
    }
    const app = apps.get(surface.appId);
    if (app === undefined)
      return Promise.resolve({
        kind: "failure",
        failure: { kind: "unavailable" },
      });
    const currentReleaseId = selectedReleases.get(surface.publicSurfaceId);
    const releaseId = request.expectedReleaseId ?? currentReleaseId;
    const sequence =
      releaseId === undefined
        ? undefined
        : surfaceReleaseHistory.get(surface.publicSurfaceId)?.get(releaseId);
    if (
      currentReleaseId === undefined ||
      releaseId === undefined ||
      sequence === undefined
    ) {
      return Promise.resolve(
        successful({
          kind: "unselected",
          app: copyApp(app),
          surface: copyPublicSurface(surface),
        }),
      );
    }
    const lifecycle = readMemoryReleaseLifecycle(releaseId);
    return Promise.resolve(
      successful({
        kind: "selected",
        app: copyApp(app),
        surface: copyPublicSurface(surface),
        releaseId,
        currentReleaseId,
        sequence,
        release: lifecycle,
      }),
    );
  };

  const store: PromiseAppReleaseStore = {
    readApp(appId) {
      const app = apps.get(appId);
      return Promise.resolve(
        successful(
          app === undefined
            ? { kind: "absent" }
            : { kind: "found", app: copyApp(app) },
        ),
      );
    },
    createAppIfAbsent(app) {
      const existing = apps.get(app.appId);
      if (existing !== undefined) {
        return Promise.resolve(
          successful({ kind: "existing", app: copyApp(existing) }),
        );
      }

      const created = copyApp(app);
      apps.set(created.appId, created);
      return Promise.resolve(
        successful({ kind: "created", app: copyApp(created) }),
      );
    },
    readRelease(releaseId) {
      const release = releases.get(releaseId);
      return Promise.resolve(
        successful(
          release === undefined
            ? { kind: "absent" }
            : { kind: "found", release: copyRelease(release) },
        ),
      );
    },
    createReleaseIfAbsent(release) {
      const existing = releases.get(release.releaseId);
      if (existing !== undefined) {
        return Promise.resolve(
          successful({ kind: "existing", release: copyRelease(existing) }),
        );
      }

      const created = copyRelease(release);
      releases.set(created.releaseId, created);
      return Promise.resolve(
        successful({ kind: "created", release: copyRelease(created) }),
      );
    },
    readPublicSurface(publicSurfaceId) {
      const surface = publicSurfaces.get(publicSurfaceId);
      return Promise.resolve(
        successful(
          surface === undefined
            ? { kind: "absent" }
            : { kind: "found", surface: copyPublicSurface(surface) },
        ),
      );
    },
    createPublicSurfaceIfAbsent(surface) {
      const existing = [...publicSurfaces.values()].find(
        (value) =>
          value.publisher.teamId === surface.publisher.teamId &&
          value.publisher.requestKey === surface.publisher.requestKey,
      );
      if (existing !== undefined) {
        if (
          existing.appId !== surface.appId ||
          existing.stableRoute !== surface.stableRoute ||
          existing.publisher.kind !== surface.publisher.kind ||
          existing.publisher.userId !== surface.publisher.userId
        )
          return Promise.resolve(successful({ kind: "conflict" }));
        return Promise.resolve(
          successful({
            kind: "existing",
            surface: copyPublicSurface(existing),
          }),
        );
      }
      if (
        publicSurfaces.has(surface.publicSurfaceId) ||
        !eligibleSurface(surface) ||
        [...publicSurfaces.values()].filter(
          (value) =>
            value.appId === surface.appId &&
            !surfaceReleaseHistory.has(value.publicSurfaceId),
        ).length >= publicRoutePolicy.maxUnusedSurfacesPerApp
      )
        return Promise.resolve(successful({ kind: "conflict" }));
      const created = {
        ...copyPublicSurface(surface),
        publisher: { ...surface.publisher },
      };
      publicSurfaces.set(created.publicSurfaceId, created);
      return Promise.resolve(
        successful({ kind: "created", surface: copyPublicSurface(created) }),
      );
    },
    readReleaseLifecycle(releaseId) {
      return Promise.resolve(successful(readMemoryReleaseLifecycle(releaseId)));
    },
    recordReleaseVerification(input) {
      if (!releases.has(input.releaseId)) {
        return Promise.resolve({
          kind: "failure",
          failure: { kind: "unavailable" },
        });
      }
      const existing = verifications.get(input.releaseId);
      if (existing === undefined) {
        verifications.set(input.releaseId, {
          digest: input.digest,
          mediaType: input.mediaType,
          description: copyVerifiedAppDescription(input.description),
        });
      } else if (
        existing.digest !== input.digest ||
        JSON.stringify(existing.description) !==
          JSON.stringify(input.description)
      ) {
        return Promise.resolve({
          kind: "failure",
          failure: { kind: "unavailable" },
        });
      }
      return Promise.resolve(successful({ kind: "recorded" as const }));
    },
    readTransition(request) {
      const stored = transitions.get(transitionKey(request));
      return Promise.resolve(successful(transitionLookup(stored, request)));
    },
    persistTransition(request, receipt) {
      const key = transitionKey(request);
      const stored = transitions.get(key);
      if (stored !== undefined) {
        const persistence: TransitionPersistence =
          sameReleaseTransitionMaterial(request, stored.request)
            ? { kind: "existing", receipt: copyReceipt(stored.receipt) }
            : { kind: "conflict" };
        return Promise.resolve(successful(persistence));
      }

      if (
        request.kind !== "revocation" &&
        revokedReleases.has(request.releaseId)
      ) {
        return Promise.resolve(
          successful({ kind: "lifecycle-conflict" as const }),
        );
      }

      if (transitionIds.has(receipt.transitionId)) {
        return Promise.resolve(
          successful({ kind: "identity-collision" as const }),
        );
      }

      if (request.kind !== "revocation") {
        const surface = publicSurfaces.get(request.publicSurfaceId);
        const release = releases.get(request.releaseId);
        const verified = verifications.get(request.releaseId);
        if (
          !surface ||
          surface.appId !== release?.appId ||
          verified?.digest !== release.artifact.artifactDigest ||
          !eligibleSurface(surface) ||
          (request.kind === "rollback" &&
            !surfaceReleaseHistory
              .get(request.publicSurfaceId)
              ?.has(request.releaseId))
        )
          return Promise.resolve(
            successful({ kind: "lifecycle-conflict" as const }),
          );
        claims.set(publicRouteKey(surface.stableRoute), surface);
      }

      const savedRequest = copyTransition(request);
      const savedReceipt = copyReceipt(receipt);
      transitions.set(key, { request: savedRequest, receipt: savedReceipt });
      transitionIds.add(savedReceipt.transitionId);
      if (request.kind === "revocation") {
        revokedReleases.add(request.releaseId);
      } else {
        selectedReleases.set(request.publicSurfaceId, request.releaseId);
        const history = new Map(
          surfaceReleaseHistory.get(request.publicSurfaceId),
        );
        history.set(request.releaseId, transitions.size);
        surfaceReleaseHistory.set(request.publicSurfaceId, history);
      }
      return Promise.resolve(
        successful({ kind: "created", receipt: copyReceipt(savedReceipt) }),
      );
    },
  };
  registerPromisePublicWebsiteAuthorityReader(store, async (requests) => {
    const results = await Promise.all(requests.map(readPublicWebsiteAuthority));
    const values: PublicWebsiteAuthority[] = [];
    for (const result of results) {
      if (result.kind === "failure") return result;
      values.push(result.value);
    }
    return successful(values);
  });
  return store;
}
