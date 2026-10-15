import {
  appBackendBindingKinds,
  type AppBackendBindingName,
  type AppBackendBindingOperation,
  type BindingOperationDefinition,
} from "./app-backend-binding-vocabulary.js";
export {
  appBackendBindingKinds,
  type AppBackendBindingName,
  type AppBackendBindingMethod,
  type AppBackendBindingOperation,
} from "./app-backend-binding-vocabulary.js";
import * as Schema from "effect/Schema";
import { appApiMethodNameSchema } from "./app-api.js";

const unique = (values: readonly string[]) =>
  new Set(values).size === values.length;
function bindingKind<const Name extends string, const Cap extends string>(
  name: Name,
  operations: Readonly<
    Record<string, Omit<BindingOperationDefinition, "cap"> & { cap: Cap }>
  >,
) {
  const names = Object.keys(operations);
  for (const operation of names)
    Schema.decodeUnknownSync(appApiMethodNameSchema)(operation);
  const declaration = Schema.Struct({
    name: Schema.Literal(name),
    operations: Schema.Array(Schema.Literals(names)).pipe(
      Schema.check(Schema.isMinLength(1)),
      Schema.check(Schema.isMaxLength(names.length)),
      Schema.check(Schema.makeFilter(unique)),
    ),
  });
  const shard = Schema.Struct({
    name: Schema.Literal(name),
    operations: Schema.Array(
      Schema.Union(
        Object.entries(operations).map(([name, operation]) =>
          Schema.Struct({
            name: Schema.Literal(name),
            cap: Schema.Literal(operation.cap),
          }),
        ),
      ),
    ).pipe(
      Schema.check(Schema.isMinLength(1)),
      Schema.check(Schema.isMaxLength(names.length)),
      Schema.check(
        Schema.makeFilter((ops) => unique(ops.map((op) => op.name)), {
          message: "App backend operation repeated",
        }),
      ),
    ),
  });
  return { declaration, shard };
}
const kinds = Object.values(appBackendBindingKinds).map((kind) =>
  bindingKind(kind.name, kind.operations),
);
const count = kinds.length;
/** Author declarations select named operations from registered binding kinds. */
export const appBackendBindingsSchema = Schema.Array(
  Schema.Union(kinds.map((kind) => kind.declaration)),
).pipe(
  Schema.check(Schema.isMaxLength(count)),
  Schema.check(
    Schema.makeFilter((bindings) =>
      unique(bindings.map((binding) => binding.name)),
    ),
  ),
);
/** Signed shard bindings pair each operation with its exact broker class. */
export const appBackendShardBindingsSchema = Schema.Array(
  Schema.Union(kinds.map((kind) => kind.shard)),
).pipe(
  Schema.check(Schema.isMaxLength(count)),
  Schema.check(
    Schema.makeFilter((bindings) =>
      unique(bindings.map((binding) => binding.name)),
    ),
  ),
);

const operationCatalog = new Map(
  Object.entries(appBackendBindingKinds).map(
    ([name, operations]) =>
      [
        name,
        new Map(
          Object.entries<AppBackendBindingOperation>(operations.operations),
        ),
      ] as const,
  ),
);
/** Look up an operation within its declared kind; unknown names have no authority. */
export function appBackendBindingOperation(
  name: AppBackendBindingName,
  operation: string,
): AppBackendBindingOperation | undefined {
  return operationCatalog.get(name)?.get(operation);
}

/** Keep only operations required by the verified method and allowed by its write ceiling.
 * Without a method, installation-scoped calls still respect the captured ceiling. */
export function scopeOperationToMethod(
  operation: AppBackendBindingOperation,
  method:
    | Pick<
        import("./app-vocabulary.js").AppApi["methods"][string],
        "requires" | "effect"
      >
    | undefined,
  ceiling: "read" | "write",
): boolean {
  return (
    (method === undefined ||
      operation.requires.every((capability) =>
        method.requires.includes(capability),
      )) &&
    (operation.effect === "read" ||
      ((method === undefined || method.effect === "write") &&
        ceiling === "write"))
  );
}
