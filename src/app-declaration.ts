import {
  appDeclaredGillSchema,
  type AppDeclaredGill,
} from "@fungi.computer/gills";
import {
  appBackendBindingsSchema,
  appBackendBindingOperation,
} from "./app-backend-bindings.js";
import * as Schema from "effect/Schema";
import { backgroundSyncAllowed } from "./internal/background-sync.js";
import { appApiMethodNameSchema, appApiSchema } from "./app-api.js";
import * as SchemaParser from "effect/SchemaParser";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  appCapabilityIds,
  appHandlers,
  appRoles,
  appStorageScopes,
  type AppDeclaration,
  type AppDeclaredCommand,
} from "./app-vocabulary.js";

export const appRoleSchema = Schema.Literals(appRoles);
export const appCapabilityIdSchema = Schema.Literals(appCapabilityIds);
export const appHandlerSchema = Schema.Literals(appHandlers);

const unique = {
  message: "App declaration entries must be unique",
};
const isUnique = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

/** Chords the shell reserves for its leader; no App may declare them. */
const reservedBindings = new Set([
  "super+k",
  "meta+k",
  "cmd+k",
  "mod+k",
  "ctrl+k",
  "control+k",
]);

const meaningful = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(256)),
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0, {
      message: "Declared command text must not be blank",
    }),
  ),
);
const order = { order: Schema.optional(Schema.Int) };
const ordered = Schema.Struct(order);

/**
 * One declared command: a Whistle definition's identity and projections.
 * Runtime-only facts (availability, typed actions, slash argument grammar)
 * are not part of the digest-covered declaration and are dropped on decode.
 */
export const appDeclaredCommandSchema: Schema.Codec<AppDeclaredCommand> =
  Schema.Struct({
    id: meaningful.pipe(
      Schema.check(
        Schema.makeFilter((id) => !id.includes(":"), {
          message: "Declared command IDs are namespace-local",
        }),
      ),
    ),
    title: meaningful,
    category: meaningful,
    description: Schema.optional(
      Schema.String.pipe(Schema.check(Schema.isMaxLength(1024))),
    ),
    sigil: Schema.optional(
      meaningful.pipe(Schema.check(Schema.isMaxLength(64))),
    ),
    projections: Schema.optional(
      Schema.Struct({
        bindings: Schema.optional(
          Schema.Struct({
            ...order,
            values: Schema.Array(meaningful).pipe(
              Schema.check(Schema.isMaxLength(16)),
              Schema.check(
                Schema.makeFilter(
                  (values) =>
                    !values.some((binding) =>
                      reservedBindings.has(binding.trim().toLowerCase()),
                    ),
                  { message: "Apps cannot bind the reserved leader chord" },
                ),
              ),
            ),
          }),
        ),
        agent: Schema.optional(
          Schema.Struct({ ...order, keybind: Schema.optional(Schema.String) }),
        ),
        help: Schema.optional(ordered),
        menu: Schema.optional(ordered),
        palette: Schema.optional(ordered),
        slash: Schema.optional(
          Schema.Struct({
            ...order,
            aliases: Schema.Array(meaningful).pipe(
              Schema.check(Schema.isMaxLength(16)),
            ),
          }),
        ),
      }),
    ),
  });

const commandsAreUnique = (commands: readonly AppDeclaredCommand[]): boolean =>
  isUnique(commands.map((command) => command.id)) &&
  isUnique(
    commands.flatMap((command) => command.projections?.slash?.aliases ?? []),
  );

const gillsAreUnique = (gills: readonly AppDeclaredGill[]): boolean =>
  isUnique(gills.map((gill) => gill.id));

/** Maintained grammar for one bounded key in an App's private storage. */
export const appStorageKeyNameSchema = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9.-]{0,63}$/),
);
const storageKeyFields = Schema.Struct({
  key: appStorageKeyNameSchema,
  scopes: Schema.Array(Schema.Literals(appStorageScopes)).check(
    Schema.isMinLength(1),
    Schema.makeFilter(isUnique, unique),
  ),
  maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65536 })),
});

// Keep the nested storage contract strict when the declaration drops
// runtime-only command fields.
export const appStorageKeySchema = Schema.declareConstructor<
  typeof storageKeyFields.Type
>()(
  [storageKeyFields],
  ([fields]) =>
    (input, _self, options) =>
      SchemaParser.decodeUnknownEffect(fields)(input, {
        ...options,
        onExcessProperty: "error",
      }),
  {
    toCodecJson: () =>
      new SchemaAST.Link(
        storageKeyFields.ast,
        SchemaTransformation.passthrough(),
      ),
  },
);

const appCallFields = Schema.Struct({
  appId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  methods: Schema.Array(appApiMethodNameSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
    Schema.makeFilter(isUnique, unique),
  ),
});
const appCallSchema = Schema.declareConstructor<typeof appCallFields.Type>()(
  [appCallFields],
  ([fields]) =>
    (input, _self, options) =>
      SchemaParser.decodeUnknownEffect(fields)(input, {
        ...options,
        onExcessProperty: "error",
      }),
  {
    toCodecJson: () =>
      new SchemaAST.Link(appCallFields.ast, SchemaTransformation.passthrough()),
  },
);
/** The bounded, digest-covered allowlist shown when approving member App calls. */
export const appCallsSchema = Schema.Array(appCallSchema).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(16),
  Schema.makeFilter(
    (calls) => isUnique(calls.map((call) => call.appId)),
    unique,
  ),
);

