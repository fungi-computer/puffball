import {
  platformSurface,
  fixturePlatformRoutes,
} from "./support/platform-publication.js";
import * as Effect from "effect/Effect";
import { expect, it } from "vitest";

import {
  createAppReleaseCatalog,
  parseAppId,
  parseArtifactRef,
  parseIdempotencyKey,
  parsePublicSurfaceId,
  parseReleaseId,
  parseSha256Digest,
  parseSourceRevision,
  parseStableRoute,
  type ArtifactReader,
  type PromiseAppReleaseStore,
  type Release,
  type StableRoute,
} from "../dist/index.js";
import {
  adaptPromiseAppReleaseStore,
  adaptPromiseArtifactReader,
  createAppReleaseCore,
  createDeterministicMemoryAppReleaseStore,
} from "../dist/effect.js";
import { registerPromisePublicWebsiteAuthorityReader } from "../dist/internal/public-website-authority.js";

type PublicWebsiteFailureName =
  | "AppReleasePublicWebsiteNotFoundError"
  | "AppReleasePublicWebsiteUnavailableError";

const digest = (character: string) =>
  parseSha256Digest(`sha256:${character.repeat(64)}`);

const html = "<!doctype html><p>orchid release</p>";
const expectedBytes = new TextEncoder().encode(html);

function isError(cause: unknown): cause is Error {
  return cause instanceof Error;
}

function publicWebsiteFailure(
  cause: Error,
  expectedName: PublicWebsiteFailureName,
  forbiddenMarker: string,
): void {
  expect(cause).toMatchObject({ name: expectedName });
  expect(cause.message).toBe(
    expectedName === "AppReleasePublicWebsiteNotFoundError"
      ? "Public website was not found"
      : "Public website is unavailable",
  );

  expect(cause.message).not.toContain(forbiddenMarker);
  expect("cause" in cause).toBe(false);
  expect("detail" in cause).toBe(false);
  expect("bytes" in cause).toBe(false);
  expect(Object.getOwnPropertyNames(cause).sort()).toEqual([
    "message",
    "name",
    "stack",
  ]);
}

async function rejected(
  operation: Promise<unknown>,
  expectedName: PublicWebsiteFailureName,
  forbiddenMarker: string,
): Promise<void> {
  const [outcome] = await Promise.allSettled([operation]);
  expect(outcome.status).toBe("rejected");
  if (outcome.status !== "rejected") return;
  expect(outcome.reason).toBeInstanceOf(Error);
  if (!isError(outcome.reason)) return;
  publicWebsiteFailure(outcome.reason, expectedName, forbiddenMarker);
}

async function rejectedEffect(
  operation: Effect.Effect<unknown, unknown>,
  expectedName: PublicWebsiteFailureName,
  forbiddenMarker: string,
): Promise<void> {
  const result = await Effect.runPromise(Effect.result(operation));
  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") return;
  expect(result.failure).toBeInstanceOf(Error);
  if (!isError(result.failure)) return;
  publicWebsiteFailure(result.failure, expectedName, forbiddenMarker);
}

