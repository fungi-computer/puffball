import {
  platformSurface,
  fixturePlatformRoutes,
} from "./support/platform-publication.js";
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
  type Release,
  type ReleaseTransition,
} from "../dist/index.js";
import { createDeterministicMemoryAppReleaseStore } from "../dist/effect.js";

const digest = (character: string) =>
  parseSha256Digest(`sha256:${character.repeat(64)}`);

it("promotes, revokes, and rolls back already verified immutable Releases idempotently", async () => {
  const htmlByDigest = new Map([
    [digest("a"), new TextEncoder().encode("<!doctype html><p>release-a</p>")],
    [digest("b"), new TextEncoder().encode("<!doctype html><p>release-b</p>")],
  ]);
  const artifactReaderCalls: {
    readonly artifactRef: ReturnType<typeof parseArtifactRef>;
    readonly expectedDigest: ReturnType<typeof parseSha256Digest>;
  }[] = [];
  const artifactReader: ArtifactReader = {
    read: (input) => {
      const isChild = input.artifactRef.endsWith(".ui");
      artifactReaderCalls.push(input);
      if (isChild) {
        const bytes = new TextEncoder().encode("<!doctype html><p>child</p>");
        return Promise.resolve({
          kind: "verified" as const,
          digest: input.expectedDigest,
          mediaType: "text/html; charset=utf-8" as const,
          bytes: { byteLength: bytes.byteLength, copy: () => bytes.slice() },
          byteLength: bytes.byteLength,
        });
      }
      const bytes = htmlByDigest.get(input.expectedDigest);
      if (bytes === undefined)
        return Promise.resolve({ kind: "missing" as const });
      const childBytes = new TextEncoder().encode(
        "<!doctype html><p>child</p>",
      );
      const childRef = parseArtifactRef(
        `artifact:${input.artifactRef.slice("artifact:".length)}.ui`,
      );
      const manifest = new TextEncoder().encode(
        JSON.stringify({
          format: "fungi-app-v1",
          ui: {
            artifactRef: childRef,
            digest: parseSha256Digest(`sha256:${"9".repeat(64)}`),
            version: "v1",
            byteLength: childBytes.byteLength,
            mediaType: "text/html; charset=utf-8",
          },
        }),
      );
      return Promise.resolve({
        kind: "verified" as const,
        digest: input.expectedDigest,
        mediaType: "application/vnd.fungi.app+json" as const,
        bytes: {
          byteLength: manifest.byteLength,
          copy: () => manifest.slice(),
        },
        byteLength: manifest.byteLength,
      });
    },
  };
  const app = { appId: parseAppId("app_orchid") };
  const surface = {
    publicSurfaceId: parsePublicSurfaceId("ps_orchid"),
    appId: app.appId,
    stableRoute: parseStableRoute("/orchid"),
  };
  const releaseA: Release = {
    releaseId: parseReleaseId("rel_orchida"),
    appId: app.appId,
    artifact: {
      artifactRef: parseArtifactRef("artifact:orchid.release-a"),
      artifactDigest: digest("a"),
      provenance: {
        sourceRevision: parseSourceRevision(`git:${"a".repeat(40)}`),
        sourceTreeDigest: digest("c"),
        buildRecipeDigest: digest("d"),
      },
    },
  };
  const releaseB: Release = {
    releaseId: parseReleaseId("rel_orchidb"),
    appId: app.appId,
    artifact: {
      artifactRef: parseArtifactRef("artifact:orchid.release-b"),
      artifactDigest: digest("b"),
      provenance: {
        sourceRevision: parseSourceRevision(`git:${"b".repeat(40)}`),
        sourceTreeDigest: digest("e"),
        buildRecipeDigest: digest("f"),
      },
    },
  };
  const catalog = createAppReleaseCatalog({
    artifactReader,
    store: createDeterministicMemoryAppReleaseStore(fixturePlatformRoutes),
  });

  await expect(catalog.createApp(app)).resolves.toEqual(app);
  await expect(
    catalog.createPublicSurface(platformSurface(surface)),
  ).resolves.toEqual(surface);
  await expect(catalog.createRelease(releaseA)).resolves.toEqual(releaseA);
  await expect(catalog.createRelease(releaseB)).resolves.toEqual(releaseB);
  await expect(
    catalog.verifyReleaseArtifact(releaseA.releaseId),
  ).resolves.toMatchObject({
    kind: "verified",
    digest: releaseA.artifact.artifactDigest,
  });
  await expect(
    catalog.verifyReleaseArtifact(releaseB.releaseId),
  ).resolves.toMatchObject({
    kind: "verified",
    digest: releaseB.artifact.artifactDigest,
  });

  const promotion: ReleaseTransition = {
    kind: "promotion",
    publicSurfaceId: surface.publicSurfaceId,
    releaseId: releaseA.releaseId,
    idempotencyKey: parseIdempotencyKey("idem_promotea"),
  };
  const revocation: ReleaseTransition = {
    kind: "revocation",
    releaseId: releaseA.releaseId,
    idempotencyKey: parseIdempotencyKey("idem_revokea"),
  };
  const rollback: ReleaseTransition = {
    kind: "rollback",
    publicSurfaceId: surface.publicSurfaceId,
    releaseId: releaseB.releaseId,
    idempotencyKey: parseIdempotencyKey("idem_rollbackb"),
  };

  await catalog.transition({
    kind: "promotion",
    publicSurfaceId: surface.publicSurfaceId,
    releaseId: releaseB.releaseId,
    idempotencyKey: parseIdempotencyKey("idem_initial_b"),
  });
  const promotedOutcome = await Promise.allSettled([
    catalog.transition(promotion),
  ]);
  const transitionIdMatcher: unknown = expect.any(String);
  expect(promotedOutcome).toEqual([
    {
      status: "fulfilled",
      value: {
        transition: promotion,
        transitionId: transitionIdMatcher,
      },
    },
  ]);
  if (promotedOutcome[0].status !== "fulfilled") {
    throw new Error("Expected promotion to fulfill");
  }
  const promoted = promotedOutcome[0].value;
  const replayedPromotion = await catalog.transition(promotion);
  const revoked = await catalog.transition(revocation);
  const replayedAfterRevocation = await catalog.transition(promotion);
  const rolledBack = await catalog.transition(rollback);

  for (const [receipt, request] of [
    [promoted, promotion],
    [revoked, revocation],
    [rolledBack, rollback],
  ] as const) {
    expect(receipt.transition).toEqual(request);
    expect(receipt.transitionId).toEqual(expect.any(String));
    expect(receipt.transitionId.length).toBeGreaterThan(0);
  }
  expect(replayedPromotion).toEqual(promoted);
  expect(replayedAfterRevocation).toEqual(promoted);
  const childDigest = parseSha256Digest(`sha256:${"9".repeat(64)}`);
  const childByteLength = new TextEncoder().encode(
    "<!doctype html><p>child</p>",
  ).byteLength;
  const childCall = (release: Release) => ({
    artifactRef: parseArtifactRef(
      `artifact:${release.artifact.artifactRef.slice("artifact:".length)}.ui`,
    ),
    expectedDigest: childDigest,
    expectedObject: { version: "v1", byteLength: childByteLength },
    verification: "publication" as const,
  });
  const rootCall = (release: Release) => ({
    artifactRef: release.artifact.artifactRef,
    expectedDigest: release.artifact.artifactDigest,
    verification: "publication" as const,
  });
  expect(artifactReaderCalls).toHaveLength(10);
  expect(artifactReaderCalls).toEqual([
    rootCall(releaseA),
    childCall(releaseA),
    rootCall(releaseB),
    childCall(releaseB),
    rootCall(releaseB),
    childCall(releaseB),
    rootCall(releaseA),
    childCall(releaseA),
    rootCall(releaseB),
    childCall(releaseB),
  ]);
  expect(revoked).not.toEqual(
    expect.objectContaining({ transition: promotion }),
  );
  expect(rolledBack).not.toEqual(
    expect.objectContaining({ transition: revocation }),
  );
});
