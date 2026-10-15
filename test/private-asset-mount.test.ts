import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  readSelectedAssetBuild,
  readPublicAssetBuild,
} from "../src/cloudflare-assets.js";
import { assetBuildMediaType } from "../src/assets.js";
import {
  parseAppId,
  parseArtifactRef,
  parseReleaseId,
  parseSha256Digest,
  parseSourceRevision,
  parseStableRoute,
} from "../src/index.js";
it("mounts a relative candidate at an authorized private prefix without making it public", async () => {
  const digest = (body: Uint8Array) =>
    parseSha256Digest(
      `sha256:${createHash("sha256").update(body).digest("hex")}`,
    );
  const body = new TextEncoder().encode(
    '<script type="module" src="./app.js"></script>',
  );
  const code = new TextEncoder().encode(
    'document.body.textContent="private edit"',
  );
  const assets = [
    ["/index.html", body, "text/html"],
    ["/app.js", code, "text/javascript"],
  ] as const;
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      format: "fungi-assets-v1",
      base: "./",
      assets: assets.map(([path, value, contentType]) => ({
        path,
        artifactRef: `artifact:${path.slice(1)}`,
        digest: digest(value),
        version: "v1",
        byteLength: value.byteLength,
        contentType,
      })),
    }),
  );
  const ui = {
    mediaType: assetBuildMediaType,
    digest: digest(bytes),
    byteLength: bytes.byteLength,
    bytes: { byteLength: bytes.byteLength, copy: () => bytes.slice() },
  };
  const releaseId = parseReleaseId("rel_private");
  const release = {
    appId: parseAppId("app_private"),
    releaseId,
    artifact: {
      artifactRef: parseArtifactRef("artifact:root"),
      artifactDigest: digest(bytes),
      provenance: {
        sourceRevision: parseSourceRevision(`git:${"a".repeat(40)}`),
        sourceTreeDigest: digest(bytes),
        buildRecipeDigest: digest(bytes),
      },
    },
  };
  const bucket = {
    head: () => Promise.resolve(null),
    get: (ref: string) => {
      const asset = assets.find(
        ([path]) => ref === `artifact:${path.slice(1)}`,
      );
      if (!asset) return Promise.resolve(null);
      return Promise.resolve({
        version: "v1",
        size: asset[1].byteLength,
        checksums: {
          sha256: Uint8Array.from(
            createHash("sha256").update(asset[1]).digest(),
          ).buffer,
        },
        body: new Blob([asset[1]]).stream(),
      });
    },
  };
  const base = "/private-apps/signed-owner-grant/";
  const policy = {
    maxManifestBytes: 4096,
    maxObjects: 8,
    maxObjectBytes: 4096,
    maxTotalBytes: 8192,
  };
  const reader = {
    app: { release, digest: digest(bytes), ui, backend: null },
    bucket,
    policy,
    base,
  };
  const response = await readSelectedAssetBuild({
    ...reader,
    request: new Request(`https://apps.example${base}`),
  });
  expect(await response.text()).toBe(new TextDecoder().decode(body));
  expect(
    await (
      await readSelectedAssetBuild({
        ...reader,
        request: new Request(`https://apps.example${base}app.js`),
      })
    ).text(),
  ).toBe(new TextDecoder().decode(code));
  const redirect = await readSelectedAssetBuild({
    ...reader,
    request: new Request(`https://apps.example${base}index.html`),
  });
  expect(redirect.headers.get("Location")).toBe(base);
  expect(
    (
      await readSelectedAssetBuild({
        ...reader,
        request: new Request("https://apps.example/app.js"),
      })
    ).status,
  ).toBe(404);
  await expect(
    readPublicAssetBuild({
      catalog: {
        resolvePublicAssetBuildVersion: () =>
          Promise.resolve({
            ...ui,
            releaseId,
            kind: "verified",
          }),
      },
      bucket,
      policy,
      stableRoute: parseStableRoute("/private"),
      expectedReleaseId: releaseId,
      request: new Request(`https://apps.example${base}`),
    }),
  ).resolves.toMatchObject({ status: 404 });
});
