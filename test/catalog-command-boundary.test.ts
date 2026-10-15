import {
  platformSurface,
  fixturePlatformRoutes,
} from "./support/platform-publication.js";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
  AppReleaseCommandInputError,
  createAppReleaseCatalog,
  parseAppId,
  parseArtifactRef,
  parseIdempotencyKey,
  parsePublicSurfaceId,
  parseReleaseId,
  parseSha256Digest,
  parseSourceRevision,
  parseStableRoute,
  type App,
  type AppReleaseCommandName,
  type ArtifactReader,
  type PublicSurface,
  type Release,
  type ReleaseTransition,
} from "../dist/index.js";
import {
  adaptPromiseAppReleaseStore,
  adaptPromiseArtifactReader,
  createAppReleaseCore,
  createDeterministicMemoryAppReleaseStore,
  type AppReleaseCoreFailure,
} from "../dist/effect.js";

type ClosedCommandOutcome =
  | { readonly status: "fulfilled" }
  | { readonly status: "rejected"; readonly isExactCommandInputError: boolean };

const commandMessages = {
  createApp: "Invalid createApp input",
  createRelease: "Invalid createRelease input",
  createPublicSurface: "Invalid createPublicSurface input",
  verifyReleaseArtifact: "Invalid verifyReleaseArtifact input",
  resolveEligibleReleaseArtifact:
    "Invalid resolveEligibleReleaseArtifact input",
  resolveEligibleAppMetadata: "Invalid resolveEligibleAppMetadata input",
  resolvePublicSurfaceAuthority: "Invalid resolvePublicSurfaceAuthority input",
  resolvePublicSurfaceAuthorityVersion:
    "Invalid resolvePublicSurfaceAuthorityVersion input",
  transition: "Invalid transition input",
} satisfies Record<AppReleaseCommandName, string>;

const allowedOwnFailureProperties = ["commandName", "message", "name", "stack"];

function close<Value>(
  command: Promise<Value>,
  commandName: AppReleaseCommandName,
  hostileMarker: string,
): Promise<ClosedCommandOutcome> {
  return Promise.allSettled([command]).then((outcomes) => {
    const outcome = outcomes[0];
    if (outcome.status === "fulfilled") {
      return { status: "fulfilled" };
    }
    if (!(outcome.reason instanceof AppReleaseCommandInputError)) {
      return { status: "rejected", isExactCommandInputError: false };
    }
    const failure = outcome.reason;
    return {
      status: "rejected",
      isExactCommandInputError: isExactCommandInputError(
        failure,
        commandName,
        hostileMarker,
      ),
    };
  });
}

function closeEffect<Value>(
  command: Effect.Effect<Value, AppReleaseCoreFailure>,
  commandName: AppReleaseCommandName,
  hostileMarker: string,
): Promise<ClosedCommandOutcome> {
  return Promise.allSettled([Effect.runPromise(Effect.flip(command))]).then(
    (outcomes) => {
      const outcome = outcomes[0];
      if (outcome.status === "rejected") {
        return { status: "fulfilled" };
      }
      if (!(outcome.value instanceof AppReleaseCommandInputError)) {
        return { status: "rejected", isExactCommandInputError: false };
      }
      return {
        status: "rejected",
        isExactCommandInputError: isExactCommandInputError(
          outcome.value,
          commandName,
          hostileMarker,
        ),
      };
    },
  );
}

function isExactCommandInputError(
  failure: AppReleaseCommandInputError,
  commandName: AppReleaseCommandName,
  hostileMarker: string,
): boolean {
  return (
    failure.name === "AppReleaseCommandInputError" &&
    failure.message === commandMessages[commandName] &&
    failure.commandName === commandName &&
    !("cause" in failure) &&
    !("detail" in failure) &&
    Object.getOwnPropertyNames(failure).every((propertyName) =>
      allowedOwnFailureProperties.includes(propertyName),
    ) &&
    !failure.message.includes(hostileMarker)
  );
}

