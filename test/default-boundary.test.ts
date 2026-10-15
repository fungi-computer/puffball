import { readFileSync } from "node:fs";

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import * as defaultRoot from "../dist/index.js";

const schemaExports = [
  "appIdSchema",
  "releaseIdSchema",
  "publicSurfaceIdSchema",
  "artifactRefSchema",
  "idempotencyKeySchema",
  "sourceRevisionSchema",
  "sha256DigestSchema",
  "stableRouteSchema",
];

const localDeclarationReference =
  /(?:(?:import|export)(?:\s+type)?(?:\s+[^"'`;]*?\s+from)?\s+["'](\.{1,2}\/[^"']+?)["']|import\(\s*["'](\.{1,2}\/[^"']+?)["']\s*\))/gu;

function localDeclarationSpecifiers(declaration: string): string[] {
  return [...declaration.matchAll(localDeclarationReference)].flatMap(
    (match) => {
      const specifier = match[1] ?? match[2];
      return specifier === undefined ? [] : [specifier];
    },
  );
}

function declarationUrlFor(specifier: string, declaringFile: URL): URL {
  const declarationSpecifier = specifier.endsWith(".js")
    ? `${specifier.slice(0, -3)}.d.ts`
    : specifier;

  return new URL(declarationSpecifier, declaringFile);
}

function reachableDeclarationGraph(entrypoint: URL): string {
  const pending = [entrypoint];
  const visited = new Set<string>();
  const declarations: string[] = [];

  for (const declarationFile of pending) {
    if (visited.has(declarationFile.href)) {
      continue;
    }

    visited.add(declarationFile.href);
    const declaration = readFileSync(declarationFile, "utf8");
    declarations.push(declaration);

    for (const specifier of localDeclarationSpecifiers(declaration)) {
      pending.push(declarationUrlFor(specifier, declarationFile));
    }
  }

  return declarations.join("\n");
}

describe("App Release default boundary", () => {
  it("follows local declaration import types", () => {
    expect(
      localDeclarationSpecifiers(
        'export type EffectReference = import("./effect.js").SomeType;',
      ),
    ).toEqual(["./effect.js"]);
  });

  it("keeps the built default root and reachable declarations free of Effect Schema", () => {
    expect(
      Object.values(defaultRoot).some((value) => Schema.isSchema(value)),
    ).toBe(false);

    expect(Object.keys(defaultRoot)).not.toEqual(
      expect.arrayContaining(schemaExports),
    );

    const declarationGraph = reachableDeclarationGraph(
      new URL("../dist/index.d.ts", import.meta.url),
    );
    expect(declarationGraph).not.toMatch(
      /(?:["']effect(?:\/[^"']*)?["']|\bSchema\s*\.)/u,
    );
  });
});
