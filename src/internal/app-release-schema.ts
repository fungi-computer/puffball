import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { appDeclarationSchema } from "../app-declaration.js";
import { emptyAppDeclaration } from "../app-vocabulary.js";
import { defineIdFamily } from "@fungi.computer/cairn/id";

import type {
  AppId,
  AppTransitionId,
  ArtifactRef,
  ImmutableArtifactBytes,
  IdempotencyKey,
  PublicSurfaceId,
  ReleaseId,
  Sha256Digest,
  SourceRevision,
  StableRoute,
} from "./app-release-contract.js";

function isAppId(input: string): input is AppId {
  return /^app_[a-z0-9]{1,63}$/u.test(input);
}

function isReleaseId(input: string): input is ReleaseId {
  return /^rel_[a-z0-9]{1,63}$/u.test(input);
}

function isPublicSurfaceId(input: string): input is PublicSurfaceId {
  return /^ps_[a-z0-9]{1,63}$/u.test(input);
}

function isArtifactRef(input: string): input is ArtifactRef {
  return /^artifact:[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u.test(input);
}

function isIdempotencyKey(input: string): input is IdempotencyKey {
  return /^idem_[a-z0-9](?:[a-z0-9_-]{0,126}[a-z0-9])?$/u.test(input);
}

function isSourceRevision(input: string): input is SourceRevision {
  return /^git:[0-9a-f]{40}$/u.test(input);
}

function isSha256Digest(input: string): input is Sha256Digest {
  return /^sha256:[0-9a-f]{64}$/u.test(input);
}

function isStableRoute(input: string): input is StableRoute {
  return /^\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(input);
}

const appReleaseIdFamily = defineIdFamily({
  family: "app-release",
  version: 1,
  kinds: {
    transition: { prefix: "app_transition" },
    surface: { prefix: "ps" },
    erasure: { prefix: "app_erasure" },
  },
});

/** Cairn owns the App transition identity grammar and parser. */
export const appTransitionIdCodec = appReleaseIdFamily.transition;
export const appSurfaceIdCodec = appReleaseIdFamily.surface;
export const appErasureIdCodec = appReleaseIdFamily.erasure;

/** Canonical Effect Schema for one Global App identifier. */
export const appIdSchema = Schema.String.pipe(Schema.refine(isAppId));

/** Canonical Effect Schema for one immutable Release identifier. */
export const releaseIdSchema = Schema.String.pipe(Schema.refine(isReleaseId));

/** Canonical Effect Schema for one anonymous public-Surface identifier. */
export const publicSurfaceIdSchema = Schema.String.pipe(
  Schema.refine(isPublicSurfaceId),
);

/** Canonical Effect Schema for one bounded artifact reference. */
export const artifactRefSchema = Schema.String.pipe(
  Schema.refine(isArtifactRef),
);

/** Canonical Effect Schema for one caller-provided idempotency key. */
export const idempotencyKeySchema = Schema.String.pipe(
  Schema.refine(isIdempotencyKey),
);

/** Canonical Effect Schema for one pinned lowercase Git source revision. */
export const sourceRevisionSchema = Schema.String.pipe(
  Schema.refine(isSourceRevision),
);

/** Canonical Effect Schema for one lowercase SHA-256 digest. */
export const sha256DigestSchema = Schema.String.pipe(
  Schema.refine(isSha256Digest),
);

/** Canonical Effect Schema for one canonical local stable route. */
export const stableRouteSchema = Schema.String.pipe(
  Schema.refine(isStableRoute),
);

const immutableArtifactBytesSchema = Schema.Struct({
  byteLength: Schema.Number,
  copy: Schema.instanceOf(Function),
}).pipe(
  Schema.refine(
    (input): input is typeof input & ImmutableArtifactBytes =>
      input.byteLength >= 0,
  ),
);

/** Canonical Effect Schema for a Global App record. */
export const appSchema = Schema.Struct({ appId: appIdSchema });

/** Canonical Effect Schema for immutable source and build provenance. */
export const artifactProvenanceSchema = Schema.Struct({
  sourceRevision: sourceRevisionSchema,
  sourceTreeDigest: sha256DigestSchema,
  buildRecipeDigest: sha256DigestSchema,
});

/** Canonical Effect Schema for immutable artifact identity and provenance. */
export const releaseArtifactSchema = Schema.Struct({
  artifactRef: artifactRefSchema,
  artifactDigest: sha256DigestSchema,
  provenance: artifactProvenanceSchema,
});

/** Canonical Effect Schema for one immutable App Release. */
export const releaseSchema = Schema.Struct({
  releaseId: releaseIdSchema,
  appId: appIdSchema,
  artifact: releaseArtifactSchema,
});

/** Canonical Effect Schema for one App-owned anonymous public Surface. */
export const publicSurfaceSchema = Schema.Struct({
  publicSurfaceId: publicSurfaceIdSchema,
  appId: appIdSchema,
  stableRoute: stableRouteSchema,
});

const publicationIdentitySchema = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256)),
);

