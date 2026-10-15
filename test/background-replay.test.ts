import * as Schema from "effect/Schema";
import { appDeclarationSchema } from "../src/app-declaration.js";
import { appMethodCallContextSchema } from "../src/app-method-context.js";
import { parseAppMethodCallContext } from "../src/app-method-runtime.js";
import * as Background from "../src/background-replay.js";
import { expect, test } from "vitest";
import {
  actorLane,
  backgroundContext,
  mayEnqueueBackground,
  backgroundWakeSchema,
  mayDefer,
  readmitBackground,
} from "../src/background-replay.js";

const wake = {
  installationId: "notes",
  actor: { kind: "member" as const, memberId: "member_one" },
  lane: "member:member_one",
  originMethod: "save",
  observed: {
    authorityVersion: 1,
    artifactDigest: `sha256:${"1".repeat(64)}`,
    membershipVersion: 1,
  },
  epoch: 1,
};

test("a removed member refuses before continuation admission", async () => {
  const calls: string[] = [];
  const result = await readmitBackground(wake, {
    resolve: () => {
      calls.push("resolve");
      return Promise.resolve(null);
    },
    admit: () => {
      calls.push("admit");
      return Promise.resolve({
        kind: "refused" as const,
        code: "denied" as const,
      });
    },
  });
  expect(result).toEqual({ kind: "refused", code: "access_changed" });
  expect(calls).toEqual(["resolve"]);
});

const context = {
  actor: wake.actor,
  computerId: null,
  role: "member" as const,
};
const enqueueOrigin = { method: "save", seal: "A".repeat(43) };

test("both caller decoders retain the host-sealed origin beside its enqueue lane", () => {
  const attested = {
    ...context,
    backgroundLane: "member:member_one",
    backgroundOrigin: { method: "files.commit", seal: "A".repeat(43) },
  };
  expect(parseAppMethodCallContext(attested, true)).toEqual(attested);
  expect(
    Schema.decodeUnknownSync(appMethodCallContextSchema, {
      onExcessProperty: "error",
    })(attested),
  ).toEqual(attested);
});

test("a host-sealed origin is admitted only for its live frame's Instance, lane and method", async () => {
  const key = await Background.backgroundOriginKey(
    "synthetic-proof-key-current",
  );
  const claims = {
    instanceId: "instance_proof",
    lane: "member:member_one",
    method: "files.commit",
  };
  const origin = await Background.sealBackgroundOrigin(key, claims);
  expect(origin.method).toBe("files.commit");
  expect(origin.seal).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(
    await Background.admitClaimedOrigin(
      key,
      { ...claims, admitted: ["files.commit"] },
      origin,
    ),
  ).toEqual({ kind: "admitted" });
});

test("origin admission refuses a noncanonical base64url alias of the same HMAC", async () => {
  const key = await Background.backgroundOriginKey(
    "synthetic-canonical-seal-proof-key",
  );
  const claims = {
    instanceId: "instance_proof",
    lane: "member:member_one",
    method: "save",
  };
  const origin = await Background.sealBackgroundOrigin(key, claims);
  // A 32-byte SHA-256 MAC has four meaningful bits in its final sextet.
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const canonical = origin.seal.at(-1);
  if (canonical === undefined) throw new Error("Missing seal sextet");
  const alias =
    origin.seal.slice(0, -1) + alphabet.charAt(alphabet.indexOf(canonical) + 1);
  expect(Buffer.from(alias, "base64url")).toEqual(
    Buffer.from(origin.seal, "base64url"),
  );
  expect(
    await Background.admitClaimedOrigin(
      key,
      { ...claims, admitted: ["save"] },
      { ...origin, seal: alias },
    ),
  ).toEqual({ kind: "refused", code: "access_changed" });
});

