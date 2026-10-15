import { platformSurface } from "./support/platform-publication.js";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
  AppReleaseInvalidStoreResultError,
  AppReleaseStoreUnavailableError,
  createAppReleaseCatalog,
  parseAppId,
  parseArtifactRef,
  parsePublicSurfaceId,
  parseReleaseId,
  parseSha256Digest,
  parseSourceRevision,
  parseStableRoute,
  type App,
  type AppCreate,
  type AppRead,
  type AppReleaseCatalog,
  type AppReleaseCommandName,
  type AppReleaseStoreResult,
  type ArtifactReader,
  type PromiseAppReleaseStore,
  type PublicSurface,
  type PublicSurfaceCreate,
  type PublicSurfaceRead,
  type Release,
  type ReleaseCreate,
  type ReleaseRead,
} from "../dist/index.js";
import {
  adaptPromiseAppReleaseStore,
  adaptPromiseArtifactReader,
  createAppReleaseCore,
  type AppReleaseCore,
  type AppReleaseCoreFailure,
  type AppReleaseStore,
} from "../dist/effect.js";

type StoreCall = keyof PromiseAppReleaseStore;
type StorePortFailure =
  { readonly kind: "unavailable" } | { readonly kind: "invalid-store-result" };

type ForeignStoreMode = "malformed" | "rejected";

type ForeignStoreFixture = {
  readonly calls: StoreCall[];
  readonly store: PromiseAppReleaseStore;
};

type ArtifactReaderFixture = {
  readonly calls: () => number;
  readonly reader: ArtifactReader;
};

type PublicFailureObservation = {
  readonly exact: boolean;
  readonly failure: Error | undefined;
};

const hostileMarker = "hostile-fulfilled-store-result";
const rejectionMarker = "hostile-rejected-store-promise";
const allowedErrorProperties = ["message", "name", "stack"];

const app: App = { appId: parseAppId("app_orchid") };
const release: Release = {
  releaseId: parseReleaseId("rel_orchid"),
  appId: app.appId,
  artifact: {
    artifactRef: parseArtifactRef("artifact:orchid.release"),
    artifactDigest: parseSha256Digest(`sha256:${"a".repeat(64)}`),
    provenance: {
      sourceRevision: parseSourceRevision(`git:${"b".repeat(40)}`),
      sourceTreeDigest: parseSha256Digest(`sha256:${"c".repeat(64)}`),
      buildRecipeDigest: parseSha256Digest(`sha256:${"d".repeat(64)}`),
    },
  },
};
const surface: PublicSurface = {
  publicSurfaceId: parsePublicSurfaceId("ps_orchid"),
  appId: app.appId,
  stableRoute: parseStableRoute("/orchid"),
};

function makeForeignStore(mode: ForeignStoreMode): ForeignStoreFixture {
  const calls: StoreCall[] = [];
  const appRead: AppRead = { kind: "absent" };
  const appCreate: AppCreate = { kind: "created", app };
  const releaseRead: ReleaseRead = { kind: "absent" };
  const releaseCreate: ReleaseCreate = { kind: "created", release };
  const surfaceRead: PublicSurfaceRead = { kind: "absent" };
  const surfaceCreate: PublicSurfaceCreate = { kind: "created", surface };

  function fulfilled<Value>(
    method: StoreCall,
    value: Value,
  ): Promise<AppReleaseStoreResult<Value>> {
    calls.push(method);
    if (mode === "rejected") return Promise.reject(new Error(rejectionMarker));

    const result: AppReleaseStoreResult<Value> = { kind: "success", value };
    Object.defineProperty(result, "value", {
      enumerable: true,
      value: { marker: hostileMarker },
    });
    return Promise.resolve(result);
  }

  return {
    calls,
    store: {
      readApp: () => fulfilled("readApp", appRead),
      createAppIfAbsent: () => fulfilled("createAppIfAbsent", appCreate),
      readRelease: () => fulfilled("readRelease", releaseRead),
      createReleaseIfAbsent: () =>
        fulfilled("createReleaseIfAbsent", releaseCreate),
      readPublicSurface: () => fulfilled("readPublicSurface", surfaceRead),
      createPublicSurfaceIfAbsent: () =>
        fulfilled("createPublicSurfaceIfAbsent", surfaceCreate),
    },
  };
}

function makeArtifactReader(): ArtifactReaderFixture {
  let count = 0;
  const reader: ArtifactReader = {
    read: () => {
      count += 1;
      return Promise.resolve({ kind: "missing" });
    },
  };
  return { calls: () => count, reader };
}

function isExactInvalidStoreSentinel(failure: StorePortFailure): boolean {
  return (
    failure.kind === "invalid-store-result" &&
    !Object.hasOwn(failure, "marker") &&
    Object.getOwnPropertyNames(failure).every(
      (propertyName) => propertyName === "kind",
    )
  );
}

function isExactUnavailableStoreSentinel(failure: StorePortFailure): boolean {
  return (
    failure.kind === "unavailable" &&
    !("cause" in failure) &&
    !("detail" in failure) &&
    !("marker" in failure) &&
    Object.getOwnPropertyNames(failure).every(
      (propertyName) => propertyName === "kind",
    )
  );
}

