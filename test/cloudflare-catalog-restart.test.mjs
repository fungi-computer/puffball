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

const html = "<!doctype html><p>orchid restart</p>";
const expectedBytes = new globalThis.TextEncoder().encode(html);
const uiArtifactRef = parseArtifactRef("artifact:a1restart.ui-7");
const manifestBytes = new globalThis.TextEncoder().encode(
  JSON.stringify({
    format: "fungi-app-v1",
    ui: {
      artifactRef: uiArtifactRef,
      digest:
        "sha256:b38e7ae4b3cb28e1209fe8faf2a6c49c991eeee9b761ca32497ba81af389fc88",
      version: "v1",
      byteLength: expectedBytes.byteLength,
      mediaType: "text/html; charset=utf-8",
    },
  }),
);
const expectedDigest = parseSha256Digest(
  "sha256:ec178edb5a458a60e2594d9bd35c3cec98f8814802901c9c03690119262245e6",
);
const app = { appId: parseAppId("app_a1restart") };
const release = {
  releaseId: parseReleaseId("rel_a1restart"),
  appId: app.appId,
  artifact: {
    artifactRef: parseArtifactRef("artifact:a1restart.release-7"),
    artifactDigest: expectedDigest,
    provenance: {
      sourceRevision: parseSourceRevision(`git:${"d".repeat(40)}`),
      sourceTreeDigest: parseSha256Digest(`sha256:${"e".repeat(64)}`),
      buildRecipeDigest: parseSha256Digest(`sha256:${"f".repeat(64)}`),
    },
  },
};

async function expectFulfilled(promise, expected) {
  const [outcome] = await Promise.allSettled([promise]);
  expect(outcome?.status).toBe("fulfilled");
  if (outcome?.status === "fulfilled") expect(outcome.value).toEqual(expected);
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

async function assertVerified(catalog) {
  const verified = await catalog.verifyReleaseArtifact(release.releaseId);
  expect(verified.kind).toBe("verified");
  expect(verified.digest).toBe(expectedDigest);
  expect(verified.mediaType).toBe("application/vnd.fungi.app+json");
  expect(verified.byteLength).toBe(manifestBytes.byteLength);
  expect(verified.bytes.byteLength).toBe(manifestBytes.byteLength);

  const firstCopy = verified.bytes.copy();
  const secondCopy = verified.bytes.copy();
  expect(firstCopy).not.toBe(secondCopy);
  expect(firstCopy).toEqual(manifestBytes);
  expect(secondCopy).toEqual(manifestBytes);
  firstCopy[0] ^= 0xff;
  expect(secondCopy).toEqual(manifestBytes);
  expect(verified.bytes.copy()).toEqual(manifestBytes);
}

describe("App Release Cloudflare catalog restart characterization", () => {
  it("replays durable App, Release, and verified artifact after adapter reconstruction", async () => {
    await env.APP_RELEASE_CATALOG.exec(APP_RELEASE_D1_FRESH_SCHEMA);
    await env.APP_RELEASE_ARTIFACTS.put(
      release.artifact.artifactRef,
      manifestBytes,
      { httpMetadata: { contentType: "application/vnd.fungi.app+json" } },
    );
    await env.APP_RELEASE_ARTIFACTS.put(uiArtifactRef, expectedBytes, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });

    {
      const catalogA = createAppReleaseCatalog({
        store: createD1AppReleaseStore(env.APP_RELEASE_CATALOG),
        artifactReader: createFixtureR2ArtifactReader(),
      });
      await expectFulfilled(catalogA.createApp(app), app);
      await expectFulfilled(catalogA.createRelease(release), release);
      await assertVerified(catalogA);
    }

    const catalogB = createAppReleaseCatalog({
      store: createD1AppReleaseStore(env.APP_RELEASE_CATALOG),
      artifactReader: createFixtureR2ArtifactReader(),
    });
    await expectFulfilled(catalogB.createApp(app), app);
    await expectFulfilled(catalogB.createApp(app), app);
    await expectFulfilled(catalogB.createRelease(release), release);
    await expectFulfilled(catalogB.createRelease(release), release);
    await assertVerified(catalogB);
    await expect(
      catalogB.resolveEligibleAppMetadata(release.releaseId),
    ).resolves.toEqual({
      release,
      digest: expectedDigest,
      description: {
        format: "fungi-app-v1",
        ui: {
          artifactRef: uiArtifactRef,
          digest: parseSha256Digest(
            "sha256:b38e7ae4b3cb28e1209fe8faf2a6c49c991eeee9b761ca32497ba81af389fc88",
          ),
          mediaType: "text/html; charset=utf-8",
          version: "v1",
          byteLength: expectedBytes.byteLength,
        },
        backend: null,
        // Metadata verified from an undeclared root requests nothing.
        declaration: { capabilities: [], handlers: [], roles: [] },
      },
    });

    const store = createD1AppReleaseStore(env.APP_RELEASE_CATALOG);
    const conflict = await store.recordReleaseVerification({
      releaseId: release.releaseId,
      digest: expectedDigest,
      mediaType: "application/vnd.fungi.app+json",
      description: {
        format: "fungi-app-v1",
        ui: {
          artifactRef: uiArtifactRef,
          digest: parseSha256Digest(`sha256:${"0".repeat(64)}`),
          mediaType: "text/html; charset=utf-8",
          version: "v1",
          byteLength: expectedBytes.byteLength,
        },
        backend: null,
      },
    });
    expect(conflict.kind).toBe("failure");
  });
});
