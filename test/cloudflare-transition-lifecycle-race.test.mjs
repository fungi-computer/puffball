import { createFixturePlatformSurface } from "./support/platform-surface.mjs";
import { TextEncoder } from "node:util";

import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

import {
  AppReleaseTransitionReleaseRevokedError,
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
} from "../dist/cloudflare.js";
import { createDeterministicMemoryAppReleaseStore } from "../dist/effect.js";

function createScenario(name) {
  const app = { appId: parseAppId(`app_lifecycle${name}`) };
  const release = {
    releaseId: parseReleaseId(`rel_lifecycle${name}`),
    appId: app.appId,
    artifact: {
      artifactRef: parseArtifactRef(`artifact:lifecycle-${name}`),
      artifactDigest: parseSha256Digest(
        "sha256:def58e9bec95cde6443de9eb05d9fb18164a2bd41273b7b3d355245dc2f0c056",
      ),
      provenance: {
        sourceRevision: parseSourceRevision(`git:${"b".repeat(40)}`),
        sourceTreeDigest: parseSha256Digest(`sha256:${"c".repeat(64)}`),
        buildRecipeDigest: parseSha256Digest(`sha256:${"d".repeat(64)}`),
      },
    },
  };
  const surface = {
    publicSurfaceId: parsePublicSurfaceId(`ps_lifecycle${name}`),
    appId: app.appId,
    stableRoute: parseStableRoute(`/lifecycle${name}`),
  };

  return { app, release, surface };
}

function promotion(scenario, suffix) {
  return {
    kind: "promotion",
    publicSurfaceId: scenario.surface.publicSurfaceId,
    releaseId: scenario.release.releaseId,
    idempotencyKey: parseIdempotencyKey(`idem_lifecycle${suffix}`),
  };
}

function revocation(scenario, suffix) {
  return {
    kind: "revocation",
    releaseId: scenario.release.releaseId,
    idempotencyKey: parseIdempotencyKey(`idem_lifecycle${suffix}`),
  };
}

function createMemoryArtifactReader(release) {
  const bytes = new TextEncoder().encode("<!doctype html><p>lifecycle</p>");
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      format: "fungi-app-v1",
      ui: {
        artifactRef: "artifact:lifecycle.ui",
        digest:
          "sha256:9c58c78a6748f3fc0ab2ebfa342709611483b86541d601bead631cf2a50fd636",
        version: "v1",
        byteLength: bytes.byteLength,
        mediaType: "text/html; charset=utf-8",
      },
    }),
  );
  return {
    read: async ({ artifactRef, expectedDigest }) => {
      if (
        artifactRef !== release.artifact.artifactRef &&
        artifactRef !== "artifact:lifecycle.ui"
      )
        return { kind: "missing" };
      return {
        kind: "verified",
        digest: expectedDigest,
        mediaType:
          artifactRef === release.artifact.artifactRef
            ? "application/vnd.fungi.app+json"
            : "text/html; charset=utf-8",
        bytes: {
          byteLength:
            artifactRef === release.artifact.artifactRef
              ? manifest.byteLength
              : bytes.byteLength,
          copy: () =>
            artifactRef === release.artifact.artifactRef
              ? manifest.slice()
              : bytes.slice(),
        },
        byteLength:
          artifactRef === release.artifact.artifactRef
            ? manifest.byteLength
            : bytes.byteLength,
      };
    },
  };
}

function pausePersistence(store, pausedKind) {
  if (store.persistTransition === undefined) {
    throw new Error("Transition-capable App Release Store is required");
  }

  const persistTransition = store.persistTransition;
  let signalEntered;
  let continuePersistence = () => {
    throw new Error("Paused persistence was not entered");
  };
  const entered = new Promise((resolve) => {
    signalEntered = resolve;
  });

  return {
    entered,
    store: {
      ...store,
      persistTransition(request, receipt) {
        if (request.kind !== pausedKind) {
          return persistTransition(request, receipt);
        }

        return new Promise((resolve, reject) => {
          continuePersistence = () => {
            void persistTransition(request, receipt).then(resolve, reject);
          };
          signalEntered({ request, receipt });
        });
      },
    },
    release() {
      continuePersistence();
    },
  };
}

async function seedCatalog(catalog, scenario) {
  await catalog.createApp(scenario.app);
  await createFixturePlatformSurface(
    catalog,
    env.APP_RELEASE_CATALOG,
    scenario.surface,
  );
  await catalog.createRelease(scenario.release);
  await catalog.verifyReleaseArtifact(scenario.release.releaseId);
}

function createCatalog(store, artifactReader) {
  return createAppReleaseCatalog({ store, artifactReader });
}

async function successfulValue(resultPromise) {
  const result = await resultPromise;
  expect(result.kind).toBe("success");
  return result.value;
}

async function expectRevoked(promise, sampledTransitionId) {
  const [outcome] = await Promise.allSettled([promise]);
  expect(outcome?.status).toBe("rejected");
  if (outcome?.status !== "rejected") return;

  const error = outcome.reason;
  expect(Object.getPrototypeOf(error)).toBe(
    AppReleaseTransitionReleaseRevokedError.prototype,
  );
  expect(error).toBeInstanceOf(AppReleaseTransitionReleaseRevokedError);
  expect(error).toMatchObject({
    name: "AppReleaseTransitionReleaseRevokedError",
    message: "Transition Release is revoked",
  });
  expect(error).not.toHaveProperty("transitionId");
  expect(error).not.toHaveProperty("cause");
  expect(error).not.toHaveProperty("detail");
  if (sampledTransitionId !== undefined) {
    expect(String(error)).not.toContain(sampledTransitionId);
  }
}