test("caller decoders refuse unpaired, malformed or non-member origins", () => {
  const valid = {
    ...context,
    backgroundLane: "member:member_one",
    backgroundOrigin: enqueueOrigin,
  };
  const invalid = [
    { ...context, backgroundLane: valid.backgroundLane },
    { ...context, backgroundOrigin: enqueueOrigin },
    { ...valid, backgroundOrigin: { ...enqueueOrigin, extra: true } },
    { ...valid, backgroundOrigin: { ...enqueueOrigin, method: "then" } },
    { ...valid, backgroundOrigin: { ...enqueueOrigin, seal: "bad" } },
    { ...valid, actor: { kind: "agent", agentId: "member_one" } },
    { ...valid, actor: { kind: "team-key", keyId: "member_one" } },
    {
      ...valid,
      workflow: {
        workflowId: "wf_one",
        runId: "run_one",
        nodeId: "node_one",
        armedBy: context.actor,
      },
    },
  ];
  for (const raw of invalid) {
    expect(() => parseAppMethodCallContext(raw, true)).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(appMethodCallContextSchema)(raw),
    ).toThrow();
  }
});

test("origin admission refuses stale, swapped and malformed evidence without throwing", async () => {
  const key = await Background.backgroundOriginKey(
    "synthetic-proof-key-current",
  );
  const rotated = await Background.backgroundOriginKey(
    "synthetic-proof-key-rotated",
  );
  const claims = {
    instanceId: "instance_proof",
    lane: "member:member_one",
    method: "files.commit",
  };
  const origin = await Background.sealBackgroundOrigin(key, claims);
  const frame = { ...claims, admitted: ["files.commit", "files.save"] };
  for (const [selectedKey, selectedFrame, raw] of [
    [key, { ...frame, admitted: [] }, origin],
    [key, { ...frame, lane: "member:member_two" }, origin],
    [key, { ...frame, instanceId: "instance_other" }, origin],
    [key, frame, { ...origin, method: "files.save" }],
    [rotated, frame, origin],
    [key, frame, { ...origin, seal: "A".repeat(43) }],
    [key, frame, { ...origin, extra: true }],
    [key, frame, null],
    [key, frame, "malformed"],
  ] as const)
    expect(
      await Background.admitClaimedOrigin(selectedKey, selectedFrame, raw),
    ).toEqual({ kind: "refused", code: "access_changed" });
});

test("foreground origin projection replaces incoming evidence and refuses a method mismatch", () => {
  const incoming = {
    ...context,
    backgroundLane: "member:member_one",
    backgroundOrigin: { ...enqueueOrigin, method: "other" },
  };
  expect(
    backgroundContext(
      incoming,
      [],
      { name: "save", effect: "write" },
      enqueueOrigin,
    ),
  ).toEqual({
    ...context,
    backgroundLane: "member:member_one",
    backgroundOrigin: enqueueOrigin,
  });
  expect(() =>
    backgroundContext(
      context,
      [],
      { name: "save", effect: "write" },
      undefined,
    ),
  ).toThrow();
  expect(() =>
    backgroundContext(
      context,
      [],
      { name: "other", effect: "write" },
      enqueueOrigin,
    ),
  ).toThrow();
  expect(
    backgroundContext(
      incoming,
      [],
      { name: "read", effect: "read" },
      undefined,
    ),
  ).toEqual(context);
});

test.each([
  ["level_too_low", { kind: "refused", code: "access_changed" }],
  ["requires_not_granted", { kind: "refused", code: "access_changed" }],
  ["not_approved", { kind: "refused", code: "access_changed" }],
  ["denied", { kind: "refused", code: "access_changed" }],
  ["unavailable", { kind: "refused", code: "installation_unavailable" }],
  ["stale_authority", { kind: "retry" }],
] as const)(
  "fresh admission %s keeps its closed outcome",
  async (code, expected) => {
    const calls: string[] = [];
    const principal = { memberId: "member_one" };
    const result = await readmitBackground(wake, {
      resolve: (actor) => {
        expect(actor).toEqual(wake.actor);
        calls.push("resolve");
        return Promise.resolve(principal);
      },
      admit: (resolved, retained) => {
        expect(resolved).toBe(principal);
        expect(retained).toEqual(wake);
        calls.push("admit");
        return Promise.resolve({ kind: "refused" as const, code });
      },
    });
    expect(result).toEqual(expected);
    expect(calls).toEqual(["resolve", "admit"]);
  },
);

test("observed revisions are evidence; fresh admitted authority is retained", async () => {
  const refreshed = {
    ...context,
    role: "owner" as const,
    computerId: "computer_now",
  };
  const result = await readmitBackground(wake, {
    resolve: () => Promise.resolve({ revision: 20 }),
    admit: (principal) => {
      expect(principal.revision).toBe(20);
      return Promise.resolve({ kind: "admitted" as const, context: refreshed });
    },
  });
  expect(result).toEqual({ kind: "admitted", context: refreshed });
});

