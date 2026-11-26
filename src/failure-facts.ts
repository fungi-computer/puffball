import * as z from "zod";

/** Diagnostic-only decoder for D1/SQLite's textual error representation.
 * It emits a closed category, never text; failures still reject unchanged. */
const storageCategorySchema = z
  .object({
    message: z
      .string()
      .transform((text) => text.slice(0, 512))
      .pipe(
        z.union([
          z
            .string()
            .regex(/timeout exceeded when trying to connect/iu)
            .transform(() => "pool_timeout"),
          z
            .string()
            .regex(/too many clients|remaining connection slots/iu)
            .transform(() => "too_many_connections"),
          z
            .string()
            .regex(/connection terminated|socket hang up|ECONNRESET/iu)
            .transform(() => "connection_lost"),
          z
            .string()
            .regex(/ECONNREFUSED|ENOTFOUND|EAI_AGAIN/iu)
            .transform(() => "unreachable"),
          z
            .string()
            .regex(/too many API requests|too many subrequests/iu)
            .transform(() => "request_limit"),
          z
            .string()
            .regex(
              /exceeded timeout|timed out|queued for too long|overloaded/iu,
            )
            .transform(() => "timeout"),
          z
            .string()
            .regex(/object to be reset|network connection lost|D1 DB reset/iu)
            .transform(() => "reset"),
          z
            .string()
            .regex(/no such column/iu)
            .transform(() => "missing_column"),
          z
            .string()
            .regex(/no such table/iu)
            .transform(() => "missing_table"),
          z
            .string()
            .regex(/SQLITE_CONSTRAINT|constraint failed/iu)
            .transform(() => "constraint"),
          z
            .string()
            .regex(/SQLITE_BUSY|database is locked/iu)
            .transform(() => "busy"),
          z
            .string()
            .regex(/SQLITE_TOOBIG|row too large|response too large/iu)
            .transform(() => "size_limit"),
          z
            .string()
            .regex(/CPU time limit/iu)
            .transform(() => "cpu_limit"),
          z
            .string()
            .regex(/D1_ERROR|SQLITE_ERROR/iu)
            .transform(() => "database_error"),
        ]),
      ),
  })
  .transform(({ message }) => message);

// Only the shapes a real driver sets: a Node system error (ECONNRESET) or a
// Postgres SQLSTATE (57P01). Any other `code` string is not ours to log.
const withCodeSchema = z.object({
  code: z.union([
    z.string().regex(/^E[A-Z0-9_]{2,31}$/u),
    z.string().regex(/^[0-9A-Z]{5}$/u),
  ]),
});
const emptyMessageSchema = z.object({ message: z.literal("") });
const frameLineSchema = z.string().regex(/^\s+at\s/u);

/**
 * The first stack frame ("fn (file:line:col)"). V8's stack opens with the
 * error's own `Name: message`, which can run over several lines, so frames are
 * read only after that exact header; a stack that does not start with it (a
 * runtime that formats it otherwise) names no frame. The query a bundler URL
 * may carry is cut.
 */
function thrownAt(cause: Error): string | undefined {
  const stack = cause.stack ?? "";
  const header = String(cause);
  if (!stack.startsWith(header)) return undefined;
  const frame = stack
    .slice(header.length)
    .split("\n")
    .find((line) => frameLineSchema.safeParse(line).success);
  return frame === undefined
    ? undefined
    : frame
        .trim()
        .replace(/^at\s+/u, "")
        .replace(/\?[^)\s:]*/gu, "")
        .slice(0, 160);
}

/** What a failure says about itself without its message: classes and places, never text. */
export type FailureFacts = {
  /** A closed category read from the message of a driver or storage error. */
  storageCategory?: string;
  /** A driver's own error code (ECONNRESET, a Postgres SQLSTATE), never text. */
  errorCode?: string;
  /** The error had no message at all, so there is nothing more to name. */
  emptyMessage?: true;
  /** Where it was thrown: the first stack frame, never the message. */
  thrownAt?: string;
};

/**
 * The facts of one error that are safe to write down: a closed category, the
 * driver's code, whether the message was empty and the throwing frame (the last
 * three only when `located`: an event that must name a bare failure). Callers
 * add the error's name and its nested cause.
 */
export function describeFailureFacts(
  cause: Error,
  located: boolean,
): FailureFacts {
  const facts: FailureFacts = {};
  const storage = storageCategorySchema.safeParse(cause);
  if (storage.success) facts.storageCategory = storage.data;
  if (!located) return facts;
  if (emptyMessageSchema.safeParse(cause).success) facts.emptyMessage = true;
  const code = withCodeSchema.safeParse(cause);
  if (code.success) facts.errorCode = code.data.code;
  const site = thrownAt(cause);
  if (site !== undefined) facts.thrownAt = site;
  return facts;
}

/** One error and its causes as an event may carry them: class, facts, nested cause. */
export type FailureChain = FailureFacts & {
  /** `error` for an Error, `non-error` for anything else thrown. */
  kind: "error" | "non-error";
  /** The error class, so a bare failure still says what kind it was. */
  name?: string;
  /** The error this one wraps, to three levels. */
  cause?: FailureChain;
};

/** {@link describeFailureFacts} for an error and its nested causes, always located. */
export function describeFailureChain(cause: unknown, depth = 0): FailureChain {
  if (!(cause instanceof Error)) return { kind: "non-error" };
  const chain: FailureChain = {
    kind: "error",
    name: cause.name,
    ...describeFailureFacts(cause, true),
  };
  if (cause.cause !== undefined && depth < 3)
    chain.cause = describeFailureChain(cause.cause, depth + 1);
  return chain;
}
