import { describe, expect, it } from "vitest";

import {
  createAppReleaseCatalog,
  AppReleaseArtifactUnavailableError,
  AppReleaseReleaseAbsentError,
  parseAppId,
  parseArtifactRef,
  parseReleaseId,
  parseSha256Digest,
  parseSourceRevision,
  type ArtifactReader,
  type Release,
} from "../dist/index.js";
import { createDeterministicMemoryAppReleaseStore } from "../dist/effect.js";

const digest = `sha256:${"a".repeat(64)}`;
const html = "<!doctype html><p>orchid</p>";

describe("App Release artifact verification", () => {
  it("fails closed before reading an artifact for an absent Release", async () => {
    let readerCalls = 0;
    const queriedReleaseId = parseReleaseId("rel_absent7");
    const catalog = createAppReleaseCatalog({
      artifactReader: {
        read: () => {
          readerCalls += 1;
          return Promise.resolve({ kind: "missing" });
        },
      },
      store: createDeterministicMemoryAppReleaseStore(),
    });

    const [outcome] = await Promise.allSettled([
      catalog.verifyReleaseArtifact(queriedReleaseId),
    ]);

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") {
      throw new Error("Expected a missing Release failure");
    }
    expect(outcome.reason).toBeInstanceOf(AppReleaseReleaseAbsentError);
    if (!(outcome.reason instanceof AppReleaseReleaseAbsentError)) {
      throw new Error("Expected a missing Release failure");
    }
    expect(outcome.reason.name).toBe("AppReleaseReleaseAbsentError");
    expect(outcome.reason.message).toBe("Release does not exist");
    expect(outcome.reason.message).not.toContain(queriedReleaseId);
    expect(readerCalls).toBe(0);
  });

  it("verifies a stored Release artifact as an owned immutable snapshot", async () => {
    const readerBacking = new TextEncoder().encode(html);
    const readerCalls: {
      readonly artifactRef: ReturnType<typeof parseArtifactRef>;
      readonly expectedDigest: ReturnType<typeof parseSha256Digest>;
    }[] = [];
    const app = { appId: parseAppId("app_orchid") };
    const release: Release = {
      releaseId: parseReleaseId("rel_orchid7"),
      appId: app.appId,
      artifact: {
        artifactRef: parseArtifactRef("artifact:orchid.release-7"),
        artifactDigest: parseSha256Digest(digest),
        provenance: {
          sourceRevision: parseSourceRevision(`git:${"b".repeat(40)}`),
          sourceTreeDigest: parseSha256Digest(`sha256:${"c".repeat(64)}`),
          buildRecipeDigest: parseSha256Digest(`sha256:${"d".repeat(64)}`),
        },
      },
    };
    const childArtifactRef = parseArtifactRef("artifact:orchid.ui-7");
    const childDigest = parseSha256Digest(`sha256:${"e".repeat(64)}`);
    const manifest = new TextEncoder().encode(
      JSON.stringify({
        format: "fungi-app-v1",
        ui: {
          artifactRef: childArtifactRef,
          digest: childDigest,
          version: "v1",
          byteLength: readerBacking.byteLength,
          mediaType: "text/html; charset=utf-8",
        },
      }),
    );
    const readerBackingRoot = manifest.slice();
    const artifactReader: ArtifactReader = {
      read: (input) => {
        readerCalls.push(input);
        if (input.artifactRef === release.artifact.artifactRef) {
          return Promise.resolve({
            kind: "verified",
            digest: input.expectedDigest,
            mediaType: "application/vnd.fungi.app+json",
            bytes: {
              byteLength: readerBackingRoot.byteLength,
              copy: () => readerBackingRoot,
            },
            byteLength: readerBackingRoot.byteLength,
          });
        }
        return Promise.resolve({
          kind: "verified",
          digest: input.expectedDigest,
          mediaType: "text/html; charset=utf-8",
          bytes: {
            byteLength: readerBacking.byteLength,
            copy: () => readerBacking,
          },
          byteLength: readerBacking.byteLength,
        });
      },
    };
    const catalog = createAppReleaseCatalog({
      artifactReader,
      store: createDeterministicMemoryAppReleaseStore(),
    });

    await expect(catalog.createApp(app)).resolves.toEqual(app);
    await expect(catalog.createRelease(release)).resolves.toEqual(release);

    const outcome = await catalog.verifyReleaseArtifact(release.releaseId).then(
      (value) => ({ status: "fulfilled" as const, value }),
      () => ({ status: "rejected" as const }),
    );
    expect(outcome).toMatchObject({
      status: "fulfilled",
      value: {
        kind: "verified",
        digest: release.artifact.artifactDigest,
        mediaType: "application/vnd.fungi.app+json",
        byteLength: manifest.byteLength,
      },
    });
    if (outcome.status === "rejected") {
      throw new Error("Expected artifact verification to fulfill");
    }
    const verifiedArtifact = outcome.value;

    expect([
      verifiedArtifact.bytes.byteLength,
      verifiedArtifact.byteLength,
    ]).toEqual([manifest.byteLength, manifest.byteLength]);
    expect(readerCalls).toEqual([
      {
        artifactRef: release.artifact.artifactRef,
        expectedDigest: release.artifact.artifactDigest,
        verification: "publication",
      },
      {
        artifactRef: childArtifactRef,
        expectedDigest: childDigest,
        expectedObject: { version: "v1", byteLength: readerBacking.byteLength },
        verification: "publication",
      },
    ]);
    expect(verifiedArtifact.digest).toBe(release.artifact.artifactDigest);
    expect(verifiedArtifact.mediaType).toBe("application/vnd.fungi.app+json");
    expect(verifiedArtifact.byteLength).toBe(manifest.byteLength);

    const snapshotBeforeBackingMutation = verifiedArtifact.bytes.copy();
    readerBackingRoot[0] = 0;
    expect(snapshotBeforeBackingMutation).toEqual(manifest);

    const firstCopy = verifiedArtifact.bytes.copy();
    const secondCopy = verifiedArtifact.bytes.copy();
    expect(firstCopy).toEqual(manifest);
    expect(secondCopy).toEqual(manifest);
    expect(firstCopy).not.toBe(secondCopy);

    firstCopy[0] = 0;
    expect(secondCopy).toEqual(manifest);
  });

  it("closes a rejected artifact-reader Promise as unavailable", async () => {
    const readerCalls: {
      readonly artifactRef: ReturnType<typeof parseArtifactRef>;
      readonly expectedDigest: ReturnType<typeof parseSha256Digest>;
    }[] = [];
    const readerSentinel = new Error("reader-sentinel");
    const artifactReader: ArtifactReader = {
      read: (input) => {
        readerCalls.push(input);
        return Promise.reject(readerSentinel);
      },
    };
    const app = { appId: parseAppId("app_rejection") };
    const release: Release = {
      releaseId: parseReleaseId("rel_rejection7"),
      appId: app.appId,
      artifact: {
        artifactRef: parseArtifactRef("artifact:rejection.release-7"),
        artifactDigest: parseSha256Digest(digest),
        provenance: {
          sourceRevision: parseSourceRevision(`git:${"e".repeat(40)}`),
          sourceTreeDigest: parseSha256Digest(`sha256:${"f".repeat(64)}`),
          buildRecipeDigest: parseSha256Digest(`sha256:${"0".repeat(64)}`),
        },
      },
    };
    const catalog = createAppReleaseCatalog({
      artifactReader,
      store: createDeterministicMemoryAppReleaseStore(),
    });

    await expect(catalog.createApp(app)).resolves.toEqual(app);
    await expect(catalog.createRelease(release)).resolves.toEqual(release);

    const [outcome] = await Promise.allSettled([
      catalog.verifyReleaseArtifact(release.releaseId),
    ]);

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") {
      throw new Error("Expected an unavailable artifact failure");
    }
    expect(outcome.reason).toBeInstanceOf(AppReleaseArtifactUnavailableError);
    if (!(outcome.reason instanceof AppReleaseArtifactUnavailableError)) {
      throw new Error("Expected an unavailable artifact failure");
    }
    const failure = outcome.reason;
    expect(failure).not.toBe(readerSentinel);
    expect(failure.name).toBe("AppReleaseArtifactUnavailableError");
    expect(failure.message).toBe("Release artifact is unavailable");
    expect(failure.message).not.toContain("reader-sentinel");
    expect("cause" in failure).toBe(false);
    expect("detail" in failure).toBe(false);
    expect(readerCalls).toEqual([
      {
        artifactRef: release.artifact.artifactRef,
        expectedDigest: release.artifact.artifactDigest,
        verification: "publication",
      },
    ]);
  });
});
