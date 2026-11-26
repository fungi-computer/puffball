import { afterEach, expect, it, vi } from "vitest";
import * as z from "zod";
import {
  describeFailureChain,
  describeFailureFacts,
} from "../src/failure-facts.js";
import { reportFailure } from "../src/internal/failure.js";

afterEach(() => vi.restoreAllMocks());

it("never reads a frame out of a multi-line message", () => {
  const chain = describeFailureChain(
    new Error('Invalid handle "x\n    at user@example.com token=sk_live_ABC"'),
  );
  expect(JSON.stringify(chain)).not.toContain("user@example.com");
  expect(JSON.stringify(chain)).not.toContain("sk_live");
  expect(chain.thrownAt).toContain("failure-facts.test");
});

it("names no frame when the stack does not open with the error's own header", () => {
  const failure = new Error("x");
  failure.stack = "something else\n    at secret (token=abc)";
  expect(describeFailureFacts(failure, true).thrownAt).toBeUndefined();
});

it.each([
  ["D1_ERROR: Network connection lost.", "reset"],
  [
    "D1 DB storage operation exceeded timeout which caused object to be reset.",
    "timeout",
  ],
  ["D1_ERROR: no such table: private", "missing_table"],
  [
    "D1_ERROR: UNIQUE constraint failed: private.value (SQLITE_CONSTRAINT)",
    "constraint",
  ],
])(
  "gives a D1 failure %j the closed category %s, without its text",
  (message, category) => {
    const chain = describeFailureChain(new Error(message));
    expect(chain.storageCategory).toBe(category);
    expect(JSON.stringify(chain)).not.toContain("private");
  },
);

it("says when the error had no message, and names its nested cause", () => {
  const chain = describeFailureChain(
    new Error("", {
      cause: Object.assign(new Error("x"), { code: "ECONNRESET" }),
    }),
  );
  expect(chain).toMatchObject({
    kind: "error",
    name: "Error",
    emptyMessage: true,
    cause: { kind: "error", errorCode: "ECONNRESET" },
  });
});

it("logs only a Node or SQLSTATE code", () => {
  const code = (value: string) =>
    describeFailureFacts(Object.assign(new Error("x"), { code: value }), true)
      .errorCode;
  expect(code("ECONNRESET")).toBe("ECONNRESET");
  expect(code("57P01")).toBe("57P01");
  expect(code("AKIAIOSFODNN7EXAMPLE")).toBeUndefined();
});

it("names a failed App Release store call by its category and frame, never its message", () => {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((line: string) => {
    lines.push(line);
  });
  reportFailure(
    "persist App Release operation",
    new Error("D1_ERROR: Network connection lost. private-artifact-body"),
  );
  const event = z
    .object({
      event: z.literal("app_release_operation_failed"),
      operation: z.string(),
      causeKind: z.string(),
      cause: z.object({
        name: z.string(),
        storageCategory: z.string(),
        thrownAt: z.string(),
      }),
    })
    .parse(JSON.parse(lines[0] ?? "{}"));
  expect(event.cause.storageCategory).toBe("reset");
  expect(event.cause.name).toBe("Error");
  expect(lines[0]).not.toContain("private-artifact-body");
});
