import { configureD1PublicRoutes } from "../dist/public-routes.js";
import { capturePublicRoutePolicy } from "../dist/public-route-policy.js";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";

import {
  AppReleaseStoreUnavailableError,
  createAppReleaseCatalog,
  parseAppId,
  parseAppTransitionId,
  parseIdempotencyKey,
  parsePublicSurfaceId,
  parseReleaseId,
  parseStableRoute,
  parseArtifactRef,
  parseSha256Digest,
  parseSourceRevision,
  emptyAppDeclaration,
} from "../dist/index.js";
import {
  APP_RELEASE_D1_FRESH_SCHEMA,
  createD1AppReleaseStore,
} from "../dist/cloudflare.js";
import { createDeterministicMemoryAppReleaseStore } from "../dist/effect.js";

const appId = parseAppId("app_storageboundary");
const stableRoute = parseStableRoute("/storageboundary");
const routeConfiguration = {
  platformRoutes: [{ appId, stableRoute }],
  structuralRoutes: [],
};
const publicSurfaceId = parsePublicSurfaceId("ps_storageboundary");
const releaseAId = parseReleaseId("rel_storageboundarya");
const releaseBId = parseReleaseId("rel_storageboundaryb");

const hostileRequest = {
  kind: "promotion",
  publicSurfaceId,
  releaseId: releaseAId,
  idempotencyKey: parseIdempotencyKey("idem_storageboundary_hostile"),
};
const hostileTransitionId = "app_transition_HOSTILE_DO_NOT_COPY";

beforeAll(async () => {
  await env.APP_RELEASE_CATALOG.exec(APP_RELEASE_D1_FRESH_SCHEMA);
  await configureD1PublicRoutes(
    env.APP_RELEASE_CATALOG,
    await capturePublicRoutePolicy(routeConfiguration),
  );
});

const firstRequest = {
  kind: "promotion",
  publicSurfaceId,
  releaseId: releaseAId,
  idempotencyKey: parseIdempotencyKey("idem_storageboundary_first"),
};
const secondRequest = {
  kind: "rollback",
  publicSurfaceId,
  releaseId: releaseBId,
  idempotencyKey: parseIdempotencyKey("idem_storageboundary_second"),
};
const sharedTransitionId = parseAppTransitionId(
  "app_transition_aaaaaaaaaaaaaaaaaaaaa",
);
const replayCandidateId = parseAppTransitionId(
  "app_transition_bbbbbbbbbbbbbbbbbbbbb",
);
const firstReceipt = {
  transition: firstRequest,
  transitionId: sharedTransitionId,
};
const secondReceipt = {
  transition: secondRequest,
  transitionId: sharedTransitionId,
};

function createInertArtifactReader() {
  return { read: async () => ({ kind: "missing" }) };
}

async function rejectedReason(promise) {
  const [outcome] = await Promise.allSettled([promise]);
  expect(outcome?.status).toBe("rejected");
  if (outcome?.status !== "rejected") {
    throw new Error("Expected the App Release catalog call to reject");
  }
  return outcome.reason;
}

function expectBoundedStoreUnavailable(error) {
  expect(Object.getPrototypeOf(error)).toBe(
    AppReleaseStoreUnavailableError.prototype,
  );
  expect(error).toBeInstanceOf(AppReleaseStoreUnavailableError);
  expect(error).toMatchObject({
    name: "AppReleaseStoreUnavailableError",
    message: "App Release store is unavailable",
  });
  expect(String(error)).toBe(
    "AppReleaseStoreUnavailableError: App Release store is unavailable",
  );
  expect(String(error)).not.toContain(hostileTransitionId);
  for (const field of [
    "cause",
    "detail",
    "identity",
    "transitionId",
    "row",
    "value",
  ]) {
    expect(error).not.toHaveProperty(field);
  }
}

async function readStoredTransitions() {
  const result = await env.APP_RELEASE_CATALOG.prepare(
    `SELECT sequence, transition_id, operation_kind, idempotency_key,
            release_id, public_surface_id
     FROM app_release_transitions
     ORDER BY sequence`,
  ).all();
  expect(result.success).toBe(true);
  return result.results;
}

