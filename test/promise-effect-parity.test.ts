import {
  platformSurface,
  fixturePlatformRoutes,
} from "./support/platform-publication.js";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
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
  type App,
  type AppReleaseCatalog,
  type ArtifactRef,
  type ArtifactReader,
  type PublicSurface,
  type Release,
  type ReleaseTransition,
  type TransitionReceipt,
  type VerifiedArtifactRead,
} from "../dist/index.js";
import {
  adaptPromiseAppReleaseStore,
  adaptPromiseArtifactReader,
  createAppReleaseCore,
  createDeterministicMemoryAppReleaseStore,
  type AppReleaseCore,
  type AppReleaseCoreFailure,
} from "../dist/effect.js";

type CatalogDriver = Pick<
  AppReleaseCatalog,
  | "createApp"
  | "createRelease"
  | "verifyReleaseArtifact"
  | "createPublicSurface"
  | "transition"
>;

type FailureRecord = {
  readonly name: string;
  readonly message: string;
};

const digest = (character: string) =>
  parseSha256Digest(`sha256:${character.repeat(64)}`);

const owner: App = { appId: parseAppId("app_orchid") };
const foreignOwner: App = { appId: parseAppId("app_lotus") };
const surface: PublicSurface = {
  publicSurfaceId: parsePublicSurfaceId("ps_orchid"),
  appId: owner.appId,
  stableRoute: parseStableRoute("/orchid"),
};

function release(app: App, name: string, character: string): Release {
  return {
    releaseId: parseReleaseId(`rel_${name}`),
    appId: app.appId,
    artifact: {
      artifactRef: parseArtifactRef(`artifact:${name}`),
      artifactDigest: digest(character),
      provenance: {
        sourceRevision: parseSourceRevision(`git:${character.repeat(40)}`),
        sourceTreeDigest: digest("d"),
        buildRecipeDigest: digest("e"),
      },
    },
  };
}

const releaseA = release(owner, "orchida", "a");
const releaseB = release(owner, "orchidb", "b");
const unverifiedRelease = release(owner, "unverified", "c");
const foreignRelease = release(foreignOwner, "lotus", "f");

type ArtifactFixture = Readonly<{
  bytes: Uint8Array;
  mediaType: VerifiedArtifactRead["mediaType"];
}>;

function appArtifact(
  release: Release,
  html: string,
): readonly (readonly [ArtifactRef, ArtifactFixture])[] {
  const childBytes = new TextEncoder().encode(html);
  const childRef = parseArtifactRef(`artifact:${release.releaseId}.ui`);
  const childDigest = digest("9");
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({
      format: "fungi-app-v1",
      ui: {
        artifactRef: childRef,
        digest: childDigest,
        version: "v1",
        byteLength: childBytes.byteLength,
        mediaType: "text/html; charset=utf-8",
      },
    }),
  );
  return [
    [
      release.artifact.artifactRef,
      { bytes: manifestBytes, mediaType: "application/vnd.fungi.app+json" },
    ],
    [childRef, { bytes: childBytes, mediaType: "text/html; charset=utf-8" }],
  ];
}

function artifactReader(): ArtifactReader {
  const artifacts = new Map([
    ...appArtifact(releaseA, "<!doctype html><p>orchid a</p>"),
    ...appArtifact(releaseB, "<!doctype html><p>orchid b</p>"),
    ...appArtifact(foreignRelease, "<!doctype html><p>lotus</p>"),
  ]);

  return {
    read: ({ artifactRef, expectedDigest }) => {
      const artifact = artifacts.get(artifactRef);
      if (artifact === undefined) return Promise.resolve({ kind: "missing" });
      const { bytes, mediaType } = artifact;
      return Promise.resolve({
        kind: "verified",
        digest: expectedDigest,
        mediaType,
        byteLength: bytes.byteLength,
        bytes: {
          byteLength: bytes.byteLength,
          copy: () => bytes.slice(),
        },
      });
    },
  };
}

function runEffect<Value>(
  program: Effect.Effect<Value, AppReleaseCoreFailure>,
): Promise<Value> {
  return Effect.runPromise(Effect.result(program)).then((result) =>
    Result.match(result, {
      onFailure: (failure) => Promise.reject(failure),
      onSuccess: (value) => Promise.resolve(value),
    }),
  );
}

function effectDriver(core: AppReleaseCore): CatalogDriver {
  return {
    createApp: (app) => runEffect(core.createApp(app)),
    createRelease: (item) => runEffect(core.createRelease(item)),
    verifyReleaseArtifact: (releaseId) =>
      runEffect(core.verifyReleaseArtifact(releaseId)),
    createPublicSurface: (item) => runEffect(core.createPublicSurface(item)),
    transition: (request) => runEffect(core.transition(request)),
  };
}