function observeInvalidStoreSentinel<Value>(
  program: Effect.Effect<Value, StorePortFailure>,
): Promise<boolean> {
  return Effect.runPromise(Effect.flip(program)).then(
    (failure) => isExactInvalidStoreSentinel(failure),
    () => false,
  );
}

function observeUnavailableStoreSentinel<Value>(
  program: Effect.Effect<Value, StorePortFailure>,
): Promise<boolean> {
  return Effect.runPromise(Effect.flip(program)).then(
    (failure) => isExactUnavailableStoreSentinel(failure),
    () => false,
  );
}

function isExactInvalidStoreResultError(failure: Error): boolean {
  return (
    failure instanceof AppReleaseInvalidStoreResultError &&
    failure.name === "AppReleaseInvalidStoreResultError" &&
    failure.message === "App Release store result is invalid" &&
    !failure.message.includes(hostileMarker) &&
    !("cause" in failure) &&
    !("detail" in failure) &&
    !("marker" in failure) &&
    !("rawData" in failure) &&
    Object.getOwnPropertyNames(failure).every((propertyName) =>
      allowedErrorProperties.includes(propertyName),
    )
  );
}

function isExactStoreUnavailableError(failure: Error): boolean {
  return (
    failure instanceof AppReleaseStoreUnavailableError &&
    failure.name === "AppReleaseStoreUnavailableError" &&
    failure.message === "App Release store is unavailable" &&
    !failure.message.includes(rejectionMarker) &&
    !("cause" in failure) &&
    !("detail" in failure) &&
    !("marker" in failure) &&
    !("rawData" in failure) &&
    Object.getOwnPropertyNames(failure).every((propertyName) =>
      allowedErrorProperties.includes(propertyName),
    )
  );
}

function observeDefaultFailure(
  command: Promise<object>,
  exact: (failure: Error) => boolean,
): Promise<PublicFailureObservation> {
  return Promise.allSettled([command]).then(([outcome]) => {
    if (outcome.status !== "rejected" || !(outcome.reason instanceof Error)) {
      return { exact: false, failure: undefined };
    }
    return { exact: exact(outcome.reason), failure: outcome.reason };
  });
}

function observeCoreFailure(
  command: Effect.Effect<object, AppReleaseCoreFailure>,
  exact: (failure: Error) => boolean,
): Promise<PublicFailureObservation> {
  return Effect.runPromise(Effect.flip(command)).then(
    (failure) => ({ exact: exact(failure), failure }),
    () => ({ exact: false, failure: undefined }),
  );
}

type DirectCase = {
  readonly method: StoreCall;
  readonly invoke: (
    store: AppReleaseStore,
  ) => Effect.Effect<object, StorePortFailure>;
};

const directCases: readonly DirectCase[] = [
  { method: "readApp", invoke: (store) => store.readApp(app.appId) },
  {
    method: "createAppIfAbsent",
    invoke: (store) => store.createAppIfAbsent(app),
  },
  {
    method: "readRelease",
    invoke: (store) => store.readRelease(release.releaseId),
  },
  {
    method: "createReleaseIfAbsent",
    invoke: (store) => store.createReleaseIfAbsent(release),
  },
  {
    method: "readPublicSurface",
    invoke: (store) => store.readPublicSurface(surface.publicSurfaceId),
  },
  {
    method: "createPublicSurfaceIfAbsent",
    invoke: (store) =>
      store.createPublicSurfaceIfAbsent(platformSurface(surface)),
  },
];

type CommandCase = {
  readonly commandName: AppReleaseCommandName;
  readonly firstStoreCall: StoreCall;
  readonly defaultCommand: (catalog: AppReleaseCatalog) => Promise<object>;
  readonly coreCommand: (
    core: AppReleaseCore,
  ) => Effect.Effect<object, AppReleaseCoreFailure>;
};

const commandCases: readonly CommandCase[] = [
  {
    commandName: "createApp",
    firstStoreCall: "createAppIfAbsent",
    defaultCommand: (catalog) => catalog.createApp(app),
    coreCommand: (core) => core.createApp(app),
  },
  {
    commandName: "createRelease",
    firstStoreCall: "readRelease",
    defaultCommand: (catalog) => catalog.createRelease(release),
    coreCommand: (core) => core.createRelease(release),
  },
  {
    commandName: "createPublicSurface",
    firstStoreCall: "readApp",
    defaultCommand: (catalog) =>
      catalog.createPublicSurface(platformSurface(surface)),
    coreCommand: (core) => core.createPublicSurface(platformSurface(surface)),
  },
  {
    commandName: "verifyReleaseArtifact",
    firstStoreCall: "readRelease",
    defaultCommand: (catalog) =>
      catalog.verifyReleaseArtifact(release.releaseId),
    coreCommand: (core) => core.verifyReleaseArtifact(release.releaseId),
  },
];

function makeDefaultCatalog(mode: ForeignStoreMode) {
  const foreign = makeForeignStore(mode);
  const artifact = makeArtifactReader();
  return {
    artifactCalls: artifact.calls,
    catalog: createAppReleaseCatalog({
      artifactReader: artifact.reader,
      store: foreign.store,
    }),
    storeCalls: foreign.calls,
  };
}

