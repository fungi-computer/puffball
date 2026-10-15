import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AppReleaseCore } from "./effect.js";
import type { ReleaseId } from "./index.js";

/** This immutable descriptor is stored inside the verified Release artifact. */
export const durableBackendSchema = Schema.Struct({
  runtime: Schema.Struct({
    kind: Schema.Literal("durable-facet"),
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
