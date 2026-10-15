import { describe, expect, it } from "vitest";

import {
  AppReleaseArtifactDigestMismatchError,
  AppReleaseArtifactInvalidSnapshotError,
  createAppReleaseCatalog,
  parseAppId,
  parseArtifactRef,
  parseReleaseId,
  parseSha256Digest,
  parseSourceRevision,
  type AppReleaseCatalogOptions,
  type ArtifactReader,
  type PromiseAppReleaseStore,
  type Release,
} from "../dist/index.js";
import { createDeterministicMemoryAppReleaseStore } from "../dist/effect.js";

const expectedDigest = parseSha256Digest(`sha256:${"a".repeat(64)}`);
const actualDigest = parseSha256Digest(`sha256:${"b".repeat(64)}`);
const appId = parseAppId("app_snapshot");
const releaseId = parseReleaseId("rel_snapshot");
const artifactRef = parseArtifactRef("artifact:snapshot");
const childArtifactRef = parseArtifactRef("artifact:snapshot.ui");
const childDigest = parseSha256Digest(`sha256:${"f".repeat(64)}`);
const defaultChildBytes = new TextEncoder().encode(
  "<!doctype html><p>snapshot</p>",
);

const release: Release = {
  releaseId,
  appId,
  artifact: {
    artifactRef,
    artifactDigest: expectedDigest,
    provenance: {
      sourceRevision: parseSourceRevision(`git:${"c".repeat(40)}`),
      sourceTreeDigest: parseSha256Digest(`sha256:${"d".repeat(64)}`),
      buildRecipeDigest: parseSha256Digest(`sha256:${"e".repeat(64)}`),
    },
  },
};

type SnapshotResult = Extract<
  Awaited<ReturnType<ArtifactReader["read"]>>,
  { readonly kind: "verified" }
>;

function verifiedSnapshot(
  byteLength: number,
  bytes: SnapshotResult["bytes"] = {
    byteLength,
    copy: () => new Uint8Array(byteLength),
  },
): SnapshotResult {
  return {
    kind: "verified",
    digest: expectedDigest,
    mediaType: "text/html; charset=utf-8",
    bytes,
    byteLength,
  };
}

function makeFixture(
  result: Awaited<ReturnType<ArtifactReader["read"]>>,
  maxBytes?: number,
) {
  const base = createDeterministicMemoryAppReleaseStore();
  let recordReleaseVerificationCalls = 0;
  const store: PromiseAppReleaseStore = {
    ...base,
    recordReleaseVerification: (input) => {
      recordReleaseVerificationCalls += 1;
      const record = base.recordReleaseVerification;
      if (record === undefined) {
        return Promise.resolve({
          kind: "failure" as const,
          failure: { kind: "unavailable" as const },
        });
      }
      return record(input);
    },
  };
  const readerCalls: Parameters<ArtifactReader["read"]>[0][] = [];
  const childByteLength =
    result.kind === "verified"
      ? Math.max(result.byteLength, 1)
      : defaultChildBytes.byteLength;
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({
      format: "fungi-app-v1",
      ui: {
        artifactRef: childArtifactRef,
        digest: childDigest,
        version: "v1",
        byteLength: childByteLength,
        mediaType: "text/html; charset=utf-8",
      },
    }),
  );
  const rootResult = {
    kind: "verified" as const,
    digest: expectedDigest,
    mediaType: "application/vnd.fungi.app+json" as const,
    bytes: {
      byteLength: manifestBytes.byteLength,
      copy: () => manifestBytes.slice(),
    },
    byteLength: manifestBytes.byteLength,
  };
  const artifactReader: ArtifactReader = {
    read: (input) => {
      readerCalls.push(input);
      if (input.artifactRef === artifactRef) {
        return Promise.resolve(
          result.kind === "digest-mismatch" ? result : rootResult,
        );
      }
      return Promise.resolve(
        result.kind === "verified"
          ? { ...result, digest: childDigest }
          : result,
      );
    },
  };
  const options: AppReleaseCatalogOptions =
    maxBytes === undefined
      ? { store, artifactReader }
      : { store, artifactReader, artifactPolicy: { maxBytes } };
  const catalog = createAppReleaseCatalog(options);
  return {
    catalog,
    readerCalls,
    childByteLength,
    getRecordReleaseVerificationCalls: () => recordReleaseVerificationCalls,
  };
}

