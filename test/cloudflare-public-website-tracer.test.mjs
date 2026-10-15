import { createFixturePlatformSurface } from "./support/platform-surface.mjs";
import { env } from "cloudflare:workers";
import { URL } from "node:url";
import { TextEncoder } from "node:util";
import { beforeAll, expect, it, vi } from "vitest";

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
} from "../dist/index.js";
import * as cloudflare from "../dist/cloudflare.js";
import { assetBuildMediaType } from "../dist/assets.js";

const html = "<!doctype html><p>orchid native website</p>";
const wrongHtml = "<!doctype html><p>wrong digest bytes</p>";
const expectedBytes = new TextEncoder().encode(html);
const wrongBytes = new TextEncoder().encode(wrongHtml);
const expectedDigest = parseSha256Digest(
  "sha256:79ee0e41b041f5b6a831f7141a6665b9883b82389de5ef352e8c1e806e5ee422",
);
const rootDigestBySuffix = {
  eligible: "c53790a0d70863643c6570e7b3bd3a89c4043150f2df970eee9565a89f1faefe",
  eligibleabsent:
    "d85feac990e1eca619364c75580f60668be42620939240430d67bb7609f1e24d",
  eligibleunverified:
    "f4da7ffb23ef6852c8090ad0ca0aab7559ca9b7372bc9e904e7977193176be75",
  eligibledigestmismatch:
    "cee6933a5df82bf0131b063be7bd25a417d1278ef1729fce7ec4afe95ddd0f36",
  eligiblerevoked:
    "3c7392f26079a2e8d5650e82dc71d98f0e34872394db06cd82c64ea27e09686e",
  eligiblemissing:
    "b4ab2b5d6644acd9c1f371e37c380b45642ad077a3adb805b1890add91de7156",
  eligiblecorrupt:
    "455b785bbeb4f279caf991cc4fc1a6472b3d8d51f44807a6954871b4d7d44291",
  eligiblesnapshotbound:
    "fe45b6238217bd3bf662cffd5a1c1400b8faa4cb4b0baae65f495b300271202d",
  eligibler2bound:
    "2a5b7264bb228b98bd1cb4ad59ba21aaa423d1e19443afefc8415b9dffa2cf9b",
  eligiblechangeprovenance:
    "628bdadbaa62df71cd933cd4e7cc9ad1f9ea83fb250d8b056781235d1141bdcb",
  eligiblechangeverification:
    "62c004f0ce24244b6701810352a650c27ceaa4b4993ab059dcbae4837e80d980",
  eligiblerace:
    "25e66f05a03b29157d5f44ff41a461c486b52eaf9291f3950e5334f9fd938ed5",
  orchid: "cb17c960b307fa0739c75599bca17297187be10bb6e0ec7699d3954b50a97527",
  mismatch: "d9edab8d7b07f887a4af2915c4223e8bc2872174bac10def032e89cc885f7566",
  foreignsurface:
    "62030a152ec2304c50aec0563e5d6c92d1fa5b54a11c076a7409ed9c12b53f4c",
  foreignrelease:
    "edfd9596c710f33d7dca3a2956469f1b88d9e4e0dedf9f94e83de2ca0de51cb0",
  unverified:
    "d7b03220b727ca6f76cc30bf5dcf5a48e1d6f6ffe8adf28a60f6e435276b6bbf",
  missing: "ae7e5aa51c6ea2a46fa310a62ab3f948600c6fd66852e35f90d483de4e64c89f",
  unavailabler2:
    "36bb508c27c98aebc8c0e9dfb7c7cd790a24e7d5f845ab6d6c6d7de7d61df40b",
  authoritychange:
    "8566e0292bff1e831ba04e3f6f8cad5ba6713325785fa097f6d57a0c0ee6e800",
  ambiguousa:
    "f81ac47165376df785feaed7c5437cf2f4651e6a02cb68571b07e50a9a86d4d5",
  ambiguousb:
    "a045b5610f57a470d811d7c60c8c136a7131638c8c737679bd2083286a5d48d6",
  oversized: "7d610dc0b99b68c49bb4a27b58922aa4c12e38ecea891c70692d7878135f842c",
  metadataauthority:
    "e91cd4e8c1deb55dea932f7ecb9ea386de0a411a6095e2dae3a25f3dc5c6c69d",
};

