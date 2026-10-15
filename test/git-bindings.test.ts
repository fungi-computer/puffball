import * as Schema from "effect/Schema";
import { expect, it } from "vitest";
import {
  appBackendBindingsSchema,
  appBackendShardBindingsSchema,
  appBackendBindingOperation,
  appDeclarationSchema,
} from "../src/app.js";

it("admits only declared installation Git operations with their exact broker classes", () => {
  const expected = [
    ["create", "app.git.create", "write"],
    ["fork", "app.git.fork", "write"],
    ["read", "app.git.read", "read"],
    ["write", "app.git.write", "write"],
    ["exchange", "app.git.exchange", "write"],
  ] as const;
  const operations = expected.map(([operation]) => operation);
  const bindings = [{ name: "GIT", operations }];
  expect(Schema.decodeUnknownSync(appBackendBindingsSchema)(bindings)).toEqual(
    bindings,
  );
  const parse = Schema.decodeUnknownSync(appDeclarationSchema);
  expect(
    parse({
      capabilities: ["git.repository"],
      handlers: [],
      roles: [],
      backend: { bindings },
    }),
  ).toMatchObject({ backend: { bindings } });
  for (const [operation, cap, effect] of expected) {
    expect(appBackendBindingOperation("GIT", operation)).toEqual({
      cap,
      requires: ["git.repository"],
      effect,
    });
    expect(() =>
      parse({
        capabilities: [],
        handlers: [],
        roles: [],
        backend: { bindings: [{ name: "GIT", operations: [operation] }] },
      }),
    ).toThrow();
  }
  expect(() =>
    Schema.decodeUnknownSync(appBackendBindingsSchema)([
      { name: "GIT", operations: ["unknown"] },
    ]),
  ).toThrow();
  const shard = Schema.decodeUnknownSync(appBackendShardBindingsSchema);
  expect(
    shard([
      { name: "GIT", operations: [{ name: "read", cap: "app.git.read" }] },
    ]),
  ).toHaveLength(1);
  expect(() =>
    shard([
      { name: "GIT", operations: [{ name: "read", cap: "app.git.write" }] },
    ]),
  ).toThrow();
});

it("admits the declared event sink without granting unrelated host capabilities", () => {
  const bindings = [{ name: "EVENTS", operations: ["emit"] }];
  const parse = Schema.decodeUnknownSync(appDeclarationSchema);
  const declaration = parse({
    capabilities: ["app.events.emit"],
    handlers: [],
    roles: [],
    backend: { bindings },
  });
  expect(declaration).toMatchObject({ backend: { bindings } });
  expect(declaration.capabilities).toEqual(["app.events.emit"]);
  expect(() =>
    parse({ capabilities: [], handlers: [], roles: [], backend: { bindings } }),
  ).toThrow();
  expect(appBackendBindingOperation("EVENTS", "emit")).toEqual({
    cap: "app.events.emit",
    requires: ["app.events.emit"],
    effect: "write",
  });
  expect(() =>
    Schema.decodeUnknownSync(appBackendBindingsSchema)([
      { name: "EVENTS", operations: ["subscribe"] },
    ]),
  ).toThrow();
});
