import * as Schema from "effect/Schema";
import { appCapabilityIds, type AppApi } from "./app-vocabulary.js";

import { isAppApiMethodName } from "./app-method-runtime.js";
export { appApiReservedMethodNames } from "./app-method-runtime.js";
/** Public method names, including grouped operations such as desktop.arrange. A name cannot also be a group (`files` with `files.read`). */
export const appApiMethodNameSchema = Schema.String.check(
  Schema.makeFilter(isAppApiMethodName),
);

function withinDepth(value: Schema.Json, depth = 0): boolean {
  if (depth > 16) return false;
  if (Schema.is(Schema.Array(Schema.Json))(value))
    return value.every((child) => withinDepth(child, depth + 1));
  if (Schema.is(Schema.JsonObject)(value))
    return Object.values(value).every((child) => withinDepth(child, depth + 1));
  return true;
}

/** JSON Schema projections are data, bounded before a renderer or compiler reads them. */
const projection = Schema.JsonObject.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) =>
        new TextEncoder().encode(JSON.stringify(value)).byteLength <= 20_000 &&
        withinDepth(value),
      { message: "App API schema exceeds its byte or depth bound" },
    ),
  ),
);

const eventName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
);

const method = Schema.Struct({
  description: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(1000)),
  ),
  input: projection,
  output: projection,
  pending: Schema.optional(Schema.Literal(true)),
  hidden: Schema.optional(Schema.Literal(true)),
  anonymous: Schema.optional(Schema.Literal(true)),
  effect: Schema.Literals(["read", "write", "external"]),
  requires: Schema.Array(Schema.Literals(appCapabilityIds)).pipe(
    Schema.check(
      Schema.makeFilter((values) => new Set(values).size === values.length),
    ),
  ),
}).check(
  Schema.makeFilter(
    (value) =>
      value.anonymous !== true ||
      (value.effect === "read" && value.requires.length === 0),
    {
      message: "Anonymous methods must be reads with no required capabilities",
    },
  ),
);

/** The build-generated, digest-covered method and event catalog; it grants no authority. */
export const appApiSchema: Schema.Codec<AppApi> = Schema.Struct({
  methods: Schema.Record(Schema.String, method).pipe(
    Schema.check(
      Schema.makeFilter(
        (methods) =>
          Object.keys(methods).every(Schema.is(appApiMethodNameSchema)),
        { message: "Invalid App API method name" },
      ),
    ),
    Schema.check(
      Schema.makeFilter((methods) => Object.keys(methods).length <= 64),
    ),
    Schema.check(
      Schema.makeFilter(
        (methods) => {
          const names = Object.keys(methods);
          return names.every(
            (name) => !names.some((other) => other.startsWith(`${name}.`)),
          );
        },
        { message: "App API method name is also a method group" },
      ),
    ),
  ),
  toolFamily: Schema.optionalKey(
    Schema.Struct({
      name: appApiMethodNameSchema.check(
        Schema.makeFilter((name) => !name.includes(".")),
      ),
      list: appApiMethodNameSchema,
      call: appApiMethodNameSchema,
    }),
  ),
  events: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        description: Schema.String.check(
          Schema.isMinLength(1),
          Schema.isMaxLength(1000),
        ),
        payload: projection,
      }),
    ).check(
      Schema.makeFilter(
        (events) => Object.keys(events).every(Schema.is(eventName)),
        { message: "Invalid App API event name" },
      ),
      Schema.makeFilter((events) => Object.keys(events).length <= 64),
    ),
  ),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (api) => {
        if (api.toolFamily === undefined) return true;
        const { name, list, call } = api.toolFamily;
        const listing = api.methods[list];
        const operation = api.methods[call];
        return (
          listing?.effect === "read" &&
          operation !== undefined &&
          operation.effect !== "external" &&
          operation.hidden !== true &&
          !Object.keys(api.methods).some(
            (method) => method.split(".")[0] === name,
          )
        );
      },
      {
        message:
          "Tool family must reference declared callable methods in a distinct namespace",
      },
    ),
  ),
  Schema.check(
    Schema.makeFilter(
      (api) =>
        new TextEncoder().encode(JSON.stringify(api)).byteLength <= 256_000,
      { message: "App API exceeds its total byte bound" },
    ),
  ),
);