it("eligible Release resolution returns immutable native bytes without a public Surface", async () => {
  const fixture = releaseFixture("eligible");
  const { app, release } = fixture;
  const catalog = createCatalog();
  await catalog.createApp(app);
  await catalog.createRelease(release);
  await env.APP_RELEASE_ARTIFACTS.put(
    release.artifact.artifactRef,
    fixture.manifestBytes,
    {
      httpMetadata: { contentType: "application/vnd.fungi.app+json" },
    },
  );
  await env.APP_RELEASE_ARTIFACTS.put(fixture.uiArtifactRef, expectedBytes, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  await catalog.verifyReleaseArtifact(release.releaseId);

  const snapshot = await catalog.resolveEligibleReleaseArtifact(
    release.releaseId,
  );
  expect(snapshot).toMatchObject({
    kind: "verified",
    digest: release.artifact.artifactDigest,
    mediaType: "application/vnd.fungi.app+json",
    byteLength: fixture.manifestBytes.byteLength,
  });
  snapshot.bytes.copy().fill(0);
  expect(snapshot.bytes.copy()).toEqual(fixture.manifestBytes);
});

it.each([
  ["absent", "AppReleaseReleaseAbsentError"],
  ["unverified", "AppReleaseTransitionReleaseUnverifiedError"],
  ["digestmismatch", "AppReleaseTransitionReleaseUnverifiedError"],
  ["revoked", "AppReleaseTransitionReleaseRevokedError"],
])(
  "eligible Release resolution denies %s before artifact access",
  async (state, name) => {
    const fixture = releaseFixture(`eligible${state}`);
    const { app, release } = fixture;
    const store = cloudflare.createD1AppReleaseStore(env.APP_RELEASE_CATALOG);
    const read = vi.fn(() => Promise.resolve({ kind: "missing" }));
    const catalog = createAppReleaseCatalog({
      store,
      artifactReader: { read },
    });
    if (state !== "absent") {
      await catalog.createApp(app);
      await catalog.createRelease(release);
      if (state !== "unverified") {
        await store.recordReleaseVerification({
          releaseId: release.releaseId,
          digest:
            state === "digestmismatch"
              ? parseSha256Digest(`sha256:${"d".repeat(64)}`)
              : release.artifact.artifactDigest,
          mediaType: "application/vnd.fungi.app+json",
          description: {
            format: "fungi-app-v1",
            ui: {
              artifactRef: fixture.uiArtifactRef,
              digest: expectedDigest,
              version: "v1",
              byteLength: expectedBytes.byteLength,
              mediaType: "text/html; charset=utf-8",
            },
            backend: null,
          },
        });
      }
      if (state === "revoked") {
        await catalog.transition({
          kind: "revocation",
          releaseId: release.releaseId,
          idempotencyKey: parseIdempotencyKey("idem_eligiblerevoked"),
        });
      }
    }
    await expect(
      catalog.resolveEligibleReleaseArtifact(release.releaseId),
    ).rejects.toMatchObject({ name });
    expect(read).not.toHaveBeenCalled();
  },
);

it.each([
  ["missing", "AppReleaseArtifactMissingError"],
  ["corrupt", "AppReleaseArtifactDigestMismatchError"],
  ["snapshotbound", "AppReleaseArtifactInvalidSnapshotError"],
  ["r2bound", "AppReleaseArtifactUnavailableError"],
])(
  "eligible Release resolution denies %s native artifacts",
  async (state, name) => {
    const fixture = releaseFixture(`eligible${state}`);
    await seedSelectedRelease(fixture);
    const policy = { maxBytes: expectedBytes.byteLength - 1 };
    const options = {
      store: cloudflare.createD1AppReleaseStore(env.APP_RELEASE_CATALOG),
      artifactReader: createFixtureR2ArtifactReader(
        state === "r2bound" ? policy : undefined,
      ),
    };
    if (state === "snapshotbound") options.artifactPolicy = policy;
    const catalog = createAppReleaseCatalog(options);
    if (state === "missing" || state === "corrupt") {
      await expect(
        catalog.resolveEligibleReleaseArtifact(fixture.release.releaseId),
      ).resolves.toMatchObject({
        digest: fixture.release.artifact.artifactDigest,
      });
      if (state === "missing") {
        await env.APP_RELEASE_ARTIFACTS.delete(
          fixture.release.artifact.artifactRef,
        );
      } else {
        await env.APP_RELEASE_ARTIFACTS.put(
          fixture.release.artifact.artifactRef,
          wrongBytes,
          { httpMetadata: { contentType: "application/vnd.fungi.app+json" } },
        );
      }
    }
    await expect(
      catalog.resolveEligibleReleaseArtifact(fixture.release.releaseId),
    ).rejects.toMatchObject({ name });
  },
);

it.each([
  ["provenance", "AppReleaseImmutableConflictError"],
  ["verification", "AppReleaseTransitionReleaseUnverifiedError"],
])(
  "eligible Release resolution rejects changed %s from a foreign store after the snapshot",
  async (state, name) => {
    const fixture = releaseFixture(`eligiblechange${state}`);
    await seedSelectedRelease(fixture);
    const store = cloudflare.createD1AppReleaseStore(env.APP_RELEASE_CATALOG);
    const reader = createFixtureR2ArtifactReader();
    let artifactRead = false;
    const catalog = createAppReleaseCatalog({
      store: {
        ...store,
        readReleaseLifecycle: async (releaseId) => {
          const result = await store.readReleaseLifecycle(releaseId);
          if (
            !artifactRead ||
            result.kind !== "success" ||
            result.value.kind !== "found"
          )
            return result;
          const lifecycle = result.value;
          return {
            kind: "success",
            value: {
              ...lifecycle,
              ...(state === "verification"
                ? { verification: { kind: "unverified" } }
                : {
                    release: {
                      ...lifecycle.release,
                      artifact: {
                        ...lifecycle.release.artifact,
                        provenance: {
                          ...lifecycle.release.artifact.provenance,
                          sourceRevision: parseSourceRevision(
                            `git:${"d".repeat(40)}`,
                          ),
                        },
                      },
                    },
                  }),
            },
          };
        },
      },
      artifactReader: {
        read: async (input) => {
          const result = await reader.read(input);
          artifactRead = true;
          return result;
        },
      },
    });
    await expect(
      catalog.resolveEligibleReleaseArtifact(fixture.release.releaseId),
    ).rejects.toMatchObject({ name });
  },
);

it("eligible Release resolution denies revocation during an R2 read after prior success", async () => {
  const fixture = releaseFixture("eligiblerace");
  await seedSelectedRelease(fixture);
  const nativeReader = createFixtureR2ArtifactReader();
  let revokeAfterRead = false;
  const catalog = createAppReleaseCatalog({
    store: cloudflare.createD1AppReleaseStore(env.APP_RELEASE_CATALOG),
    artifactReader: {
      read: async (input) => {
        const result = await nativeReader.read(input);
        if (revokeAfterRead) {
          await createCatalog().transition({
            kind: "revocation",
            releaseId: fixture.release.releaseId,
            idempotencyKey: parseIdempotencyKey("idem_eligibleracerevoke"),
          });
        }
        return result;
      },
    },
  });
  await expect(
    catalog.resolveEligibleReleaseArtifact(fixture.release.releaseId),
  ).resolves.toMatchObject({ digest: fixture.release.artifact.artifactDigest });
  revokeAfterRead = true;
  await expect(
    catalog.resolveEligibleReleaseArtifact(fixture.release.releaseId),
  ).rejects.toMatchObject({ name: "AppReleaseTransitionReleaseRevokedError" });
});

const localDeclarationReference =
  /(?:(?:import|export)(?:\s+type)?(?:\s+[^"'`;]*?\s+from)?\s+["'](\.{1,2}\/[^"]+?)["']|import\(\s*["'](\.{1,2}\/[^"]+?)["']\s*\))/gu;

const declarationContents = new Map(
  Object.entries(
    import.meta.glob("../dist/**/*.d.ts", {
      eager: true,
      import: "default",
      query: "?raw",
    }),
  ).map(([path, declaration]) => [
    new URL(path, import.meta.url).href,
    declaration,
  ]),
);

function reachableDeclarationSurface(entrypoint) {
  const pending = [entrypoint];
  const visited = new Set();
  const declarations = [];

  for (const declarationFile of pending) {
    if (visited.has(declarationFile.href)) continue;
    visited.add(declarationFile.href);

    const declaration = declarationContents.get(declarationFile.href);
    if (declaration === undefined) continue;
    declarations.push(declaration);

    for (const match of declaration.matchAll(localDeclarationReference)) {
      const specifier = match[1] ?? match[2];
      if (specifier === undefined) continue;
      const declarationSpecifier = specifier.endsWith(".js")
        ? `${specifier.slice(0, -3)}.d.ts`
        : specifier;
      pending.push(new URL(declarationSpecifier, declarationFile));
    }
  }

  return declarations.join("\n");
}

function releaseFixture(suffix, route = `/orchid-${suffix}`) {
  const app = { appId: parseAppId(`app_nativewebsite${suffix}`) };
  const surface = {
    publicSurfaceId: parsePublicSurfaceId(`ps_nativewebsite${suffix}`),
    appId: app.appId,
    stableRoute: parseStableRoute(route),
  };
  const release = {
    releaseId: parseReleaseId(`rel_nativewebsite${suffix}`),
    appId: app.appId,
    artifact: {
      artifactRef: parseArtifactRef(`artifact:native-website-${suffix}`),
      artifactDigest: parseSha256Digest(`sha256:${rootDigestBySuffix[suffix]}`),
      provenance: {
        sourceRevision: parseSourceRevision(`git:${"a".repeat(40)}`),
        sourceTreeDigest: parseSha256Digest(`sha256:${"b".repeat(64)}`),
        buildRecipeDigest: parseSha256Digest(`sha256:${"c".repeat(64)}`),
      },
    },
  };

  const uiArtifactRef = parseArtifactRef(
    `artifact:native-website-${suffix}-ui`,
  );
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({
      format: "fungi-app-v1",
      ui: {
        artifactRef: uiArtifactRef,
        digest: expectedDigest,
        version: "v1",
        byteLength: expectedBytes.byteLength,
        mediaType: "text/html; charset=utf-8",
      },
    }),
  );
  const description = {
    format: "fungi-app-v1",
    ui: {
      artifactRef: uiArtifactRef,
      digest: expectedDigest,
      version: "v1",
      byteLength: expectedBytes.byteLength,
      mediaType: "text/html; charset=utf-8",
    },
    backend: null,
  };

  return {
    app,
    release,
    route: surface.stableRoute,
    surface,
    uiArtifactRef,
    manifestBytes,
    manifestDigest: release.artifact.artifactDigest,
    description,
  };
}

function createCatalog() {
  return createAppReleaseCatalog({
    store: cloudflare.createD1AppReleaseStore(env.APP_RELEASE_CATALOG),
    artifactReader: createFixtureR2ArtifactReader(),
  });
}

function createFixtureR2ArtifactReader(policy) {
  return cloudflare.createR2ArtifactReader(
    {
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
    },
    policy,
  );
}

async function migrate() {
  await env.APP_RELEASE_CATALOG.exec(cloudflare.APP_RELEASE_D1_FRESH_SCHEMA);
}

beforeAll(migrate);

async function seedSelectedRelease(fixture) {
  await env.APP_RELEASE_ARTIFACTS.put(
    fixture.release.artifact.artifactRef,
    fixture.manifestBytes,
    { httpMetadata: { contentType: "application/vnd.fungi.app+json" } },
  );
  await env.APP_RELEASE_ARTIFACTS.put(fixture.uiArtifactRef, expectedBytes, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });

  const catalog = createCatalog();
  await expect(catalog.createApp(fixture.app)).resolves.toEqual(fixture.app);
  await expect(
    createFixturePlatformSurface(
      catalog,
      env.APP_RELEASE_CATALOG,
      fixture.surface,
    ),
  ).resolves.toEqual(fixture.surface);
  await expect(catalog.createRelease(fixture.release)).resolves.toEqual(
    fixture.release,
  );
  await expect(
    catalog.verifyReleaseArtifact(fixture.release.releaseId),
  ).resolves.toMatchObject({
    kind: "verified",
    digest: fixture.manifestDigest,
    mediaType: "application/vnd.fungi.app+json",
  });
  await expect(
    catalog.transition({
      kind: "promotion",
      publicSurfaceId: fixture.surface.publicSurfaceId,
      releaseId: fixture.release.releaseId,
      idempotencyKey: parseIdempotencyKey(
        `idem_nativewebsite${fixture.release.releaseId}`,
      ),
    }),
  ).resolves.toMatchObject({
    transition: { kind: "promotion", releaseId: fixture.release.releaseId },
  });
}

async function recordNativeSelection(fixture, transitionCharacter) {
  const result = await env.APP_RELEASE_CATALOG.prepare(
    `INSERT INTO app_release_transitions
      (transition_id, operation_kind, idempotency_key, release_id, public_surface_id)
     VALUES (?, 'promotion', ?, ?, ?)`,
  )
    .bind(
      `app_transition_${transitionCharacter.repeat(21)}`,
      `idem_nativewebsite${transitionCharacter}`,
      fixture.release.releaseId,
      fixture.surface.publicSurfaceId,
    )
    .run();

  expect(result.success).toBe(true);
}

async function expectUnavailable(operation, forbiddenBytes) {
  const [outcome] = await Promise.allSettled([operation]);
  expect(outcome?.status).toBe("rejected");
  if (outcome?.status !== "rejected") return;

  expect(outcome.reason).toMatchObject({
    name: "AppReleasePublicWebsiteUnavailableError",
    message: "Public website is unavailable",
  });
  expect(outcome.reason).not.toHaveProperty("cause");
  expect(outcome.reason).not.toHaveProperty("detail");
  expect(outcome.reason).not.toHaveProperty("bytes");
  expect(String(outcome.reason)).not.toContain(forbiddenBytes);
}

it("D1 unsuccessful route queries are unavailable rather than absent", async () => {
  const r2Get = vi.fn(() => Promise.resolve(null));
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(() => Promise.reject(new Error("unexpected D1 first"))),
    all: vi.fn(() => Promise.reject(new Error("unexpected D1 all"))),
    run: vi.fn(() => Promise.reject(new Error("unexpected D1 run"))),
  };
  const database = {
    prepare: vi.fn(() => statement),
    batch: vi.fn(() => Promise.resolve([{ success: false, results: [] }])),
  };
  const catalog = createAppReleaseCatalog({
    store: cloudflare.createD1AppReleaseStore(database),
    artifactReader: cloudflare.createR2ArtifactReader({ get: r2Get }),
  });

  await expectUnavailable(
    catalog.resolvePublicWebsite(parseStableRoute("/orchid")),
    "unexpected D1",
  );
  expect(database.batch).toHaveBeenCalledExactlyOnceWith([statement]);
  expect(statement.all).not.toHaveBeenCalled();
  expect(r2Get).not.toHaveBeenCalled();
});

// These native tracer bytes prove the current conformance law; they are not
// retroactive TDD evidence for the already-landed A1.2 implementation.
it("native local D1 and R2 deliver one selected digest and revoke it across restart", async () => {
  const store = cloudflare.createD1AppReleaseStore(env.APP_RELEASE_CATALOG);
  expect.soft(store).not.toHaveProperty("readPublicWebsiteAuthority");

  for (const declaration of [
    reachableDeclarationSurface(new URL("../dist/index.d.ts", import.meta.url)),
    reachableDeclarationSurface(
      new URL("../dist/effect.d.ts", import.meta.url),
    ),
  ]) {
    expect.soft(declaration).not.toContain("PublicWebsiteAuthority");
    expect.soft(declaration).not.toContain("readPublicWebsiteAuthority");
  }

  const fixture = releaseFixture("orchid");
  await seedSelectedRelease(fixture);

  const catalog = createCatalog();
  const cold = await catalog.resolvePublicWebsite(fixture.route);
  const warm = await catalog.resolvePublicWebsite(fixture.route);
  for (const representation of [cold, warm]) {
    expect(representation).toMatchObject({
      releaseId: fixture.release.releaseId,
      digest: expectedDigest,
      mediaType: "text/html; charset=utf-8",
      byteLength: expectedBytes.byteLength,
    });
    expect(representation.bytes.copy()).toEqual(expectedBytes);
  }
  expect(cold.digest).toBe(warm.digest);
  expect(cold.bytes.copy()).not.toBe(warm.bytes.copy());

  const reconstructedCatalog = createCatalog();
  const reconstructed = await reconstructedCatalog.resolvePublicWebsite(
    fixture.route,
  );
  expect(reconstructed.digest).toBe(expectedDigest);
  expect(reconstructed.bytes.copy()).toEqual(expectedBytes);

  await expect(
    createCatalog().transition({
      kind: "revocation",
      releaseId: fixture.release.releaseId,
      idempotencyKey: parseIdempotencyKey("idem_nativewebsiteorchidrevoke"),
    }),
  ).resolves.toMatchObject({
    transition: { kind: "revocation", releaseId: fixture.release.releaseId },
  });

  await expectUnavailable(
    createCatalog().resolvePublicWebsite(fixture.route),
    html,
  );
});

it("native local D1 resolves Surface authority metadata without an R2 body read", async () => {
  const fixture = releaseFixture("metadataauthority");
  await seedSelectedRelease(fixture);
  const read = vi.fn(() => Promise.resolve({ kind: "unavailable" }));
  const catalog = createAppReleaseCatalog({
    store: cloudflare.createD1AppReleaseStore(env.APP_RELEASE_CATALOG),
    artifactReader: { read },
  });

  await expect(
    catalog.resolvePublicSurfaceAuthority(fixture.route),
  ).resolves.toMatchObject({
    app: fixture.app,
    release: fixture.release,
    surface: fixture.surface,
    digest: fixture.release.artifact.artifactDigest,
    revocation: { kind: "active" },
    description: fixture.description,
  });
  expect(read).not.toHaveBeenCalled();
});

it("R2 rejects oversized artifact metadata before reading body", async () => {
  const fixture = releaseFixture("oversized");
  const arrayBuffer = vi.fn(() =>
    Promise.resolve(expectedBytes.slice().buffer),
  );
  const reader = cloudflare.createR2ArtifactReader({
    get: () =>
      Promise.resolve({
        httpMetadata: { contentType: "application/vnd.fungi.app+json" },
        size: 65_537,
        arrayBuffer,
      }),
  });

  const result = await reader.read({
    artifactRef: fixture.release.artifact.artifactRef,
    expectedDigest: fixture.release.artifact.artifactDigest,
  });

  expect(result).toEqual({ kind: "unavailable" });
  expect(arrayBuffer).not.toHaveBeenCalled();
});

it("defers asset sibling checks to publication verification", async () => {
  const encoder = new TextEncoder();
  const policy = {
    maxManifestBytes: 4096,
    maxObjects: 3,
    maxObjectBytes: 1024,
    maxTotalBytes: 2048,
  };
  const base = "/surfaces/cost/releases/rel_cost/";
  const indexBytes = encoder.encode("<!doctype html>");
  const scriptBytes = encoder.encode("document.title = 'cost';");
  const digestBytes = async (bytes) =>
    new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  const hex = (bytes) =>
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const indexDigest = await digestBytes(indexBytes);
  const scriptDigest = await digestBytes(scriptBytes);
  const manifest = encoder.encode(
    JSON.stringify({
      format: "fungi-assets-v1",
      base,
      assets: [
        {
          path: "/index.html",
          artifactRef: "artifact:cost-index",
          digest: `sha256:${hex(indexDigest)}`,
          version: "index-version",
          byteLength: indexBytes.byteLength,
          contentType: "text/html",
        },
        {
          path: "/assets/app.js",
          artifactRef: "artifact:cost-script",
          digest: `sha256:${hex(scriptDigest)}`,
          version: "script-version",
          byteLength: scriptBytes.byteLength,
          contentType: "text/javascript",
        },
      ],
    }),
  );
  const manifestDigest = await digestBytes(manifest);
  const head = vi.fn(async (key) => {
    const bytes = key.endsWith("index") ? indexBytes : scriptBytes;
    const digest = key.endsWith("index") ? indexDigest : scriptDigest;
    return {
      version: key.endsWith("index") ? "index-version" : "script-version",
      size: bytes.byteLength,
      checksums: { sha256: digest.buffer },
    };
  });
  const reader = cloudflare.createR2ArtifactReader(
    {
      get: async () => ({
        size: manifest.byteLength,
        httpMetadata: { contentType: assetBuildMediaType },
        arrayBuffer: async () => manifest.slice().buffer,
      }),
    },
    { maxBytes: 65_536, maxManifestBytes: 4096 },
    { bucket: { head }, policy },
  );
  const input = {
    artifactRef: parseArtifactRef("artifact:cost-manifest"),
    expectedDigest: parseSha256Digest(`sha256:${hex(manifestDigest)}`),
  };

  await expect(reader.read(input)).resolves.toMatchObject({ kind: "verified" });
  expect(head).not.toHaveBeenCalled();
  await expect(
    reader.read({ ...input, verification: "publication" }),
  ).resolves.toMatchObject({ kind: "verified" });
  expect(head).toHaveBeenCalledTimes(2);
});

it("native platform route refuses a conflicting Surface owner before public delivery", async () => {
  const first = releaseFixture("ambiguousa", "/orchid-ambiguous");
  const second = releaseFixture("ambiguousb", "/orchid-ambiguous");
  const catalog = createCatalog();
  await catalog.createApp(first.app);
  await catalog.createApp(second.app);
  await expect(
    createFixturePlatformSurface(
      catalog,
      env.APP_RELEASE_CATALOG,
      first.surface,
    ),
  ).resolves.toEqual(first.surface);
  await expect(
    createFixturePlatformSurface(
      catalog,
      env.APP_RELEASE_CATALOG,
      second.surface,
    ),
  ).rejects.toMatchObject({ name: "AppReleaseImmutableConflictError" });
  await expect(
    createCatalog().resolvePublicWebsite(first.route),
  ).rejects.toMatchObject({ name: "AppReleasePublicWebsiteNotFoundError" });
});

it("native local R2 digest mismatch fails closed after D1 reconstruction", async () => {
  const fixture = releaseFixture("mismatch");
  await seedSelectedRelease(fixture);
  await env.APP_RELEASE_ARTIFACTS.put(fixture.uiArtifactRef, wrongBytes, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });

  await expectUnavailable(
    createCatalog().resolvePublicWebsite(fixture.route),
    wrongHtml,
  );
});

