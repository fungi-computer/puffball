import { expect, it } from "vitest";
import * as Schema from "effect/Schema";
import {
  parseAppMethodCallContext,
  isAppApiMethodName,
} from "../src/app-method-runtime.js";
import {
  appBackendBindingsSchema,
  appBackendShardBindingsSchema,
  appBackendBindingOperation,
  scopeOperationToMethod,
  appMethodCallContextSchema,
  appApiMethodNameSchema,
  appApiReservedMethodNames,
  appCapabilityIdSchema,
  appApiSchema,
  appDeclarationSchema,
} from "../src/app.js";

it("offers ordinary Computer execution without an App credential operation", () => {
  expect(
    appBackendBindingOperation("COMPUTER", "workflowGitPass"),
  ).toBeUndefined();
  expect(() =>
    Schema.decodeUnknownSync(appBackendBindingsSchema)([
      { name: "COMPUTER", operations: ["workflowGitPass"] },
    ]),
  ).toThrow();
  const bindings = [{ name: "COMPUTER", operations: ["exec", "processStart"] }];
  expect(Schema.decodeUnknownSync(appBackendBindingsSchema)(bindings)).toEqual(
    bindings,
  );
});

it("registers BACKGROUND admission for hosts while refusing App-declared bindings", () => {
  expect(appBackendBindingOperation("BACKGROUND", "admit")).toEqual({
    cap: "app.background.admit",
    requires: [],
    effect: "read",
  });
  expect(() =>
    Schema.decodeUnknownSync(appDeclarationSchema)({
      capabilities: [],
      handlers: [],
      roles: [],
      backend: { bindings: [{ name: "BACKGROUND", operations: ["admit"] }] },
    }),
  ).toThrow();
});

it("declares independent Workflow publish and arm permissions in the signed API", () => {
  const declaration = Schema.decodeUnknownSync(appDeclarationSchema)({
    capabilities: ["workflow.run", "workflow.publish", "workflow.arm"],
    handlers: [],
    roles: [],
  });
  expect(declaration.capabilities).toEqual([
    "workflow.run",
    "workflow.publish",
    "workflow.arm",
  ]);
  const api = Schema.decodeUnknownSync(appApiSchema)({
    methods: {
      publish: {
        description: "Publish a Workflow",
        effect: "write",
        requires: ["workflow.publish"],
        input: { type: "object" },
        output: { type: "object" },
      },
      arm: {
        description: "Arm a Workflow trigger",
        effect: "write",
        requires: ["workflow.arm"],
        input: { type: "object" },
        output: { type: "object" },
      },
    },
  });
  expect(api.methods.publish?.requires).toEqual(["workflow.publish"]);
  expect(api.methods.arm?.requires).toEqual(["workflow.arm"]);
});

it("preserves the host's role and Workflow arming actor through both caller ports", () => {
  const caller = {
    computerId: "computer-build",
    actor: { kind: "member", memberId: "owner-one" },
    role: "owner",
    workflow: {
      workflowId: "build-on-push",
      runId: "run-one",
      nodeId: "build",
      armedBy: { kind: "member", memberId: "owner-one" },
    },
  };
  expect(parseAppMethodCallContext(caller)).toEqual(caller);
  expect(parseAppMethodCallContext(caller, true)).toEqual(caller);
  expect(Schema.decodeUnknownSync(appMethodCallContextSchema)(caller)).toEqual(
    caller,
  );
});

it.each([
  { kind: "member", memberId: "member-one" },
  { kind: "agent", agentId: "agent-one" },
  { kind: "team-key", keyId: "key-one" },
])("retains the typed Workflow arming actor: $kind", (armedBy) => {
  const caller = {
    computerId: null,
    actor: armedBy,
    workflow: {
      workflowId: "workflow-one",
      runId: "run-one",
      nodeId: "review",
      armedBy,
    },
  };
  expect(parseAppMethodCallContext(caller, true)).toEqual(caller);
  expect(
    Schema.decodeUnknownSync(appMethodCallContextSchema, {
      onExcessProperty: "error",
    })(caller),
  ).toEqual(caller);
});

