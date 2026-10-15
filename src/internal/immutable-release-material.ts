import type { Release } from "./app-release-contract.js";

/** Compare every write-once fact carried by an immutable Release. */
export function sameImmutableReleaseMaterial(
  left: Release,
  right: Release,
): boolean {
  return (
    left.releaseId === right.releaseId &&
    left.appId === right.appId &&
    left.artifact.artifactRef === right.artifact.artifactRef &&
    left.artifact.artifactDigest === right.artifact.artifactDigest &&
    left.artifact.provenance.sourceRevision ===
      right.artifact.provenance.sourceRevision &&
    left.artifact.provenance.sourceTreeDigest ===
      right.artifact.provenance.sourceTreeDigest &&
    left.artifact.provenance.buildRecipeDigest ===
      right.artifact.provenance.buildRecipeDigest
  );
}