it("native local D1 rejects a foreign selected Release before delivery", async () => {
  const surfaceFixture = releaseFixture("foreignsurface", "/orchid-foreign");
  const foreignReleaseFixture = releaseFixture("foreignrelease");
  const catalog = createCatalog();

  await env.APP_RELEASE_ARTIFACTS.put(
    foreignReleaseFixture.release.artifact.artifactRef,
    foreignReleaseFixture.manifestBytes,
    { httpMetadata: { contentType: "application/vnd.fungi.app+json" } },
  );
  await env.APP_RELEASE_ARTIFACTS.put(
    foreignReleaseFixture.uiArtifactRef,
    expectedBytes,
    { httpMetadata: { contentType: "text/html; charset=utf-8" } },
  );
  await expect(catalog.createApp(surfaceFixture.app)).resolves.toEqual(
    surfaceFixture.app,
  );
  await expect(catalog.createApp(foreignReleaseFixture.app)).resolves.toEqual(
    foreignReleaseFixture.app,
  );
  await expect(
    createFixturePlatformSurface(
      catalog,
      env.APP_RELEASE_CATALOG,
      surfaceFixture.surface,
    ),
  ).resolves.toEqual(surfaceFixture.surface);
  await expect(
    catalog.createRelease(foreignReleaseFixture.release),
  ).resolves.toEqual(foreignReleaseFixture.release);
  await expect(
    catalog.verifyReleaseArtifact(foreignReleaseFixture.release.releaseId),
  ).resolves.toMatchObject({
    kind: "verified",
    digest: foreignReleaseFixture.release.artifact.artifactDigest,
  });
  await expect(
    recordNativeSelection(
      {
        release: foreignReleaseFixture.release,
        surface: surfaceFixture.surface,
      },
      "f",
    ),
  ).rejects.toThrow();

  await expect(
    createCatalog().resolvePublicWebsite(surfaceFixture.route),
  ).rejects.toMatchObject({ name: "AppReleasePublicWebsiteNotFoundError" });
});

