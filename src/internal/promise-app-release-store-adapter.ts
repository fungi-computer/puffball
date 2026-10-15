import type * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import type {
  AppReleaseStoreFailure,
  AppReleaseStoreResult,
  PromiseAppReleaseStore,
} from "./app-release-contract.js";

import type {
  AppReleaseStore,
  AppReleaseStorePortFailure,
} from "./app-release-store.js";
import {
  decodePublicWebsiteAuthorityStoreResult,
  getPromisePublicWebsiteAuthorityReader,
  registerEffectPublicWebsiteAuthorityReader,
} from "./public-website-authority.js";
import {
  decodeAppCreateStoreResult,
  decodeAppReadStoreResult,
  decodePublicSurfaceCreateStoreResult,
  decodePublicSurfaceReadStoreResult,
  decodeReleaseLifecycleStoreResult,
  decodeReleaseVerificationRecordStoreResult,
  decodeReleaseCreateStoreResult,
  decodeReleaseReadStoreResult,
  decodeTransitionLookupStoreResult,
  decodeTransitionPersistenceStoreResult,
} from "./app-release-schema.js";

/**
 * Adapt the Promise store projection at the one outer edge.
 *
 * Rejected Promise work is deliberately collapsed into the closed unavailable
 * store outcome; infrastructure detail never crosses into catalog policy.
 */
export function adaptPromiseAppReleaseStore(
  projection: PromiseAppReleaseStore,
): AppReleaseStore {
  const store: AppReleaseStore = {
    readApp: (appId) =>
      fromPromise(() => projection.readApp(appId), decodeAppReadStoreResult),
    createAppIfAbsent: (app) =>
      fromPromise(
        () => projection.createAppIfAbsent(app),
        decodeAppCreateStoreResult,
      ),
    readRelease: (releaseId) =>
      fromPromise(
        () => projection.readRelease(releaseId),
        decodeReleaseReadStoreResult,
      ),
    createReleaseIfAbsent: (release) =>
      fromPromise(
        () => projection.createReleaseIfAbsent(release),
        decodeReleaseCreateStoreResult,
      ),
    readPublicSurface: (publicSurfaceId) =>
      fromPromise(
        () => projection.readPublicSurface(publicSurfaceId),
        decodePublicSurfaceReadStoreResult,
      ),
    createPublicSurfaceIfAbsent: (surface) =>
      fromPromise(
        () => projection.createPublicSurfaceIfAbsent(surface),
        decodePublicSurfaceCreateStoreResult,
      ),
    readReleaseLifecycle: (releaseId) =>
      fromOptionalPromise(
        projection.readReleaseLifecycle === undefined
          ? undefined
          : () => projection.readReleaseLifecycle?.(releaseId),
        decodeReleaseLifecycleStoreResult,
      ),
    recordReleaseVerification: (input) =>
      fromOptionalPromise(
        projection.recordReleaseVerification === undefined
          ? undefined
          : () => projection.recordReleaseVerification?.(input),
        decodeReleaseVerificationRecordStoreResult,
      ),
    readTransition: (request) =>
      fromOptionalPromise(
        projection.readTransition === undefined
          ? undefined
          : () => projection.readTransition?.(request),
        decodeTransitionLookupStoreResult,
      ),
    persistTransition: (request, receipt) =>
      fromOptionalPromise(
        projection.persistTransition === undefined
          ? undefined
          : () => projection.persistTransition?.(request, receipt),
        decodeTransitionPersistenceStoreResult,
      ),
  };
  const websiteReader = getPromisePublicWebsiteAuthorityReader(projection);
  if (websiteReader !== undefined)
    registerEffectPublicWebsiteAuthorityReader(store, (request) =>
      fromPromise(
        () => websiteReader(request),
        decodePublicWebsiteAuthorityStoreResult,
      ),
    );
  return store;
}

function fromOptionalPromise<Value>(
  operation:
    (() => Promise<AppReleaseStoreResult<Value>> | undefined) | undefined,
  decodeResult: (
    result: AppReleaseStoreResult<Value>,
  ) => Result.Result<AppReleaseStoreResult<Value>, Schema.SchemaError>,
): Effect.Effect<Value, AppReleaseStorePortFailure> {
  return operation === undefined
    ? Effect.fail(unavailable())
    : fromPromise(
        () =>
          operation() ??
          Promise.reject(new Error("App Release store operation unavailable")),
        decodeResult,
      );
}

function fromPromise<Value>(
  operation: () => Promise<AppReleaseStoreResult<Value>>,
  decodeResult: (
    result: AppReleaseStoreResult<Value>,
  ) => Result.Result<AppReleaseStoreResult<Value>, Schema.SchemaError>,
): Effect.Effect<Value, AppReleaseStorePortFailure> {
  return Effect.tryPromise({
    try: operation,
    catch: unavailable,
  }).pipe(
    Effect.flatMap((result) =>
      Effect.try({
        try: () => decodeResult(result),
        catch: invalidStoreResult,
      }).pipe(Effect.flatMap(storeOutcome)),
    ),
  );
}

function storeOutcome<Value>(
  decoded: Result.Result<AppReleaseStoreResult<Value>, Schema.SchemaError>,
): Effect.Effect<Value, AppReleaseStorePortFailure> {
  return Result.match(decoded, {
    onFailure: () => Effect.fail(invalidStoreResult()),
    onSuccess: (result) =>
      result.kind === "success"
        ? Effect.succeed(result.value)
        : Effect.fail(result.failure),
  });
}

function unavailable(): AppReleaseStoreFailure {
  return { kind: "unavailable" };
}

function invalidStoreResult() {
  return { kind: "invalid-store-result" } satisfies AppReleaseStorePortFailure;
}