async function rejected(work: Promise<unknown>): Promise<FailureRecord> {
  const [settled] = await Promise.allSettled([work]);
  if (settled.status !== "rejected") {
    throw new Error("Expected the catalog operation to reject");
  }

  // SAFETY: Promise rejection reasons are hostile until narrowed at this seam.
  const reason: unknown = settled.reason as unknown;
  if (!(reason instanceof Error)) {
    throw new Error("Expected a typed Error rejection");
  }
  return { name: reason.name, message: reason.message };
}

function verifiedRecord(verified: VerifiedArtifactRead) {
  return {
    kind: verified.kind,
    digest: verified.digest,
    mediaType: verified.mediaType,
    byteLength: verified.byteLength,
    copiedBytes: [...verified.bytes.copy()],
  };
}

function receiptRecord(receipt: TransitionReceipt) {
  return {
    transition: receipt.transition,
    hasTransitionId: receipt.transitionId.length > 0,
  };
}

async function exercise(driver: CatalogDriver) {
  const orphanSurface: PublicSurface = {
    publicSurfaceId: parsePublicSurfaceId("ps_orphan"),
    appId: parseAppId("app_absent"),
    stableRoute: parseStableRoute("/orphan"),
  };
  const orphanFailure = await rejected(
    driver.createPublicSurface(platformSurface(orphanSurface)),
  );

  await driver.createApp(owner);
  await driver.createApp(foreignOwner);
  const createdSurface = await driver.createPublicSurface(
    platformSurface(surface),
  );
  const replayedSurface = await driver.createPublicSurface(
    platformSurface(surface),
  );
  const surfaceConflict = await rejected(
    driver.createPublicSurface(
      platformSurface({ ...surface, appId: foreignOwner.appId }),
    ),
  );

  for (const item of [releaseA, releaseB, unverifiedRelease, foreignRelease]) {
    await driver.createRelease(item);
  }

  const verifiedA = await driver.verifyReleaseArtifact(releaseA.releaseId);
  await driver.verifyReleaseArtifact(releaseB.releaseId);
  await driver.verifyReleaseArtifact(foreignRelease.releaseId);
  const missingArtifact = await rejected(
    driver.verifyReleaseArtifact(unverifiedRelease.releaseId),
  );

  const promotion: ReleaseTransition = {
    kind: "promotion",
    publicSurfaceId: surface.publicSurfaceId,
    releaseId: releaseA.releaseId,
    idempotencyKey: parseIdempotencyKey("idem_promote_a"),
  };
  const rollback: ReleaseTransition = {
    kind: "rollback",
    publicSurfaceId: surface.publicSurfaceId,
    releaseId: releaseB.releaseId,
    idempotencyKey: parseIdempotencyKey("idem_rollback_b"),
  };
  const revocation: ReleaseTransition = {
    kind: "revocation",
    releaseId: releaseA.releaseId,
    idempotencyKey: parseIdempotencyKey("idem_revoke_a"),
  };

  await driver.transition({
    ...promotion,
    releaseId: releaseB.releaseId,
    idempotencyKey: parseIdempotencyKey("idem_initial_b"),
  });
  const promoted = await driver.transition(promotion);
  const replayedPromotion = await driver.transition(promotion);
  const rolledBack = await driver.transition(rollback);
  const revoked = await driver.transition(revocation);
  const revokedPromotion = await rejected(
    driver.transition({
      ...promotion,
      idempotencyKey: parseIdempotencyKey("idem_promote_revoked"),
    }),
  );
  const unverifiedPromotion = await rejected(
    driver.transition({
      ...promotion,
      releaseId: unverifiedRelease.releaseId,
      idempotencyKey: parseIdempotencyKey("idem_promote_unverified"),
    }),
  );
  const foreignPromotion = await rejected(
    driver.transition({
      ...promotion,
      releaseId: foreignRelease.releaseId,
      idempotencyKey: parseIdempotencyKey("idem_promote_foreign"),
    }),
  );

  return {
    surface: {
      created: createdSurface,
      replayed: replayedSurface,
      orphanFailure,
      immutableOwnershipFailure: surfaceConflict,
    },
    verification: {
      verified: verifiedRecord(verifiedA),
      missingFailure: missingArtifact,
    },
    transitions: {
      promotion: receiptRecord(promoted),
      promotionReplayIsOriginal:
        replayedPromotion.transitionId === promoted.transitionId,
      rollback: receiptRecord(rolledBack),
      revocation: receiptRecord(revoked),
      revokedFailure: revokedPromotion,
      unverifiedFailure: unverifiedPromotion,
      ownershipFailure: foreignPromotion,
    },
  };
}

