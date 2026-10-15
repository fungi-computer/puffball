import {
  platformSurface,
  fixturePlatformRoutes,
} from "./support/platform-publication.js";
import { expect, it } from "vitest";

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
} from "../dist/index.js";
import { createDeterministicMemoryAppReleaseStore } from "../dist/effect.js";
import { createPublicWebsiteFetchHandler } from "../dist/internal/public-website-fetch.js";

const digest = (character: string) =>
  parseSha256Digest(`sha256:${character.repeat(64)}`);

const html = "<!doctype html><p>orchid immutable artifact</p>";
const expectedBytes = new TextEncoder().encode(html);
const uiArtifactRef = parseArtifactRef("artifact:orchid.ui");
const uiDigest = digest("b");
const manifestBytes = new TextEncoder().encode(
  JSON.stringify({
    format: "fungi-app-v1",
    ui: {
      artifactRef: uiArtifactRef,
      digest: uiDigest,
      version: "v1",
      byteLength: expectedBytes.byteLength,
      mediaType: "text/html; charset=utf-8",
    },
  }),
);
const releaseDigest = digest("a");
const rejectedInput = "rel_attacker_and_their_untrusted_selection";
const forbiddenArtifactBytes = "orchid immutable artifact";

function fixture() {
  const app = { appId: parseAppId("app_orchid") };
  const route = parseStableRoute("/orchid");
  const surface = {
    publicSurfaceId: parsePublicSurfaceId("ps_orchid"),
    appId: app.appId,
    stableRoute: route,
  };
  const release: Release = {
    releaseId: parseReleaseId("rel_orchid"),
    appId: app.appId,
    artifact: {
      artifactRef: parseArtifactRef("artifact:orchid.release"),
      artifactDigest: releaseDigest,
      provenance: {
        sourceRevision: parseSourceRevision(`git:${"b".repeat(40)}`),
        sourceTreeDigest: digest("c"),
        buildRecipeDigest: digest("d"),
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
            byteLength: manifestBytes.byteLength,
            copy: () => manifestBytes.slice(),
          },
          byteLength: manifestBytes.byteLength,
        });
      }
      if (input.artifactRef === uiArtifactRef) {
        return Promise.resolve({
          kind: "verified" as const,
          digest: input.expectedDigest,
          mediaType: "text/html; charset=utf-8" as const,
          bytes: {
            byteLength: expectedBytes.byteLength,
            copy: () => expectedBytes.slice(),
          },
          byteLength: expectedBytes.byteLength,
        });
      }
      return Promise.resolve({ kind: "missing" as const });
    },
  };
  const catalog = createAppReleaseCatalog({
    artifactReader,
    store: createDeterministicMemoryAppReleaseStore(fixturePlatformRoutes),
  });

  return { app, catalog, release, route, surface };
}

async function seedSelectedRelease(
  value: ReturnType<typeof fixture>,
): Promise<void> {
  await value.catalog.createApp(value.app);
  await value.catalog.createPublicSurface(platformSurface(value.surface));
  await value.catalog.createRelease(value.release);
  await value.catalog.verifyReleaseArtifact(value.release.releaseId);
  await value.catalog.transition({
    kind: "promotion",
    publicSurfaceId: value.surface.publicSurfaceId,
    releaseId: value.release.releaseId,
    idempotencyKey: parseIdempotencyKey("idem_orchidpromotion"),
  });
}

async function responseText(response: Response): Promise<string> {
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  return response.text();
}

it("Fetch delivery ignores non-path request inputs and never serves revoked bytes", async () => {
  const value = fixture();
  await seedSelectedRelease(value);

  expect(createPublicWebsiteFetchHandler).toBeTypeOf("function");
  const handler = createPublicWebsiteFetchHandler({
    resolvePublicWebsite: (stableRoute) =>
      value.catalog.resolvePublicWebsite(stableRoute),
  });
  const canonical = await handler.fetch(
    new Request("https://public.example.test/orchid"),
  );
  expect(canonical.status).toBe(200);
  await expect(responseText(canonical)).resolves.toBe(html);

  const withExcludedInputs = await handler.fetch(
    new Request(
      `https://public.example.test/orchid?releaseId=${rejectedInput}&artifactDigest=${value.release.artifact.artifactDigest}&receipt=attacker-receipt`,
      {
        headers: {
          cookie: `releaseId=${rejectedInput}`,
          "x-release-id": rejectedInput,
          "x-release-digest": value.release.artifact.artifactDigest,
        },
      },
    ),
  );
  expect(withExcludedInputs.status).toBe(200);
  await expect(responseText(withExcludedInputs)).resolves.toBe(html);

  const malformedRoute = await handler.fetch(
    new Request(
      `https://public.example.test/orchid/?rejectedRoute=${rejectedInput}`,
    ),
  );
  const absentRoute = await handler.fetch(
    new Request(
      `https://public.example.test/missing?rejectedRoute=${rejectedInput}`,
    ),
  );
  expect(malformedRoute.status).toBe(404);
  expect(absentRoute.status).toBe(404);
  const notFound = await responseText(malformedRoute);
  expect(await responseText(absentRoute)).toBe(notFound);
  expect(notFound).not.toContain(rejectedInput);
  expect(notFound).not.toContain(forbiddenArtifactBytes);

  const postWithBody = await handler.fetch(
    new Request("https://public.example.test/orchid", {
      method: "POST",
      body: `releaseId=${rejectedInput}&artifact=${forbiddenArtifactBytes}`,
    }),
  );
  const putWithBody = await handler.fetch(
    new Request("https://public.example.test/orchid", {
      method: "PUT",
      body: `releaseId=${rejectedInput}&artifact=${forbiddenArtifactBytes}`,
    }),
  );
  expect(postWithBody.status).toBe(405);
  expect(putWithBody.status).toBe(405);
  const methodNotAllowed = await responseText(postWithBody);
  expect(await responseText(putWithBody)).toBe(methodNotAllowed);
  expect(methodNotAllowed).not.toContain(rejectedInput);
  expect(methodNotAllowed).not.toContain(forbiddenArtifactBytes);

  await value.catalog.transition({
    kind: "revocation",
    releaseId: value.release.releaseId,
    idempotencyKey: parseIdempotencyKey("idem_orchidrevocation"),
  });
  const revoked = await handler.fetch(
    new Request(
      `https://public.example.test/orchid?releaseId=${rejectedInput}`,
    ),
  );
  const revokedAgain = await handler.fetch(
    new Request("https://public.example.test/orchid"),
  );
  expect(revoked.status).toBe(503);
  expect(revokedAgain.status).toBe(503);
  const unavailable = await responseText(revoked);
  expect(await responseText(revokedAgain)).toBe(unavailable);
  expect(unavailable).not.toContain(rejectedInput);
  expect(unavailable).not.toContain(forbiddenArtifactBytes);
});

it("Fetch delivery treats forged public-website error names as unavailable", async () => {
  expect(createPublicWebsiteFetchHandler).toBeTypeOf("function");
  const forged = new Error("untrusted error");
  forged.name = "AppReleasePublicWebsiteNotFoundError";
  const handler = createPublicWebsiteFetchHandler({
    resolvePublicWebsite: () => Promise.reject(forged),
  });

  const response = await handler.fetch(
    new Request("https://public.example.test/orchid"),
  );
  expect(response.status).toBe(503);
  await expect(responseText(response)).resolves.toBe(
    "<!doctype html><title>Unavailable</title>",
  );
});
