import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import { describe, expect, test } from "vitest";
import {
  appApiSchema,
  appApiReservedMethodNames,
  appBuildJsonSchema,
  appDeclarationSchema,
  createAppBuild,
  type AppDeclaration,
} from "../src/app.js";
import { parseArtifactRef, parseSha256Digest } from "../src/index.js";

const api = {
  methods: {
    read: {
      description: "Read a file",
      input: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      output: { type: "string" },
      effect: "read",
      requires: ["computer.readFile"],
    },
  },
} as const;
const declaration = {
  capabilities: ["computer.readFile"],
  handlers: [],
  roles: [],
  api,
} as const;
const backend = {
  artifactRef: parseArtifactRef("artifact:backend"),
  digest: parseSha256Digest(`sha256:${"a".repeat(64)}`),
  version: "1",
  byteLength: 1,
  mediaType: "application/vnd.fungi.app-backend+json",
} as const;
const decode = Schema.decodeUnknownSync(appDeclarationSchema);

describe("digest-covered App API declaration", () => {
  test("carries a method's presentation verb as bounded display metadata", () => {
    const presented = (verb: string) => ({
      methods: { read: { ...api.methods.read, present: { verb } } },
    });
    const decodeApi = Schema.decodeUnknownSync(appApiSchema);
    expect(decodeApi(presented("read")).methods.read?.present).toEqual({
      verb: "read",
    });
    expect(() => decodeApi(presented(""))).toThrow();
    expect(() => decodeApi(presented("x".repeat(33)))).toThrow();
  });
  test("preserves an anonymous read request in release bytes without inventing approval", () => {
    const marked: AppDeclaration = {
      ...declaration,
      api: {
        methods: {
          read: { ...api.methods.read, requires: [], anonymous: true },
        },
      },
    };
    const encode = Schema.encodeUnknownSync(appBuildJsonSchema);
    const encoded = encode(createAppBuild(null, backend, marked));
    expect(
      Schema.decodeUnknownSync(appBuildJsonSchema)(encoded).declaration?.api,
    ).toEqual(marked.api);
    expect(decode(declaration).api?.methods.read).not.toHaveProperty(
      "anonymous",
    );
    expect(decode(marked)).not.toHaveProperty("approvedAnonymous");
    const privateRead = {
      ...marked,
      api: { methods: { read: { ...api.methods.read, requires: [] } } },
    };
    expect(encoded).not.toBe(
      encode(createAppBuild(null, backend, privateRead)),
    );
  });

  test("rejects anonymous writes, external calls, required grants and false markers", () => {
    const cases = [
      { ...api.methods.read, requires: [], effect: "write", anonymous: true },
      {
        ...api.methods.read,
        requires: [],
        effect: "external",
        anonymous: true,
      },
      { ...api.methods.read, anonymous: true },
      { ...api.methods.read, requires: [], anonymous: false },
    ];
    for (const method of cases) {
      expect(() =>
        decode({ ...declaration, api: { methods: { read: method } } }),
      ).toThrow();
    }
  });

  test("pins a declared tool family and refuses invalid discovery references", () => {
    const familyApi = {
      methods: {
        list: { ...api.methods.read, hidden: true as const },
        run: { ...api.methods.read, effect: "write" as const },
      },
      toolFamily: { name: "flows", list: "list", call: "run" },
    };
    const declared = { ...declaration, api: familyApi };
    const encode = Schema.encodeUnknownSync(appBuildJsonSchema);
    const encoded = encode(createAppBuild(null, backend, declared));
    expect(
      Schema.decodeUnknownSync(appBuildJsonSchema)(encoded).declaration?.api,
    ).toEqual(familyApi);
    expect(encoded).not.toBe(
      encode(
        createAppBuild(null, backend, {
          ...declared,
          api: {
            ...familyApi,
            toolFamily: { ...familyApi.toolFamily, name: "jobs" },
          },
        }),
      ),
    );
    for (const toolFamily of [
      { name: "flows", list: "missing", call: "run" },
      { name: "flows", list: "run", call: "run" },
      { name: "flows", list: "list", call: "missing" },
      { name: "list", list: "list", call: "run" },
      { name: "flows.nested", list: "list", call: "run" },
    ])
      expect(() =>
        Schema.decodeUnknownSync(appApiSchema)({ ...familyApi, toolFamily }),
      ).toThrow();
    for (const change of [{ hidden: true }, { effect: "external" }])
      expect(() =>
        Schema.decodeUnknownSync(appApiSchema)({
          ...familyApi,
          methods: {
            ...familyApi.methods,
            run: { ...familyApi.methods.run, ...change },
          },
        }),
      ).toThrow();
    expect(decode(declaration).api).not.toHaveProperty("toolFamily");
  });

  test("preserves the hidden discovery marker in signed Release bytes", () => {
    const marked = {
      ...declaration,
      api: { methods: { read: { ...api.methods.read, hidden: true } } },
    } as const;
    const encode = Schema.encodeUnknownSync(appBuildJsonSchema);
    const encoded = encode(createAppBuild(null, backend, marked));
    expect(
      Schema.decodeUnknownSync(appBuildJsonSchema)(encoded).declaration?.api,
    ).toEqual(marked.api);
    expect(encoded).not.toBe(
      encode(createAppBuild(null, backend, declaration)),
    );
    expect(decode(declaration).api?.methods.read).not.toHaveProperty("hidden");
    for (const hidden of [false, "true", 1])
      expect(() =>
        decode({
          ...declaration,
          api: { methods: { read: { ...api.methods.read, hidden } } },
        }),
      ).toThrow();
  });

  test("preserves declared event schemas through the Release codec and pins payload changes", () => {
    const events = {
      "git.push": {
        description: "A repository accepted a push",
        payload: {
          type: "object",
          properties: {
            type: { const: "git.push" },
            timestamp: { type: "string" },
            data: { type: "object" },
          },
          required: ["type", "timestamp", "data"],
        },
      },
    } as const;
    const encode = Schema.encodeUnknownSync(appBuildJsonSchema);
    const declared = { ...declaration, api: { ...api, events } };
    const encoded = encode(createAppBuild(null, backend, declared));
    expect(
      Schema.decodeUnknownSync(appBuildJsonSchema)(encoded).declaration?.api,
    ).toEqual(declared.api);
    const changed = encode(
      createAppBuild(null, backend, {
        ...declared,
        api: {
          ...api,
          events: {
            "git.push": { ...events["git.push"], payload: { type: "string" } },
          },
        },
      }),
    );
    expect(createHash("sha256").update(encoded).digest("hex")).not.toBe(
      createHash("sha256").update(changed).digest("hex"),
    );
    expect(
      Schema.decodeUnknownSync(appBuildJsonSchema)(
        encode(createAppBuild(null, backend, declaration)),
      ).declaration?.api,
    ).not.toHaveProperty("events");
  });

  test("refuses malformed or oversized event declarations instead of dropping entries", () => {
    const event = { description: "Changed", payload: { type: "object" } };
    for (const events of [
      { "": event },
      { ["e".repeat(129)]: event },
      { changed: { ...event, description: "" } },
      { changed: { ...event, payload: [] } },
      { changed: { ...event, payload: { description: "x".repeat(20_001) } } },
      Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [
          `event${String(index)}`,
          event,
        ]),
      ),
    ]) {
      expect(() =>
        decode({ ...declaration, api: { ...api, events } }),
      ).toThrow();
    }
  });

  test("preserves the Pending opt-in through the immutable Release and covers it in the digest", () => {
    const optedIn = {
      ...declaration,
      api: { methods: { read: { ...api.methods.read, pending: true } } },
    } as const;
    const encode = Schema.encodeUnknownSync(appBuildJsonSchema);
    const root = createAppBuild(null, backend, optedIn);
    const encoded = encode(root);
    expect(
      Schema.decodeUnknownSync(appBuildJsonSchema)(encoded).declaration?.api,
    ).toEqual(optedIn.api);
    expect(encoded).not.toBe(
      encode(createAppBuild(null, backend, declaration)),
    );
    for (const pending of [false, "true", 1]) {
      expect(() =>
        decode({
          ...declaration,
          api: { methods: { read: { ...api.methods.read, pending } } },
        }),
      ).toThrow();
    }
  });
  test("preserves schemas and policy through the Release codec; each API change changes its digest", () => {
    const root = createAppBuild(null, backend, declaration);
    const encode = Schema.encodeUnknownSync(appBuildJsonSchema);
    expect(
      Schema.decodeUnknownSync(appBuildJsonSchema)(encode(root)).declaration
        ?.api,
    ).toEqual(api);
    const digest = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    const baseline = digest(encode(root));
    for (const change of [
      { description: "Read plain text" },
      { input: { type: "string" } },
      { output: { type: "number" } },
      { effect: "write" },
      { requires: [] },
    ]) {
      expect(
        digest(
          encode({
            ...root,
            declaration: {
              ...declaration,
              api: { methods: { read: { ...api.methods.read, ...change } } },
            },
          }),
        ),
      ).not.toBe(baseline);
    }
  });

  test("refuses a method that requires an undeclared capability", () => {
    expect(() => decode({ ...declaration, capabilities: [] })).toThrow(
      /outside/,
    );
  });

  test("refuses duplicate requirements instead of advertising the same capability twice", () => {
    expect(() =>
      decode({
        ...declaration,
        api: {
          methods: {
            read: {
              ...api.methods.read,
              requires: ["computer.readFile", "computer.readFile"],
            },
          },
        },
      }),
    ).toThrow();
  });

  test("bounds schema UTF-8 bytes, depth, method count and total metadata", () => {
    const withInput = (input: Schema.Json) => ({
      ...declaration,
      api: { methods: { read: { ...api.methods.read, input } } },
    });
    expect(() => decode(withInput({ description: "🍄".repeat(6000) }))).toThrow(
      /bound/,
    );
    let nested: Schema.Json = { type: "string" };
    for (let index = 0; index < 17; index++) nested = { items: nested };
    expect(() => decode(withInput(nested))).toThrow(/bound/);
    expect(() =>
      decode({
        ...declaration,
        api: {
          methods: Object.fromEntries(
            Array.from({ length: 65 }, (_, index) => [
              `read${String(index)}`,
              api.methods.read,
            ]),
          ),
        },
      }),
    ).toThrow();
    const large = {
      ...api.methods.read,
      input: { description: "a".repeat(19_000) },
    };
    expect(() =>
      decode({
        ...declaration,
        api: {
          methods: Object.fromEntries(
            Array.from({ length: 16 }, (_, index) => [
              `read${String(index)}`,
              large,
            ]),
          ),
        },
      }),
    ).toThrow(/total/);
  });

  test("refuses instance fields and additional Worker handlers as App methods", () => {
    for (const name of [
      "ctx",
      "env",
      "tail",
      "trace",
      "email",
      "test",
      "tailStream",
    ]) {
      expect(() =>
        Schema.decodeUnknownSync(appApiSchema)({
          methods: { [name]: api.methods.read },
        }),
      ).toThrow();
    }
  });

  test("refuses reserved entrypoints and malformed method metadata", () => {
    for (const name of [
      ...Object.values(appApiReservedMethodNames).flat(),
      "bad-name",
    ]) {
      expect(() =>
        Schema.decodeUnknownSync(appApiSchema)({
          methods: { [name]: api.methods.read },
        }),
      ).toThrow();
    }
    expect(() =>
      decode({
        ...declaration,
        api: { methods: { read: { ...api.methods.read, effect: "other" } } },
      }),
    ).toThrow();
  });

  test("a UI-only Release cannot advertise backend methods", () => {
    expect(() =>
      Schema.decodeUnknownSync(appBuildJsonSchema)(
        JSON.stringify({
          format: "fungi-app-v1",
          ui: { ...backend, mediaType: "text/html; charset=utf-8" },
          declaration,
        }),
      ),
    ).toThrow(/backend/);
  });

  test("refuses a method name that is also a dotted method group", () => {
    for (const names of [
      ["files", "files.read"],
      ["files.read", "files"],
      ["files", "files.history.read"],
    ])
      expect(() =>
        Schema.decodeUnknownSync(appApiSchema)({
          methods: Object.fromEntries(
            names.map((name) => [name, api.methods.read]),
          ),
        }),
      ).toThrow("App API method name is also a method group");
    expect(
      Schema.decodeUnknownSync(appApiSchema)({
        methods: {
          "files.read": api.methods.read,
          filesystem: api.methods.read,
        },
      }).methods,
    ).toHaveProperty("files.read");
  });
});
