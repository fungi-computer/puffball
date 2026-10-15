import {
  platformSurface,
  fixturePlatformRoutes,
} from "./support/platform-publication.js";
import { CairnGenerationError } from "@fungi.computer/cairn/id";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { expect, it } from "vitest";

import {
  AppReleaseTransitionIdUnavailableError,
  AppReleaseTransitionReleaseUnverifiedError,
  type AppReleaseCatalog,
  createAppReleaseCatalog,
  parseAppId,
  parseArtifactRef,
  parseAppTransitionId,
  parseIdempotencyKey,
  parsePublicSurfaceId,
  parseReleaseId,
  parseSha256Digest,
  parseSourceRevision,
  parseStableRoute,
  type AppTransitionId,
  type ArtifactReader,
  type PromiseAppReleaseStore,
  type Release,
  type ReleaseTransition,
} from "../dist/index.js";
import {
  adaptPromiseAppReleaseStore,
  adaptPromiseArtifactReader,
  createDeterministicMemoryAppReleaseStore,
  createAppReleaseCore,
} from "../dist/effect.js";
import { appTransitionIdCodec } from "../dist/internal/app-release-schema.js";

const transitionA = parseAppTransitionId(
  "app_transition_000000000000000000001",
);
const transitionB = parseAppTransitionId(
  "app_transition_000000000000000000002",
);
const digest = (character: string) =>
  parseSha256Digest(`sha256:${character.repeat(64)}`);

const app = { appId: parseAppId("app_generationlaw") };
const surface = {
  publicSurfaceId: parsePublicSurfaceId("ps_generationlaw"),
  appId: app.appId,
  stableRoute: parseStableRoute("/generationlaw"),
};

function release(name: string, character: string): Release {
  return {
    releaseId: parseReleaseId(`rel_generationlaw${name}`),
    appId: app.appId,
    artifact: {
      artifactRef: parseArtifactRef(`artifact:generationlaw.${name}`),
      artifactDigest: digest(character),
      provenance: {
        sourceRevision: parseSourceRevision(`git:${character.repeat(40)}`),
        sourceTreeDigest: digest("d"),
        buildRecipeDigest: digest("e"),
      },
    },
  };
}

const verifiedRelease = release("verified", "a");
const unverifiedRelease = release("unverified", "b");

const artifactReader: ArtifactReader = {
  read: ({ artifactRef, expectedDigest }) => {
    const childBytes = new TextEncoder().encode(
      "<!doctype html><p>verified</p>",
    );
    const isChild = artifactRef.endsWith(".ui");
    const childRef = parseArtifactRef(
      `artifact:${artifactRef.slice("artifact:".length)}.ui`,
    );
    const bytes = isChild
      ? childBytes
      : new TextEncoder().encode(
          JSON.stringify({
            format: "fungi-app-v1",
            ui: {
              artifactRef: childRef,
              digest: digest("9"),
              version: "v1",
              byteLength: childBytes.byteLength,
              mediaType: "text/html; charset=utf-8",
            },
          }),
        );
    return Promise.resolve({
      kind: "verified" as const,
      digest: expectedDigest,
      mediaType: isChild
        ? ("text/html; charset=utf-8" as const)
        : ("application/vnd.fungi.app+json" as const),
      bytes: { byteLength: bytes.byteLength, copy: () => bytes.slice() },
      byteLength: bytes.byteLength,
    });
  },
};

type CatalogDriver = Pick<
  AppReleaseCatalog,
  | "createApp"
  | "createRelease"
  | "verifyReleaseArtifact"
  | "createPublicSurface"
  | "transition"
>;

type MutableTransitionCodec = { generate: () => AppTransitionId };

async function withControlledGeneration<Value>(
  generate: () => AppTransitionId,
  work: () => Promise<Value>,
): Promise<Value> {
  // SAFETY: The package-private codec's runtime descriptor is writable; this
  // test temporarily controls only the accepted randomness boundary.
  const mutableCodec = appTransitionIdCodec as MutableTransitionCodec;
  const originalGenerate = mutableCodec.generate;
  mutableCodec.generate = generate;
  try {
    return await work();
  } finally {
    mutableCodec.generate = originalGenerate;
  }
}

function observedStore() {
  const base = createDeterministicMemoryAppReleaseStore(fixturePlatformRoutes);
  const persistTransition = base.persistTransition;
  if (persistTransition === undefined) {
    throw new Error("Transition-capable memory fixture is required");
  }
  const events: string[] = [];
  let persistCalls = 0;
  const store: PromiseAppReleaseStore = {
    ...base,
    persistTransition: async (request, receipt) => {
      persistCalls += 1;
      events.push(`persist:${request.idempotencyKey}`);
      return persistTransition(request, receipt);
    },
  };
  return { store, events, persistCalls: () => persistCalls };
}

function effectCatalog(store: PromiseAppReleaseStore): CatalogDriver {
  const core = createAppReleaseCore({
    store: adaptPromiseAppReleaseStore(store),
    artifactReader: adaptPromiseArtifactReader(artifactReader),
  });
  return {
    createApp: (input) => runEffect(core.createApp(input)),
    createRelease: (input) => runEffect(core.createRelease(input)),
    verifyReleaseArtifact: (releaseId) =>
      runEffect(core.verifyReleaseArtifact(releaseId)),
    createPublicSurface: (input) => runEffect(core.createPublicSurface(input)),
    transition: (input) => runEffect(core.transition(input)),
  };
}

