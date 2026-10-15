import {
  handleAssetRequest,
  type AssetManifest,
} from "@fungi.computer/cloudflare-worker-bundler/assets";
import type {
  AppReleaseCatalog,
  ReleaseId,
  ResolvedApp,
  StableRoute,
  VerifiedArtifactRead,
} from "./index.js";
import {
  assetBuildMediaType,
  decodeAssetBuild,
  publicAssetBase,
  type AssetBuildPolicy,
  type BuildAsset,
} from "./assets.js";

/** Native R2 metadata: checksums are validated by R2, not custom metadata claims. */
export type AssetR2Object = {
  readonly version: string;
  readonly size: number;
  readonly checksums: { readonly sha256?: ArrayBuffer };
};
/** Native R2 operations required to verify and serve one asset build. */
export type AssetR2Bucket = {
  /** Read immutable object metadata without loading its body. */
  head(key: string): Promise<AssetR2Object | null>;
  /** Read immutable object metadata and its streaming body. */
  get(
    key: string,
  ): Promise<
    (AssetR2Object & { readonly body: ReadableStream<Uint8Array> }) | null
  >;
};

/** A missing referenced object is an unavailable build, never an unknown-path 404. */
export class AssetBuildUnavailableError extends Error {
  constructor() {
    super("Asset build unavailable");
    this.name = "AssetBuildUnavailableError";
  }
}

export function matchesAssetObject(
  asset: BuildAsset,
  object: AssetR2Object | null,
): boolean {
  if (
    !object?.checksums.sha256 ||
    object.version !== asset.version ||
    object.size !== asset.byteLength
  )
    return false;
  const digest = Array.from(new Uint8Array(object.checksums.sha256), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${digest}` === asset.digest;
}

/** Verify every reference with bounded sequential native metadata reads. */
export async function verifyAssetBuildObjects(
  bytes: Uint8Array,
  bucket: Pick<AssetR2Bucket, "head">,
  policy: AssetBuildPolicy,
): Promise<void> {
  const build = decodeAssetBuild(bytes, policy);
  for (const asset of build.assets) {
    if (!matchesAssetObject(asset, await bucket.head(asset.artifactRef)))
      throw new AssetBuildUnavailableError();
  }
}

/**
 * Caller supplies its owner-selected Release on every request. Catalog resolves
 * and rechecks eligibility; neither pathname nor child ASSETS selects authority.
 */
export async function readSelectedAssetBuild(options: {
  /** App snapshot resolved by the caller at this delivery boundary. */
  app: ResolvedApp;
  /** Trusted host mount pathname; a handle-root shell supplies "/". */
  base: string;
  bucket: AssetR2Bucket;
  policy: AssetBuildPolicy;
  request: Request;
}): Promise<Response> {
  if (options.app.ui?.mediaType !== assetBuildMediaType)
    throw new AssetBuildUnavailableError();
  return serveAssetBuild(options.app.ui, {
    ...options,
    expectedBase: options.base,
    allowRelativeMount: true,
  });
}

/** Anonymous Surface delivery uses its current selection, never arbitrary unpublished IDs. */
export async function readPublicAssetBuild(options: {
  catalog: Pick<AppReleaseCatalog, "resolvePublicAssetBuildVersion">;
  stableRoute: StableRoute;
  expectedReleaseId: ReleaseId;
  bucket: AssetR2Bucket;
  policy: AssetBuildPolicy;
  request: Request;
}): Promise<Response> {
  const snapshot = await options.catalog.resolvePublicAssetBuildVersion(
    options.stableRoute,
    options.expectedReleaseId,
  );
  return serveAssetBuild(snapshot, {
    ...options,
    expectedBase: publicAssetBase(
      options.stableRoute,
      options.expectedReleaseId,
    ),
    allowRelativeMount: true,
  });
}

async function serveAssetBuild(
  snapshot: Pick<VerifiedArtifactRead, "bytes">,
  options: {
    bucket: AssetR2Bucket;
    policy: AssetBuildPolicy;
    request: Request;
    expectedBase?: string;
    allowRelativeMount?: boolean;
  },
): Promise<Response> {
  const build = decodeAssetBuild(snapshot.bytes.copy(), options.policy);
  const base =
    build.base === "./" && options.allowRelativeMount
      ? (options.expectedBase ?? "/")
      : build.base;
  if (options.expectedBase !== undefined && base !== options.expectedBase)
    throw new AssetBuildUnavailableError();
  const url = new URL(options.request.url);
  if (url.pathname === base.slice(0, -1)) {
    url.pathname = base;
    return new Response(null, {
      status: 307,
      headers: {
        Location: url.pathname + url.search,
        "Cache-Control": "no-store",
      },
    });
  }
  if (!url.pathname.startsWith(base))
    return new Response(null, { status: 404 });
  url.pathname = "/" + url.pathname.slice(base.length);
  const assetRequest = new Request(url, options.request);
  const byPath = new Map(build.assets.map((asset) => [asset.path, asset]));
  const manifest: AssetManifest = new Map(
    build.assets.map((asset) => [
      asset.path,
      { contentType: asset.contentType, etag: asset.digest },
    ]),
  );
  const response = await handleAssetRequest(
    assetRequest,
    manifest,
    {
      async get(pathname) {
        const asset = byPath.get(pathname);
        if (!asset) throw new AssetBuildUnavailableError();
        const object = await options.bucket.get(asset.artifactRef);
        // This metadata and body belong to the same native get result. A changed
        // key cannot reuse old verification or leak replacement bytes.
        if (!object || !matchesAssetObject(asset, object)) {
          if (object) await object.body.cancel();
          throw new AssetBuildUnavailableError();
        }
        return object.body;
      },
    },
    { not_found_handling: "single-page-application" },
  );
  if (response && response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location");
    if (location) {
      const destination = new URL(location, url);
      // Only maintained same-origin asset redirects are configured here.
      if (destination.origin !== url.origin)
        throw new AssetBuildUnavailableError();
      destination.pathname = base + destination.pathname.slice(1);
      const headers = new Headers(response.headers);
      headers.set(
        "Location",
        destination.pathname + destination.search + destination.hash,
      );
      return new Response(response.body, { status: response.status, headers });
    }
  }
  return response ?? new Response("Not Found", { status: 404 });
}
