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

it("never throws, whichever accessor of the error throws", () => {
  const hostile = (property: "stack" | "name" | "cause" | "message") => {
    const failure = new Error("x");
    Object.defineProperty(failure, property, {
      get() {
        throw new Error("hostile getter");
      },
    });
    return failure;
  };
  for (const property of ["stack", "name", "cause", "message"] as const) {
    const chain = describeFailureChain(hostile(property));
    expect(chain.kind).toBe("error");
  }
  // The rest of the chain survives the one hostile read.
  expect(describeFailureChain(hostile("stack")).name).toBe("Error");
  // A throwing name also fails the stack header, so that error names no frame.
  expect(describeFailureChain(hostile("name")).thrownAt).toBeUndefined();
  const nested = new Error("outer", { cause: hostile("stack") });
  expect(describeFailureChain(nested).cause?.kind).toBe("error");
  // A throwing getter on the wrapped error cannot reject its reporter either.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect(() => {
    reportFailure("persist App Release operation", hostile("stack"));
  }).not.toThrow();
});

it("builds the stack header the built-in way, so a toString override cannot expose message lines", () => {
  for (const rendered of ["", "Error"]) {
    const failure = new Error(
      'bad "x\n    at user@example.com token=sk_live_ABC"',
    );
    failure.toString = () => rendered;
    const chain = describeFailureChain(failure);
    expect(JSON.stringify(chain)).not.toContain("user@example.com");
    expect(JSON.stringify(chain)).not.toContain("sk_live");
  }
});

it.each([
  ["Error", "Error"],
  ["AppInstanceError", "AppInstanceError"],
  ["Pg.Error$1", "Pg.Error$1"],
  ["user@example.com token=sk_live_ABC", undefined],
  ["", undefined],
  ["x".repeat(65), undefined],
])("bounds the logged class name %j", (name, expected) => {
  const failure = new Error("x");
  failure.name = name;
  expect(describeFailureChain(failure).name).toBe(expected);
});