it("both caller ports refuse malformed host role and Workflow attribution", () => {
  const caller = {
    computerId: null,
    actor: { kind: "member", memberId: "member-one" },
  };
  const workflow = {
    workflowId: "workflow-one",
    runId: "run-one",
    nodeId: "review",
    armedBy: caller.actor,
  };
  for (const attribution of [
    { role: "admin" },
    { role: null },
    { workflow: null },
    { workflow: { ...workflow, workflowId: "" } },
    { workflow: { ...workflow, runId: "x".repeat(257) } },
    { workflow: { ...workflow, nodeId: "" } },
    { workflow: { ...workflow, armedBy: "member-one" } },
    { workflow: { ...workflow, armedBy: { kind: "installation", id: "a" } } },
  ]) {
    const input = { ...caller, ...attribution };
    expect(() => parseAppMethodCallContext(input)).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(appMethodCallContextSchema)(input),
    ).toThrow();
  }
  const input = {
    ...caller,
    workflow: {
      ...workflow,
      armedBy: { ...caller.actor, role: "owner" },
    },
  };
  expect(parseAppMethodCallContext(input)).toEqual({ ...caller, workflow });
  expect(() => parseAppMethodCallContext(input, true)).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(appMethodCallContextSchema, {
      onExcessProperty: "error",
    })(input),
  ).toThrow();
});

it("derives the closed declaration and signed operation vocabulary from the registry", () => {
  const declaration = Schema.decodeUnknownSync(appBackendBindingsSchema);
  const shard = Schema.decodeUnknownSync(appBackendShardBindingsSchema);
  expect(
    declaration([
      { name: "INBOX", operations: ["page", "visit"] },
      { name: "AGENTS", operations: ["list", "send"] },
    ]),
  ).toHaveLength(2);
  for (const value of [
    [{ name: "INBOX", capabilities: ["inbox.read"] }],
    [{ name: "INBOX", operations: ["send"] }],
    [{ name: "INBOX", operations: ["page", "page"] }],
    [{ name: "INBOX", operations: [] }],
    [
      { name: "INBOX", operations: ["page"] },
      { name: "INBOX", operations: ["visit"] },
    ],
    [{ name: "COMPUTER", operations: ["readFile"] }],
  ])
    expect(() => declaration(value)).toThrow();
  expect(
    shard([
      { name: "INBOX", operations: [{ name: "page", cap: "inbox.read" }] },
    ]),
  ).toHaveLength(1);
  for (const value of [
    [{ name: "INBOX", operations: [{ name: "page", cap: "inbox.visit" }] }],
    [{ name: "AGENTS", operations: [{ name: "page", cap: "inbox.read" }] }],
    [
      {
        name: "INBOX",
        operations: [
          { name: "page", cap: "inbox.read" },
          { name: "page", cap: "inbox.read" },
        ],
      },
    ],
  ])
    expect(() => shard(value)).toThrow();
  expect(appBackendBindingOperation("INBOX", "visit")).toEqual({
    cap: "inbox.visit",
    requires: ["agent.read"],
    effect: "write",
  });
  expect(appBackendBindingOperation("INBOX", "send")).toBeUndefined();
});
it("requires a bounded Hub caller identity for Agent attribution", () => {
  const parse = Schema.decodeUnknownSync(appMethodCallContextSchema);
  expect(
    parse({ actor: { kind: "agent", agentId: "agent-a" }, computerId: null }),
  ).toEqual({
    actor: { kind: "agent", agentId: "agent-a" },
    computerId: null,
  });
  expect(
    parse({
      actor: { kind: "member", memberId: "member-a" },
      computerId: "computer-a",
    }),
  ).toEqual({
    actor: { kind: "member", memberId: "member-a" },
    computerId: "computer-a",
  });
  expect(
    parse({ actor: { kind: "team-key", keyId: "key-a" }, computerId: null }),
  ).toEqual({
    actor: { kind: "team-key", keyId: "key-a" },
    computerId: null,
  });
  for (const value of [
    {},
    { actor: { kind: "agent" }, computerId: null },
    { actor: { kind: "agent", agentId: "" }, computerId: null },
    { actor: { kind: "agent", agentId: "a".repeat(257) }, computerId: null },
    { actor: { kind: "root" }, computerId: null },
    { actor: { kind: "member" }, computerId: null },
    { actor: { kind: "team-key" }, computerId: null },
    { actor: { kind: "member", memberId: "member-a" } },
    { actor: { kind: "member", memberId: "member-a" }, computerId: "" },
    {
      actor: { kind: "member", memberId: "member-a" },
      computerId: "a".repeat(257),
    },
  ]) {
    expect(() => parse(value)).toThrow();
    expect(() => parseAppMethodCallContext(value)).toThrow();
  }
});

