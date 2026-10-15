import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  appBuildJsonSchema,
  appDeclarationSchema,
  createAppBuild,
  emptyAppDeclaration,
  isEmptyAppDeclaration,
} from "../src/app.js";

describe("App storage declaration", () => {
  it("requires declared keys for storage bindings, with mutation scope enforced by the caller", () => {
    const decode = Schema.decodeUnknownSync(appDeclarationSchema);
    const binding = {
      ...emptyAppDeclaration,
      capabilities: ["app.storage"],
      backend: { bindings: [{ name: "APP_STORAGE", operations: ["read"] }] },
    };
    for (const declaration of [binding, { ...binding, storage: [] }])
      expect(() => decode(declaration)).toThrow(
        "App storage bindings require declared keys",
      );
    const teamKey = [{ key: "desktop", scopes: ["team"], maxBytes: 16384 }];
    expect(decode({ ...binding, storage: teamKey }).storage).toEqual(teamKey);
    for (const operation of ["write", "reset"])
      expect(
        decode({
          ...binding,
          storage: teamKey,
          backend: {
            bindings: [{ name: "APP_STORAGE", operations: [operation] }],
          },
        }).storage,
      ).toEqual(teamKey);
    const storage = [
      { key: "desktop", scopes: ["team", "member"], maxBytes: 16384 },
    ];
    expect(decode({ ...binding, storage }).storage).toEqual(storage);
    expect(() => decode({ ...binding, storage, capabilities: [] })).toThrow(
      "Backend bindings require declared App capabilities",
    );
  });
  it("admits Inkcap's Team-only lifecycle marker without a member key", () => {
    const declaration = {
      ...emptyAppDeclaration,
      capabilities: ["app.storage"],
      storage: [{ key: "repo-changed", scopes: ["team"], maxBytes: 1024 }],
      backend: {
        bindings: [
          { name: "APP_STORAGE", operations: ["read", "write", "reset"] },
        ],
      },
    };
    expect(Schema.decodeUnknownSync(appDeclarationSchema)(declaration)).toEqual(
      declaration,
    );
  });
  it("retains storage-only declarations in the digest-covered root", () => {
    const declaration = Schema.decodeUnknownSync(appDeclarationSchema)({
      ...emptyAppDeclaration,
      storage: [
        { key: "desktop", scopes: ["team", "member"], maxBytes: 16384 },
      ],
    });
    expect(declaration).toEqual({
      ...emptyAppDeclaration,
      storage: [
        { key: "desktop", scopes: ["team", "member"], maxBytes: 16384 },
      ],
    });
    expect(isEmptyAppDeclaration(declaration)).toBe(false);
    const build = Schema.decodeUnknownSync(appBuildJsonSchema)(
      JSON.stringify({
        format: "fungi-app-v1",
        ui: {
          artifactRef: "artifact:desktop.ui",
          digest: `sha256:${"a".repeat(64)}`,
          version: "ui-v1",
          byteLength: 1,
          mediaType: "text/html; charset=utf-8",
        },
      }),
    );
    if (!("ui" in build)) throw new Error("UI fixture must have a UI");
    const root = createAppBuild(build.ui, null, declaration);
    const encode = Schema.encodeSync(appBuildJsonSchema);
    const digest = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    expect(root.declaration).toEqual(declaration);
    expect(digest(encode(root))).not.toBe(digest(encode(build)));
    expect(Schema.decodeUnknownSync(appBuildJsonSchema)(encode(root))).toEqual(
      root,
    );
  });
  it.each([
    { key: "Desktop", scopes: ["team"], maxBytes: 16 },
    { key: "x".repeat(65), scopes: ["team"], maxBytes: 16 },
    { key: "../desktop", scopes: ["team"], maxBytes: 16 },
    { key: "desktop", scopes: [], maxBytes: 16 },
    { key: "desktop", scopes: ["global"], maxBytes: 16 },
    { key: "desktop", scopes: ["member", "member"], maxBytes: 16 },
    { key: "desktop", scopes: ["team"], maxBytes: 65537 },
    { key: "desktop", scopes: ["team"], maxBytes: 0 },
    { key: "desktop", scopes: ["team"], maxBytes: 1.5 },
    { key: "desktop", scopes: ["team"], maxBytes: 16, memberId: "forged" },
  ])("refuses an invalid storage entry: %j", (entry) => {
    expect(() =>
      Schema.decodeUnknownSync(appDeclarationSchema)({
        ...emptyAppDeclaration,
        storage: [entry],
      }),
    ).toThrow();
  });

  it("bounds and uniquely names keys, while allowing an empty declaration", () => {
    const decode = Schema.decodeUnknownSync(appDeclarationSchema);
    const keys = Array.from({ length: 16 }, (_, index) => ({
      key: `key-${String(index)}`,
      scopes: ["member"],
      maxBytes: 65536,
    }));
    expect(decode({ ...emptyAppDeclaration, storage: keys })).toMatchObject({
      storage: keys,
    });
    expect(() =>
      decode({
        ...emptyAppDeclaration,
        storage: [...keys, { ...keys[0], key: "seventeen" }],
      }),
    ).toThrow();
    expect(() =>
      decode({ ...emptyAppDeclaration, storage: [keys[0], keys[0]] }),
    ).toThrow();
    expect(
      isEmptyAppDeclaration(decode({ ...emptyAppDeclaration, storage: [] })),
    ).toBe(true);
  });
});