function makeFixture(options?: {
  readonly store?: PromiseAppReleaseStore;
  readonly artifactReader?: ArtifactReader;
}) {
  const app = { appId: parseAppId("app_orchid") };
  const route = parseStableRoute("/orchid");
  const surface = {
    publicSurfaceId: parsePublicSurfaceId("ps_orchid"),
    appId: app.appId,
    stableRoute: route,
  };
  const release: Release = {
    releaseId: parseReleaseId("rel_orchid"),
    appId: app.appId,
    artifact: {
      artifactRef: parseArtifactRef("artifact:orchid.release"),
      artifactDigest: digest("a"),
      provenance: {
        sourceRevision: parseSourceRevision(`git:${"b".repeat(40)}`),
        sourceTreeDigest: digest("c"),
        buildRecipeDigest: digest("d"),
      },
    },
  };
  const uiArtifactRef = parseArtifactRef("artifact:orchid.ui");
  const uiDigest = digest("e");
  const uiBuild = {
    artifactRef: uiArtifactRef,
    digest: uiDigest,
    version: "v1",
    byteLength: expectedBytes.byteLength,
    mediaType: "text/html; charset=utf-8" as const,
  };
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({
      format: "fungi-app-v1",
      ui: uiBuild,
    }),
  );
  const backing = expectedBytes.slice();
  let readerCalls = 0;
  let readerResult: "verified" | "unavailable" = "verified";
  const artifactReader =
    options?.artifactReader ??
    ({
      read: (input) => {
        readerCalls += 1;
        if (readerResult === "unavailable") {
          return Promise.reject(new Error("artifact-reader-sentinel"));
        }
        const isManifest = input.artifactRef === release.artifact.artifactRef;
        const bytes = isManifest ? manifestBytes : backing;
        return Promise.resolve({
          kind: "verified" as const,
          digest: input.expectedDigest,
          mediaType: isManifest
            ? ("application/vnd.fungi.app+json" as const)
            : ("text/html; charset=utf-8" as const),
          bytes: {
            byteLength: bytes.byteLength,
            copy: () => bytes.slice(),
          },
          byteLength: bytes.byteLength,
        });
      },
    } satisfies ArtifactReader);
  const store =
    options?.store ??
    createDeterministicMemoryAppReleaseStore(fixturePlatformRoutes);
  const catalog = createAppReleaseCatalog({ artifactReader, store });
  const core = createAppReleaseCore({
    artifactReader: adaptPromiseArtifactReader(artifactReader),
    store: adaptPromiseAppReleaseStore(store),
  });

  return {
    app,
    artifactReader,
    backing,
    catalog,
    core,
    getReaderCalls: () => readerCalls,
    release,
    route,
    setReaderResult: (result: "verified" | "unavailable") => {
      readerResult = result;
    },
    store,
    surface,
    appDescription: {
      format: "fungi-app-v1" as const,
      ui: uiBuild,
      backend: null,
      declaration: { capabilities: [], handlers: [], roles: [] },
    },
    uiArtifactRef,
    uiDigest,
  };
}

async function seedSelectedRelease(
  fixture: ReturnType<typeof makeFixture>,
): Promise<void> {
  await expect(fixture.catalog.createApp(fixture.app)).resolves.toEqual(
    fixture.app,
  );
  await expect(
    fixture.catalog.createPublicSurface(platformSurface(fixture.surface)),
  ).resolves.toEqual(fixture.surface);
  await expect(fixture.catalog.createRelease(fixture.release)).resolves.toEqual(
    fixture.release,
  );
  await expect(
    fixture.catalog.verifyReleaseArtifact(fixture.release.releaseId),
  ).resolves.toMatchObject({
    kind: "verified",
    digest: fixture.release.artifact.artifactDigest,
  });
  await expect(
    fixture.catalog.transition({
      kind: "promotion",
      publicSurfaceId: fixture.surface.publicSurfaceId,
      releaseId: fixture.release.releaseId,
      idempotencyKey: parseIdempotencyKey("idem_orchidpromotion"),
    }),
  ).resolves.toMatchObject({
    transition: {
      kind: "promotion",
      publicSurfaceId: fixture.surface.publicSurfaceId,
      releaseId: fixture.release.releaseId,
    },
  });
}

it("resolves eligible Surface authority without reading artifact bytes", async () => {
  const fixture = makeFixture();
  await seedSelectedRelease(fixture);
  const readsBeforeAdmission = fixture.getReaderCalls();

  await expect(
    Effect.runPromise(
      fixture.core.resolveEligibleSurfaceRelease(fixture.route),
    ),
  ).resolves.toEqual({
    appId: fixture.app.appId,
    releaseId: fixture.release.releaseId,
    stableRoute: fixture.route,
    artifactDigest: fixture.release.artifact.artifactDigest,
    mediaType: "application/vnd.fungi.app+json",
  });
  expect(fixture.getReaderCalls()).toBe(readsBeforeAdmission);
});

