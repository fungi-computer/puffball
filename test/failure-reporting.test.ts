import { inspect } from "node:util";
import * as Redacted from "effect/Redacted";
import { afterEach, expect, it, vi } from "vitest";
import { reportFailure } from "../src/internal/failure.js";

afterEach(() => vi.restoreAllMocks());

it("retains the original failure and nested cause behind redaction", () => {
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const nested = new Error("synthetic-private-nested-cause");
  const cause = new Error("synthetic-private-top-cause", { cause: nested });
  reportFailure("fixture operation", cause);
  const args = report.mock.calls[0];
  const retained: unknown = args?.[1];
  expect(Redacted.isRedacted(retained)).toBe(true);
  if (!Redacted.isRedacted(retained)) throw new Error("Missing redacted cause");
  expect(Redacted.value(retained)).toBe(cause);
  expect(cause.cause).toBe(nested);
  for (const rendered of [JSON.stringify(args), String(args), inspect(args)]) {
    expect(rendered).not.toContain(cause.message);
    expect(rendered).not.toContain(nested.message);
  }
});

it("retains non-Error thrown values without printing their contents", () => {
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const cause = { privateValue: "synthetic-private-value" };
  reportFailure("fixture operation", cause);
  const args = report.mock.calls[0];
  const retained: unknown = args?.[1];
  if (!Redacted.isRedacted(retained)) throw new Error("Missing redacted value");
  expect(Redacted.value(retained)).toBe(cause);
  expect(inspect(args)).not.toContain(cause.privateValue);
});
