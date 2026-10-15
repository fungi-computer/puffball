import { createFixturePlatformSurface } from "./support/platform-surface.mjs";
import { TextEncoder } from "node:util";

import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

import {
  AppReleaseTransitionIdempotencyConflictError,
  AppReleaseTransitionIdUnavailableError,
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
import {
  APP_RELEASE_D1_FRESH_SCHEMA,
  createD1AppReleaseStore,
  createR2ArtifactReader,
} from "../dist/cloudflare.js";

const app = { appId: parseAppId("app_d1race") };
const surface = {
  publicSurfaceId: parsePublicSurfaceId("ps_d1race"),
  appId: app.appId,
  stableRoute: parseStableRoute("/d1race"),
};

function release(name, sourceCharacter) {
  const rootDigest = {
    a: "ae9ad1c1e05c957dca863406d668833e3ad8c88bb2c3fe09c8bdffd6a1edb95a",
    b: "25db7b8a59ade7d721dcac9746b7df5f0688d0277a7ae1e5fde3473ca7fadcf1",
  }[name];
  return {
    releaseId: parseReleaseId(`rel_d1race${name}`),
    appId: app.appId,
    artifact: {
      artifactRef: parseArtifactRef(`artifact:d1race.release-${name}`),
      artifactDigest: parseSha256Digest(`sha256:${rootDigest}`),
      provenance: {
        sourceRevision: parseSourceRevision(
          `git:${sourceCharacter.repeat(40)}`,
        ),
        sourceTreeDigest: parseSha256Digest(`sha256:${"c".repeat(64)}`),
        buildRecipeDigest: parseSha256Digest(`sha256:${"d".repeat(64)}`),
      },
    },
  };
}

const releaseA = release("a", "a");
const releaseB = release("b", "b");
const artifacts = [
  [
    releaseA.artifact.artifactRef,
    new TextEncoder().encode(
      JSON.stringify({
        format: "fungi-app-v1",
        ui: {
          artifactRef: "artifact:d1race.ui-a",
          digest:
            "sha256:6b7cd97dea1eb2ef9aac16b4dfdf55f2287134924ae12586f122b204f65e5a65",
          version: "v1",
          byteLength: 23,
          mediaType: "text/html; charset=utf-8",
        },
      }),
    ),
  ],
  [
    releaseB.artifact.artifactRef,
    new TextEncoder().encode(
      JSON.stringify({
        format: "fungi-app-v1",
        ui: {
          artifactRef: "artifact:d1race.ui-b",
          digest:
            "sha256:1a674a48c2860b41fa113ab0c1a3a8fb289ac322feb77d9689f0404dc6b59611",
          version: "v1",
          byteLength: 23,
          mediaType: "text/html; charset=utf-8",
        },
      }),
    ),
  ],
  [
    parseArtifactRef("artifact:d1race.ui-a"),
    new TextEncoder().encode("<!doctype html><p>a</p>"),
  ],
  [
    parseArtifactRef("artifact:d1race.ui-b"),
    new TextEncoder().encode("<!doctype html><p>b</p>"),
  ],
];

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

function promotion(releaseId) {
  return {
    kind: "promotion",
    publicSurfaceId: surface.publicSurfaceId,
    releaseId,
    idempotencyKey: parseIdempotencyKey("idem_d1race_shared"),
  };
}

it("native D1 atomically chooses one winner for materially different promotions", async () => {
  await env.APP_RELEASE_CATALOG.exec(APP_RELEASE_D1_FRESH_SCHEMA);
  for (const [artifactRef, bytes] of artifacts) {
    await env.APP_RELEASE_ARTIFACTS.put(artifactRef, bytes, {
      httpMetadata: {
        contentType: artifactRef.includes(".release-")
          ? "application/vnd.fungi.app+json"
          : "text/html; charset=utf-8",
      },
    });
  }

  const catalog = createAppReleaseCatalog({
    store: createD1AppReleaseStore(env.APP_RELEASE_CATALOG),
    artifactReader: createFixtureR2ArtifactReader(),
  });
  await catalog.createApp(app);
  await createFixturePlatformSurface(catalog, env.APP_RELEASE_CATALOG, surface);
  await catalog.createRelease(releaseA);
  await catalog.createRelease(releaseB);
  await catalog.verifyReleaseArtifact(releaseA.releaseId);
  await catalog.verifyReleaseArtifact(releaseB.releaseId);

  const requestA = promotion(releaseA.releaseId);
  const requestB = promotion(releaseB.releaseId);
  const outcomes = await Promise.allSettled([
    catalog.transition(requestA),
    catalog.transition(requestB),
  ]);
  const fulfilled = outcomes.filter(
    (outcome) => outcome.status === "fulfilled",
  );
  const rejected = outcomes.filter((outcome) => outcome.status === "rejected");

  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  const winnerOutcome = fulfilled[0];
  const loserOutcome = rejected[0];
  if (
    winnerOutcome.status !== "fulfilled" ||
    loserOutcome.status !== "rejected"
  ) {
    throw new Error("Expected one fulfilled winner and one rejected loser");
  }
  const winner = winnerOutcome.value;
  const winnerRequest =
    winner.transition.releaseId === releaseA.releaseId ? requestA : requestB;
  expect(winner.transition).toEqual(winnerRequest);
  expect(loserOutcome.reason).toBeInstanceOf(
    AppReleaseTransitionIdempotencyConflictError,
  );
  expect(loserOutcome.reason).toMatchObject({
    name: "AppReleaseTransitionIdempotencyConflictError",
    message: "Transition idempotency key conflicts with its original request",
  });
  expect(loserOutcome.reason).not.toBeInstanceOf(
    AppReleaseTransitionIdUnavailableError,
  );

  await expect(catalog.transition(winnerRequest)).resolves.toEqual(winner);

  const count = await env.APP_RELEASE_CATALOG.prepare(
    "SELECT COUNT(*) AS count FROM app_release_transitions WHERE operation_kind = ? AND idempotency_key = ?",
  )
    .bind("promotion", "idem_d1race_shared")
    .first();
  expect(count).toEqual({ count: 1 });

  const row = await env.APP_RELEASE_CATALOG.prepare(
    "SELECT transition_id, operation_kind, idempotency_key, release_id, public_surface_id FROM app_release_transitions WHERE operation_kind = ? AND idempotency_key = ?",
  )
    .bind("promotion", "idem_d1race_shared")
    .first();
  expect(row).toEqual({
    transition_id: winner.transitionId,
    operation_kind: "promotion",
    idempotency_key: "idem_d1race_shared",
    release_id: winnerRequest.releaseId,
    public_surface_id: surface.publicSurfaceId,
  });
});
