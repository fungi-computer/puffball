import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createInterface } from "node:readline";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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
  type Sha256Digest,
} from "../src/index.js";
import { createDeterministicMemoryAppReleaseStore } from "../src/effect.js";
import { createPublicWebsiteFetchHandler } from "../src/internal/public-website-fetch.js";
import { reportFailure } from "../src/internal/failure.js";

const orchidHtml = `<!doctype html><html><head><title>Orchid</title></head><body><h1>Orchid</h1><p>Release <code data-release-digest>calculating…</code></p><script>(async()=>{const response=await fetch(location.href,{cache:"no-store"});const bytes=await response.arrayBuffer();const hash=await crypto.subtle.digest("SHA-256",bytes);const digest="sha256:"+Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,"0")).join("");const target=document.querySelector("[data-release-digest]");if(target!==null)target.textContent=digest})()</script></body></html>`;
const orchidDigest = parseSha256Digest(
  "sha256:d7c4d301a1300526fe774cd00c1076b5c137f1352763a4da8a9ae9b1c9f3a22d",
);
const orchidBytes = new TextEncoder().encode(orchidHtml);
const orchidUiRef = parseArtifactRef("artifact:orchid.ui");
const orchidManifestBytes = new TextEncoder().encode(
  JSON.stringify({
    format: "fungi-app-v1",
    ui: {
      artifactRef: orchidUiRef,
      digest: orchidDigest,
      version: "v1",
      byteLength: orchidBytes.byteLength,
      mediaType: "text/html; charset=utf-8",
    },
  }),
);
const orchidReleaseDigest = parseSha256Digest(
  "sha256:a21f3a8fc01191efb417a78a606c8be9ddb4bcf44f8553479d1edc421cd38a63",
);
const addressInfoSchema = Schema.Struct({
  port: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThan(0)),
  ),
});

export type A12PublicWebsiteLauncher = Readonly<{
  readonly close: () => Promise<void>;
  readonly digest: Sha256Digest;
  readonly revoke: () => Promise<void>;
  readonly url: string;
}>;

/** Start the local-only A1.2 Orchid public-website tracer. */
export async function launchA12PublicWebsite(): Promise<A12PublicWebsiteLauncher> {
  const app = { appId: parseAppId("app_orchid") };
  const surface = {
    publicSurfaceId: parsePublicSurfaceId("ps_orchid"),
    appId: app.appId,
    stableRoute: parseStableRoute("/orchid"),
  };
  const release: Release = {
    releaseId: parseReleaseId("rel_orchid"),
    appId: app.appId,
    artifact: {
      artifactRef: parseArtifactRef("artifact:orchid.release"),
      artifactDigest: orchidReleaseDigest,
      provenance: {
        sourceRevision: parseSourceRevision(`git:${"b".repeat(40)}`),
        sourceTreeDigest: parseSha256Digest(`sha256:${"c".repeat(64)}`),
        buildRecipeDigest: parseSha256Digest(`sha256:${"d".repeat(64)}`),
      },
    },
  };
  const artifactReader: ArtifactReader = {
    read: (input) => {
      if (input.artifactRef === release.artifact.artifactRef) {
        return Promise.resolve({
          kind: "verified" as const,
          digest: input.expectedDigest,
          mediaType: "application/vnd.fungi.app+json" as const,
          bytes: {
            byteLength: orchidManifestBytes.byteLength,
            copy: () => orchidManifestBytes.slice(),
          },
          byteLength: orchidManifestBytes.byteLength,
        });
      }
      if (input.artifactRef === orchidUiRef) {
        return Promise.resolve({
          kind: "verified" as const,
          digest: input.expectedDigest,
          mediaType: "text/html; charset=utf-8" as const,
          bytes: {
            byteLength: orchidBytes.byteLength,
            copy: () => orchidBytes.slice(),
          },
          byteLength: orchidBytes.byteLength,
        });
      }
      return Promise.resolve({ kind: "missing" as const });
    },
  };
  const catalog = createAppReleaseCatalog({
    artifactReader,
    store: createDeterministicMemoryAppReleaseStore({
      routes: {
        platformRoutes: [
          { appId: app.appId, stableRoute: surface.stableRoute },
        ],
        structuralRoutes: [],
      },
    }),
  });
  await catalog.createApp(app);
  await catalog.createPublicSurface({
    ...surface,
    publisher: {
      kind: "platform",
      teamId: "local-tracer",
      userId: "local-operator",
      requestKey: surface.publicSurfaceId,
    },
  });
  await catalog.createRelease(release);
  await catalog.verifyReleaseArtifact(release.releaseId);
  await catalog.transition({
    kind: "promotion",
    publicSurfaceId: surface.publicSurfaceId,
    releaseId: release.releaseId,
    idempotencyKey: parseIdempotencyKey("idem_orchidpromotion"),
  });

  const handler = createPublicWebsiteFetchHandler({
    resolvePublicWebsite: (stableRoute) =>
      catalog.resolvePublicWebsite(stableRoute),
  });
  const server = createServer((request, response) => {
    void respond(request, response, handler.fetch).catch((cause: unknown) => {
      reportFailure("respond to local website request", cause);
      response.writeHead(503, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Unavailable</title>");
    });
  });
  await listen(server);
  const address = Schema.decodeUnknownOption(addressInfoSchema)(
    server.address(),
  );
  if (Option.isNone(address)) {
    await closeServer(server);
    throw new Error("A1.2 launcher did not bind a loopback port");
  }
  const addressInfo = address.value;

  let closeOperation: Promise<void> | undefined;
  let revokeOperation: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closeOperation !== undefined) return closeOperation;
    const operation = closeServer(server);
    closeOperation = operation;
    void operation.catch((cause: unknown) => {
      reportFailure("close local website server", cause);
      if (closeOperation === operation) closeOperation = undefined;
    });
    return operation;
  };
  const revoke = (): Promise<void> => {
    if (revokeOperation !== undefined) return revokeOperation;
    const operation = catalog
      .transition({
        kind: "revocation",
        releaseId: release.releaseId,
        idempotencyKey: parseIdempotencyKey("idem_orchidrevocation"),
      })
      .then(() => undefined);
    revokeOperation = operation;
    void operation.catch((cause: unknown) => {
      reportFailure("revoke local website release", cause);
      if (revokeOperation === operation) revokeOperation = undefined;
    });
    return operation;
  };

  return {
    close,
    digest: orchidDigest,
    revoke,
    url: `http://127.0.0.1:${String(addressInfo.port)}/orchid`,
  };
}

