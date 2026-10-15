import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type {
  AppReleaseStoreResult,
  PromiseAppReleaseStore,
  ReleaseId,
  StableRoute,
} from "./app-release-contract.js";
import type {
  AppReleaseStore,
  AppReleaseStorePortFailure,
} from "./app-release-store.js";
import {
  publicSurfaceSchema,
  appSchema,
  releaseIdSchema,
  releaseLifecycleSchema,
} from "./app-release-schema.js";

/** Private atomic route, selection, and selected Release delivery facts. */
export type PublicWebsiteAuthority = Schema.Schema.Type<typeof authoritySchema>;

/** One atomic route authority query, optionally pinned to a previously selected Release. */
export type PublicWebsiteAuthorityRequest = Readonly<{
  readonly stableRoute: StableRoute;
  readonly expectedReleaseId?: ReleaseId;
}>;

export type PromisePublicWebsiteAuthorityReader = (
  requests: readonly PublicWebsiteAuthorityRequest[],
) => Promise<AppReleaseStoreResult<readonly PublicWebsiteAuthority[]>>;

export type EffectPublicWebsiteAuthorityReader = (
  requests: readonly PublicWebsiteAuthorityRequest[],
) => Effect.Effect<
  readonly PublicWebsiteAuthority[],
  AppReleaseStorePortFailure
>;

const promiseReaders = new WeakMap<
  object,
  PromisePublicWebsiteAuthorityReader
>();
const effectReaders = new WeakMap<object, EffectPublicWebsiteAuthorityReader>();

const authoritySchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("absent") }),
  Schema.Struct({ kind: Schema.Literal("ambiguous") }),
  Schema.Struct({
    kind: Schema.Literal("unselected"),
    app: appSchema,
    surface: publicSurfaceSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("selected"),
    app: appSchema,
    surface: publicSurfaceSchema,
    releaseId: releaseIdSchema,
    currentReleaseId: releaseIdSchema,
    sequence: Schema.Number.pipe(
      Schema.check(Schema.isInt()),
      Schema.check(Schema.isGreaterThan(0)),
    ),
    release: releaseLifecycleSchema,
  }),
]);

const authorityStoreResultSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("success"),
    value: Schema.Array(authoritySchema),
  }),
  Schema.Struct({
    kind: Schema.Literal("failure"),
    failure: Schema.Struct({ kind: Schema.Literal("unavailable") }),
  }),
]);

export const decodePublicWebsiteAuthorityStoreResult =
  Schema.decodeUnknownResult(authorityStoreResultSchema, {
    onExcessProperty: "error",
  });

export function registerPromisePublicWebsiteAuthorityReader(
  store: PromiseAppReleaseStore,
  reader: PromisePublicWebsiteAuthorityReader,
): PromiseAppReleaseStore {
  promiseReaders.set(store, reader);
  return store;
}

export function getPromisePublicWebsiteAuthorityReader(
  store: PromiseAppReleaseStore,
): PromisePublicWebsiteAuthorityReader | undefined {
  return promiseReaders.get(store);
}

export function registerEffectPublicWebsiteAuthorityReader(
  store: AppReleaseStore,
  reader: EffectPublicWebsiteAuthorityReader,
): AppReleaseStore {
  effectReaders.set(store, reader);
  return store;
}

export function getEffectPublicWebsiteAuthorityReader(
  store: AppReleaseStore,
): EffectPublicWebsiteAuthorityReader | undefined {
  return effectReaders.get(store);
}
