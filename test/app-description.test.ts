import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  appBuildJsonSchema,
  appMediaType,
  createAppBuild,
  emptyAppDeclaration,
  isEmptyAppDeclaration,
} from "../src/app.js";
import { backendMediaType } from "../src/backend.js";
import { createDeterministicMemoryAppReleaseStore } from "../src/effect.js";
import {
  createAppReleaseCatalog,
  parseAppId,
  parseArtifactRef,
  parseReleaseId,
  parseSha256Digest,
  parseSourceRevision,
  type ArtifactReader,
  type Release,
} from "../src/index.js";

type JsonValue =
  | null
  | string
  | number
  | boolean
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

const encode = (value: JsonValue) =>
  new TextEncoder().encode(JSON.stringify(value));
const digest = (bytes: Uint8Array) =>
  parseSha256Digest(
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  );

describe("one App Release", () => {
  it("admits a headless App root and rejects an empty App", () => {
    const backend = {
      artifactRef: "artifact:api.backend",
      digest: `sha256:${"a".repeat(64)}`,
      version: "backend-v1",
      byteLength: 1,
      mediaType: backendMediaType,
    };
    expect(
      Schema.decodeUnknownSync(appBuildJsonSchema)(
        JSON.stringify({ format: "fungi-app-v1", backend }),
      ),
    ).toEqual({ format: "fungi-app-v1", backend });
    expect(() =>
      Schema.decodeUnknownSync(appBuildJsonSchema)(
        JSON.stringify({ format: "fungi-app-v1" }),
      ),
    ).toThrow();
  });

  it("declares requests only from the closed vocabulary", () => {
    const backend = {
      artifactRef: "artifact:api.backend",
      digest: `sha256:${"a".repeat(64)}`,
      version: "backend-v1",
      byteLength: 1,
      mediaType: backendMediaType,
    } as const;
    const decode = (declaration: JsonValue) =>
      Schema.decodeUnknownSync(appBuildJsonSchema)(
        JSON.stringify({ format: "fungi-app-v1", backend, declaration }),
      );
    const backendBuild = {
      ...backend,
      artifactRef: parseArtifactRef(backend.artifactRef),
      digest: parseSha256Digest(backend.digest),
    };
    expect(
      createAppBuild(null, backendBuild, emptyAppDeclaration),
    ).not.toHaveProperty("declaration");
    expect(
      decode({ capabilities: [], handlers: ["file.open"], roles: ["files"] }),
    ).toMatchObject({ declaration: { roles: ["files"] } });
    expect(
      decode({
        capabilities: [],
        handlers: [],
        icon: "installApps",
        roles: [],
      }),
    ).toMatchObject({ declaration: { icon: "installApps" } });
    expect(() =>
      decode({ capabilities: ["root"], handlers: [], roles: [] }),
    ).toThrow();
    expect(() =>
      decode({ capabilities: [], handlers: [], roles: ["inbox", "inbox"] }),
    ).toThrow();
    // An App may declare the world capability and the guidance it gives the
    // Agents a Team grants it; the guidance is bounded and never blank.
    expect(
      decode({
        capabilities: ["world"],
        guidance: "Play the world.",
        handlers: [],
        roles: [],
      }),
    ).toMatchObject({
      declaration: {
        capabilities: ["world"],
        guidance: "Play the world.",
      },
    });
    expect(() =>
      decode({ capabilities: [], guidance: "", handlers: [], roles: [] }),
    ).toThrow();
    expect(() =>
      decode({
        capabilities: [],
        guidance: "x".repeat(12_001),
        handlers: [],
        roles: [],
      }),
    ).toThrow();
    expect(
      isEmptyAppDeclaration({
        capabilities: [],
        guidance: "Play.",
        handlers: [],
        roles: [],
      }),
    ).toBe(false);
    expect(
      isEmptyAppDeclaration({
        capabilities: [],
        handlers: [],
        roles: [],
        gills: [{ id: "inbox", source: "listInbox", title: "Inbox" }],
      }),
    ).toBe(false);
  });

  it("digest-covers bounded source-backed Gill views and placement context", () => {
    const backend = {
      artifactRef: "artifact:api.backend",
      digest: `sha256:${"a".repeat(64)}`,
      version: "backend-v1",
      byteLength: 1,
      mediaType: backendMediaType,
    } as const;
    const decode = (gills: JsonValue) =>
      Schema.decodeUnknownSync(appBuildJsonSchema)(
        JSON.stringify({
          format: "fungi-app-v1",
          backend,
          declaration: { capabilities: [], handlers: [], roles: [], gills },
        }),
      );
    const inbox = {
      id: "inbox",
      source: "listInbox",
      title: "Inbox",
      params: [
        {
          key: "repository",
          label: "Repository",
          kind: "repository",
          required: true,
        },
      ],
      watch: { storage: "repo-changed" },
    };
    expect(decode([inbox])).toMatchObject({
      declaration: { gills: [inbox] },
    });
    expect(() => decode([inbox, inbox])).toThrow();
    expect(() => decode([{ ...inbox, source: "" }])).toThrow();
    expect(() =>
      decode([{ ...inbox, params: [...inbox.params, ...inbox.params] }]),
    ).toThrow();
    expect(() => decode([{ ...inbox, id: "inbox:other" }])).toThrow();
    expect(() => decode([{ ...inbox, title: "" }])).toThrow();
    const params = Array.from({ length: 4 }, (_, index) => ({
      key: `key${String(index)}`,
      label: "Repository",
      kind: "repository",
      required: false,
    }));
    expect(decode([{ ...inbox, params }])).toMatchObject({
      declaration: { gills: [{ ...inbox, params }] },
    });
    expect(() =>
      decode([
        {
          ...inbox,
          params: [
            ...params,
            { key: "extra", label: "Branch", kind: "branch", required: false },
          ],
        },
      ]),
    ).toThrow();
    const gills = Array.from({ length: 16 }, (_, index) => ({
      ...inbox,
      id: `gill-${String(index)}`,
    }));
    expect(decode(gills)).toMatchObject({ declaration: { gills } });
    expect(() => decode([...gills, { ...inbox, id: "extra" }])).toThrow();
  });

  it("declares a Whistle command catalog the backend can advertise", () => {
    const backend = {
      artifactRef: "artifact:api.backend",
      digest: `sha256:${"a".repeat(64)}`,
      version: "backend-v1",
      byteLength: 1,
      mediaType: backendMediaType,
    } as const;
    const decode = (commands: JsonValue) =>
      Schema.decodeUnknownSync(appBuildJsonSchema)(
        JSON.stringify({
          format: "fungi-app-v1",
          backend,
          declaration: { capabilities: [], handlers: [], roles: [], commands },
        }),
      );
    const save = {
      id: "save",
      title: "Save",
      category: "File",
      projections: {
        slash: { aliases: ["save"] },
        bindings: { values: ["mod+s", "<leader> w"] },
        palette: {},
      },
    };
    expect(decode([save])).toMatchObject({
      declaration: { commands: [save] },
    });
    // Runtime availability never enters a digest-covered declaration; the
    // reserved leader chord and duplicate identities are refused.
    expect(
      decode([{ ...save, availability: { status: "available" } }]),
    ).toMatchObject({ declaration: { commands: [save] } });
    expect(
      decode([{ ...save, availability: { status: "available" } }]).declaration
        ?.commands?.[0],
    ).not.toHaveProperty("availability");
    for (const reservedChord of ["super+k", "ctrl+k", "control+k"]) {
      expect(() =>
        decode([
          { ...save, projections: { bindings: { values: [reservedChord] } } },
        ]),
      ).toThrow();
    }
    expect(() => decode([save, { ...save, id: "save-as" }])).toThrow();
    expect(() => decode([{ id: "", title: "", category: "" }])).toThrow();
  });

  it("app-backend-bindings-declaration: binds backend authority into the Release root", () => {
    const backend = {
      artifactRef: parseArtifactRef("artifact:api.backend"),
      digest: parseSha256Digest(`sha256:${"a".repeat(64)}`),
      version: "backend-v1",
      byteLength: 1,
      mediaType: backendMediaType,
    } as const;
    const declaration = {
      capabilities: ["agent.read", "agent.list"],
      handlers: [],
      roles: [],
      backend: {
        bindings: [
          { name: "INBOX", operations: ["page", "visit"] },
          { name: "AGENTS", operations: ["list"] },
        ],
      },
    } as const;
    const root = createAppBuild(null, backend, declaration);
    expect(root.declaration).toEqual(declaration);
    const encoded = Schema.encodeSync(appBuildJsonSchema)(root);
    const withoutBindings = Schema.encodeSync(appBuildJsonSchema)(
      createAppBuild(null, backend, {
        capabilities: ["agent.read", "agent.list"],
        handlers: [],
        roles: [],
      }),
    );
    expect(digest(new TextEncoder().encode(encoded))).not.toBe(
      digest(new TextEncoder().encode(withoutBindings)),
    );
    expect(
      Schema.decodeUnknownSync(appBuildJsonSchema)(encoded).declaration,
    ).toEqual(declaration);
    const invalid = (capabilities: readonly string[]) =>
      JSON.stringify({
        format: "fungi-app-v1",
        backend,
        declaration: { ...declaration, capabilities },
      });
    expect(() =>
      Schema.decodeUnknownSync(appBuildJsonSchema)(invalid(["agent.list"])),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(appBuildJsonSchema)(invalid(["agent.read"])),
    ).toThrow();
  });

  it("resolves its UI and durable backend through one eligible root", async () => {
    const ui = new TextEncoder().encode("<!doctype html><title>Notes</title>");
    const backend = encode({
      runtime: { kind: "durable-facet", stateSchema: 1 },
      compatibilityDate: "2026-09-18",
      exportName: "NotesFacet",
      code: "export class NotesFacet {}",
    });
    const root = encode({
      format: "fungi-app-v1",
      ui: {
        artifactRef: "artifact:notes.ui",
        digest: digest(ui),
        version: "ui-v1",
        byteLength: ui.byteLength,
        mediaType: "text/html; charset=utf-8",
      },
      backend: {
        artifactRef: "artifact:notes.backend",
        digest: digest(backend),
        version: "backend-v1",
        byteLength: backend.byteLength,
        mediaType: backendMediaType,
      },
      declaration: {
        capabilities: ["agent.read"],
        handlers: [],
        roles: ["sessions"],
      },
    });
    const objects = new Map([
      ["artifact:notes.root", { bytes: root, mediaType: appMediaType }],
      [
        "artifact:notes.ui",
        { bytes: ui, mediaType: "text/html; charset=utf-8" as const },
      ],
      [
        "artifact:notes.backend",
        { bytes: backend, mediaType: backendMediaType },
      ],
    ]);
    const reads: unknown[] = [];
    const artifactReader: ArtifactReader = {
      read: (input) => {
        reads.push(input);
        const object = objects.get(input.artifactRef);
        if (object === undefined) return Promise.resolve({ kind: "missing" });
        return Promise.resolve({
          kind: "verified" as const,
          digest: digest(object.bytes),
          mediaType: object.mediaType,
          byteLength: object.bytes.byteLength,
          bytes: {
            byteLength: object.bytes.byteLength,
            copy: () => object.bytes.slice(),
          },
        });
      },
    };
    const app = { appId: parseAppId("app_notes") };
    const release: Release = {
      appId: app.appId,
      releaseId: parseReleaseId("rel_notes1"),
      artifact: {
        artifactRef: parseArtifactRef("artifact:notes.root"),
        artifactDigest: digest(root),
        provenance: {
          sourceRevision: parseSourceRevision(`git:${"a".repeat(40)}`),
          sourceTreeDigest: digest(new TextEncoder().encode("tree")),
          buildRecipeDigest: digest(new TextEncoder().encode("recipe")),
        },
      },
    };
    const catalog = createAppReleaseCatalog({
      artifactReader,
      store: createDeterministicMemoryAppReleaseStore(),
    });

    await catalog.createApp(app);
    await catalog.createRelease(release);
    await catalog.verifyReleaseArtifact(release.releaseId);
    const readsAfterVerification = reads.length;
    const metadata = await catalog.resolveEligibleAppMetadata(
      release.releaseId,
    );
    expect(reads).toHaveLength(readsAfterVerification);
    expect(metadata.description).toEqual({
      format: "fungi-app-v1",
      ui: {
        artifactRef: parseArtifactRef("artifact:notes.ui"),
        digest: digest(ui),
        mediaType: "text/html; charset=utf-8",
        version: "ui-v1",
        byteLength: ui.byteLength,
      },
      backend: {
        artifact: {
          artifactRef: parseArtifactRef("artifact:notes.backend"),
          digest: digest(backend),
          mediaType: backendMediaType,
          version: "backend-v1",
          byteLength: backend.byteLength,
        },
        profile: {
          runtime: { kind: "durable-facet", stateSchema: 1 },
          compatibilityDate: "2026-09-18",
          exportName: "NotesFacet",
        },
      },
      declaration: {
        capabilities: ["agent.read"],
        handlers: [],
        roles: ["sessions"],
      },
    });
    const resolved = await catalog.resolveEligibleApp(release.releaseId);

    expect(resolved.release).toEqual(release);
    expect(new TextDecoder().decode(resolved.ui?.bytes.copy())).toContain(
      "Notes",
    );
    expect(resolved.backend?.descriptor).toMatchObject({
      exportName: "NotesFacet",
    });
    expect(reads).toHaveLength(6);
    expect(reads.slice(0, 3)).toMatchObject([
      { artifactRef: "artifact:notes.root", verification: "publication" },
      { artifactRef: "artifact:notes.ui", verification: "publication" },
      { artifactRef: "artifact:notes.backend", verification: "publication" },
    ]);
  });
});
