import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AppReleaseCore } from "./effect.js";
import type { ReleaseId } from "./index.js";

/**
 * The closed runtime profiles. `durable-facet` runs only inside an admitted
 * call; `region` adds supervisor-owned native alarms and sockets that reach
 * the App as bounded events.
 */
export const appBackendRuntimeKindSchema = Schema.Literals([
  "durable-facet",
  "region",
]);

/** This immutable descriptor is stored inside the verified Release artifact. */
export const durableBackendSchema = Schema.Struct({
  runtime: Schema.Struct({
    kind: appBackendRuntimeKindSchema,
    stateSchema: Schema.Number.pipe(
      Schema.check(Schema.isInt()),
      Schema.check(Schema.isGreaterThan(0)),
    ),
  }),
  compatibilityDate: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  ),
  exportName: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  code: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});
export type { DurableBackend } from "./internal/app-release-contract.js";
/** Content type separating executable backend artifacts from website HTML. */
export const backendMediaType =
  "application/vnd.fungi.app-backend+json" as const;
/** Maintained JSON codec for immutable backend bytes. */
export const backendJsonSchema = Schema.fromJsonString(durableBackendSchema);

/** Resolve through catalog eligibility and digest verification before decoding code. */
export function resolveDurableBackend(
  catalog: Pick<AppReleaseCore, "resolveEligibleApp">,
  releaseId: ReleaseId,
) {
  return Effect.gen(function* () {
    const app = yield* catalog.resolveEligibleApp(releaseId);
    if (app.backend === null)
      return yield* Effect.fail(new Error("Release has no durable backend"));
    return {
      release: app.release,
      digest: app.backend.digest,
      backend: app.backend.descriptor,
    };
  });
}

export {
  appRegionEventSchema,
  appRegionReplySchema,
  maxAppRegionMessageBytes,
  maxAppRegionReplyBytes,
  type AppRegionEvent,
  type AppRegionReply,
} from "./app-method-runtime.js";

/** Bounded HTTP cargo on the existing signed App-backend dispatch rail. */
export const siteHttpRequestSchema = Schema.Struct({
  url: Schema.String,
  method: Schema.NonEmptyString,
  contentType: Schema.NullOr(Schema.String),
  bodyBase64: Schema.String,
});
/** Closed HTTP input carried by a signed Site backend dispatch. */
export type SiteHttpRequest = Schema.Schema.Type<typeof siteHttpRequestSchema>;
/** Content-only HTTP result; browser origin policy stays with the host. */
export const siteHttpReplySchema = Schema.Struct({
  status: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 200, maximum: 599 }),
  ),
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  bodyBase64: Schema.String,
});
/** Bounded Site backend reply encoded as JSON across the execution rail. */
export type SiteHttpReply = Schema.Schema.Type<typeof siteHttpReplySchema>;
