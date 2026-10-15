import * as Effect from "effect/Effect";

import type {
  ArtifactRef,
  ArtifactVerificationIntent,
  ImmutableArtifactBytes,
  Sha256Digest,
  VerifiedArtifactRead,
} from "./app-release-contract.js";
import type { AppReleaseArtifactReader } from "./app-release-artifact-reader.js";
import { decodeArtifactReadResult } from "./app-release-schema.js";
import { reportFailure } from "./failure.js";

/** Private, package-owned immutable artifact snapshot shape. */
export type VerifiedArtifactSnapshot = Omit<VerifiedArtifactRead, "kind">;

/** Trusted composition limit for reading one immutable artifact. */
export type ArtifactSnapshotPolicy = Readonly<{
  /** Maximum verified artifact size in bytes. */
  readonly maxBytes: number;
  readonly maxManifestBytes?: number;
}>;
export const DEFAULT_ARTIFACT_SNAPSHOT_POLICY: ArtifactSnapshotPolicy =
  Object.freeze({ maxBytes: 65_536 });
export function createArtifactSnapshotPolicy(
  maxBytes: number,
  maxManifestBytes?: number,
): ArtifactSnapshotPolicy {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error("Invalid artifact snapshot policy");
  if (
    maxManifestBytes !== undefined &&
    (!Number.isSafeInteger(maxManifestBytes) || maxManifestBytes < 1)
  )
    throw new Error("Invalid asset manifest policy");
  return Object.freeze(
    maxManifestBytes === undefined
      ? { maxBytes }
      : { maxBytes, maxManifestBytes },
  );
}

/** Closed reasons that an immutable artifact snapshot cannot be established. */
export type VerifiedArtifactSnapshotFailure =
  | { readonly kind: "unavailable" }
  | { readonly kind: "missing" }
  | { readonly kind: "digest-mismatch" }
  | { readonly kind: "invalid-snapshot"; readonly cause?: unknown };

/**
 * Read, decode, classify, and own one hostile artifact-reader result.
 *
 * Callers receive only a bounded immutable snapshot or this closed internal
 * failure vocabulary. Publication may request complete asset verification;
 * ordinary delivery leaves that work to the requested-object handler. Reader
 * and schema details do not escape this module.
 */
export function readVerifiedArtifactSnapshot(
  artifactReader: AppReleaseArtifactReader,
  input: {
    readonly artifactRef: ArtifactRef;
    readonly expectedDigest: Sha256Digest;
    readonly expectedObject?: {
      readonly version: string;
      readonly byteLength: number;
    };
    readonly verification?: ArtifactVerificationIntent;
  },
  policy: ArtifactSnapshotPolicy = DEFAULT_ARTIFACT_SNAPSHOT_POLICY,
): Effect.Effect<VerifiedArtifactSnapshot, VerifiedArtifactSnapshotFailure> {
  return artifactReader.read(input).pipe(
    Effect.mapError(() => artifactFailure("unavailable")),
    Effect.flatMap((raw) =>
      decodeArtifactReadResult(raw).pipe(
        Effect.mapError(() => artifactFailure("invalid-snapshot")),
        Effect.flatMap((result) => {
          switch (result.kind) {
            case "unavailable":
              return Effect.fail(artifactFailure("unavailable"));
            case "missing":
              return Effect.fail(artifactFailure("missing"));
            case "digest-mismatch":
              return Effect.fail(artifactFailure("digest-mismatch"));
            case "verified": {
              if (result.digest !== input.expectedDigest) {
                return Effect.fail(artifactFailure("digest-mismatch"));
              }

              let snapshot: VerifiedArtifactSnapshot | undefined;
              try {
                snapshot = createVerifiedArtifactSnapshot(result, policy);
              } catch (cause) {
                reportFailure("copy verified artifact snapshot", cause);
                return Effect.fail(artifactFailure("invalid-snapshot", cause));
              }
              return snapshot === undefined
                ? Effect.fail(artifactFailure("invalid-snapshot"))
                : Effect.succeed(snapshot);
            }
          }
        }),
      ),
    ),
  );
}

/**
 * Copy hostile verified bytes into the package-owned immutable snapshot.
 *
 * Undefined means that the foreign result could not satisfy the fixed A1
 * snapshot bounds. The returned closure only retains the owned copy.
 */
function createVerifiedArtifactSnapshot(
  input: {
    readonly digest: Sha256Digest;
    readonly mediaType: VerifiedArtifactRead["mediaType"];
    readonly bytes: ImmutableArtifactBytes;
    readonly byteLength: number;
  },
  policy: ArtifactSnapshotPolicy,
): VerifiedArtifactSnapshot | undefined {
  const isManifest =
    input.mediaType === "application/vnd.fungi.app-assets+json" ||
    input.mediaType === "application/vnd.fungi.app+json";
  const maxBytes = isManifest
    ? (policy.maxManifestBytes ?? policy.maxBytes)
    : policy.maxBytes;
  if (
    !Number.isInteger(input.byteLength) ||
    input.byteLength < 1 ||
    input.byteLength > maxBytes
  ) {
    return undefined;
  }

  const bytes = input.bytes;
  if (bytes.byteLength !== input.byteLength) {
    return undefined;
  }

  const foreignCopy = bytes.copy();
  if (
    !(foreignCopy instanceof Uint8Array) ||
    foreignCopy.byteLength !== input.byteLength
  ) {
    return undefined;
  }

  const ownedBytes = new Uint8Array(input.byteLength);
  ownedBytes.set(foreignCopy);
  return {
    digest: input.digest,
    mediaType: input.mediaType,
    byteLength: ownedBytes.byteLength,
    bytes: {
      byteLength: ownedBytes.byteLength,
      copy: () => ownedBytes.slice(),
    },
  };
}

function artifactFailure(
  kind: VerifiedArtifactSnapshotFailure["kind"],
  cause?: unknown,
): VerifiedArtifactSnapshotFailure {
  return cause === undefined ? { kind } : { kind, cause };
}