function makeCore(mode: ForeignStoreMode) {
  const foreign = makeForeignStore(mode);
  const artifact = makeArtifactReader();
  return {
    artifactCalls: artifact.calls,
    core: createAppReleaseCore({
      artifactReader: adaptPromiseArtifactReader(artifact.reader),
      store: adaptPromiseAppReleaseStore(foreign.store),
    }),
    storeCalls: foreign.calls,
  };
}

describe("App Release Promise Store result boundary", () => {
  it("closes malformed fulfilled Promise Store results before any catalog decision", async () => {
    const directResults = await Promise.all(
      directCases.map(async ({ method, invoke }) => {
        const foreign = makeForeignStore("malformed");
        const exact = await observeInvalidStoreSentinel(
          invoke(adaptPromiseAppReleaseStore(foreign.store)),
        );
        return {
          exact,
          onlyOneCall:
            JSON.stringify(foreign.calls) === JSON.stringify([method]),
          method,
        };
      }),
    );
    const unavailableAdapter = makeForeignStore("rejected");
    const directRejectedPromiseControl = await observeUnavailableStoreSentinel(
      adaptPromiseAppReleaseStore(unavailableAdapter.store).createAppIfAbsent(
        app,
      ),
    );

    const commandResults = [];
    for (const commandCase of commandCases) {
      const defaultComposition = makeDefaultCatalog("malformed");
      const defaultFailure = await observeDefaultFailure(
        commandCase.defaultCommand(defaultComposition.catalog),
        isExactInvalidStoreResultError,
      );
      const coreComposition = makeCore("malformed");
      const coreFailure = await observeCoreFailure(
        commandCase.coreCommand(coreComposition.core),
        isExactInvalidStoreResultError,
      );
      commandResults.push({
        commandName: commandCase.commandName,
        coreExact: coreFailure.exact,
        coreNoArtifactRead: coreComposition.artifactCalls() === 0,
        coreOnlyFirstStoreCall:
          JSON.stringify(coreComposition.storeCalls) ===
          JSON.stringify([commandCase.firstStoreCall]),
        defaultExact: defaultFailure.exact,
        defaultNoArtifactRead: defaultComposition.artifactCalls() === 0,
        defaultOnlyFirstStoreCall:
          JSON.stringify(defaultComposition.storeCalls) ===
          JSON.stringify([commandCase.firstStoreCall]),
        freshFailures:
          defaultFailure.failure !== undefined &&
          coreFailure.failure !== undefined &&
          defaultFailure.failure !== coreFailure.failure,
      });
    }

    const unavailableDefault = makeDefaultCatalog("rejected");
    const unavailableDefaultFailure = await observeDefaultFailure(
      unavailableDefault.catalog.createApp(app),
      isExactStoreUnavailableError,
    );
    const unavailableCore = makeCore("rejected");
    const unavailableCoreFailure = await observeCoreFailure(
      unavailableCore.core.createApp(app),
      isExactStoreUnavailableError,
    );

    expect({
      directResults,
      directRejectedPromiseControl: {
        exact: directRejectedPromiseControl,
        onlyOneCall:
          JSON.stringify(unavailableAdapter.calls) ===
          JSON.stringify(["createAppIfAbsent"]),
      },
      commandResults,
      rejectedPromiseControl: {
        coreExact: unavailableCoreFailure.exact,
        coreNoArtifactRead: unavailableCore.artifactCalls() === 0,
        coreOnlyFirstStoreCall:
          JSON.stringify(unavailableCore.storeCalls) ===
          JSON.stringify(["createAppIfAbsent"]),
        defaultExact: unavailableDefaultFailure.exact,
        defaultNoArtifactRead: unavailableDefault.artifactCalls() === 0,
        defaultOnlyFirstStoreCall:
          JSON.stringify(unavailableDefault.storeCalls) ===
          JSON.stringify(["createAppIfAbsent"]),
        freshFailures:
          unavailableDefaultFailure.failure !== undefined &&
          unavailableCoreFailure.failure !== undefined &&
          unavailableDefaultFailure.failure !== unavailableCoreFailure.failure,
      },
    }).toEqual({
      directResults: directCases.map(({ method }) => ({
        exact: true,
        onlyOneCall: true,
        method,
      })),
      directRejectedPromiseControl: {
        exact: true,
        onlyOneCall: true,
      },
      commandResults: commandCases.map(({ commandName }) => ({
        commandName,
        coreExact: true,
        coreNoArtifactRead: true,
        coreOnlyFirstStoreCall: true,
        defaultExact: true,
        defaultNoArtifactRead: true,
        defaultOnlyFirstStoreCall: true,
        freshFailures: true,
      })),
      rejectedPromiseControl: {
        coreExact: true,
        coreNoArtifactRead: true,
        coreOnlyFirstStoreCall: true,
        defaultExact: true,
        defaultNoArtifactRead: true,
        defaultOnlyFirstStoreCall: true,
        freshFailures: true,
      },
    });
  });
});