test("a host cannot substitute an actor or Workflow for the retained member", async () => {
  for (const substituted of [
    { ...context, actor: { kind: "member" as const, memberId: "other" } },
    { ...context, actor: { kind: "agent" as const, agentId: "member_one" } },
    {
      ...context,
      workflow: {
        workflowId: "w",
        runId: "r",
        nodeId: "n",
        armedBy: wake.actor,
      },
    },
  ]) {
    expect(
      await readmitBackground(wake, {
        resolve: () => Promise.resolve(context),
        admit: () =>
          Promise.resolve({ kind: "admitted" as const, context: substituted }),
      }),
    ).toEqual({ kind: "refused", code: "access_changed" });
  }
});

test("transport failures remain failures for Carrier retry", async () => {
  const cause = new Error("directory unavailable");
  await expect(
    readmitBackground(wake, {
      resolve: () => Promise.reject(cause),
      admit: () => Promise.resolve({ kind: "admitted" as const, context }),
    }),
  ).rejects.toBe(cause);
});

test("the strict wake carries identity and evidence, never bearer or grants", () => {
  expect(backgroundWakeSchema.parse(wake)).toEqual(wake);
  const oysterObserved = {
    authorityVersion: wake.observed.authorityVersion,
    artifactDigest: wake.observed.artifactDigest,
  };
  expect(
    backgroundWakeSchema.parse({ ...wake, observed: oysterObserved }).observed,
  ).toEqual(oysterObserved);
  for (const field of ["token", "authorization", "cookie", "grants"]) {
    expect(() =>
      backgroundWakeSchema.parse({ ...wake, [field]: "secret" }),
    ).toThrow();
    expect(() =>
      backgroundWakeSchema.parse({
        ...wake,
        observed: { ...wake.observed, [field]: "secret" },
      }),
    ).toThrow();
    expect(() =>
      backgroundWakeSchema.parse({
        ...wake,
        actor: { ...wake.actor, [field]: "secret" },
      }),
    ).toThrow();
  }
  expect(() =>
    backgroundWakeSchema.parse({ ...wake, lane: "member:other" }),
  ).toThrow();
  expect(() =>
    backgroundWakeSchema.parse({
      ...wake,
      actor: { kind: "agent", agentId: "member_one" },
    }),
  ).toThrow();
  for (const epoch of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => backgroundWakeSchema.parse({ ...wake, epoch })).toThrow();
});

test("only an ordinary member with empty ancestry may defer", () => {
  expect(mayDefer(context, [])).toBe(true);
  expect(mayDefer(context, ["other_instance"])).toBe(false);
  expect(
    mayDefer(
      { ...context, actor: { kind: "agent", agentId: "member_one" } },
      [],
    ),
  ).toBe(false);
  expect(
    mayDefer(
      { ...context, actor: { kind: "team-key", keyId: "member_one" } },
      [],
    ),
  ).toBe(false);
  expect(
    mayDefer(
      {
        ...context,
        workflow: {
          workflowId: "w",
          runId: "r",
          nodeId: "n",
          armedBy: wake.actor,
        },
      },
      [],
    ),
  ).toBe(false);
  expect(actorLane(wake.actor)).toBe("member:member_one");
  expect(actorLane({ kind: "agent", agentId: "member_one" })).toBe(
    "agent:member_one",
  );
  expect(actorLane({ kind: "team-key", keyId: "member_one" })).toBe(
    "team-key:member_one",
  );
});

const continuationDeclaration = {
  capabilities: ["computer.readFile", "computer.writeFile"],
  handlers: [],
  roles: [],
  backend: { bindings: [], sync: { method: "continueWrites" } },
  api: {
    methods: {
      save: {
        description: "Save",
        effect: "write",
        requires: ["computer.writeFile"],
        input: {},
        output: {},
      },
      load: {
        description: "Load",
        effect: "read",
        requires: ["computer.readFile"],
        input: {},
        output: {},
      },
      continueWrites: {
        description: "Continue",
        effect: "write",
        requires: ["computer.writeFile"],
        input: {},
        output: {},
      },
    },
  },
} as const;

