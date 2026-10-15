import { createFixturePlatformSurface } from "./support/platform-surface.mjs";
import { TextEncoder } from "node:util";

import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import * as Effect from "effect/Effect";

import {
  AppReleaseInvalidStoreResultError,
  AppReleaseTransitionIdempotencyConflictError,
  createAppReleaseCatalog,
  parseAppId,
  parseArtifactRef,
  parseIdempotencyKey,
  parsePublicSurfaceId,
  parseReleaseId,
  parseSha256Digest,
  parseSourceRevision,
  parseStableRoute,
} from "../dist/index.js";
import {
  APP_RELEASE_D1_FRESH_SCHEMA,
  createD1AppReleaseStore,
  createD1TransitionObligationStore,
  createR2ArtifactReader,
  matchEligibleSurfaceTransitionBasis,
  readD1SurfaceTransitionBasis,
} from "../dist/cloudflare.js";
import {
  adaptPromiseAppReleaseStore,
  adaptPromiseArtifactReader,
  createAppReleaseCore,
  createDeterministicMemoryAppReleaseStore,
} from "../dist/effect.js";

const transitionIdPattern = /^app_transition_[a-z0-9]{21}$/;
const app = { appId: parseAppId("app_transitionlaw") };
const surface = {
  publicSurfaceId: parsePublicSurfaceId("ps_transitionlaw"),
  appId: app.appId,
  stableRoute: parseStableRoute("/transitionlaw"),
};

const releaseA = createRelease("a");
const releaseB = createRelease("b");

beforeAll(async () => {
  await env.APP_RELEASE_CATALOG.exec(APP_RELEASE_D1_FRESH_SCHEMA);
});

function createRelease(name) {
  const rootDigest = {
    a: "80667e3709037ad6f0d5411d06a02bf571c8bc33f222e8fd30e597ada2f60b35",
    b: "e4db4a67075f7534286f761680aa35467cc16e0bebfd027d3a495864ff37e188",
  }[name];
  return {
    releaseId: parseReleaseId(`rel_transitionlaw${name}`),
    appId: app.appId,
    artifact: {
      artifactRef: parseArtifactRef(`artifact:transitionlaw.release-${name}`),
      artifactDigest: parseSha256Digest(`sha256:${rootDigest}`),
      provenance: {
        sourceRevision: parseSourceRevision(`git:${name.repeat(40)}`),
        sourceTreeDigest: parseSha256Digest(`sha256:${"b".repeat(64)}`),
        buildRecipeDigest: parseSha256Digest(`sha256:${"c".repeat(64)}`),
      },
    },
  };
}

const artifacts = new Map([
  [
    releaseA.artifact.artifactRef,
    new TextEncoder().encode(
      JSON.stringify({
        format: "fungi-app-v1",
        ui: {
          artifactRef: "artifact:transitionlaw.ui-a",
          digest:
            "sha256:6b7cd97dea1eb2ef9aac16b4dfdf55f2287134924ae12586f122b204f65e5a65",
          version: "v1",
          byteLength: 23,
          mediaType: "text/html; charset=utf-8",
        },
      }),
    ),
  ],
  [
    releaseB.artifact.artifactRef,
    new TextEncoder().encode(
      JSON.stringify({
        format: "fungi-app-v1",
        ui: {
          artifactRef: "artifact:transitionlaw.ui-b",
          digest:
            "sha256:1a674a48c2860b41fa113ab0c1a3a8fb289ac322feb77d9689f0404dc6b59611",
          version: "v1",
          byteLength: 23,
          mediaType: "text/html; charset=utf-8",
        },
      }),
    ),
  ],
  [
    parseArtifactRef("artifact:transitionlaw.ui-a"),
    new TextEncoder().encode("<!doctype html><p>a</p>"),
  ],
  [
    parseArtifactRef("artifact:transitionlaw.ui-b"),
    new TextEncoder().encode("<!doctype html><p>b</p>"),
  ],
]);

