import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  createAppReleaseCatalog,
  parseAppId,
  parseArtifactRef,
  parseReleaseId,
  parseSha256Digest,
  parseSourceRevision,
} from "../dist/index.js";
import {
  APP_RELEASE_D1_FRESH_SCHEMA,
  createD1AppReleaseStore,
  createR2ArtifactReader,
} from "../dist/cloudflare.js";
import { createDeterministicMemoryAppReleaseStore } from "../dist/effect.js";

const html = "<!doctype html><p>orchid durable</p>";
const expectedBytes = new globalThis.TextEncoder().encode(html);
const uiArtifactRef = parseArtifactRef("artifact:a1durable.ui-7");
const manifestBytes = new globalThis.TextEncoder().encode(
  JSON.stringify({
    format: "fungi-app-v1",
    ui: {
      artifactRef: uiArtifactRef,
      digest:
        "sha256:3ed35afbfc174e056b576404c501b1658f5ceb530571cc42d2894e3ddefd5575",
      version: "v1",
      byteLength: expectedBytes.byteLength,
      mediaType: "text/html; charset=utf-8",
    },
  }),
);
const expectedDigest = parseSha256Digest(
  "sha256:d61c92c93849604c9ae0f0fde82facad5995064ed5a1567a90597637fc05f660",
);
const app = { appId: parseAppId("app_a1durable") };
const release = {
  releaseId: parseReleaseId("rel_a1durable"),
  appId: app.appId,
  artifact: {
    artifactRef: parseArtifactRef("artifact:a1durable.release-7"),
    artifactDigest: expectedDigest,
    provenance: {
      sourceRevision: parseSourceRevision(`git:${"a".repeat(40)}`),
      sourceTreeDigest: parseSha256Digest(`sha256:${"b".repeat(64)}`),
      buildRecipeDigest: parseSha256Digest(`sha256:${"c".repeat(64)}`),
    },
  },
};

function createFixtureArtifactReader() {
  const backing = expectedBytes.slice();
  return {
    read: async ({ artifactRef, expectedDigest }) => {
      expect([release.artifact.artifactRef, uiArtifactRef]).toContain(
        artifactRef,
      );
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
              ? manifestBytes.byteLength
              : backing.byteLength,
          copy: () =>
            artifactRef === release.artifact.artifactRef
              ? manifestBytes.slice()
              : backing.slice(),
        },
        byteLength:
          artifactRef === release.artifact.artifactRef
            ? manifestBytes.byteLength
            : backing.byteLength,
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

async function assertCatalogReplay(catalog) {
  await expectFulfilled(catalog.createApp(app), app);
  await expectFulfilled(catalog.createApp(app), app);
  await expectFulfilled(catalog.createRelease(release), release);
  await expectFulfilled(catalog.createRelease(release), release);

  const first = await catalog.verifyReleaseArtifact(release.releaseId);
  const second = await catalog.verifyReleaseArtifact(release.releaseId);

  for (const verified of [first, second]) {
    expect(verified.kind).toBe("verified");
    expect(verified.digest).toBe(expectedDigest);
    expect(verified.mediaType).toBe("application/vnd.fungi.app+json");
    expect(verified.byteLength).toBe(manifestBytes.byteLength);
    expect(verified.bytes.byteLength).toBe(manifestBytes.byteLength);
    expect(verified.bytes.copy()).toEqual(manifestBytes);
  }

  const firstCopy = first.bytes.copy();
  const secondCopy = first.bytes.copy();
  expect(firstCopy).not.toBe(secondCopy);
  firstCopy[0] ^= 0xff;
  expect(secondCopy).toEqual(manifestBytes);
  expect(first.bytes.copy()).toEqual(manifestBytes);
  expect(second.bytes.copy()).toEqual(manifestBytes);
}

async function expectFulfilled(promise, expected) {
  const [outcome] = await Promise.allSettled([promise]);
  expect(outcome?.status).toBe("fulfilled");
  if (outcome?.status === "fulfilled") expect(outcome.value).toEqual(expected);
}

describe("App Release Cloudflare catalog conformance", () => {
  it("replays one App and immutable Release through memory and native D1/R2", async () => {
    const memoryCatalog = createAppReleaseCatalog({
      store: createDeterministicMemoryAppReleaseStore(),
      artifactReader: createFixtureArtifactReader(),
    });

    await assertCatalogReplay(memoryCatalog);

    await env.APP_RELEASE_CATALOG.exec(APP_RELEASE_D1_FRESH_SCHEMA);
    await env.APP_RELEASE_ARTIFACTS.put(
      release.artifact.artifactRef,
      manifestBytes,
      { httpMetadata: { contentType: "application/vnd.fungi.app+json" } },
    );
    await env.APP_RELEASE_ARTIFACTS.put(uiArtifactRef, expectedBytes, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
    const seeded = await env.APP_RELEASE_ARTIFACTS.get(
      release.artifact.artifactRef,
    );
    expect(seeded).not.toBeNull();
    if (seeded === null) throw new Error("R2 artifact seed was not retained");
    expect(new Uint8Array(await seeded.arrayBuffer())).toEqual(manifestBytes);

    const nativeCatalog = createAppReleaseCatalog({
      store: createD1AppReleaseStore(env.APP_RELEASE_CATALOG),
      artifactReader: createFixtureR2ArtifactReader(),
    });
    await assertCatalogReplay(nativeCatalog);
  });
});