it("bounds directory resolution before invoking storage or artifacts", async () => {
  const fixture = makeFixture();
  registerPromisePublicWebsiteAuthorityReader(fixture.store, () => {
    throw new Error("invalid or empty directory must not query storage");
  });
  const core = createAppReleaseCore({
    store: adaptPromiseAppReleaseStore(fixture.store),
    artifactReader: adaptPromiseArtifactReader(fixture.artifactReader),
  });
  await expect(
    Effect.runPromise(core.resolveEligibleSurfaceReleases([])),
  ).resolves.toEqual([]);
  await expect(
    Effect.runPromise(
      Effect.result(
        core.resolveEligibleSurfaceReleases(
          Array.from({ length: 101 }, () => fixture.route),
        ),
      ),
    ),
  ).resolves.toMatchObject({
    _tag: "Failure",
    failure: { name: "AppReleasePublicWebsiteUnavailableError" },
  });
  expect(fixture.getReaderCalls()).toBe(0);
});

it("fails the directory read when storage is unavailable instead of reporting ineligible entries", async () => {
  const fixture = makeFixture();
  await seedSelectedRelease(fixture);
  registerPromisePublicWebsiteAuthorityReader(fixture.store, () =>
    Promise.resolve({ kind: "failure", failure: { kind: "unavailable" } }),
  );
  const core = createAppReleaseCore({
    store: adaptPromiseAppReleaseStore(fixture.store),
    artifactReader: adaptPromiseArtifactReader(fixture.artifactReader),
  });
  await rejectedEffect(
    core.resolveEligibleSurfaceReleases([fixture.route]),
    "AppReleasePublicWebsiteUnavailableError",
    "storage",
  );
});

it("resolves one persisted Surface authority snapshot without artifact reads", async () => {
  const fixture = makeFixture();
  await seedSelectedRelease(fixture);
  const readsBeforeAdmission = fixture.getReaderCalls();

  await expect(
    fixture.catalog.resolvePublicSurfaceAuthority(fixture.route),
  ).resolves.toEqual({
    sequence: 1,
    currentReleaseId: fixture.release.releaseId,
    app: fixture.app,
    release: fixture.release,
    surface: fixture.surface,
    digest: fixture.release.artifact.artifactDigest,
    revocation: { kind: "active" },
    description: fixture.appDescription,
  });
  expect(fixture.getReaderCalls()).toBe(readsBeforeAdmission);

  await fixture.catalog.transition({
    kind: "revocation",
    releaseId: fixture.release.releaseId,
    idempotencyKey: parseIdempotencyKey("idem_orchidmetadatarevocation"),
  });
  await expect(
    fixture.catalog.resolvePublicSurfaceAuthority(fixture.route),
  ).resolves.toMatchObject({
    digest: fixture.release.artifact.artifactDigest,
    revocation: { kind: "revoked" },
    description: fixture.appDescription,
  });
  expect(fixture.getReaderCalls()).toBe(readsBeforeAdmission);
});

