import * as Schema from "effect/Schema";

import type { AppId, SourceRevision } from "./internal/app-release-contract.js";
import {
  appIdSchema,
  sourceRevisionSchema,
} from "./internal/app-release-schema.js";

const boundedIdentity = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256)),
);

/** Canonical source repository resolved by the product publisher. */
export const appSourceRepositorySchema = Schema.Struct({
  provider: Schema.Literals(["artifacts", "github"]),
  repository: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(1024)),
  ),
  branch: Schema.Literal("main"),
});

/** Team-owned publication authority for one separately registered App. */
export const teamAppPublisherRegistrationSchema = Schema.Struct({
  appId: appIdSchema,
  teamId: boundedIdentity,
  source: appSourceRepositorySchema,
  templateSeed: Schema.optionalKey(
    Schema.Struct({ appId: appIdSchema, revision: sourceRevisionSchema }),
  ),
});

/** Exact first-party platform seed from which a Team-owned App was forked. */
export type TeamAppTemplateSeed = Readonly<{
  appId: AppId;
  revision: SourceRevision;
}>;

/** Parsed immutable source location used to build one App. */
export type AppSourceRepository = Schema.Schema.Type<
  typeof appSourceRepositorySchema
>;
/** Parsed Team ownership record for one App publisher. */
export type TeamAppPublisherRegistration = Schema.Schema.Type<
  typeof teamAppPublisherRegistrationSchema
>;

/** Result of reading the durable publisher registered for an App. */
export type TeamAppPublisherRegistrationRead =
  | Readonly<{
      kind: "found";
      registration: TeamAppPublisherRegistration;
    }>
  | Readonly<{ kind: "absent" }>;

/** Idempotent result of registering one App publisher. */
export type TeamAppPublisherRegistrationCreate =
  | Readonly<{
      kind: "created" | "existing";
      registration: TeamAppPublisherRegistration;
    }>
  | Readonly<{ kind: "conflict" }>;

/** Team-scoped decision for publishing a registered App. */
export type TeamAppPublicationAuthorization =
  | Readonly<{
      kind: "authorized";
      registration: TeamAppPublisherRegistration;
    }>
  | Readonly<{ kind: "absent" | "denied" }>;

/** Durable App publisher facts; Team membership remains owned by Hub. */
export type TeamAppPublisherRegistry = Readonly<{
  /** Read the publisher registration for an App. */
  read(appId: AppId): Promise<TeamAppPublisherRegistrationRead>;
  /** Atomically create or observe one immutable publisher registration. */
  register(
    registration: TeamAppPublisherRegistration,
  ): Promise<TeamAppPublisherRegistrationCreate>;
  /** Authorize a Team against the App's retained publisher registration. */
  authorize(
    appId: AppId,
    teamId: string,
  ): Promise<TeamAppPublicationAuthorization>;
}>;