it("native local D1 rejects an unverified selected Release before delivery", async () => {
  const fixture = releaseFixture("unverified");
  const catalog = createCatalog();

  await env.APP_RELEASE_ARTIFACTS.put(
    fixture.release.artifact.artifactRef,
    fixture.manifestBytes,
    { httpMetadata: { contentType: "application/vnd.fungi.app+json" } },
  );
  await env.APP_RELEASE_ARTIFACTS.put(fixture.uiArtifactRef, expectedBytes, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  await expect(catalog.createApp(fixture.app)).resolves.toEqual(fixture.app);
  await expect(
    createFixturePlatformSurface(
      catalog,
      env.APP_RELEASE_CATALOG,
      fixture.surface,
    ),
  ).resolves.toEqual(fixture.surface);
  await expect(catalog.createRelease(fixture.release)).resolves.toEqual(
    fixture.release,
  );
  await expect(recordNativeSelection(fixture, "u")).rejects.toThrow();

  await expect(
    createCatalog().resolvePublicWebsite(fixture.route),
  ).rejects.toMatchObject({ name: "AppReleasePublicWebsiteNotFoundError" });
});

it("native local R2 missing artifacts do not fall back to prior bytes", async () => {
  const fixture = releaseFixture("missing");
  await seedSelectedRelease(fixture);
  const catalog = createCatalog();

  await expect(
    catalog.resolvePublicWebsite(fixture.route),
  ).resolves.toMatchObject({ digest: expectedDigest });
  await env.APP_RELEASE_ARTIFACTS.delete(fixture.uiArtifactRef);

  await expectUnavailable(catalog.resolvePublicWebsite(fixture.route), html);
});

it("native D1 with unavailable R2 does not expose prior bytes", async () => {
  const fixture = releaseFixture("unavailabler2");
  await seedSelectedRelease(fixture);
  const unavailableMarker = "injected-r2-unavailable-sentinel";
  const catalog = createAppReleaseCatalog({
    store: cloudflare.createD1AppReleaseStore(env.APP_RELEASE_CATALOG),
    artifactReader: cloudflare.createR2ArtifactReader({
      get: () => Promise.reject(new Error(unavailableMarker)),
    }),
  });

  await expectUnavailable(
    catalog.resolvePublicWebsite(fixture.route),
    unavailableMarker,
  );
});

it("native local D1 revalidates authority after the R2 read", async () => {
  const fixture = releaseFixture("authoritychange");
  await seedSelectedRelease(fixture);
  const nativeReader = createFixtureR2ArtifactReader();
  let revokeAfterRead = false;
  let revocationCommitted = false;
  const racingCatalog = createAppReleaseCatalog({
    store: cloudflare.createD1AppReleaseStore(env.APP_RELEASE_CATALOG),
    artifactReader: {
      read: async (input) => {
        const result = await nativeReader.read(input);
        if (revokeAfterRead && !revocationCommitted) {
          await createCatalog().transition({
            kind: "revocation",
            releaseId: fixture.release.releaseId,
            idempotencyKey: parseIdempotencyKey(
              "idem_nativewebsiteauthoritychangerevoke",
            ),
          });
          revocationCommitted = true;
        }
        return result;
      },
    },
  });

  await expect(
    racingCatalog.resolvePublicWebsite(fixture.route),
  ).resolves.toMatchObject({ digest: expectedDigest });
  revokeAfterRead = true;

  await expectUnavailable(
    racingCatalog.resolvePublicWebsite(fixture.route),
    html,
  );
  expect(revocationCommitted).toBe(true);
});
