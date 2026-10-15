import * as Redacted from "effect/Redacted";

/** Report a failed operation without exposing artifact or request contents. */
export function reportFailure(operation: string, cause: unknown): void {
  console.error(
    JSON.stringify({
      event: "app_release_operation_failed",
      operation,
      causeKind: cause instanceof Error ? "error" : "non_error",
    }),
    Redacted.make(cause),
  );
}
