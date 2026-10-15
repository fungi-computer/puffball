import {
  platformSurface,
  fixturePlatformRoutes,
} from "./support/platform-publication.js";
import { expect, it } from "vitest";

import {
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
  type ArtifactReader,
  type PromiseAppReleaseStore,
  type PublicSurface,
  type Release,
  type ReleaseTransition,
  type TransitionReceipt,
} from "../dist/index.js";
import { createDeterministicMemoryAppReleaseStore } from "../dist/effect.js";

const digest = (character: string) =>
  parseSha256Digest(`sha256:${character.repeat(64)}`);

const release = (
  name: string,
  character: string,
  appId: Release["appId"],
): Release => ({
  releaseId: parseReleaseId(`rel_${name}`),
  appId,
  artifact: {
    artifactRef: parseArtifactRef(`artifact:${name}`),
    artifactDigest: digest(character),
    provenance: {
      sourceRevision: parseSourceRevision(`git:${character.repeat(40)}`),
      sourceTreeDigest: digest("d"),
      buildRecipeDigest: digest("e"),
    },
  },
});

function observeTransitionState(store: PromiseAppReleaseStore) {
  const persistTransition = store.persistTransition;
  if (persistTransition === undefined) {
    throw new Error("Transition-capable fixture requires persistence");
  }

  const selected = new Map<string, string>();
  const revoked = new Set<string>();
  const receipts: TransitionReceipt[] = [];
  const observedStore: PromiseAppReleaseStore = {
    ...store,
    persistTransition: async (request, proposedReceipt) => {
      const outcome = await persistTransition(request, proposedReceipt);
      if (outcome.kind === "success" && outcome.value.kind === "created") {
        const retained = outcome.value.receipt;
        receipts.push(retained);
        if (retained.transition.kind === "revocation") {
          revoked.add(retained.transition.releaseId);
        } else {
          selected.set(
            retained.transition.publicSurfaceId,
            retained.transition.releaseId,
          );
        }
      }
      return outcome;
    },
  };

  return {
    store: observedStore,
    snapshot: () => ({
      selected: [...selected.entries()].sort(),
      revoked: [...revoked].sort(),
      receipts: [...receipts],
    }),
  };
}

it("rejects changed material within an operation-scoped idempotency key without mutating transition state", async () => {
  const app = { appId: parseAppId("app_orchid") };
  const firstSurface: PublicSurface = {
    publicSurfaceId: parsePublicSurfaceId("ps_orchid"),
    appId: app.appId,
    stableRoute: parseStableRoute("/orchid"),
  };
  const secondSurface: PublicSurface = {
    publicSurfaceId: parsePublicSurfaceId("ps_lotus"),
    appId: app.appId,
    stableRoute: parseStableRoute("/lotus"),
  };
  const releaseA = release("orchida", "a", app.appId);
  const releaseB = release("orchidb", "b", app.appId);
  const releaseC = release("orchidc", "c", app.appId);
  const artifactReader: ArtifactReader = {
    read: ({ artifactRef, expectedDigest }) => {
      const childBytes = new TextEncoder().encode("<p>verified</p>");
      const isChild = artifactRef.endsWith(".ui");
      const childRef = parseArtifactRef(
        `artifact:${artifactRef.slice("artifact:".length)}.ui`,
      );
      const bytes = isChild
        ? childBytes
        : new TextEncoder().encode(
            JSON.stringify({
              format: "fungi-app-v1",
              ui: {
                artifactRef: childRef,
                digest: digest("9"),
                version: "v1",
                byteLength: childBytes.byteLength,
                mediaType: "text/html; charset=utf-8",
              },
            }),
          );
      return Promise.resolve({
        kind: "verified",
        digest: expectedDigest,
        mediaType: isChild
          ? "text/html; charset=utf-8"
          : "application/vnd.fungi.app+json",
        bytes: { byteLength: bytes.byteLength, copy: () => bytes.slice() },
        byteLength: bytes.byteLength,
      });
    },
  };
  const observed = observeTransitionState(
    createDeterministicMemoryAppReleaseStore(fixturePlatformRoutes),
  );
  const catalog = createAppReleaseCatalog({
    artifactReader,
    store: observed.store,
  });

  await catalog.createApp(app);
  await catalog.createPublicSurface(platformSurface(firstSurface));
  await catalog.createPublicSurface(platformSurface(secondSurface));
  for (const item of [releaseA, releaseB, releaseC]) {
    await catalog.createRelease(item);
    await catalog.verifyReleaseArtifact(item.releaseId);
  }

  const sharedKey = parseIdempotencyKey("idem_shared_transition");
  const promotion: ReleaseTransition = {
    kind: "promotion",
    publicSurfaceId: firstSurface.publicSurfaceId,
    releaseId: releaseA.releaseId,
    idempotencyKey: sharedKey,
  };
  const promotionReceipt = await catalog.transition(promotion);

  for (const conflict of [
    { ...promotion, releaseId: releaseB.releaseId },
    { ...promotion, publicSurfaceId: secondSurface.publicSurfaceId },
  ]) {
    await expect(catalog.transition(conflict)).rejects.toBeInstanceOf(
      AppReleaseTransitionIdempotencyConflictError,
    );
  }
  expect(observed.snapshot()).toEqual({
    selected: [[firstSurface.publicSurfaceId, releaseA.releaseId]],
    revoked: [],
    receipts: [promotionReceipt],
  });
  await expect(catalog.transition(promotion)).resolves.toEqual(
    promotionReceipt,
  );

  const revocation: ReleaseTransition = {
    kind: "revocation",
    releaseId: releaseC.releaseId,
    idempotencyKey: sharedKey,
  };
  const revocationReceipt = await catalog.transition(revocation);
  await expect(
    catalog.transition({ ...revocation, releaseId: releaseA.releaseId }),
  ).rejects.toBeInstanceOf(AppReleaseTransitionIdempotencyConflictError);
  expect(observed.snapshot()).toEqual({
    selected: [[firstSurface.publicSurfaceId, releaseA.releaseId]],
    revoked: [releaseC.releaseId],
    receipts: [promotionReceipt, revocationReceipt],
  });
  await expect(catalog.transition(revocation)).resolves.toEqual(
    revocationReceipt,
  );

  const rollback: ReleaseTransition = {
    kind: "rollback",
    publicSurfaceId: firstSurface.publicSurfaceId,
    releaseId: releaseA.releaseId,
    idempotencyKey: sharedKey,
  };
  const rollbackReceipt = await catalog.transition(rollback);
  for (const conflict of [
    { ...rollback, releaseId: releaseB.releaseId },
    { ...rollback, publicSurfaceId: secondSurface.publicSurfaceId },
  ]) {
    await expect(catalog.transition(conflict)).rejects.toBeInstanceOf(
      AppReleaseTransitionIdempotencyConflictError,
    );
  }
  expect(observed.snapshot()).toEqual({
    selected: [[firstSurface.publicSurfaceId, releaseA.releaseId]],
    revoked: [releaseC.releaseId],
    receipts: [promotionReceipt, revocationReceipt, rollbackReceipt],
  });
  await expect(catalog.transition(rollback)).resolves.toEqual(rollbackReceipt);
});