function createMemoryArtifactReader() {
  return {
    read: async ({ artifactRef, expectedDigest }) => {
      const bytes = artifacts.get(artifactRef);
      if (bytes === undefined) return { kind: "missing" };
      return {
        kind: "verified",
        digest: expectedDigest,
        mediaType: artifactRef.includes(".release-")
          ? "application/vnd.fungi.app+json"
          : "text/html; charset=utf-8",
        bytes: { byteLength: bytes.byteLength, copy: () => bytes.slice() },
        byteLength: bytes.byteLength,
      };
    },
  };
}

function createFixtureR2ArtifactReader() {
  return createR2ArtifactReader({
    get: async (key) => {
      const object = await env.APP_RELEASE_ARTIFACTS.get(key);
      return object === null
        ? null
        : {
            version: "v1",
            size: object.size,
            httpMetadata: object.httpMetadata,
            arrayBuffer: object.arrayBuffer.bind(object),
          };
    },
  });
}

async function seedCatalog(catalog) {
  await catalog.createApp(app);
  await createFixturePlatformSurface(catalog, env.APP_RELEASE_CATALOG, surface);
  await catalog.createRelease(releaseA);
  await catalog.createRelease(releaseB);
  await catalog.verifyReleaseArtifact(releaseA.releaseId);
  await catalog.verifyReleaseArtifact(releaseB.releaseId);
}

function promotion(idempotencyKey, releaseId = releaseA.releaseId) {
  return {
    kind: "promotion",
    publicSurfaceId: surface.publicSurfaceId,
    releaseId,
    idempotencyKey: parseIdempotencyKey(idempotencyKey),
  };
}

async function assertTransitionLaws(createCatalog) {
  let catalog = createCatalog();
  await seedCatalog(catalog);

  const firstRequest = promotion("idem_transitionlaw_first");
  const first = await catalog.transition(firstRequest);

  expect(first.transition).toEqual(firstRequest);
  expect(first.transition.publicSurfaceId).toBe(surface.publicSurfaceId);
  expect(first.transition.releaseId).toBe(releaseA.releaseId);
  expect(first.transitionId).toMatch(transitionIdPattern);
  expect(first.transitionId).not.toMatch(/^transition_[0-9]+$/);

  const replay = await catalog.transition(firstRequest);
  expect(replay).toEqual(first);

  catalog = createCatalog();
  const changedMaterial = promotion(
    "idem_transitionlaw_first",
    releaseB.releaseId,
  );
  await expect(catalog.transition(changedMaterial)).rejects.toBeInstanceOf(
    AppReleaseTransitionIdempotencyConflictError,
  );
  await expect(catalog.transition(firstRequest)).resolves.toEqual(first);

  catalog = createCatalog();
  const concurrentRequest = promotion("idem_transitionlaw_concurrent");
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, () => catalog.transition(concurrentRequest)),
  );
  expect(concurrent).toHaveLength(8);
  for (const receipt of concurrent) {
    expect(receipt).toEqual(concurrent[0]);
    expect(receipt.transition).toEqual(concurrentRequest);
    expect(receipt.transitionId).toMatch(transitionIdPattern);
  }
  expect(concurrent[0].transitionId).not.toBe(first.transitionId);
}

function createHostileStore() {
  const store = createDeterministicMemoryAppReleaseStore({
    routes: {
      platformRoutes: [{ appId: app.appId, stableRoute: surface.stableRoute }],
      structuralRoutes: [],
    },
  });
  let persistCalls = 0;
  const readTransition = store.readTransition;
  if (readTransition === undefined) {
    throw new Error("Transition-capable memory fixture is required");
  }

  return {
    persistCalls: () => persistCalls,
    store: {
      ...store,
      readTransition: async (request) => {
        const outcome = await readTransition(request);
        if (outcome.kind !== "success" || outcome.value.kind !== "absent") {
          return outcome;
        }
        return {
          kind: "success",
          value: {
            kind: "found",
            receipt: {
              transition: request,
              transitionId: "app_transition_HOSTILE",
            },
          },
        };
      },
      persistTransition: async (...args) => {
        persistCalls += 1;
        return store.persistTransition(...args);
      },
    },
  };
}

