import * as Schema from "effect/Schema";
import { expect, it } from "vitest";
import { appDeclarationSchema, emptyAppDeclaration } from "../src/app.js";

it("approvals is independently requestable in an App declaration", () => {
  const request = { ...emptyAppDeclaration, capabilities: ["approvals"] };
  expect(Schema.is(appDeclarationSchema)(request)).toBe(true);
  expect(
    Schema.decodeUnknownSync(appDeclarationSchema)(request).capabilities,
  ).toEqual(["approvals"]);
});