describe("App Release artifact snapshot bounds", () => {
  it.each([
    ["empty", verifiedSnapshot(0)],
    ["oversized", verifiedSnapshot(65_537)],
    ["fractional declared length", verifiedSnapshot(1.5)],
    [
      "declared bytes/copy mismatch",
      verifiedSnapshot(4, { byteLength: 4, copy: () => new Uint8Array(3) }),
    ],
    [
      "non-Uint8Array copy",
      verifiedSnapshot(4, {
        byteLength: 4,
        copy: () => {
          const hostile = new Uint8Array(4);
          Object.setPrototypeOf(hostile, Array.prototype);
          return hostile;
        },
      }),
    ],
    [
      "throwing copy",
      verifiedSnapshot(4, {
        byteLength: 4,
        copy: () => {
          throw new Error("hostile copy");
        },
      }),
    ],
  ])(
    "rejects %s snapshots before recording verification",
    async (_, result) => {
      const fixture = makeFixture(result);
      await expect(fixture.catalog.createApp({ appId })).resolves.toEqual({
        appId,
      });
      await expect(fixture.catalog.createRelease(release)).resolves.toEqual(
        release,
      );

      await expect(
        fixture.catalog.verifyReleaseArtifact(releaseId),
      ).rejects.toBeInstanceOf(AppReleaseArtifactInvalidSnapshotError);
      expect(fixture.readerCalls).toEqual(
        _ === "fractional declared length"
          ? [{ artifactRef, expectedDigest, verification: "publication" }]
          : [
              { artifactRef, expectedDigest, verification: "publication" },
              {
                artifactRef: childArtifactRef,
                expectedDigest: childDigest,
                expectedObject: {
                  version: "v1",
                  byteLength: fixture.childByteLength,
                },
                verification: "publication",
              },
            ],
      );
      expect(fixture.getRecordReleaseVerificationCalls()).toBe(0);
    },
  );

  it("closes a differing actual digest without using it to locate bytes", async () => {
    const fixture = makeFixture({
      kind: "digest-mismatch",
      actualDigest,
    });
    await fixture.catalog.createApp({ appId });
    await fixture.catalog.createRelease(release);

    await expect(
      fixture.catalog.verifyReleaseArtifact(releaseId),
    ).rejects.toBeInstanceOf(AppReleaseArtifactDigestMismatchError);
    expect(fixture.readerCalls).toEqual([
      { artifactRef, expectedDigest, verification: "publication" },
    ]);
    expect(fixture.readerCalls[0]?.expectedDigest).not.toBe(actualDigest);
    expect(fixture.getRecordReleaseVerificationCalls()).toBe(0);
  });

  it.each([
    ["minimum", 1],
    ["maximum", 65_536],
  ])("accepts the %s snapshot bound", async (_, byteLength) => {
    const fixture = makeFixture(
      verifiedSnapshot(byteLength, {
        byteLength,
        copy: () => new Uint8Array(byteLength),
      }),
    );
    await fixture.catalog.createApp({ appId });
    await fixture.catalog.createRelease(release);

    await expect(
      fixture.catalog.verifyReleaseArtifact(releaseId),
    ).resolves.toMatchObject({
      kind: "verified",
      digest: expectedDigest,
      mediaType: "application/vnd.fungi.app+json",
    });
    expect(fixture.readerCalls[0]?.artifactRef).toBe(artifactRef);
    expect(fixture.readerCalls[1]?.expectedObject).toEqual({
      version: "v1",
      byteLength,
    });
    expect(fixture.getRecordReleaseVerificationCalls()).toBe(1);
  });
  it("accepts a configured greater-than-fixture artifact and rejects one byte over it", async () => {
    const policy = 65_537;
    const accepted = makeFixture(verifiedSnapshot(policy), policy);
    await accepted.catalog.createApp({ appId });
    await accepted.catalog.createRelease(release);
    await expect(
      accepted.catalog.verifyReleaseArtifact(releaseId),
    ).resolves.toMatchObject({
      mediaType: "application/vnd.fungi.app+json",
    });
    expect(accepted.readerCalls[1]?.expectedObject).toEqual({
      version: "v1",
      byteLength: policy,
    });

    const rejected = makeFixture(verifiedSnapshot(policy + 1), policy);
    await rejected.catalog.createApp({ appId });
    await rejected.catalog.createRelease(release);
    await expect(
      rejected.catalog.verifyReleaseArtifact(releaseId),
    ).rejects.toBeInstanceOf(AppReleaseArtifactInvalidSnapshotError);
    expect(rejected.getRecordReleaseVerificationCalls()).toBe(0);
  });
});