function createIdentityCollisionStore() {
  const store = createDeterministicMemoryAppReleaseStore({
    routes: {
      platformRoutes: [{ appId: app.appId, stableRoute: surface.stableRoute }],
      structuralRoutes: [],
    },
  });
  if (store.persistTransition === undefined) {
    throw new Error("Transition-capable memory fixture is required");
  }
  let persistCalls = 0;

  return {
    persistCalls: () => persistCalls,
    store: {
      ...store,
      persistTransition: async () => {
        persistCalls += 1;
        return {
          kind: "success",
          value: { kind: "identity-collision" },
        };
      },
    },
  };
}

it("Cairn transition receipts converge across memory, D1 reconstruction, concurrent replay, and hostile rows", async () => {
  const memoryStore = createDeterministicMemoryAppReleaseStore({
    routes: {
      platformRoutes: [{ appId: app.appId, stableRoute: surface.stableRoute }],
      structuralRoutes: [],
    },
  });
  const memoryArtifactReader = createMemoryArtifactReader();
  await assertTransitionLaws(() =>
    createAppReleaseCatalog({
      store: memoryStore,
      artifactReader: memoryArtifactReader,
    }),
  );

  for (const [artifactRef, bytes] of artifacts) {
    await env.APP_RELEASE_ARTIFACTS.put(artifactRef, bytes, {
      httpMetadata: {
        contentType: artifactRef.includes(".release-")
          ? "application/vnd.fungi.app+json"
          : "text/html; charset=utf-8",
      },
    });
  }
  await assertTransitionLaws(() =>
    createAppReleaseCatalog({
      store: createD1AppReleaseStore(env.APP_RELEASE_CATALOG),
      artifactReader: createFixtureR2ArtifactReader(),
    }),
  );

  const hostile = createHostileStore();
  const hostileCatalog = createAppReleaseCatalog({
    store: hostile.store,
    artifactReader: createMemoryArtifactReader(),
  });
  await hostileCatalog.createApp(app);
  await createFixturePlatformSurface(
    hostileCatalog,
    env.APP_RELEASE_CATALOG,
    surface,
  );
  await hostileCatalog.createRelease(releaseA);
  await hostileCatalog.verifyReleaseArtifact(releaseA.releaseId);
  await expect(
    hostileCatalog.transition(promotion("idem_transitionlaw_hostile")),
  ).rejects.toBeInstanceOf(AppReleaseInvalidStoreResultError);
  expect(hostile.persistCalls()).toBe(0);

  const collision = createIdentityCollisionStore();
  const collisionCatalog = createAppReleaseCatalog({
    store: collision.store,
    artifactReader: createMemoryArtifactReader(),
  });
  await collisionCatalog.createApp(app);
  await createFixturePlatformSurface(
    collisionCatalog,
    env.APP_RELEASE_CATALOG,
    surface,
  );
  await collisionCatalog.createRelease(releaseA);
  await collisionCatalog.verifyReleaseArtifact(releaseA.releaseId);
  const collisionOutcome = await Promise.allSettled([
    collisionCatalog.transition(promotion("idem_transitionlaw_collision")),
  ]);
  expect(collisionOutcome).toHaveLength(1);
  expect(collisionOutcome[0]?.status).toBe("rejected");
  if (collisionOutcome[0]?.status === "rejected") {
    const error = collisionOutcome[0].reason;
    expect(error).toMatchObject({
      name: "AppReleaseTransitionIdUnavailableError",
      message: "App Release transition identity is unavailable",
    });
    for (const field of [
      "cause",
      "detail",
      "family",
      "kind",
      "code",
      "transitionId",
    ]) {
      expect(error).not.toHaveProperty(field);
    }
  }
  expect(collision.persistCalls()).toBe(1);
});

