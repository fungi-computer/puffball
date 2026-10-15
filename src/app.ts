export {
  appMethodCallContextSchema,
  type AppMethodCallContext,
  type HostActor,
  type WorkflowAttestation,
} from "./app-method-context.js";
export {
  appBackendBindingKinds,
  appBackendBindingOperation,
  scopeOperationToMethod,
  appBackendBindingsSchema,
  appBackendShardBindingsSchema,
} from "./app-backend-bindings.js";
export type {
  AppBackendBindingMethod,
  AppBackendBindingName,
  AppBackendBindingOperation,
} from "./app-backend-bindings.js";
import * as Schema from "effect/Schema";
export {
  appApiSchema,
  appApiReservedMethodNames,
  appApiMethodNameSchema,
} from "./app-api.js";
export type { AppApi } from "./app-vocabulary.js";
import { appDeclarationSchema } from "./app-declaration.js";
import {
  isEmptyAppDeclaration,
  type AppDeclaration,
} from "./app-vocabulary.js";
import {
  artifactRefSchema,
  sha256DigestSchema,
} from "./internal/app-release-schema.js";

/** One immutable Release root binds every surface published by the App. */
export const appMediaType = "application/vnd.fungi.app+json" as const;

const objectReference = {
  artifactRef: artifactRefSchema,
  digest: sha256DigestSchema,
  version: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  byteLength: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThan(0)),
    Schema.check(Schema.makeFilter(Number.isSafeInteger)),
  ),
};

const appUiBuildSchema = Schema.Struct({
  ...objectReference,
  mediaType: Schema.Literals([
    "text/html; charset=utf-8",
    "application/vnd.fungi.app-assets+json",
  ]),
});

const appBackendBuildSchema = Schema.Struct({
  ...objectReference,
  mediaType: Schema.Literal("application/vnd.fungi.app-backend+json"),
});

/** Omitted when the App requests nothing, so older roots stay valid. */
const declaration = {
  declaration: Schema.optionalKey(appDeclarationSchema),
};

/**
 * Closed child formats prevent recursive manifests and independent selection.
 * An App may be visual, headless, or both, but never empty.
 */
export const appBuildSchema = Schema.Union([
  Schema.Struct({
    format: Schema.Literal("fungi-app-v1"),
    ui: appUiBuildSchema,
    backend: appBackendBuildSchema,
    ...declaration,
  }),
  Schema.Struct({
    format: Schema.Literal("fungi-app-v1"),
    ui: appUiBuildSchema,
    ...declaration,
  }),
  Schema.Struct({
    format: Schema.Literal("fungi-app-v1"),
    backend: appBackendBuildSchema,
    ...declaration,
  }),
]).pipe(
  Schema.check(
    Schema.makeFilter(
      (app) => app.declaration?.api === undefined || "backend" in app,
      { message: "An App API requires a backend" },
    ),
  ),
);

/** Digest-covered App description, not mutable selection or permission. */
export type AppBuild = Schema.Schema.Type<typeof appBuildSchema>;
export type AppUiBuild = Schema.Schema.Type<typeof appUiBuildSchema>;
export type AppBackendBuild = Schema.Schema.Type<typeof appBackendBuildSchema>;
/** Maintained codec shared by artifact producers and consumers. */
export const appBuildJsonSchema = Schema.fromJsonString(appBuildSchema);

/** Construct one non-empty App root without leaking union mechanics to adapters. */
export function createAppBuild(
  ui: AppUiBuild | null,
  backend: AppBackendBuild | null,
  appDeclaration?: AppDeclaration,
): AppBuild {
  const declared =
    appDeclaration === undefined || isEmptyAppDeclaration(appDeclaration)
      ? {}
      : { declaration: appDeclaration };
  if (ui === null) {
    if (backend === null) throw new Error("App build has no UI or backend");
    return { format: "fungi-app-v1", backend, ...declared };
  }
  return backend === null
    ? { format: "fungi-app-v1", ui, ...declared }
    : { format: "fungi-app-v1", ui, backend, ...declared };
}

export {
  appCapabilityIdSchema,
  appDeclarationSchema,
  appDeclaredCommandSchema,
  appHandlerSchema,
  appRoleSchema,
  appStorageKeySchema,
  appStorageKeyNameSchema,
} from "./app-declaration.js";
export {
  appCapabilityIds,
  appHandlers,
  appRoles,
  appStorageScopes,
  emptyAppDeclaration,
  isEmptyAppDeclaration,
  resolveAppRoles,
} from "./app-vocabulary.js";
export type {
  AppBackendBinding,
  AppCapabilityId,
  AppDeclaration,
  AppDeclaredCommand,
  AppHandler,
  AppRole,
  AppStorageScope,
  AppStorageKey,
  EffectiveAppRole,
  RoleCandidate,
} from "./app-vocabulary.js";
export type {
  AppDescription,
  AppUi,
  ResolvedApp,
} from "./internal/app-release-contract.js";

export { appCallsSchema } from "./app-declaration.js";