const publicSurfaceDefinitionSchema = Schema.Struct({
  ...publicSurfaceSchema.fields,
  publisher: Schema.Struct({
    kind: Schema.Literals(["customer", "platform"]),
    teamId: publicationIdentitySchema,
    userId: publicationIdentitySchema,
    requestKey: publicationIdentitySchema,
  }),
});

/** Supported immutable artifact representation formats at the storage boundary. */
export const artifactMediaTypeSchema = Schema.Literals([
  "text/html; charset=utf-8",
  "application/vnd.fungi.app-backend+json",
  "application/vnd.fungi.app-assets+json",
  "application/vnd.fungi.app+json",
]);

const verifiedAppArtifactReferenceSchema = Schema.Struct({
  artifactRef: artifactRefSchema,
  digest: sha256DigestSchema,
  mediaType: Schema.Literals([
    "text/html; charset=utf-8",
    "application/vnd.fungi.app-backend+json",
    "application/vnd.fungi.app-assets+json",
  ]),
  version: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  byteLength: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThan(0)),
    Schema.check(Schema.makeFilter(Number.isSafeInteger)),
  ),
});

const verifiedBackendProfileSchema = Schema.Struct({
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
});

/** Canonical persisted metadata derived only by App artifact verification. */
export const verifiedAppDescriptionSchema = Schema.Struct({
  format: Schema.Literal("fungi-app-v1"),
  ui: Schema.NullOr(verifiedAppArtifactReferenceSchema),
  backend: Schema.NullOr(
    Schema.Struct({
      artifact: verifiedAppArtifactReferenceSchema,
      profile: verifiedBackendProfileSchema,
    }),
  ),
  // Metadata verified before declarations existed requested nothing.
  declaration: appDeclarationSchema.pipe(
    Schema.withDecodingDefaultType(Effect.succeed(emptyAppDeclaration)),
  ),
});

/** Canonical Effect Schema for a verified immutable artifact snapshot. */
export const verifiedArtifactReadSchema = Schema.Struct({
  kind: Schema.Literal("verified"),
  digest: sha256DigestSchema,
  mediaType: artifactMediaTypeSchema,
  bytes: immutableArtifactBytesSchema,
  byteLength: Schema.Number,
});

/** Canonical Effect Schema for the complete hostile artifact-reader result. */
export const artifactReadResultSchema = Schema.Union([
  verifiedArtifactReadSchema,
  Schema.Struct({ kind: Schema.Literal("unavailable") }),
  Schema.Struct({ kind: Schema.Literal("missing") }),
  Schema.Struct({
    kind: Schema.Literal("digest-mismatch"),
    actualDigest: sha256DigestSchema,
  }),
]);

/** Canonical Effect Schema for one explicit App lookup result. */
export const appReadSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("found"), app: appSchema }),
  Schema.Struct({ kind: Schema.Literal("absent") }),
]);