async function respond(
  request: IncomingMessage,
  response: ServerResponse,
  fetchHandler: (request: Request) => Promise<Response>,
): Promise<void> {
  const requestUrl = `http://127.0.0.1${request.url ?? "/"}`;
  const delivered = await fetchHandler(
    new Request(requestUrl, { method: request.method ?? "GET" }),
  );
  response.writeHead(delivered.status, {
    "content-type": delivered.headers.get("content-type") ?? "text/plain",
  });
  response.end(new Uint8Array(await delivered.arrayBuffer()));
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

async function selfCheck(): Promise<void> {
  const launcher = await launchA12PublicWebsite();
  try {
    const cold = await fetch(launcher.url);
    const warm = await fetch(launcher.url);
    if (cold.status !== 200 || warm.status !== 200)
      throw new Error("Orchid was not delivered");
    const coldHtml = await cold.text();
    if ((await warm.text()) !== coldHtml || !coldHtml.includes("Orchid")) {
      throw new Error("Orchid warm delivery changed immutable bytes");
    }
    await launcher.revoke();
    const revoked = await fetch(launcher.url);
    if (revoked.status !== 503 || (await revoked.text()).includes(coldHtml)) {
      throw new Error("revoked Orchid bytes were delivered");
    }
  } finally {
    await launcher.close();
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--self-check")) {
    await selfCheck();
    return;
  }
  const launcher = await launchA12PublicWebsite();
  const controls = createInterface({ input: process.stdin });
  const stop = async (): Promise<void> => {
    controls.close();
    process.stdin.pause();
    process.off("SIGINT", onInterrupt);
    await launcher.close();
  };
  const stopForInterrupt = async (): Promise<void> => {
    try {
      await stop();
      process.exitCode = 0;
    } catch (error) {
      reportFailure("stop launcher after interrupt", error);
      process.exitCode = 1;
    }
  };
  const stopForExit = async (): Promise<void> => {
    try {
      await stop();
      process.exit(0);
    } catch (error) {
      reportFailure("stop launcher after exit request", error);
      process.exitCode = 1;
    }
  };
  const revokeForInput = async (): Promise<void> => {
    try {
      await launcher.revoke();
      process.stdout.write("Orchid revoked\n");
    } catch (error) {
      reportFailure("revoke launcher release", error);
      process.exitCode = 1;
    }
  };
  const onInterrupt = (): void => {
    void stopForInterrupt();
  };
  controls.on("line", (line) => {
    if (line === "r") void revokeForInput();
    if (line === "q") {
      void stopForExit();
    }
  });
  process.once("SIGINT", onInterrupt);
  process.stdout.write(`${launcher.url}\n`);
}

if (process.argv[1]?.endsWith("a1-2-public-website.ts")) {
  void main().catch((cause: unknown) => {
    reportFailure("run local website launcher", cause);
    process.stderr.write("A1.2 launcher failed\n");
    process.exitCode = 1;
  });
}
