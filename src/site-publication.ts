import * as Schema from "effect/Schema";
import {
  publicSurfaceIdSchema,
  sha256DigestSchema,
} from "./internal/app-release-schema.js";

/** Bounds of captured, already-built Computer output; runtime policy may be stricter. */
export const sitePublicationLimits = {
  files: 2_000,
  totalBytes: 25 * 1024 * 1024,
  fileBytes: 5 * 1024 * 1024,
} as const;

/** Team-local Site name, separate from its opaque route and identity. */
export const siteNameSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9._-]{1,128}$/u),
);
/** Visibility vocabulary; admission can refuse modes not yet served. */
export const siteVisibilitySchema = Schema.Literals([
  "public",
  "unlisted",
  "private",
]);

/** Artifact-local names are relative POSIX paths, never filesystem paths or URLs. */
export const siteFilePathSchema = Schema.String.check(
  Schema.makeFilter(
    (path) =>
      path.length > 0 &&
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !/\p{Cc}/u.test(path) &&
      path
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
  ),
);
const staticExtensions = new Set([
  "html",
  "css",
  "js",
  "mjs",
  "json",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "ico",
  "woff2",
  "wasm",
  "txt",
  "xml",
  "webmanifest",
  "map",
]);
/** Static media vocabulary; executable server sources never enter a folder bundle. */
export function isStaticSitePath(path: string): boolean {
  return staticExtensions.has(path.split(".").at(-1)?.toLowerCase() ?? "");
}
const object = {
  digest: sha256DigestSchema,
  byteLength: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(sitePublicationLimits.fileBytes),
  ),
};
/** Closed captured output with file-count, byte and static-media bounds. */
export const siteBundleSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("static"),
    files: Schema.Array(
      Schema.Struct({
        path: siteFilePathSchema.check(Schema.makeFilter(isStaticSitePath)),
        ...object,
      }),
    ).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(sitePublicationLimits.files),
      Schema.makeFilter(
        (files) =>
          files.some((file) => file.path === "index.html") &&
          new Set(files.map((file) => file.path)).size === files.length &&
          files.reduce((sum, file) => sum + file.byteLength, 0) <=
            sitePublicationLimits.totalBytes,
      ),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("worker"),
    entry: Schema.Struct(object),
  }),
]);
/** Captured output references inside the admitted Team content namespace. */
export type SiteBundle = Schema.Schema.Type<typeof siteBundleSchema>;

/** Domain request after the Agent has uploaded content-addressed objects. */
export const sitePublicationRequestSchema = Schema.Struct({
  requestId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
  ),
  name: siteNameSchema,
  intentDigest: sha256DigestSchema,
  visibility: siteVisibilitySchema,
  bundle: siteBundleSchema,
});
/** Parsed publication request, without host principal or quota fields. */
export type SitePublicationRequest = Schema.Schema.Type<
  typeof sitePublicationRequestSchema
>;
/** Retry lookup and capacity admission identify the Site without waking its Computer. */
export const sitePublicationReceiptRequestSchema = Schema.Struct({
  name: siteNameSchema,
  requestId: sitePublicationRequestSchema.fields.requestId,
  intentDigest: sha256DigestSchema,
});
/** Site name, publication request key and captured tool-intent digest. */
export type SitePublicationReceiptRequest = Schema.Schema.Type<
  typeof sitePublicationReceiptRequestSchema
>;

/** Closed rejection vocabulary for publication and retry lookup. */
export const sitePublicationCodes = [
  "denied",
  "invalid",
  "too_large",
  "conflict",
  "limit",
  "unavailable",
  "private_unavailable",
] as const;
/** One publication rejection code. */
export type SitePublicationCode = (typeof sitePublicationCodes)[number];
/** Typed internal failure closed to a plain RPC rejection at the host boundary. */
export class SitePublicationError extends Schema.TaggedError<SitePublicationError>()(
  "SitePublicationError",
  { code: Schema.Literals(sitePublicationCodes) },
) {}
/** Published immutable Release receipt or a closed rejection. */
export type SitePublicationResult =
  | Readonly<{
      kind: "published";
      siteId: string;
      url: string;
      visibility: "public" | "unlisted";
      releaseId: string;
    }>
  | Readonly<{ kind: "rejected"; code: SitePublicationCode }>;

/** Host-only additions: no tool input may choose Team, actor or quota. */
export type AdmittedSitePublication = SitePublicationRequest &
  Readonly<{
    teamId: string;
    actorId: string;
    siteLimit: number;
  }>;

/** Site reads remain scoped to the Team selected by the trusted door. */
export const siteReadRequestSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("list") }),
  Schema.Struct({ kind: Schema.Literal("get"), siteId: publicSurfaceIdSchema }),
]);
/** Team-scoped list or current Site lookup input. */
export type SiteReadRequest = Schema.Codec.Encoded<
  typeof siteReadRequestSchema
>;
const siteMutation = {
  requestId: sitePublicationRequestSchema.fields.requestId,
  siteId: publicSurfaceIdSchema,
};
/** A request id names one lifecycle intent; repeating unlisted with a new id rotates. */
export const siteMutationRequestSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("visibility"),
    ...siteMutation,
    visibility: siteVisibilitySchema,
  }),
  Schema.Struct({ kind: Schema.Literal("rotate"), ...siteMutation }),
  Schema.Struct({ kind: Schema.Literal("delete"), ...siteMutation }),
]);
/** One visibility, link rotation or deletion intent with its stable request key. */
export type SiteMutationRequest = Schema.Codec.Encoded<
  typeof siteMutationRequestSchema
>;
/** Member/Agent-facing projection; no storage keys, ciphertext or host credentials. */
export type SiteInfo = Readonly<{
  siteId: string;
  name: string;
  url: string;
  releaseId: string | null;
}> &
  (
    | Readonly<{ visibility: "public" }>
    | Readonly<{ visibility: "unlisted"; shareUrl: string }>
  );
/** Current admitted Site projections or one closed rejection. */
export type SiteReadResult =
  | Readonly<{ kind: "listed"; sites: readonly SiteInfo[] }>
  | Readonly<{ kind: "found"; site: SiteInfo }>
  | Extract<SitePublicationResult, { kind: "rejected" }>;
/** Current Site projection or deletion receipt after an admitted lifecycle intent. */
export type SiteMutationResult =
  | Readonly<{ kind: "updated"; site: SiteInfo }>
  | Readonly<{ kind: "deleted"; siteId: string }>
  | Extract<SitePublicationResult, { kind: "rejected" }>;