/** Canonical Effect Schema for one explicit App create-or-observe result. */
export const appCreateSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("created"), app: appSchema }),
  Schema.Struct({ kind: Schema.Literal("existing"), app: appSchema }),
]);

/** Canonical Effect Schema for one explicit Release lookup result. */
export const releaseReadSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("found"), release: releaseSchema }),
  Schema.Struct({ kind: Schema.Literal("absent") }),
]);

/** Canonical Effect Schema for one explicit Release create-or-observe result. */
export const releaseCreateSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("created"), release: releaseSchema }),
  Schema.Struct({ kind: Schema.Literal("existing"), release: releaseSchema }),
]);

/** Canonical Effect Schema for one explicit public-Surface lookup result. */
export const publicSurfaceReadSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("found"),
    surface: publicSurfaceSchema,
  }),
  Schema.Struct({ kind: Schema.Literal("absent") }),
]);

/** Canonical Effect Schema for one public-Surface create-or-observe result. */
export const publicSurfaceCreateSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("created"),
    surface: publicSurfaceSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("existing"),
    surface: publicSurfaceSchema,
  }),
  Schema.Struct({ kind: Schema.Literal("conflict") }),
]);

/** Canonical Effect Schema for a verified/unverified Release fact. */
export const releaseVerificationSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("verified"),
    digest: sha256DigestSchema,
    mediaType: Schema.Literal("application/vnd.fungi.app+json"),
    description: verifiedAppDescriptionSchema,
  }),
  Schema.Struct({ kind: Schema.Literal("unverified") }),
]);

/** Canonical Effect Schema for a live/revoked Release fact. */
export const releaseRevocationSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("active") }),
  Schema.Struct({ kind: Schema.Literal("revoked") }),
]);

/** Canonical Effect Schema for one owner-issued transition command. */
export const releaseTransitionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("promotion"),
    publicSurfaceId: publicSurfaceIdSchema,
    releaseId: releaseIdSchema,
    idempotencyKey: idempotencyKeySchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("rollback"),
    publicSurfaceId: publicSurfaceIdSchema,
    releaseId: releaseIdSchema,
    idempotencyKey: idempotencyKeySchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("revocation"),
    releaseId: releaseIdSchema,
    idempotencyKey: idempotencyKeySchema,
  }),
]);

/** The sole Effect Schema wrapper around Cairn's transition codec parser. */
export const appTransitionIdSchema = Schema.declare<AppTransitionId>(
  (input): input is AppTransitionId =>
    appTransitionIdCodec.schema.safeParse(input).success,
);

/** Canonical Effect Schema for a terminal owner-issued transition receipt. */
export const transitionReceiptSchema = Schema.Struct({
  transition: releaseTransitionSchema,
  transitionId: appTransitionIdSchema,
});

const releaseSelectionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("selected"),
    releaseId: releaseIdSchema,
  }),
]);

/** Canonical Effect Schema for durable Release lifecycle facts. */
export const releaseLifecycleSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("found"),
    release: releaseSchema,
    verification: releaseVerificationSchema,
    revocation: releaseRevocationSchema,
  }),
  Schema.Struct({ kind: Schema.Literal("absent") }),
]);

/** Canonical Effect Schema for durable public-Surface selection facts. */
export const publicSurfaceLifecycleSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("found"),
    surface: publicSurfaceSchema,
    selection: releaseSelectionSchema,
  }),
  Schema.Struct({ kind: Schema.Literal("absent") }),
]);

/** Canonical Effect Schema for an operation-scoped receipt lookup. */
export const transitionLookupSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("absent") }),
  Schema.Struct({
    kind: Schema.Literal("found"),
    receipt: transitionReceiptSchema,
  }),
  Schema.Struct({ kind: Schema.Literal("conflict") }),
]);

/** Canonical Effect Schema for atomic transition persistence. */
export const transitionPersistenceSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("created"),
    receipt: transitionReceiptSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("existing"),
    receipt: transitionReceiptSchema,
  }),
  Schema.Struct({ kind: Schema.Literal("conflict") }),
  Schema.Struct({ kind: Schema.Literal("identity-collision") }),
  Schema.Struct({ kind: Schema.Literal("lifecycle-conflict") }),
]);