test("the continuation is a declared write covering every write's requirements", () => {
  const decode = Schema.decodeUnknownSync(appDeclarationSchema, {
    onExcessProperty: "error",
  });
  expect(decode(continuationDeclaration).backend?.sync).toEqual({
    method: "continueWrites",
  });
  for (const continuation of [
    { ...continuationDeclaration.api.methods.continueWrites, effect: "read" },
    {
      ...continuationDeclaration.api.methods.continueWrites,
      effect: "external",
    },
    { ...continuationDeclaration.api.methods.continueWrites, requires: [] },
  ])
    expect(() =>
      decode({
        ...continuationDeclaration,
        api: {
          methods: {
            ...continuationDeclaration.api.methods,
            continueWrites: continuation,
          },
        },
      }),
    ).toThrow();
  expect(() =>
    decode({
      ...continuationDeclaration,
      backend: { bindings: [], sync: { method: "missing" } },
    }),
  ).toThrow();
  expect(() =>
    decode({ ...continuationDeclaration, api: undefined }),
  ).toThrow();
  // A read's capability is deliberately outside the write continuation ceiling.
  expect(
    decode(continuationDeclaration).api?.methods.continueWrites?.requires,
  ).toEqual(["computer.writeFile"]);
});

test("an App defers only from host-attested eligibility, never fabricated ancestry", () => {
  expect(mayEnqueueBackground(context)).toBe(false);
  const admitted = backgroundContext(
    context,
    [],
    { name: "save", effect: "write" },
    enqueueOrigin,
  );
  expect(admitted.backgroundLane).toBe("member:member_one");
  expect(mayEnqueueBackground(admitted)).toBe(true);
  for (const effect of ["read", "external"] as const) {
    expect(
      backgroundContext(admitted, [], { name: "save", effect }, undefined)
        .backgroundLane,
    ).toBeUndefined();
  }
  expect(
    backgroundContext(
      admitted,
      ["parent_instance"],
      { name: "save", effect: "write" },
      undefined,
    ).backgroundLane,
  ).toBeUndefined();
  const agent = {
    ...context,
    actor: { kind: "agent" as const, agentId: "member_one" },
  };
  expect(
    backgroundContext(
      agent,
      [],
      { name: "save", effect: "write" },
      enqueueOrigin,
    ).backgroundLane,
  ).toBeUndefined();
});

test("the Watchdog lane bound covers every canonical member identity without changing it", () => {
  for (const [length, eligible] of [
    [249, true],
    [250, true],
    [256, true],
  ] as const) {
    const bounded = {
      ...context,
      actor: { kind: "member" as const, memberId: "m".repeat(length) },
    };
    expect(mayDefer(bounded, [])).toBe(eligible);
    expect(
      mayEnqueueBackground(
        backgroundContext(
          bounded,
          [],
          { name: "save", effect: "write" },
          enqueueOrigin,
        ),
      ),
    ).toBe(eligible);
  }
  const longestActor = { kind: "member" as const, memberId: "m".repeat(256) };
  const longest = { ...context, actor: longestActor };
  expect(mayDefer(longest, [])).toBe(true);
  expect(
    mayEnqueueBackground(
      backgroundContext(
        longest,
        [],
        { name: "save", effect: "write" },
        enqueueOrigin,
      ),
    ),
  ).toBe(true);
  expect(
    backgroundContext(
      longest,
      [],
      { name: "save", effect: "write" },
      enqueueOrigin,
    ).backgroundLane,
  ).toBe(`member:${"m".repeat(256)}`);
  expect(
    backgroundWakeSchema.parse({
      ...wake,
      actor: longestActor,
      lane: actorLane(longestActor),
    }),
  ).toEqual({
    ...wake,
    actor: longestActor,
    lane: `member:${"m".repeat(256)}`,
  });
});

test("fresh replay cannot carry foreground enqueue eligibility into its continuation", async () => {
  const attested = backgroundContext(
    context,
    [],
    { name: "save", effect: "write" },
    enqueueOrigin,
  );
  const result = await readmitBackground(wake, {
    resolve: () => Promise.resolve(context),
    admit: () =>
      Promise.resolve({ kind: "admitted" as const, context: attested }),
  });
  expect(result).toEqual({ kind: "admitted", context });
  expect(
    result.kind === "admitted" && mayEnqueueBackground(result.context),
  ).toBe(false);
});