function runEffect<Value, Failure>(
  program: Effect.Effect<Value, Failure>,
): Promise<Value> {
  return Effect.runPromise(Effect.result(program)).then((result) =>
    Result.match(result, {
      onFailure: (failure) => {
        if (!(failure instanceof Error)) {
          throw new Error("Expected a typed catalog failure");
        }
        throw failure;
      },
      onSuccess: (value) => Promise.resolve(value),
    }),
  );
}

async function seed(catalog: CatalogDriver) {
  await catalog.createApp(app);
  await catalog.createPublicSurface(platformSurface(surface));
  await catalog.createRelease(verifiedRelease);
  await catalog.createRelease(unverifiedRelease);
  await catalog.verifyReleaseArtifact(verifiedRelease.releaseId);
}

function promotion(
  idempotencyKey: string,
  releaseId = verifiedRelease.releaseId,
): ReleaseTransition {
  return {
    kind: "promotion",
    publicSurfaceId: surface.publicSurfaceId,
    releaseId,
    idempotencyKey: parseIdempotencyKey(idempotencyKey),
  };
}

async function assertGenerationLaw(
  catalog: CatalogDriver,
  observed: ReturnType<typeof observedStore>,
) {
  await seed(catalog);

  let samples = 0;
  const firstRequest = promotion("idem_generationlaw_first");
  const first = await withControlledGeneration(
    () => {
      samples += 1;
      observed.events.push("generate:transition-a");
      return transitionA;
    },
    () => catalog.transition(firstRequest),
  );

  expect(first.transitionId).toBe(transitionA);
  expect(samples).toBe(1);
  expect(observed.persistCalls()).toBe(1);
  expect(observed.events).toEqual([
    "generate:transition-a",
    "persist:idem_generationlaw_first",
  ]);

  await withControlledGeneration(
    () => {
      samples += 1;
      throw new Error("replay must not sample Cairn");
    },
    async () => {
      await expect(catalog.transition(firstRequest)).resolves.toEqual(first);
    },
  );
  await withControlledGeneration(
    () => {
      samples += 1;
      throw new Error("policy rejection must not sample Cairn");
    },
    async () => {
      await expect(
        catalog.transition(
          promotion(
            "idem_generationlaw_unverified",
            unverifiedRelease.releaseId,
          ),
        ),
      ).rejects.toBeInstanceOf(AppReleaseTransitionReleaseUnverifiedError);
    },
  );
  expect(samples).toBe(1);
  expect(observed.persistCalls()).toBe(1);

  const generationFailureRequest = promotion("idem_generationlaw_failure");
  const cairnFailure = new CairnGenerationError({
    family: "app-release",
    kind: "transition",
  });
  await withControlledGeneration(
    () => {
      samples += 1;
      observed.events.push("generate:cairn-error");
      throw cairnFailure;
    },
    async () => {
      const [outcome] = await Promise.allSettled([
        catalog.transition(generationFailureRequest),
      ]);
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(
          AppReleaseTransitionIdUnavailableError,
        );
        expect(outcome.reason).not.toBe(cairnFailure);
        expect(outcome.reason).toMatchObject({
          name: "AppReleaseTransitionIdUnavailableError",
          message: "App Release transition identity is unavailable",
        });
        expect(outcome.reason).not.toHaveProperty("cause");
        expect(outcome.reason).not.toHaveProperty("detail");
      }
    },
  );
  expect(observed.persistCalls()).toBe(1);
  expect(observed.events).not.toContain("persist:idem_generationlaw_failure");

  const retry = await withControlledGeneration(
    () => {
      samples += 1;
      observed.events.push("generate:transition-b");
      return transitionB;
    },
    () => catalog.transition(generationFailureRequest),
  );
  expect(retry.transitionId).toBe(transitionB);
  expect(observed.persistCalls()).toBe(2);

  const unrelatedDefect = new Error("unrelated generation defect");
  await withControlledGeneration(
    () => {
      samples += 1;
      observed.events.push("generate:unrelated-defect");
      throw unrelatedDefect;
    },
    async () => {
      const [outcome] = await Promise.allSettled([
        catalog.transition(promotion("idem_generationlaw_defect")),
      ]);
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toMatchObject({
          message: "unrelated generation defect",
        });
        expect(outcome.reason).not.toBeInstanceOf(
          AppReleaseTransitionIdUnavailableError,
        );
      }
    },
  );
  expect(observed.persistCalls()).toBe(2);
  expect(samples).toBe(4);
  expect(observed.events).toEqual([
    "generate:transition-a",
    "persist:idem_generationlaw_first",
    "generate:cairn-error",
    "generate:transition-b",
    "persist:idem_generationlaw_failure",
    "generate:unrelated-defect",
  ]);
}

it("Cairn transition generation samples exactly once at the persistence boundary", async () => {
  for (const createCatalog of [
    (store: PromiseAppReleaseStore) =>
      createAppReleaseCatalog({ artifactReader, store }),
    effectCatalog,
  ]) {
    const observed = observedStore();
    await assertGenerationLaw(createCatalog(observed.store), observed);
  }
});