it("records delivery obligations only for security revocation", async () => {
  const catalogDatabase = env.APP_RELEASE_OBLIGATION_CONFORMANCE;
  const obligationApp = { appId: parseAppId("app_obligationd1") };
  const obligationSurface = {
    publicSurfaceId: parsePublicSurfaceId("ps_obligationd1"),
    appId: obligationApp.appId,
    stableRoute: parseStableRoute("/obligationd1"),
  };
  const obligationRelease = {
    releaseId: parseReleaseId("rel_obligationd1"),
    appId: obligationApp.appId,
    artifact: {
      artifactRef: parseArtifactRef("artifact:obligationd1.release"),
      artifactDigest: parseSha256Digest(
        "sha256:cf7e8aaa418eaea6f790374384adcab3ec41b2fd9d828106e816d922a8735523",
      ),
      provenance: {
        sourceRevision: parseSourceRevision(`git:${"e".repeat(40)}`),
        sourceTreeDigest: parseSha256Digest(`sha256:${"f".repeat(64)}`),
        buildRecipeDigest: parseSha256Digest(`sha256:${"a".repeat(64)}`),
      },
    },
  };
  await catalogDatabase.exec(APP_RELEASE_D1_FRESH_SCHEMA);
  const obligationChild = new Uint8Array([60]);
  const obligationManifest = new TextEncoder().encode(
    JSON.stringify({
      format: "fungi-app-v1",
      ui: {
        artifactRef: "artifact:obligationd1.ui",
        digest:
          "sha256:dabd3aff769f07eb2965401eb029974ebba3407afd02b26ddb564ea5f8efae72",
        version: "v1",
        byteLength: obligationChild.byteLength,
        mediaType: "text/html; charset=utf-8",
      },
    }),
  );
  const store = createD1AppReleaseStore(catalogDatabase);
  const catalog = createAppReleaseCatalog({
    store,
    artifactReader: {
      read: async ({ artifactRef, expectedDigest }) => ({
        kind: "verified",
        digest: expectedDigest,
        mediaType: artifactRef.includes(".release")
          ? "application/vnd.fungi.app+json"
          : "text/html; charset=utf-8",
        bytes: {
          byteLength: artifactRef.includes(".release")
            ? obligationManifest.byteLength
            : obligationChild.byteLength,
          copy: () =>
            artifactRef.includes(".release")
              ? obligationManifest.slice()
              : obligationChild.slice(),
        },
        byteLength: artifactRef.includes(".release")
          ? obligationManifest.byteLength
          : obligationChild.byteLength,
      }),
    },
  });
  await catalog.createApp(obligationApp);
  await createFixturePlatformSurface(
    catalog,
    catalogDatabase,
    obligationSurface,
  );
  await catalog.createRelease(obligationRelease);
  await catalog.verifyReleaseArtifact(obligationRelease.releaseId);
  const effectCatalog = createAppReleaseCore({
    store: adaptPromiseAppReleaseStore(store),
    artifactReader: adaptPromiseArtifactReader({
      read: async ({ artifactRef, expectedDigest }) => ({
        kind: "verified",
        digest: expectedDigest,
        mediaType: artifactRef.includes(".release")
          ? "application/vnd.fungi.app+json"
          : "text/html; charset=utf-8",
        bytes: {
          byteLength: artifactRef.includes(".release") ? 225 : 1,
          copy: () =>
            artifactRef.includes(".release")
              ? new TextEncoder().encode(
                  JSON.stringify({
                    format: "fungi-app-v1",
                    ui: {
                      artifactRef: "artifact:obligationd1.ui",
                      digest:
                        "sha256:dabd3aff769f07eb2965401eb029974ebba3407afd02b26ddb564ea5f8efae72",
                      version: "v1",
                      byteLength: 1,
                      mediaType: "text/html; charset=utf-8",
                    },
                  }),
                )
              : new Uint8Array([60]),
        },
        byteLength: artifactRef.includes(".release") ? 225 : 1,
      }),
    }),
  });
  await expect(
    Effect.runPromise(
      Effect.result(
        effectCatalog.resolveEligibleSurfaceVersion(
          obligationSurface.stableRoute,
          obligationRelease.releaseId,
        ),
      ),
    ),
  ).resolves.toMatchObject({ _tag: "Failure" });
  const request = {
    kind: "promotion",
    publicSurfaceId: obligationSurface.publicSurfaceId,
    releaseId: obligationRelease.releaseId,
    idempotencyKey: parseIdempotencyKey("idem_obligationd1"),
  };
  const receipt = await catalog.transition(request);
  await expect(
    Effect.runPromise(
      effectCatalog.resolveEligibleSurfaceVersion(
        obligationSurface.stableRoute,
        obligationRelease.releaseId,
      ),
    ),
  ).resolves.toMatchObject({
    appId: obligationApp.appId,
    releaseId: obligationRelease.releaseId,
    stableRoute: obligationSurface.stableRoute,
  });
  await expect(
    store.transitionObligations.readByTransitionId(receipt.transitionId),
  ).resolves.toMatchObject({
    kind: "success",
    value: { kind: "absent" },
  });
  const rollback = await catalog.transition({
    kind: "rollback",
    publicSurfaceId: obligationSurface.publicSurfaceId,
    releaseId: obligationRelease.releaseId,
    idempotencyKey: parseIdempotencyKey("idem_obligationd1_rollback"),
  });
  const eligibleBasis = await readD1SurfaceTransitionBasis(
    catalogDatabase,
    obligationSurface.stableRoute,
    obligationRelease.releaseId,
  );
  expect(eligibleBasis).toMatchObject({
    kind: "success",
    value: {
      kind: "selected",
      appId: obligationApp.appId,
      publicSurfaceId: obligationSurface.publicSurfaceId,
      releaseId: obligationRelease.releaseId,
      eligibility: "eligible",
    },
  });
  expect(
    matchEligibleSurfaceTransitionBasis(eligibleBasis, {
      appId: obligationApp.appId,
      releaseId: obligationRelease.releaseId,
      sequence: eligibleBasis.value.sequence,
    }),
  ).toMatchObject({
    kind: "selected",
    appId: obligationApp.appId,
    releaseId: obligationRelease.releaseId,
    sequence: eligibleBasis.value.sequence,
  });
  expect(
    matchEligibleSurfaceTransitionBasis(eligibleBasis, {
      appId: obligationApp.appId,
      releaseId: obligationRelease.releaseId,
      sequence: eligibleBasis.value.sequence + 1,
    }),
  ).toBeNull();
  const replacement = {
    ...obligationRelease,
    releaseId: parseReleaseId("rel_obligationreplacement"),
  };
  await catalog.createRelease(replacement);
  await catalog.verifyReleaseArtifact(replacement.releaseId);
  await catalog.transition({
    kind: "promotion",
    publicSurfaceId: obligationSurface.publicSurfaceId,
    releaseId: replacement.releaseId,
    idempotencyKey: parseIdempotencyKey("idem_obligationreplacement"),
  });
  await expect(
    catalog.resolvePublicSurfaceAuthorityVersion(
      obligationSurface.stableRoute,
      obligationRelease.releaseId,
    ),
  ).resolves.toMatchObject({
    currentReleaseId: replacement.releaseId,
    release: { releaseId: obligationRelease.releaseId },
    revocation: { kind: "active" },
  });
  const revocation = await catalog.transition({
    kind: "revocation",
    releaseId: obligationRelease.releaseId,
    idempotencyKey: parseIdempotencyKey("idem_obligationd1_revocation"),
  });
  await expect(
    store.transitionObligations.readByTransitionId(revocation.transitionId),
  ).resolves.toMatchObject({
    kind: "success",
    value: {
      affectedSurfaces: [obligationSurface],
    },
  });
  await expect(
    Effect.runPromise(
      effectCatalog.resolveEligibleSurfaceRelease(
        obligationSurface.stableRoute,
      ),
    ),
  ).resolves.toMatchObject({ releaseId: replacement.releaseId });
  await expect(
    Effect.runPromise(
      Effect.result(
        effectCatalog.resolveEligibleSurfaceVersion(
          obligationSurface.stableRoute,
          obligationRelease.releaseId,
        ),
      ),
    ),
  ).resolves.toMatchObject({ _tag: "Failure" });
  await expect(catalog.transition(request)).resolves.toEqual(receipt);
  const rows = await catalogDatabase
    .prepare(
      `SELECT sequence, transition_id, state
     FROM app_release_transition_obligations
     WHERE transition_id IN (?, ?, ?)
     ORDER BY sequence`,
    )
    .bind(receipt.transitionId, rollback.transitionId, revocation.transitionId)
    .all();
  expect(rows.results).toHaveLength(1);
  const [revocationRow] = rows.results;
  expect(revocationRow).toMatchObject({
    transition_id: revocation.transitionId,
    state: "pending",
  });
  await expect(
    readD1SurfaceTransitionBasis(
      catalogDatabase,
      obligationSurface.stableRoute,
      obligationRelease.releaseId,
    ),
  ).resolves.toMatchObject({
    kind: "success",
    value: {
      kind: "selected",
      appId: obligationApp.appId,
      publicSurfaceId: obligationSurface.publicSurfaceId,
      releaseId: obligationRelease.releaseId,
      sequence: eligibleBasis.value.sequence,
      eligibility: "ineligible",
    },
  });

  const reopenedObligations =
    createD1TransitionObligationStore(catalogDatabase);
  await expect(
    reopenedObligations.readByTransitionId(receipt.transitionId),
  ).resolves.toMatchObject({
    kind: "success",
    value: { kind: "absent" },
  });
  await expect(
    reopenedObligations.read({
      afterSequence: revocationRow.sequence - 1,
    }),
  ).resolves.toMatchObject({
    kind: "success",
    value: [
      {
        sequence: revocationRow.sequence,
        transitionId: revocation.transitionId,
        state: "pending",
        affectedPublicSurfaceIds: [obligationSurface.publicSurfaceId],
      },
    ],
  });
  expect(rollback.transitionId).not.toBe(receipt.transitionId);
});