it.each([
  { actor: { kind: "agent", agentId: "agent-a" }, computerId: null },
  { actor: { kind: "member", memberId: "member-a" }, computerId: "computer-a" },
  { actor: { kind: "team-key", keyId: "key-a" }, computerId: null },
])(
  "decodes the same caller through the runtime and Effect ports: $actor.kind",
  (caller) => {
    expect(parseAppMethodCallContext(caller)).toEqual(caller);
    expect(
      Schema.decodeUnknownSync(appMethodCallContextSchema)(caller),
    ).toEqual(caller);
  },
);
it("declares only generic graph operations for Workflows", () => {
  const declaration = Schema.decodeUnknownSync(appBackendBindingsSchema);
  expect(
    declaration([{ name: "WORKFLOWS", operations: ["catalog", "runGraph"] }]),
  ).toEqual([{ name: "WORKFLOWS", operations: ["catalog", "runGraph"] }]);
  for (const operation of [
    "inspect",
    "startStoryboard",
    "approve",
    "reject",
    "regenerate",
    "animate",
    "listRecipes",
  ])
    expect(() =>
      declaration([{ name: "WORKFLOWS", operations: [operation] }]),
    ).toThrow();
});

it("refuses reserved RPC and lifecycle names for binding operations", () => {
  const parse = Schema.decodeUnknownSync(appApiMethodNameSchema);
  for (const name of Object.values(appApiReservedMethodNames).flat())
    expect(() => parse(name)).toThrow();
  expect(parse("page")).toBe("page");
});

it.each(["member", "team-key"])(
  "bounds the %s identity in both caller ports",
  (kind) => {
    const actor =
      kind === "member"
        ? { kind, memberId: "x".repeat(257) }
        : { kind, keyId: "x".repeat(257) };
    const input = { actor, computerId: null };
    expect(() => parseAppMethodCallContext(input)).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(appMethodCallContextSchema)(input),
    ).toThrow();
  },
);
it("both caller ports return decoded fields instead of the raw JSON object", () => {
  const input: unknown = JSON.parse(
    '{"computerId":null,"actor":{"kind":"member","memberId":"member-a","extra":"discard"},"extra":"discard","__proto__":{"injected":true}}',
  );
  const expected = {
    computerId: null,
    actor: { kind: "member", memberId: "member-a" },
  };
  expect(parseAppMethodCallContext(input)).toEqual(expected);
  expect(Schema.decodeUnknownSync(appMethodCallContextSchema)(input)).toEqual(
    expected,
  );
  expect(() =>
    Schema.decodeUnknownSync(appMethodCallContextSchema, {
      onExcessProperty: "error",
    })(input),
  ).toThrow();
});

it.each(["then", "ctx", "fetch", "constructor"])(
  "refuses the reserved producer method name %s in both grammars",
  (name) => {
    expect(isAppApiMethodName(name)).toBe(false);
    expect(() =>
      Schema.decodeUnknownSync(appApiMethodNameSchema)(name),
    ).toThrow();
  },
);