async function seed(store) {
  const digest = parseSha256Digest(`sha256:${"a".repeat(64)}`);
  await store.createAppIfAbsent({ appId });
  await store.createPublicSurfaceIfAbsent({
    appId,
    publicSurfaceId,
    stableRoute,
    publisher: {
      kind: "platform",
      teamId: "fixture-platform",
      userId: "fixture-operator",
      requestKey: "storage-boundary",
    },
  });
  for (const releaseId of [releaseAId, releaseBId]) {
    await store.createReleaseIfAbsent({
      appId,
      releaseId,
      artifact: {
        artifactRef: parseArtifactRef(`artifact:${releaseId}`),
        artifactDigest: digest,
        provenance: {
          sourceRevision: parseSourceRevision(`git:${"a".repeat(40)}`),
          sourceTreeDigest: digest,
          buildRecipeDigest: digest,
        },
      },
    });
    await store.recordReleaseVerification({
      releaseId,
      digest,
      mediaType: "application/vnd.fungi.app+json",
      description: {
        format: "fungi-app-v1",
        ui: null,
        backend: null,
        declaration: emptyAppDeclaration,
      },
    });
  }
}

async function assertIdentityCollision(store) {
  await seed(store);
  expect(store.persistTransition).toBeDefined();
  expect(store.readTransition).toBeDefined();
  if (
    store.persistTransition === undefined ||
    store.readTransition === undefined
  ) {
    throw new Error("Transition-capable App Release Store is required");
  }

  await expect(
    store.persistTransition(firstRequest, firstReceipt),
  ).resolves.toEqual({
    kind: "success",
    value: { kind: "created", receipt: firstReceipt },
  });
  await expect(
    store.persistTransition(secondRequest, secondReceipt),
  ).resolves.toEqual({
    kind: "success",
    value: { kind: "identity-collision" },
  });

  await expect(store.readTransition(firstRequest)).resolves.toEqual({
    kind: "success",
    value: { kind: "found", receipt: firstReceipt },
  });
  await expect(store.readTransition(secondRequest)).resolves.toEqual({
    kind: "success",
    value: { kind: "absent" },
  });
  await expect(
    store.persistTransition(firstRequest, {
      transition: firstRequest,
      transitionId: replayCandidateId,
    }),
  ).resolves.toEqual({
    kind: "success",
    value: { kind: "existing", receipt: firstReceipt },
  });
}

it("rejects one malformed stored D1 transition without leaking or replacing its identity", async () => {
  expect({ appId, publicSurfaceId, releaseAId }).toEqual({
    appId: "app_storageboundary",
    publicSurfaceId: "ps_storageboundary",
    releaseAId: "rel_storageboundarya",
  });

  const store = createD1AppReleaseStore(env.APP_RELEASE_CATALOG);
  await seed(store);
  const seedRequest = {
    ...firstRequest,
    idempotencyKey: parseIdempotencyKey("idem_storageboundary_seed"),
  };
  await store.persistTransition(seedRequest, {
    transition: seedRequest,
    transitionId: parseAppTransitionId("app_transition_ccccccccccccccccccccc"),
  });
  await env.APP_RELEASE_CATALOG.prepare(
    `INSERT INTO app_release_transitions
      (transition_id, operation_kind, idempotency_key, release_id, public_surface_id)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      hostileTransitionId,
      hostileRequest.kind,
      hostileRequest.idempotencyKey,
      hostileRequest.releaseId,
      hostileRequest.publicSurfaceId,
    )
    .run();

  const before = await readStoredTransitions();
  expect(before).toHaveLength(2);
  expect(before[1]).toMatchObject({
    transition_id: hostileTransitionId,
    operation_kind: hostileRequest.kind,
    idempotency_key: hostileRequest.idempotencyKey,
    release_id: hostileRequest.releaseId,
    public_surface_id: hostileRequest.publicSurfaceId,
  });

  const catalog = createAppReleaseCatalog({
    store: createD1AppReleaseStore(env.APP_RELEASE_CATALOG),
    artifactReader: createInertArtifactReader(),
  });
  const firstError = await rejectedReason(catalog.transition(hostileRequest));
  const secondError = await rejectedReason(catalog.transition(hostileRequest));

  expect(firstError).not.toBe(secondError);
  expectBoundedStoreUnavailable(firstError);
  expectBoundedStoreUnavailable(secondError);
  await expect(readStoredTransitions()).resolves.toEqual(before);
});

it("keeps the first receipt canonical when distinct keys collide on one Cairn transition identity", async () => {
  expect(firstRequest.idempotencyKey).not.toBe(secondRequest.idempotencyKey);
  expect(firstRequest).not.toEqual(secondRequest);

  await assertIdentityCollision(
    createDeterministicMemoryAppReleaseStore({ routes: routeConfiguration }),
  );

  await assertIdentityCollision(
    createD1AppReleaseStore(env.APP_RELEASE_CATALOG),
  );
});
