import * as Effect from "effect/Effect";

import type {
  ArtifactRef,
  ArtifactVerificationIntent,
  Sha256Digest,
} from "./app-release-contract.js";

/** Closed infrastructure failure at the hostile artifact-reader boundary. */
export type AppReleaseArtifactReaderUnavailable = {
  readonly kind: "unavailable";
};

/**
 * Effect-native artifact reader port.
 *
 * A reader result is hostile until the App Release core decodes it through its
 * canonical schema. This port owns the only direct unknown success value.
 */
export type AppReleaseArtifactReader = {
  /** Resolve one stored artifact reference for its expected immutable digest. */
  read(input: {
    readonly artifactRef: ArtifactRef;
    readonly expectedDigest: Sha256Digest;
    /** Native version and size of a child named by a verified App root. */
    readonly expectedObject?: {
      readonly version: string;
      readonly byteLength: number;
    };
    /** Publication additionally verifies every object named by an asset manifest. */
    readonly verification?: ArtifactVerificationIntent;
  }): Effect.Effect<unknown, AppReleaseArtifactReaderUnavailable>;
};