it("retains paged Team recipients, exact terminal receipts, and completion gating", async () => {
  const app = { appId: parseAppId("app_recipientpages") };
  const surface = {
    publicSurfaceId: parsePublicSurfaceId("ps_recipientpages"),
    appId: app.appId,
    stableRoute: parseStableRoute("/recipientpages"),
  };
  const release = {
    releaseId: parseReleaseId("rel_recipientpages"),
    appId: app.appId,
    artifact: {
      artifactRef: parseArtifactRef("artifact:recipientpages.release"),
      artifactDigest: parseSha256Digest(`sha256:${"1".repeat(64)}`),
      provenance: {
        sourceRevision: parseSourceRevision(`git:${"2".repeat(40)}`),
        sourceTreeDigest: parseSha256Digest(`sha256:${"3".repeat(64)}`),
        buildRecipeDigest: parseSha256Digest(`sha256:${"4".repeat(64)}`),
      },
    },
  };
  const recipientChild = new Uint8Array([60]);
  const recipientManifest = new TextEncoder().encode(
    JSON.stringify({
      format: "fungi-app-v1",
      ui: {
        artifactRef: "artifact:recipientpages.ui",
        digest: `sha256:${"5".repeat(64)}`,
        version: "v1",
        byteLength: recipientChild.byteLength,
        mediaType: "text/html; charset=utf-8",
      },
    }),
  );
  const catalog = createAppReleaseCatalog({
    store: createD1AppReleaseStore(env.APP_RELEASE_CATALOG),
    artifactReader: {
      read: async ({ artifactRef, expectedDigest }) => ({
        kind: "verified",
        digest: expectedDigest,
        mediaType: artifactRef.includes(".release")
          ? "application/vnd.fungi.app+json"
          : "text/html; charset=utf-8",
        bytes: artifactRef.includes(".release")
          ? {
              byteLength: recipientManifest.byteLength,
              copy: () => recipientManifest.slice(),
            }
          : {
              byteLength: recipientChild.byteLength,
              copy: () => recipientChild.slice(),
            },
        byteLength: artifactRef.includes(".release")
          ? recipientManifest.byteLength
          : recipientChild.byteLength,
      }),
    },
  });
  await catalog.createApp(app);
  await createFixturePlatformSurface(catalog, env.APP_RELEASE_CATALOG, surface);
  await catalog.createRelease(release);
  await catalog.verifyReleaseArtifact(release.releaseId);
  await catalog.transition({
    kind: "promotion",
    publicSurfaceId: surface.publicSurfaceId,
    releaseId: release.releaseId,
    idempotencyKey: parseIdempotencyKey("idem_recipientpages"),
  });
  const receipt = await catalog.transition({
    kind: "revocation",
    releaseId: release.releaseId,
    idempotencyKey: parseIdempotencyKey("idem_recipientpages_revocation"),
  });
  const transitionRow = await env.APP_RELEASE_CATALOG.prepare(
    "SELECT sequence FROM app_release_transitions WHERE transition_id = ?",
  )
    .bind(receipt.transitionId)
    .first();
  const sequence = transitionRow.sequence;
  const obligations = createD1TransitionObligationStore(
    env.APP_RELEASE_CATALOG,
  );
  const firstPage = {
    teamIds: ["opaque-team-a", "opaque-team-b"],
    nextCursor: "cursor/from-global/one",
    complete: false,
  };
  await expect(
    obligations.recordTeamRecipientPage(sequence, firstPage),
  ).resolves.toMatchObject({
    kind: "success",
    value: {
      enumeration: { cursor: "cursor/from-global/one", complete: false },
    },
  });
  await expect(
    obligations.recordTeamRecipientPage(sequence, firstPage),
  ).resolves.toMatchObject({ kind: "success" });
  await expect(
    obligations.readPendingTeamRecipients({ sequence, limit: 1 }),
  ).resolves.toMatchObject({
    kind: "success",
    value: [{ teamId: "opaque-team-a", state: "pending" }],
  });
  await expect(obligations.acknowledge(sequence)).resolves.toMatchObject({
    kind: "success",
    value: { state: "pending" },
  });

  await expect(
    obligations.recordTeamRecipientPage(sequence, {
      cursor: "cursor/from-global/one",
      teamIds: ["opaque-team-c"],
      nextCursor: "cursor/from-global/two",
      complete: false,
    }),
  ).resolves.toMatchObject({ kind: "success" });
  await expect(
    obligations.recordTeamRecipientPage(sequence, {
      cursor: "cursor/from-global/two",
      teamIds: [],
      complete: true,
    }),
  ).resolves.toMatchObject({
    kind: "success",
    value: { enumeration: { complete: true, cursor: null } },
  });
  await expect(
    obligations.recordTeamRecipientOutcome(
      sequence,
      "opaque-team-a",
      "applied",
    ),
  ).resolves.toEqual({
    kind: "success",
    value: { teamId: "opaque-team-a", state: "applied" },
  });
  await expect(
    obligations.recordTeamRecipientOutcome(
      sequence,
      "opaque-team-a",
      "applied",
    ),
  ).resolves.toEqual({
    kind: "success",
    value: { teamId: "opaque-team-a", state: "applied" },
  });
  await expect(
    obligations.recordTeamRecipientOutcome(sequence, "opaque-team-b", "no-op"),
  ).resolves.toMatchObject({ kind: "success", value: { state: "no-op" } });
  await expect(
    obligations.recordTeamRecipientOutcome(
      sequence,
      "opaque-team-c",
      "expired",
    ),
  ).resolves.toMatchObject({ kind: "success", value: { state: "expired" } });
  await expect(
    obligations.readPendingTeamRecipients({ sequence }),
  ).resolves.toEqual({ kind: "success", value: [] });
  await expect(obligations.acknowledge(sequence)).resolves.toMatchObject({
    kind: "success",
    value: { state: "acknowledged", enumeration: { complete: true } },
  });
  await expect(
    obligations.recordTeamRecipientPage(sequence, {
      teamIds: ["opaque-team-z"],
      complete: true,
    }),
  ).resolves.toMatchObject({
    kind: "failure",
    failure: { kind: "unavailable" },
  });
});

