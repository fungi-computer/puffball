import type { ReleaseTransition } from "./app-release-contract.js";

/** Compare the durable material owned by one operation-scoped transition key. */
export function sameReleaseTransitionMaterial(
  left: ReleaseTransition,
  right: ReleaseTransition,
): boolean {
  if (
    left.kind !== right.kind ||
    left.idempotencyKey !== right.idempotencyKey ||
    left.releaseId !== right.releaseId
  ) {
    return false;
  }

  return (
    left.kind === "revocation" ||
    (right.kind !== "revocation" &&
      left.publicSurfaceId === right.publicSurfaceId)
  );
}