it("resolvePublicWebsite returns the same verified digest cold and warm and fails closed after revocation", async () => {
  const fixture = makeFixture();

  // These current bytes are conformance evidence only. The predecessor receipt
  // is historical evidence for its archived test bytes; the remainder is the
  // frozen public-seam contract.
  expect(fixture.catalog).toHaveProperty("resolvePublicWebsite");

  await seedSelectedRelease(fixture);
  const catalog = fixture.catalog;
  const core = fixture.core;

  const cold = await catalog.resolvePublicWebsite(fixture.route);
  const warm = await catalog.resolvePublicWebsite(fixture.route);
  const effect = await Effect.runPromise(
    core.resolvePublicWebsite(fixture.route),
  );

  for (const representation of [cold, warm, effect]) {
    expect(representation).toMatchObject({
      releaseId: fixture.release.releaseId,
      digest: fixture.uiDigest,
      mediaType: "text/html; charset=utf-8",
      byteLength: expectedBytes.byteLength,
    });
    expect(representation.bytes.copy()).toEqual(expectedBytes);
  }
  expect(cold.digest).toBe(warm.digest);
  expect(cold.digest).toBe(effect.digest);
  // Verification and promotion validate the manifest and UI; each website read
  // then verifies only the selected immutable UI object.
  expect(fixture.getReaderCalls()).toBe(7);

  const coldCopy = cold.bytes.copy();
  const warmCopy = warm.bytes.copy();
  expect(coldCopy).not.toBe(warmCopy);
  coldCopy[0] = 0;
  expect(warmCopy).toEqual(expectedBytes);
  fixture.backing[0] = 0;
  expect(effect.bytes.copy()).toEqual(expectedBytes);

  const readerCallsBeforeForgedRoute = fixture.getReaderCalls();
  // SAFETY: This deliberately malformed route models an untyped caller forging the branded public boundary.
  await rejected(
    catalog.resolvePublicWebsite("/orchid?forged-route" as StableRoute),
    "AppReleasePublicWebsiteNotFoundError",
    "forged-route",
  );
  // SAFETY: This deliberately malformed route models an untyped caller forging the branded public boundary.
  await rejectedEffect(
    core.resolvePublicWebsite("/orchid?forged-route" as StableRoute),
    "AppReleasePublicWebsiteNotFoundError",
    "forged-route",
  );
  expect(fixture.getReaderCalls()).toBe(readerCallsBeforeForgedRoute);

  fixture.setReaderResult("unavailable");
  await rejected(
    catalog.resolvePublicWebsite(fixture.route),
    "AppReleasePublicWebsiteUnavailableError",
    "artifact-reader-sentinel",
  );

  fixture.setReaderResult("verified");
  await expect(
    fixture.catalog.transition({
      kind: "revocation",
      releaseId: fixture.release.releaseId,
      idempotencyKey: parseIdempotencyKey("idem_orchidrevocation"),
    }),
  ).resolves.toMatchObject({
    transition: { kind: "revocation", releaseId: fixture.release.releaseId },
  });
  await rejected(
    catalog.resolvePublicWebsite(fixture.route),
    "AppReleasePublicWebsiteUnavailableError",
    "orchid release",
  );
  await rejectedEffect(
    core.resolvePublicWebsite(fixture.route),
    "AppReleasePublicWebsiteUnavailableError",
    "orchid release",
  );

  const authorityFixture = makeFixture();
  await seedSelectedRelease(authorityFixture);
  let revocationCommitted = false;
  const revokingArtifactReader: ArtifactReader = {
    read: async (input) => {
      const result = await authorityFixture.artifactReader.read(input);
      await authorityFixture.catalog.transition({
        kind: "revocation",
        releaseId: authorityFixture.release.releaseId,
        idempotencyKey: parseIdempotencyKey("idem_racingrevocation"),
      });
      revocationCommitted = true;
      return result;
    },
  };
  const racingCatalog = createAppReleaseCatalog({
    artifactReader: revokingArtifactReader,
    store: authorityFixture.store,
  });
  await rejected(
    racingCatalog.resolvePublicWebsite(authorityFixture.route),
    "AppReleasePublicWebsiteUnavailableError",
    "orchid release",
  );
  expect(revocationCommitted).toBe(true);
});

it("resolvePublicWebsite closes hostile artifact-reader results as unavailable", async () => {
  const fixture = makeFixture();
  await seedSelectedRelease(fixture);

  const hostileMarker = "hostile-artifact-reader-sentinel";
  const hostileResult = {
    kind: "verified" as const,
    digest: fixture.uiDigest,
    mediaType: "text/html; charset=utf-8" as const,
    bytes: {
      byteLength: expectedBytes.byteLength,
      copy: () => expectedBytes.slice(),
    },
    byteLength: expectedBytes.byteLength,
    [hostileMarker]: hostileMarker,
  };
  const hostileArtifactReader: ArtifactReader = {
    read: () => Promise.resolve(hostileResult),
  };
  const catalog = createAppReleaseCatalog({
    artifactReader: hostileArtifactReader,
    store: fixture.store,
  });
  const core = createAppReleaseCore({
    artifactReader: adaptPromiseArtifactReader(hostileArtifactReader),
    store: adaptPromiseAppReleaseStore(fixture.store),
  });

  await rejected(
    catalog.resolvePublicWebsite(fixture.route),
    "AppReleasePublicWebsiteUnavailableError",
    hostileMarker,
  );
  await rejectedEffect(
    core.resolvePublicWebsite(fixture.route),
    "AppReleasePublicWebsiteUnavailableError",
    hostileMarker,
  );
});