/** Canonical Effect Schema for recording one verified Release artifact. */
const releaseVerificationRecordSchema = Schema.Struct({
  kind: Schema.Literal("recorded"),
});

/** Canonical Effect Schema for a closed App Release store infrastructure failure. */
export const appReleaseStoreFailureSchema = Schema.Struct({
  kind: Schema.Literal("unavailable"),
});

function storeResultSchema<Value, Input>(value: Schema.Codec<Value, Input>) {
  return Schema.Union([
    Schema.Struct({ kind: Schema.Literal("success"), value }),
    Schema.Struct({
      kind: Schema.Literal("failure"),
      failure: appReleaseStoreFailureSchema,
    }),
  ]);
}

/** Canonical Effect Schema for a closed App-read store result envelope. */
export const appReadStoreResultSchema = storeResultSchema(appReadSchema);

/** Canonical Effect Schema for a closed App-create store result envelope. */
export const appCreateStoreResultSchema = storeResultSchema(appCreateSchema);

/** Canonical Effect Schema for a closed Release-read store result envelope. */
export const releaseReadStoreResultSchema =
  storeResultSchema(releaseReadSchema);

/** Canonical Effect Schema for a closed Release-create store result envelope. */
export const releaseCreateStoreResultSchema =
  storeResultSchema(releaseCreateSchema);

/** Canonical Effect Schema for a closed public-Surface-read store result envelope. */
export const publicSurfaceReadStoreResultSchema = storeResultSchema(
  publicSurfaceReadSchema,
);

/** Canonical Effect Schema for a closed public-Surface-create store result envelope. */
export const publicSurfaceCreateStoreResultSchema = storeResultSchema(
  publicSurfaceCreateSchema,
);
/** Canonical Effect Schema for a Release lifecycle store result envelope. */
export const releaseLifecycleStoreResultSchema = storeResultSchema(
  releaseLifecycleSchema,
);

/** Canonical Effect Schema for a Release verification record result envelope. */
export const releaseVerificationRecordStoreResultSchema = storeResultSchema(
  releaseVerificationRecordSchema,
);

/** Canonical Effect Schema for a transition lookup store result envelope. */
export const transitionLookupStoreResultSchema = storeResultSchema(
  transitionLookupSchema,
);

/** Canonical Effect Schema for transition persistence store result envelope. */
export const transitionPersistenceStoreResultSchema = storeResultSchema(
  transitionPersistenceSchema,
);

/** Decode one Global App identifier through its canonical closed Effect Schema. */
export const decodeAppId = Schema.decodeUnknownResult(appIdSchema, {
  onExcessProperty: "error",
});

/** Decode one immutable Release identifier through its canonical closed Effect Schema. */
export const decodeReleaseId = Schema.decodeUnknownResult(releaseIdSchema, {
  onExcessProperty: "error",
});

/** Decode one public-Surface identifier through its canonical closed Effect Schema. */
export const decodePublicSurfaceId = Schema.decodeUnknownResult(
  publicSurfaceIdSchema,
  { onExcessProperty: "error" },
);

/** Decode one bounded artifact reference through its canonical closed Effect Schema. */
export const decodeArtifactRef = Schema.decodeUnknownResult(artifactRefSchema, {
  onExcessProperty: "error",
});

/** Decode one idempotency key through its canonical closed Effect Schema. */
export const decodeIdempotencyKey = Schema.decodeUnknownResult(
  idempotencyKeySchema,
  { onExcessProperty: "error" },
);

/** Decode one pinned source revision through its canonical closed Effect Schema. */
export const decodeSourceRevision = Schema.decodeUnknownResult(
  sourceRevisionSchema,
  { onExcessProperty: "error" },
);

/** Decode one SHA-256 digest through its canonical closed Effect Schema. */
export const decodeSha256Digest = Schema.decodeUnknownResult(
  sha256DigestSchema,
  { onExcessProperty: "error" },
);

