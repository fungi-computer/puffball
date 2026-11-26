import * as Redacted from "effect/Redacted";
import { describeFailureChain } from "../failure-facts.js";

/**
 * Report a failed operation without exposing artifact or request contents. The
 * cause names its class, driver code, a closed category and where it was thrown,
 * never its message.
 */
export function reportFailure(operation: string, cause: unknown): void {
  console.error(
    JSON.stringify({
      event: "app_release_operation_failed",
      operation,
      causeKind: cause instanceof Error ? "error" : "non_error",
      cause: describeFailureChain(cause),
    }),
    Redacted.make(cause),
  );
}