describe("App Release catalog command boundary", () => {
  it("closes hostile App Release commands before any domain or adapter decision", async () => {
    let artifactReaderCalls = 0;
    const artifactReader: ArtifactReader = {
      read: () => {
        artifactReaderCalls += 1;
        return Promise.resolve({ kind: "missing" });
      },
    };
    const memoryStore = createDeterministicMemoryAppReleaseStore(
      fixturePlatformRoutes,
    );
    let storeOperations = 0;
    const store = {
      readApp: (appId: ReturnType<typeof parseAppId>) => {
        storeOperations += 1;
        return memoryStore.readApp(appId);
      },
      createAppIfAbsent: (app: App) => {
        storeOperations += 1;
        return memoryStore.createAppIfAbsent(app);
      },
      readRelease: (releaseId: ReturnType<typeof parseReleaseId>) => {
        storeOperations += 1;
        return memoryStore.readRelease(releaseId);
      },
      createReleaseIfAbsent: (release: Release) => {
        storeOperations += 1;
        return memoryStore.createReleaseIfAbsent(release);
      },
      readPublicSurface: (
        publicSurfaceId: ReturnType<typeof parsePublicSurfaceId>,
      ) => {
        storeOperations += 1;
        return memoryStore.readPublicSurface(publicSurfaceId);
      },
      createPublicSurfaceIfAbsent: (surface: PublicSurface) => {
        storeOperations += 1;
        return memoryStore.createPublicSurfaceIfAbsent(
          platformSurface(surface),
        );
      },
    };
    const catalog = createAppReleaseCatalog({ artifactReader, store });
    const core = createAppReleaseCore({
      artifactReader: adaptPromiseArtifactReader(artifactReader),
      store: adaptPromiseAppReleaseStore(store),
    });

    const hostileAppMarker = "hostile-app-id";
    const app: App = { appId: parseAppId("app_orchid") };
    Object.defineProperty(app, "appId", { value: hostileAppMarker });

    const hostileReleaseMarker = "hostile-source-revision";
    const release: Release = {
      releaseId: parseReleaseId("rel_orchid"),
      appId: parseAppId("app_orchid"),
      artifact: {
        artifactRef: parseArtifactRef("artifact:orchid.release"),
        artifactDigest: parseSha256Digest(`sha256:${"a".repeat(64)}`),
        provenance: {
          sourceRevision: parseSourceRevision(`git:${"b".repeat(40)}`),
          sourceTreeDigest: parseSha256Digest(`sha256:${"c".repeat(64)}`),
          buildRecipeDigest: parseSha256Digest(`sha256:${"d".repeat(64)}`),
        },
      },
    };
    Object.defineProperty(release.artifact.provenance, "sourceRevision", {
      value: hostileReleaseMarker,
    });

    const hostileSurfaceMarker = "hostile-stable-route";
    const surface: PublicSurface = {
      publicSurfaceId: parsePublicSurfaceId("ps_orchid"),
      appId: parseAppId("app_orchid"),
      stableRoute: parseStableRoute("/orchid"),
    };
    Object.defineProperty(surface, "stableRoute", {
      value: hostileSurfaceMarker,
    });

    const hostileReleaseIdMarker = "hostile-release-id";
    const releaseId = { value: parseReleaseId("rel_orchid") };
    Object.defineProperty(releaseId, "value", {
      value: hostileReleaseIdMarker,
    });

    const hostileTransitionMarker = "hostile-idempotency-key";
    const transition: ReleaseTransition = {
      kind: "promotion",
      publicSurfaceId: parsePublicSurfaceId("ps_orchid"),
      releaseId: parseReleaseId("rel_orchid"),
      idempotencyKey: parseIdempotencyKey("idem_transition"),
    };
    Object.defineProperty(transition, "idempotencyKey", {
      value: hostileTransitionMarker,
    });

    const outcomes = await Promise.all([
      close(catalog.createApp(app), "createApp", hostileAppMarker),
      closeEffect(core.createApp(app), "createApp", hostileAppMarker),
      close(
        catalog.createRelease(release),
        "createRelease",
        hostileReleaseMarker,
      ),
      closeEffect(
        core.createRelease(release),
        "createRelease",
        hostileReleaseMarker,
      ),
      close(
        catalog.createPublicSurface(platformSurface(surface)),
        "createPublicSurface",
        hostileSurfaceMarker,
      ),
      closeEffect(
        core.createPublicSurface(platformSurface(surface)),
        "createPublicSurface",
        hostileSurfaceMarker,
      ),
      close(
        catalog.verifyReleaseArtifact(releaseId.value),
        "verifyReleaseArtifact",
        hostileReleaseIdMarker,
      ),
      closeEffect(
        core.verifyReleaseArtifact(releaseId.value),
        "verifyReleaseArtifact",
        hostileReleaseIdMarker,
      ),
      close(
        catalog.resolveEligibleReleaseArtifact(releaseId.value),
        "resolveEligibleReleaseArtifact",
        hostileReleaseIdMarker,
      ),
      closeEffect(
        core.resolveEligibleReleaseArtifact(releaseId.value),
        "resolveEligibleReleaseArtifact",
        hostileReleaseIdMarker,
      ),
      close(
        catalog.resolveEligibleAppMetadata(releaseId.value),
        "resolveEligibleAppMetadata",
        hostileReleaseIdMarker,
      ),
      closeEffect(
        core.resolveEligibleAppMetadata(releaseId.value),
        "resolveEligibleAppMetadata",
        hostileReleaseIdMarker,
      ),
      close(
        catalog.transition(transition),
        "transition",
        hostileTransitionMarker,
      ),
      closeEffect(
        core.transition(transition),
        "transition",
        hostileTransitionMarker,
      ),
    ]);

    expect(outcomes).toEqual([
      { status: "rejected", isExactCommandInputError: true },
      { status: "rejected", isExactCommandInputError: true },
      { status: "rejected", isExactCommandInputError: true },
      { status: "rejected", isExactCommandInputError: true },
      { status: "rejected", isExactCommandInputError: true },
      { status: "rejected", isExactCommandInputError: true },
      { status: "rejected", isExactCommandInputError: true },
      { status: "rejected", isExactCommandInputError: true },
      { status: "rejected", isExactCommandInputError: true },
      { status: "rejected", isExactCommandInputError: true },
      { status: "rejected", isExactCommandInputError: true },
      { status: "rejected", isExactCommandInputError: true },
      { status: "rejected", isExactCommandInputError: true },
      { status: "rejected", isExactCommandInputError: true },
    ]);
    expect(storeOperations).toBe(0);
    expect(artifactReaderCalls).toBe(0);
  });
});
