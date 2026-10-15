import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
  AppReleaseImmutableConflictError,
  AppReleaseOwnerAppAbsentError,
  createAppReleaseCatalog,
  parseAppId,
  parseArtifactRef,
  parseReleaseId,
  parseSha256Digest,
  parseSourceRevision,
  type ArtifactReader,
  type Release,
} from "../dist/index.js";
import {
  adaptPromiseAppReleaseStore,
  adaptPromiseArtifactReader,
  createAppReleaseCore,
  createDeterministicMemoryAppReleaseStore,
} from "../dist/effect.js";

const sha256 = (character: string): string => `sha256:${character.repeat(64)}`;

describe("App Release public catalog", () => {
  it("creates one immutable Release once across the default and Effect seams", async () => {
    let artifactReadCount = 0;
    const artifactReader: ArtifactReader = {
      read: () => {
        artifactReadCount += 1;
        return Promise.resolve({ kind: "missing" });
      },
    };
    const app = { appId: parseAppId("app_orchid") };
    const release: Release = {
      releaseId: parseReleaseId("rel_orchid7"),
      appId: app.appId,
      artifact: {
        artifactRef: parseArtifactRef("artifact:orchid.release-7"),
        artifactDigest: parseSha256Digest(sha256("a")),
        provenance: {
          sourceRevision: parseSourceRevision(`git:${"b".repeat(40)}`),
          sourceTreeDigest: parseSha256Digest(sha256("c")),
          buildRecipeDigest: parseSha256Digest(sha256("d")),
        },
      },
    };
    let memoryStore:
      ReturnType<typeof createDeterministicMemoryAppReleaseStore> | undefined;
    let catalog: ReturnType<typeof createAppReleaseCatalog> | undefined;
    let core: ReturnType<typeof createAppReleaseCore> | undefined;

    expect(() => {
      memoryStore = createDeterministicMemoryAppReleaseStore();
      catalog = createAppReleaseCatalog({ artifactReader, store: memoryStore });
      core = createAppReleaseCore({
        artifactReader: adaptPromiseArtifactReader(artifactReader),
        store: adaptPromiseAppReleaseStore(memoryStore),
      });
    }).not.toThrow();

    if (
      memoryStore === undefined ||
      catalog === undefined ||
      core === undefined
    ) {
      throw new Error("App Release public seams were not constructed");
    }

    await expect(catalog.createApp(app)).resolves.toEqual(app);
    await expect(
      Effect.runPromise(core.createRelease(release)),
    ).resolves.toEqual(release);
    await expect(catalog.createRelease(release)).resolves.toEqual(release);

    const changedOwner = {
      ...release,
      appId: parseAppId("app_lily"),
    };
    const changedArtifactRef = {
      ...release,
      artifact: {
        ...release.artifact,
        artifactRef: parseArtifactRef("artifact:orchid.release-8"),
      },
    };
    const changedArtifactDigest = {
      ...release,
      artifact: {
        ...release.artifact,
        artifactDigest: parseSha256Digest(sha256("e")),
      },
    };
    const changedSourceRevision = {
      ...release,
      artifact: {
        ...release.artifact,
        provenance: {
          ...release.artifact.provenance,
          sourceRevision: parseSourceRevision(`git:${"f".repeat(40)}`),
        },
      },
    };
    const changedSourceTreeDigest = {
      ...release,
      artifact: {
        ...release.artifact,
        provenance: {
          ...release.artifact.provenance,
          sourceTreeDigest: parseSha256Digest(sha256("1")),
        },
      },
    };
    const changedBuildRecipeDigest = {
      ...release,
      artifact: {
        ...release.artifact,
        provenance: {
          ...release.artifact.provenance,
          buildRecipeDigest: parseSha256Digest(sha256("2")),
        },
      },
    };

    for (const changedRelease of [
      changedOwner,
      changedArtifactRef,
      changedArtifactDigest,
      changedSourceRevision,
      changedSourceTreeDigest,
      changedBuildRecipeDigest,
    ]) {
      await expect(
        catalog.createRelease(changedRelease),
      ).rejects.toBeInstanceOf(AppReleaseImmutableConflictError);
    }

    await expect(catalog.createRelease(release)).resolves.toEqual(release);

    const releaseWithoutCreatedOwner: Release = {
      ...release,
      releaseId: parseReleaseId("rel_orchid8"),
      appId: parseAppId("app_uncreated"),
    };
    await expect(
      Effect.runPromise(
        Effect.flip(core.createRelease(releaseWithoutCreatedOwner)),
      ),
    ).resolves.toBeInstanceOf(AppReleaseOwnerAppAbsentError);
    expect(artifactReadCount).toBe(0);
  });
});