async function readRows(releaseId) {
  const result = await env.APP_RELEASE_CATALOG.prepare(
    `SELECT sequence, transition_id, operation_kind, idempotency_key,
            release_id, public_surface_id
     FROM app_release_transitions
     WHERE release_id = ?
     ORDER BY sequence`,
  )
    .bind(releaseId)
    .all();
  expect(result.success).toBe(true);
  return result.results;
}

async function assertLifecycleIsRevoked(store, releaseId) {
  const lifecycle = await successfulValue(
    store.readReleaseLifecycle(releaseId),
  );
  expect(lifecycle).toMatchObject({
    kind: "found",
    revocation: { kind: "revoked" },
  });
}

async function runRevocationBeforeSelection(
  storeFactory,
  artifactReaderFactory,
  name,
) {
  const scenario = createScenario(`${name}a`);
  const control = pausePersistence(storeFactory(), "promotion");
  const catalog = createCatalog(
    control.store,
    artifactReaderFactory(scenario.release),
  );
  await seedCatalog(catalog, scenario);

  const selected = promotion(scenario, `${name}_revocationfirst_selection`);
  const revoke = revocation(scenario, `${name}_revocationfirst_revocation`);
  const selectionInFlight = catalog.transition(selected);
  const paused = await control.entered;
  const revocationReceipt = await catalog.transition(revoke);
  expect(revocationReceipt.transition).toEqual(revoke);
  control.release();
  await expectRevoked(selectionInFlight, paused.receipt.transitionId);

  expect(await successfulValue(control.store.readTransition(selected))).toEqual(
    {
      kind: "absent",
    },
  );
  await assertLifecycleIsRevoked(control.store, scenario.release.releaseId);

  await expectRevoked(catalog.transition(promotion(scenario, `${name}_after`)));

  return { scenario, revocationReceipt };
}

async function runRevocationAfterSelection(
  storeFactory,
  artifactReaderFactory,
  name,
) {
  const scenario = createScenario(`${name}b`);
  const control = pausePersistence(storeFactory(), "revocation");
  const catalog = createCatalog(
    control.store,
    artifactReaderFactory(scenario.release),
  );
  await seedCatalog(catalog, scenario);

  const selected = promotion(scenario, `${name}_selectionfirst_selection`);
  const revoke = revocation(scenario, `${name}_selectionfirst_revocation`);
  const revocationInFlight = catalog.transition(revoke);
  await control.entered;
  const selectionReceipt = await catalog.transition(selected);
  control.release();
  const revocationReceipt = await revocationInFlight;

  expect(selectionReceipt.transition).toEqual(selected);
  expect(revocationReceipt.transition).toEqual(revoke);
  expect(await successfulValue(control.store.readTransition(selected))).toEqual(
    {
      kind: "found",
      receipt: selectionReceipt,
    },
  );
  expect(await successfulValue(control.store.readTransition(revoke))).toEqual({
    kind: "found",
    receipt: revocationReceipt,
  });
  await assertLifecycleIsRevoked(control.store, scenario.release.releaseId);

  return { control, scenario, selectionReceipt, revocationReceipt };
}

it("promotion and revocation linearize at persistence across memory and D1", async () => {
  await env.APP_RELEASE_CATALOG.exec(APP_RELEASE_D1_FRESH_SCHEMA);

  const memory = () =>
    createDeterministicMemoryAppReleaseStore({
      routes: {
        platformRoutes: ["memorya", "memoryb"].map((name) => ({
          appId: parseAppId(`app_lifecycle${name}`),
          stableRoute: parseStableRoute(`/lifecycle${name}`),
        })),
        structuralRoutes: [],
      },
    });
  const memoryReader = (release) => createMemoryArtifactReader(release);
  const d1 = () => createD1AppReleaseStore(env.APP_RELEASE_CATALOG);
  for (const [name, storeFactory, artifactReaderFactory] of [
    ["memory", memory, memoryReader],
    ["d1", d1, memoryReader],
  ]) {
    const revocationBeforeSelection = await runRevocationBeforeSelection(
      storeFactory,
      artifactReaderFactory,
      name,
    );
    const afterSelection = await runRevocationAfterSelection(
      storeFactory,
      artifactReaderFactory,
      name,
    );

    if (name === "d1") {
      const rejectedRows = await readRows(
        revocationBeforeSelection.scenario.release.releaseId,
      );
      expect(rejectedRows).toEqual([
        {
          sequence: expect.any(Number),
          transition_id:
            revocationBeforeSelection.revocationReceipt.transitionId,
          operation_kind: "revocation",
          idempotency_key:
            revocationBeforeSelection.revocationReceipt.transition
              .idempotencyKey,
          release_id: revocationBeforeSelection.scenario.release.releaseId,
          public_surface_id: null,
        },
      ]);

      const rows = await readRows(afterSelection.scenario.release.releaseId);
      expect(rows).toEqual([
        {
          sequence: expect.any(Number),
          transition_id: afterSelection.selectionReceipt.transitionId,
          operation_kind: "promotion",
          idempotency_key:
            afterSelection.selectionReceipt.transition.idempotencyKey,
          release_id: afterSelection.scenario.release.releaseId,
          public_surface_id: afterSelection.scenario.surface.publicSurfaceId,
        },
        {
          sequence: expect.any(Number),
          transition_id: afterSelection.revocationReceipt.transitionId,
          operation_kind: "revocation",
          idempotency_key:
            afterSelection.revocationReceipt.transition.idempotencyKey,
          release_id: afterSelection.scenario.release.releaseId,
          public_surface_id: null,
        },
      ]);
      expect(rows[0].sequence).toBeLessThan(rows[1].sequence);
    }
  }
});