/** Decode one local stable route through its canonical closed Effect Schema. */
export const decodeStableRoute = Schema.decodeUnknownResult(stableRouteSchema, {
  onExcessProperty: "error",
});

/** Decode a Cairn-issued App transition identity through its sole wrapper. */
export const decodeAppTransitionId = Schema.decodeUnknownResult(
  appTransitionIdSchema,
  { onExcessProperty: "error" },
);

/** Decode a hostile artifact-reader result through its canonical closed schema. */
export const decodeArtifactReadResult = Schema.decodeUnknownEffect(
  artifactReadResultSchema,
  { onExcessProperty: "error" },
);

/** Decode a hostile App record through its canonical closed schema. */
export const decodeApp = Schema.decodeUnknownResult(appSchema, {
  onExcessProperty: "error",
});

/** Decode a hostile Release record through its canonical closed schema. */
export const decodeRelease = Schema.decodeUnknownResult(releaseSchema, {
  onExcessProperty: "error",
});

/** Decode a hostile public Surface through its canonical closed schema. */
export const decodePublicSurface = Schema.decodeUnknownResult(
  publicSurfaceSchema,
  { onExcessProperty: "error" },
);

export const decodePublicSurfaceDefinition = Schema.decodeUnknownResult(
  publicSurfaceDefinitionSchema,
  { onExcessProperty: "error" },
);

/** Decode a hostile App-read store result through its canonical closed schema. */
export const decodeAppReadStoreResult = Schema.decodeUnknownResult(
  appReadStoreResultSchema,
  { onExcessProperty: "error" },
);

/** Decode a hostile App-create store result through its canonical closed schema. */
export const decodeAppCreateStoreResult = Schema.decodeUnknownResult(
  appCreateStoreResultSchema,
  { onExcessProperty: "error" },
);

/** Decode a hostile Release-read store result through its canonical closed schema. */
export const decodeReleaseReadStoreResult = Schema.decodeUnknownResult(
  releaseReadStoreResultSchema,
  { onExcessProperty: "error" },
);

/** Decode a hostile Release-create store result through its canonical closed schema. */
export const decodeReleaseCreateStoreResult = Schema.decodeUnknownResult(
  releaseCreateStoreResultSchema,
  { onExcessProperty: "error" },
);

/** Decode a hostile public-Surface-read store result through its canonical closed schema. */
export const decodePublicSurfaceReadStoreResult = Schema.decodeUnknownResult(
  publicSurfaceReadStoreResultSchema,
  { onExcessProperty: "error" },
);

/** Decode a hostile public-Surface-create store result through its canonical closed schema. */
export const decodePublicSurfaceCreateStoreResult = Schema.decodeUnknownResult(
  publicSurfaceCreateStoreResultSchema,
  { onExcessProperty: "error" },
);

/** Decode an owner-issued transition through its canonical closed schema. */
export const decodeReleaseTransition = Schema.decodeUnknownResult(
  releaseTransitionSchema,
  { onExcessProperty: "error" },
);

/** Decode a hostile Release lifecycle store result. */
export const decodeReleaseLifecycleStoreResult = Schema.decodeUnknownResult(
  releaseLifecycleStoreResultSchema,
  { onExcessProperty: "error" },
);

/** Decode a hostile verification-record store result. */
export const decodeReleaseVerificationRecordStoreResult =
  Schema.decodeUnknownResult(releaseVerificationRecordStoreResultSchema, {
    onExcessProperty: "error",
  });

/** Decode a hostile transition lookup store result. */
export const decodeTransitionLookupStoreResult = Schema.decodeUnknownResult(
  transitionLookupStoreResultSchema,
  { onExcessProperty: "error" },
);

/** Decode a hostile transition-persistence store result. */
export const decodeTransitionPersistenceStoreResult =
  Schema.decodeUnknownResult(transitionPersistenceStoreResultSchema, {
    onExcessProperty: "error",
  });