it("strict caller decoding refuses an extra member-actor key without extra root keys", () => {
  const input = {
    computerId: null,
    actor: { kind: "member", memberId: "member-a", extra: "refuse" },
  };
  expect(() => parseAppMethodCallContext(input, true)).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(appMethodCallContextSchema, {
      onExcessProperty: "error",
    })(input),
  ).toThrow();
});

it("derives read, write and reset for the member App storage binding", () => {
  const declaration = Schema.decodeUnknownSync(appBackendBindingsSchema);
  const storage = [
    { name: "APP_STORAGE", operations: ["read", "write", "reset"] },
  ];
  expect(declaration(storage)).toEqual(storage);
  expect(appBackendBindingOperation("APP_STORAGE", "read")).toEqual({
    cap: "app.storage.read",
    requires: ["app.storage"],
    effect: "read",
  });
  for (const name of ["write", "reset"])
    expect(appBackendBindingOperation("APP_STORAGE", name)).toEqual({
      cap: "app.storage.write",
      requires: ["app.storage"],
      effect: "write",
    });
});

it("declares a read-only App catalog with the existing workbench capability", () => {
  const declaration = Schema.decodeUnknownSync(appBackendBindingsSchema);
  expect(declaration([{ name: "APPS", operations: ["catalog"] }])).toEqual([
    { name: "APPS", operations: ["catalog"] },
  ]);
  expect(appBackendBindingOperation("APPS", "catalog")).toEqual({
    cap: "app.catalog.read",
    requires: ["team.workbenchHost"],
    effect: "read",
  });
  for (const name of ["install", "open", "write", "delete"])
    expect(() => declaration([{ name: "APPS", operations: [name] }])).toThrow();
});

it("carries the host's idempotency key to App methods, bounded, in both caller ports", () => {
  const caller = {
    computerId: "computer-a",
    actor: { kind: "member", memberId: "member-a" },
    idempotencyKey: "run_a:generate:0",
  };
  expect(parseAppMethodCallContext(caller)).toEqual(caller);
  expect(parseAppMethodCallContext(caller, true)).toEqual(caller);
  expect(Schema.decodeUnknownSync(appMethodCallContextSchema)(caller)).toEqual(
    caller,
  );
  // Callers without one (Agents, people) decode unchanged.
  const plain = { computerId: caller.computerId, actor: caller.actor };
  expect(parseAppMethodCallContext(plain)).toEqual(plain);
  for (const idempotencyKey of ["", "k".repeat(129)]) {
    expect(() =>
      parseAppMethodCallContext({ ...caller, idempotencyKey }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(appMethodCallContextSchema)({
        ...caller,
        idempotencyKey,
      }),
    ).toThrow();
  }
});

it("requires explicit event-emission capability approval for the EVENTS binding", () => {
  expect(
    Schema.decodeUnknownSync(appCapabilityIdSchema)("app.events.emit"),
  ).toBe("app.events.emit");
  expect(appBackendBindingOperation("EVENTS", "emit")).toEqual({
    cap: "app.events.emit",
    requires: ["app.events.emit"],
    effect: "write",
  });
});

it("scopes registered operations to method requirements, effect and the captured ceiling", () => {
  const read = appBackendBindingOperation("APP_STORAGE", "read");
  const write = appBackendBindingOperation("APP_STORAGE", "write");
  if (read === undefined || write === undefined)
    throw new Error("Missing storage operations");
  const method = { requires: ["app.storage"], effect: "write" } as const;
  expect(scopeOperationToMethod(read, method, "read")).toBe(true);
  expect(scopeOperationToMethod(write, method, "write")).toBe(true);
  expect(scopeOperationToMethod(write, method, "read")).toBe(false);
  expect(
    scopeOperationToMethod(write, { ...method, effect: "read" }, "write"),
  ).toBe(false);
  expect(
    scopeOperationToMethod(write, { ...method, effect: "external" }, "write"),
  ).toBe(false);
  expect(
    scopeOperationToMethod(read, { ...method, requires: [] }, "write"),
  ).toBe(false);
});
