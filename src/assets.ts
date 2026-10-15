import { appOriginPaths } from "./app-origin-paths.js";
import * as Schema from "effect/Schema";
import type {
  ReleaseId,
  StableRoute,
} from "./internal/app-release-contract.js";
import {
  artifactRefSchema,
  sha256DigestSchema,
} from "./internal/app-release-schema.js";

/** Explicit root representation; existing HTML and backend artifacts remain distinct. */
export const assetBuildMediaType =
  "application/vnd.fungi.app-assets+json" as const;

const positiveInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThan(0)),
  Schema.check(Schema.makeFilter(Number.isSafeInteger)),
);
/** Trusted host policy, independently bounded from single-document HTML. */
export const assetBuildPolicySchema = Schema.Struct({
  maxManifestBytes: positiveInteger,
  maxObjects: positiveInteger,
  maxObjectBytes: positiveInteger,
  maxTotalBytes: positiveInteger,
});
export type AssetBuildPolicy = Schema.Schema.Type<
  typeof assetBuildPolicySchema
>;

/** Captured Vite base: a canonical pathname, or a relative private host mount. */
export const assetBaseSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => {
      if (value == "./") return true;
      const origin = "https://assets.invalid";
      if (!URL.canParse(value, origin)) return false;
      const url = new URL(value, origin);
      return (
        value.startsWith("/") &&
        value.endsWith("/") &&
        url.origin === origin &&
        url.pathname === value &&
        url.search === "" &&
        url.hash === ""
      );
    }),
  ),
);

/** StableRoute already owns the canonical single-slug grammar. */
export function publicAssetBase(
  stableRoute: StableRoute,
  releaseId: ReleaseId,
): string {
  return `${appOriginPaths.surfaceAssets}/${stableRoute.slice(1)}/releases/${encodeURIComponent(releaseId)}/`;
}

/** Vite output names are relative POSIX paths, never request URLs or storage keys. */
export const assetPathSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (path) =>
        path.startsWith("/") &&
        !path.includes("\\") &&
        !/\p{Cc}/u.test(path) &&
        path
          .slice(1)
          .split("/")
          .every((part) => part !== "" && part !== "." && part !== ".."),
    ),
  ),
);
const assetSchema = Schema.Struct({
  path: assetPathSchema,
  artifactRef: artifactRefSchema,
  digest: sha256DigestSchema,
  version: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  byteLength: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
    Schema.check(Schema.makeFilter(Number.isSafeInteger)),
  ),
  contentType: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isPattern(/^[^\r\n]+$/u)),
  ),
});
export const assetBuildSchema = Schema.Struct({
  format: Schema.Literal("fungi-assets-v1"),
  base: assetBaseSchema,
  assets: Schema.Array(assetSchema),
});
export const assetBuildJsonSchema = Schema.fromJsonString(assetBuildSchema);
export type AssetBuild = Schema.Schema.Type<typeof assetBuildSchema>;
export type BuildAsset = AssetBuild["assets"][number];

/**
 * A shell App's module: an ES module exporting `mountShell`, shipped beside
 * `index.html`. A host composes the shell its Team picked by importing it
 * from the host's own origin into the top-level page.
 */
export const shellModuleAssetPath = "/shell.js";

/** The shell module this asset build ships, if it ships one. */
export function shellModuleAsset(build: AssetBuild): BuildAsset | undefined {
  return build.assets.find((asset) => asset.path === shellModuleAssetPath);
}

/** Decode the digest-covered root and enforce bounds before touching its objects. */
export function decodeAssetBuild(
  bytes: Uint8Array,
  policy: AssetBuildPolicy,
): AssetBuild {
  const limits = Schema.decodeUnknownSync(assetBuildPolicySchema)(policy);
  if (bytes.byteLength > limits.maxManifestBytes)
    throw new Error("Asset manifest exceeds policy");
  const build = Schema.decodeUnknownSync(assetBuildJsonSchema)(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    { onExcessProperty: "error" },
  );
  if (build.assets.length === 0 || build.assets.length > limits.maxObjects)
    throw new Error("Asset count exceeds policy");
  const paths = new Set<string>();
  let total = 0;
  for (const asset of build.assets) {
    if (paths.has(asset.path)) throw new Error("Duplicate asset path");
    paths.add(asset.path);
    total += asset.byteLength;
    if (
      asset.byteLength > limits.maxObjectBytes ||
      !Number.isSafeInteger(total) ||
      total > limits.maxTotalBytes
    )
      throw new Error("Asset bytes exceed policy");
  }
  const index = build.assets.find((asset) => asset.path === "/index.html");
  if (!index?.contentType.startsWith("text/html"))
    throw new Error("Asset build requires HTML index");
  return build;
}