it("keeps the default Promise facade and canonical Effect interface in decision parity", async () => {
  const promiseTranscript = await exercise(
    createAppReleaseCatalog({
      store: createDeterministicMemoryAppReleaseStore(fixturePlatformRoutes),
      artifactReader: artifactReader(),
    }),
  );
  const effectTranscript = await exercise(
    effectDriver(
      createAppReleaseCore({
        store: adaptPromiseAppReleaseStore(
          createDeterministicMemoryAppReleaseStore(fixturePlatformRoutes),
        ),
        artifactReader: adaptPromiseArtifactReader(artifactReader()),
      }),
    ),
  );

  expect(effectTranscript).toEqual(promiseTranscript);
  expect(promiseTranscript).toMatchObject({
    surface: {
      created: surface,
      replayed: surface,
      orphanFailure: {
        name: "AppReleaseSurfaceOwnerAppAbsentError",
        message: "Public Surface owner App does not exist",
      },
      immutableOwnershipFailure: {
        name: "AppReleaseImmutableConflictError",
        message: "Release immutable input conflicts with its existing record",
      },
    },
    verification: {
      verified: {
        kind: "verified",
        digest: releaseA.artifact.artifactDigest,
        mediaType: "application/vnd.fungi.app+json",
      },
      missingFailure: {
        name: "AppReleaseArtifactMissingError",
        message: "Release artifact is missing",
      },
    },
    transitions: {
      promotion: { transition: { kind: "promotion" }, hasTransitionId: true },
      promotionReplayIsOriginal: true,
      rollback: { transition: { kind: "rollback" }, hasTransitionId: true },
      revocation: { transition: { kind: "revocation" }, hasTransitionId: true },
      revokedFailure: {
        name: "AppReleaseTransitionReleaseRevokedError",
        message: "Transition Release is revoked",
      },
      unverifiedFailure: {
        name: "AppReleaseTransitionReleaseUnverifiedError",
        message: "Transition Release is not verified",
      },
      ownershipFailure: {
        name: "AppReleaseTransitionOwnershipConflictError",
        message: "Transition Release is not owned by the public Surface App",
      },
    },
  });
});

it("forwards publication intent through a direct Effect artifact reader", async () => {
  const readerCalls: Parameters<
    import("../dist/effect.js").AppReleaseArtifactReader["read"]
  >[0][] = [];
  const bytes = new TextEncoder().encode("<!doctype html><p>orchid a</p>");
  const childRef = parseArtifactRef(`artifact:${releaseA.releaseId}.ui`);
  const childDigest = digest("9");
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      format: "fungi-app-v1",
      ui: {
        artifactRef: childRef,
        digest: childDigest,
        version: "v1",
        byteLength: bytes.byteLength,
        mediaType: "text/html; charset=utf-8",
      },
    }),
  );
  const core = createAppReleaseCore({
    store: adaptPromiseAppReleaseStore(
      createDeterministicMemoryAppReleaseStore(fixturePlatformRoutes),
    ),
    artifactReader: {
      read: (input) => {
        readerCalls.push(input);
        return Effect.succeed({
          kind: "verified" as const,
          digest: input.expectedDigest,
          mediaType:
            input.artifactRef === releaseA.artifact.artifactRef
              ? ("application/vnd.fungi.app+json" as const)
              : ("text/html; charset=utf-8" as const),
          byteLength:
            input.artifactRef === releaseA.artifact.artifactRef
              ? manifest.byteLength
              : bytes.byteLength,
          bytes: {
            byteLength:
              input.artifactRef === releaseA.artifact.artifactRef
                ? manifest.byteLength
                : bytes.byteLength,
            copy: () =>
              (input.artifactRef === releaseA.artifact.artifactRef
                ? manifest
                : bytes
              ).slice(),
          },
        });
      },
    },
  });

  await runEffect(core.createApp(owner));
  await runEffect(core.createRelease(releaseA));
  await runEffect(core.verifyReleaseArtifact(releaseA.releaseId));
  await runEffect(core.resolveEligibleReleaseArtifact(releaseA.releaseId));

  expect(readerCalls).toEqual([
    {
      artifactRef: releaseA.artifact.artifactRef,
      expectedDigest: releaseA.artifact.artifactDigest,
      verification: "publication",
    },
    {
      artifactRef: childRef,
      expectedDigest: childDigest,
      expectedObject: { version: "v1", byteLength: bytes.byteLength },
      verification: "publication",
    },
    {
      artifactRef: releaseA.artifact.artifactRef,
      expectedDigest: releaseA.artifact.artifactDigest,
    },
  ]);
});
