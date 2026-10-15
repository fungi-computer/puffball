import * as Effect from "effect/Effect";

import type { ArtifactReader } from "./app-release-contract.js";

import type {
  AppReleaseArtifactReader,
  AppReleaseArtifactReaderUnavailable,
} from "./app-release-artifact-reader.js";

/**
 * Adapt the Promise artifact-reader projection at the one outer edge.
 *
 * Successful values remain hostile until the core's canonical schema decodes
 * them. A rejected Promise is closed to the reader's unavailable failure.
 */
export function adaptPromiseArtifactReader(
  projection: ArtifactReader,
): AppReleaseArtifactReader {
  return {
    read: (input) =>
      Effect.tryPromise({
        try: () => projection.read(input),
        catch: unavailable,
      }),
  };
}

function unavailable(): AppReleaseArtifactReaderUnavailable {
  return { kind: "unavailable" };
}