it("rejects malformed recipient boundaries through the D1 store schema", async () => {
  const obligations = createD1TransitionObligationStore(
    env.APP_RELEASE_CATALOG,
  );
  await expect(
    obligations.recordTeamRecipientPage(1, {
      teamIds: ["team-malformed"],
      complete: false,
    }),
  ).resolves.toMatchObject({
    kind: "failure",
    failure: { kind: "unavailable" },
  });
  await expect(
    obligations.recordTeamRecipientPage(1, {
      teamIds: [],
      nextCursor: "cursor-after-complete",
      complete: true,
    }),
  ).resolves.toMatchObject({
    kind: "failure",
    failure: { kind: "unavailable" },
  });
  await expect(
    obligations.readPendingTeamRecipients({ sequence: 1, limit: 0 }),
  ).resolves.toMatchObject({
    kind: "failure",
    failure: { kind: "unavailable" },
  });
});

it("resolves ordered directory selections in one D1 batch without artifact reads", async () => {
  let batches = 0;
  const store = createD1AppReleaseStore({
    prepare: (query) => env.APP_RELEASE_CATALOG.prepare(query),
    batch: (statements) => {
      batches += 1;
      return env.APP_RELEASE_CATALOG.batch(statements);
    },
  });
  const reader = createMemoryArtifactReader();
  const catalog = createAppReleaseCatalog({ store, artifactReader: reader });
  await seedCatalog(catalog);
  await catalog.transition(promotion("idem_directory_first"));
  const other = {
    ...surface,
    publicSurfaceId: parsePublicSurfaceId("ps_directorysecond"),
    stableRoute: parseStableRoute("/directorysecond"),
  };
  await createFixturePlatformSurface(catalog, env.APP_RELEASE_CATALOG, other);
  await catalog.transition({
    ...promotion("idem_directory_second", releaseB.releaseId),
    publicSurfaceId: other.publicSurfaceId,
  });
  const core = createAppReleaseCore({
    store: adaptPromiseAppReleaseStore(store),
    artifactReader: adaptPromiseArtifactReader({
      read: async () => {
        throw new Error("directory must not load artifacts");
      },
    }),
  });
  batches = 0;
  const selected = await Effect.runPromise(
    core.resolveEligibleSurfaceReleases([
      other.stableRoute,
      surface.stableRoute,
    ]),
  );
  expect(selected).toMatchObject([
    { _tag: "Success", success: { releaseId: releaseB.releaseId } },
    { _tag: "Success", success: { releaseId: releaseA.releaseId } },
  ]);
  expect(batches).toBe(1);
  await catalog.transition({
    kind: "revocation",
    releaseId: releaseB.releaseId,
    idempotencyKey: parseIdempotencyKey("idem_directory_revoke"),
  });
  await expect(
    Effect.runPromise(
      core.resolveEligibleSurfaceReleases([
        other.stableRoute,
        surface.stableRoute,
      ]),
    ),
  ).resolves.toMatchObject([
    {
      _tag: "Failure",
      failure: { name: "AppReleasePublicWebsiteUnavailableError" },
    },
    { _tag: "Success", success: { releaseId: releaseA.releaseId } },
  ]);
  await expect(
    Effect.runPromise(core.resolveEligibleSurfaceRelease(other.stableRoute)),
  ).rejects.toThrow();
});