it("resolvePublicWebsite rejects authority snapshots for a different route", async () => {
  const fixture = makeFixture();
  await seedSelectedRelease(fixture);

  const wrongRouteAuthority = {
    kind: "selected" as const,
    releaseId: fixture.release.releaseId,
    sequence: 1,
    currentReleaseId: fixture.release.releaseId,
    app: fixture.app,
    surface: {
      ...fixture.surface,
      stableRoute: parseStableRoute("/lotus"),
    },
    release: {
      kind: "found" as const,
      release: fixture.release,
      verification: {
        kind: "verified" as const,
        digest: fixture.release.artifact.artifactDigest,
        mediaType: "application/vnd.fungi.app+json" as const,
        description: fixture.appDescription,
      },
      revocation: { kind: "active" as const },
    },
  };
  registerPromisePublicWebsiteAuthorityReader(fixture.store, () =>
    Promise.resolve({ kind: "success", value: [wrongRouteAuthority] }),
  );

  const catalog = createAppReleaseCatalog({
    artifactReader: fixture.artifactReader,
    store: fixture.store,
  });
  const core = createAppReleaseCore({
    artifactReader: adaptPromiseArtifactReader(fixture.artifactReader),
    store: adaptPromiseAppReleaseStore(fixture.store),
  });

  await rejected(
    catalog.resolvePublicWebsite(fixture.route),
    "AppReleasePublicWebsiteUnavailableError",
    html,
  );
  await rejectedEffect(
    core.resolvePublicWebsite(fixture.route),
    "AppReleasePublicWebsiteUnavailableError",
    html,
  );
});

it("rejects backend website promotion and preserves the current HTML selection", async () => {
  const fixture = makeFixture();
  await seedSelectedRelease(fixture);

  const backendId = parseReleaseId("rel_backend");
  const backendRef = parseArtifactRef("artifact:backend");
  const manifestRef = parseArtifactRef("artifact:backend.release");
  const backendDigest = digest("f");
  const backendBytes = new TextEncoder().encode(
    JSON.stringify({
      runtime: { kind: "durable-facet", stateSchema: 1 },
      compatibilityDate: "2026-09-18",
      exportName: "Backend",
      code: "export default {};",
    }),
  );
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({
      format: "fungi-app-v1",
      backend: {
        artifactRef: backendRef,
        digest: backendDigest,
        version: "v1",
        byteLength: backendBytes.byteLength,
        mediaType: "application/vnd.fungi.app-backend+json",
      },
    }),
  );
  const artifactReader: ArtifactReader = {
    read: (input) => {
      if (input.artifactRef === manifestRef) {
        return Promise.resolve({
          kind: "verified",
          digest: input.expectedDigest,
          mediaType: "application/vnd.fungi.app+json",
          bytes: {
            byteLength: manifestBytes.byteLength,
            copy: () => manifestBytes.slice(),
          },
          byteLength: manifestBytes.byteLength,
        });
      }
      if (input.artifactRef === backendRef) {
        return Promise.resolve({
          kind: "verified",
          digest: input.expectedDigest,
          mediaType: "application/vnd.fungi.app-backend+json",
          bytes: {
            byteLength: backendBytes.byteLength,
            copy: () => backendBytes.slice(),
          },
          byteLength: backendBytes.byteLength,
        });
      }
      return fixture.artifactReader.read(input);
    },
  };
  const catalog = createAppReleaseCatalog({
    artifactReader,
    store: fixture.store,
  });
  const backend = {
    ...fixture.release,
    releaseId: backendId,
    artifact: {
      ...fixture.release.artifact,
      artifactRef: manifestRef,
      artifactDigest: digest("9"),
    },
  };
  await catalog.createRelease(backend);
  await catalog.verifyReleaseArtifact(backendId);
  expect(
    (await catalog.resolveEligibleReleaseArtifact(backendId)).release,
  ).toEqual(backend);
  for (const kind of ["promotion", "rollback"] as const) {
    await expect(
      catalog.transition({
        kind,
        releaseId: backendId,
        publicSurfaceId: fixture.surface.publicSurfaceId,
        idempotencyKey: parseIdempotencyKey(`idem_backend${kind}`),
      }),
    ).rejects.toMatchObject({
      name: "AppReleaseTransitionArtifactIncompatibleError",
    });
    expect(await catalog.resolvePublicWebsite(fixture.route)).toMatchObject({
      releaseId: fixture.release.releaseId,
    });
  }
});
