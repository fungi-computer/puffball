import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { appDeclarationSchema, emptyAppDeclaration } from "../src/app.js";

describe("Declared member App calls", () => {
  it("refuses a call list without the apps.call capability", () => {
    expect(() =>
      Schema.decodeUnknownSync(appDeclarationSchema)({
        ...emptyAppDeclaration,
        calls: [{ appId: "app_bonsai", methods: ["files.read"] }],
      }),
    ).toThrow("App calls require apps.call");
  });
});

it("keeps a strict bounded allowlist rather than silently dropping unknown keys", () => {
  const declaration = {
    ...emptyAppDeclaration,
    capabilities: ["apps.call"],
    calls: [{ appId: "app_bonsai", methods: ["files.read"] }],
  };
  const decode = Schema.decodeUnknownSync(appDeclarationSchema);
  expect(decode(declaration)).toEqual(declaration);
  for (const calls of [
    [{ ...declaration.calls[0], extra: true }],
    [
      {
        appId: "app_bonsai",
        methods: Array.from(
          { length: 17 },
          (_, i) => `files.method${String(i)}`,
        ),
      },
    ],
    [declaration.calls[0], declaration.calls[0]],
    [{ appId: "app_bonsai", methods: ["files.read", "files.read"] }],
  ])
    expect(() => decode({ ...declaration, calls })).toThrow();
});

it("preserves the call allowlist in the published digest-covered declaration", () => {
  const calls = [
    { appId: "app_bonsai", methods: ["files.read", "files.save"] },
  ];
  const value = Schema.decodeUnknownSync(appDeclarationSchema)({
    ...emptyAppDeclaration,
    capabilities: ["apps.call"],
    calls,
  });
  expect(value.calls).toEqual(calls);
  const encode = Schema.encodeSync(appDeclarationSchema);
  expect(encode(value).calls).toEqual(calls);
});
