import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  decodeAssetBuild,
  assetBaseSchema,
  publicAssetBase,
  assetBuildMediaType,
} from "../src/assets.js";
import { readPublicAssetBuild } from "../src/cloudflare-assets.js";
import {
  parseStableRoute,
  parseReleaseId,
  parseSha256Digest,
} from "../src/index.js";
import * as Schema from "effect/Schema";

const policy = {
  maxManifestBytes: 4096,
  maxObjects: 3,
  maxObjectBytes: 100,
  maxTotalBytes: 150,
};
const index = {
  path: "/index.html",
  artifactRef: "artifact:index",
  digest: `sha256:${"a".repeat(64)}`,
  version: "native-r2-version",
  byteLength: 90,
  contentType: "text/html",
};
const encode = (assets: readonly object[]) =>
  new TextEncoder().encode(
    JSON.stringify({ format: "fungi-assets-v1", base: "/", assets }),
  );

describe("immutable asset root", () => {
  it("accepts only canonical same-origin Vite bases", () => {
    const decode = Schema.decodeUnknownSync(assetBaseSchema);
    expect(decode("/surfaces/inkcap/releases/rel_inkcap/")).toBe(
      "/surfaces/inkcap/releases/rel_inkcap/",
    );
    for (const base of [
      "https://elsewhere.example/",
      "//elsewhere.example/",
      "/a/../",
      "/base?query/",
      "/base#fragment/",
      "relative/",
      "/no-slash",
    ])
      expect(() => decode(base)).toThrow();
  });
  it("accepts the producer's index and split file while keeping independent limits", () => {
    const bytes = encode([
      index,
      {
        ...index,
        path: "/assets/app.js",
        byteLength: 50,
        contentType: "text/javascript",
      },
    ]);
    expect(decodeAssetBuild(bytes, policy).assets).toHaveLength(2);
    expect(() =>
      decodeAssetBuild(bytes, { ...policy, maxTotalBytes: 139 }),
    ).toThrow("bytes exceed");
    expect(() =>
      decodeAssetBuild(bytes, { ...policy, maxObjectBytes: 89 }),
    ).toThrow("bytes exceed");
    expect(() => decodeAssetBuild(bytes, { ...policy, maxObjects: 1 })).toThrow(
      "count exceeds",
    );
    expect(() =>
      decodeAssetBuild(bytes, {
        ...policy,
        maxManifestBytes: bytes.byteLength - 1,
      }),
    ).toThrow("manifest exceeds");
  });
  it("rejects duplicate paths, absent index, traversal and extra representation keys", () => {
    expect(() => decodeAssetBuild(encode([index, index]), policy)).toThrow(
      "Duplicate",
    );
    expect(() =>
      decodeAssetBuild(encode([{ ...index, path: "/app.js" }]), policy),
    ).toThrow("requires HTML index");
    expect(() =>
      decodeAssetBuild(encode([{ ...index, path: "/../index.html" }]), policy),
    ).toThrow();
    expect(() =>
      decodeAssetBuild(
        encode([{ ...index, mutablePrefix: "promoted" }]),
        policy,
      ),
    ).toThrow();
  });
});

it("keeps native asset redirects, queries and deep navigation inside the one resolved Surface build", async () => {
  const stableRoute = parseStableRoute("/inkcap");
  const releaseId = parseReleaseId("rel_inkcap");
  const base = publicAssetBase(stableRoute, releaseId);
  const body = new TextEncoder().encode(
    "<!doctype html><title>Selected</title>",
  );
  const hash = createHash("sha256").update(body).digest();
  const digest = parseSha256Digest(`sha256:${hash.toString("hex")}`);
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      format: "fungi-assets-v1",
      base,
      assets: [{ ...index, byteLength: body.byteLength, digest }],
    }),
  );
  let resolutions = 0;
  let resolvedReleaseId = releaseId;
  let gets = 0;
  const reader = {
    stableRoute,
    expectedReleaseId: releaseId,
    policy,
    catalog: {
      resolvePublicAssetBuildVersion: (
        _route: typeof stableRoute,
        expectedReleaseId: typeof releaseId,
      ) => {
        resolutions += 1;
        resolvedReleaseId = expectedReleaseId;
        return Promise.resolve({
          releaseId,
          mediaType: assetBuildMediaType,
          byteLength: bytes.byteLength,
          digest: parseSha256Digest(
            `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          ),
          bytes: { byteLength: bytes.byteLength, copy: () => bytes.slice() },
        });
      },
    },
    bucket: {
      head: () => Promise.resolve(null),
      get: () => {
        gets += 1;
        return Promise.resolve({
          version: index.version,
          size: body.byteLength,
          checksums: { sha256: Uint8Array.from(hash).buffer },
          body: new Blob([body]).stream(),
        });
      },
    },
  };
  const request = (path: string, accept = "text/html") =>
    new Request(`https://apps.example${path}`, { headers: { accept } });
  const redirect = await readPublicAssetBuild({
    ...reader,
    request: request(`${base}index.html?view=editor`),
  });
  expect(redirect.status).toBe(307);
  expect(redirect.headers.get("location")).toBe(`${base}?view=editor`);
  expect(resolutions).toBe(1);
  expect(resolvedReleaseId).toBe(releaseId);
  expect(gets).toBe(0);
  const trailing = await readPublicAssetBuild({
    ...reader,
    request: request(`${base.slice(0, -1)}?view=editor`),
  });
  expect(trailing.headers.get("location")).toBe(`${base}?view=editor`);
  const navigation = await readPublicAssetBuild({
    ...reader,
    request: request(`${base}editor/files/example.txt`),
  });
  expect(await navigation.text()).toBe(new TextDecoder().decode(body));
  expect(
    (
      await readPublicAssetBuild({
        ...reader,
        request: request(`${base}missing.js`, "*/*"),
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await readPublicAssetBuild({
        ...reader,
        request: request("/assets/index.js", "*/*"),
      })
    ).status,
  ).toBe(404);
});
