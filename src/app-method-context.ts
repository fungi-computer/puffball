import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as SchemaIssue from "effect/SchemaIssue";
import {
  parseAppMethodCallContext,
  type AppMethodCallContext,
} from "./app-method-runtime.js";
export type {
  AppMethodCallContext,
  HostActor,
  WorkflowAttestation,
} from "./app-method-runtime.js";
/** Host attribution, including paired sealed enqueue origin, uses the sole lightweight caller grammar. */
export const appMethodCallContextSchema =
  Schema.declareConstructor<AppMethodCallContext>()(
    [],
    () => (value, ast, options) =>
      Effect.try({
        try: () =>
          parseAppMethodCallContext(
            value,
            options.onExcessProperty === "error",
          ),
        catch: () => new SchemaIssue.InvalidType(ast, value, options),
      }),
  );