/** Boundary codec for the digest-covered {@link AppDeclaration}. */
export const appDeclarationSchema: Schema.Codec<AppDeclaration> = Schema.Struct(
  {
    api: Schema.optionalKey(appApiSchema),
    displayName: Schema.optional(
      Schema.String.pipe(
        Schema.check(Schema.isMinLength(1)),
        Schema.check(Schema.isMaxLength(64)),
      ),
    ),
    capabilities: Schema.Array(appCapabilityIdSchema).pipe(
      Schema.check(Schema.makeFilter(isUnique, unique)),
    ),
    calls: Schema.optionalKey(appCallsSchema),
    guidance: Schema.optional(
      Schema.String.pipe(
        Schema.check(Schema.isMinLength(1)),
        Schema.check(Schema.isMaxLength(12_000)),
      ),
    ),
    handlers: Schema.Array(appHandlerSchema).pipe(
      Schema.check(Schema.makeFilter(isUnique, unique)),
    ),
    receives: Schema.optionalKey(
      Schema.Array(Schema.Literal("git.push")).check(
        Schema.isMaxLength(1),
        Schema.makeFilter(isUnique, unique),
      ),
    ),
    icon: Schema.optionalKey(
      Schema.String.pipe(
        Schema.check(Schema.isMinLength(1)),
        Schema.check(Schema.isMaxLength(80)),
      ),
    ),
    roles: Schema.Array(appRoleSchema).pipe(
      Schema.check(Schema.makeFilter(isUnique, unique)),
    ),
    storage: Schema.optionalKey(
      Schema.Array(appStorageKeySchema).check(
        Schema.isMaxLength(16),
        Schema.makeFilter(
          (keys) => isUnique(keys.map((entry) => entry.key)),
          unique,
        ),
      ),
    ),
    commands: Schema.optional(
      Schema.Array(appDeclaredCommandSchema).pipe(
        Schema.check(Schema.isMaxLength(64)),
        Schema.check(
          Schema.makeFilter(commandsAreUnique, {
            message: "Declared command IDs and slash aliases must be unique",
          }),
        ),
      ),
    ),
    gills: Schema.optional(
      Schema.Array(appDeclaredGillSchema).pipe(
        Schema.check(Schema.isMaxLength(16)),
        Schema.check(
          Schema.makeFilter(gillsAreUnique, {
            message: "Declared Gill IDs must be unique",
          }),
        ),
      ),
    ),
    backend: Schema.optional(
      Schema.Struct({
        bindings: appBackendBindingsSchema,
        sync: Schema.optionalKey(
          Schema.Struct({ method: appApiMethodNameSchema }),
        ),
      }),
    ),
  },
).pipe(
  Schema.check(
    Schema.makeFilter(
      (declaration) =>
        declaration.calls === undefined ||
        declaration.capabilities.includes("apps.call"),
      { message: "App calls require apps.call" },
    ),
  ),
  Schema.check(
    Schema.makeFilter(
      (declaration) =>
        declaration.backend?.bindings.every(
          (binding) => binding.name !== "BACKGROUND",
        ) ?? true,
      { message: "BACKGROUND is host-minted and cannot be declared by an App" },
    ),
  ),
  Schema.check(
    Schema.makeFilter(
      (declaration) =>
        backgroundSyncAllowed(declaration.api, declaration.backend?.sync),
      {
        message:
          "Background continuation must be a declared write covering all write requirements",
      },
    ),
  ),
  Schema.check(
    Schema.makeFilter(
      (declaration) =>
        !(declaration.receives?.includes("git.push") ?? false) ||
        declaration.capabilities.includes("git.repository"),
      { message: "Git push reception requires git.repository" },
    ),
  ),
  Schema.check(
    Schema.makeFilter(
      (declaration) =>
        declaration.backend?.bindings.every((binding) =>
          binding.operations.every(
            (name) =>
              appBackendBindingOperation(binding.name, name)?.requires.every(
                (capability) => declaration.capabilities.includes(capability),
              ) === true,
          ),
        ) ?? true,
      { message: "Backend bindings require declared App capabilities" },
    ),
  ),
  Schema.check(
    Schema.makeFilter(
      (declaration) =>
        !declaration.backend?.bindings.some(
          (binding) => binding.name === "APP_STORAGE",
        ) || (declaration.storage?.length ?? 0) > 0,
      { message: "App storage bindings require declared keys" },
    ),
  ),
  Schema.check(
    Schema.makeFilter(
      (declaration) =>
        Object.values(declaration.api?.methods ?? {}).every((method) =>
          method.requires.every((capability) =>
            declaration.capabilities.includes(capability),
          ),
        ),
      { message: "App API requires capabilities outside the App declaration" },
    ),
  ),
);
