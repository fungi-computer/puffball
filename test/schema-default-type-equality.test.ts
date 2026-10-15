import { readFileSync } from "node:fs";

import * as Schema from "effect/Schema";
import { describe, expect, expectTypeOf, it } from "vitest";

import * as defaultRoot from "../dist/index.js";
import type {
  App,
  AppCreate,
  AppId,
  AppRead,
  AppReleaseStoreFailure,
  AppReleaseStoreResult,
  ArtifactProvenance,
  ArtifactReadResult,
  ArtifactRef,
  IdempotencyKey,
  PublicSurface,
  PublicSurfaceCreate,
  PublicSurfaceId,
  PublicSurfaceLifecycle,
  PublicSurfaceRead,
  Release,
  ReleaseArtifact,
  ReleaseCreate,
  ReleaseId,
  ReleaseLifecycle,
  ReleaseRead,
  ReleaseRevocation,
  ReleaseTransition,
  ReleaseVerification,
  Sha256Digest,
  SourceRevision,
  StableRoute,
  TransitionLookup,
  TransitionPersistence,
  TransitionReceipt,
  VerifiedArtifactRead,
} from "../dist/index.js";
import {
  appCreateSchema,
  appCreateStoreResultSchema,
  appIdSchema,
  appReadSchema,
  appReadStoreResultSchema,
  appReleaseStoreFailureSchema,
  appSchema,
  artifactProvenanceSchema,
  artifactReadResultSchema,
  artifactRefSchema,
  idempotencyKeySchema,
  publicSurfaceCreateSchema,
  publicSurfaceCreateStoreResultSchema,
  publicSurfaceIdSchema,
  publicSurfaceLifecycleSchema,
  publicSurfaceReadSchema,
  publicSurfaceReadStoreResultSchema,
  publicSurfaceSchema,
  releaseArtifactSchema,
  releaseCreateSchema,
  releaseCreateStoreResultSchema,
  releaseIdSchema,
  releaseLifecycleSchema,
  releaseLifecycleStoreResultSchema,
  releaseReadSchema,
  releaseReadStoreResultSchema,
  releaseRevocationSchema,
  releaseSchema,
  releaseTransitionSchema,
  releaseVerificationRecordStoreResultSchema,
  releaseVerificationSchema,
  sha256DigestSchema,
  sourceRevisionSchema,
  stableRouteSchema,
  transitionLookupSchema,
  transitionLookupStoreResultSchema,
  transitionPersistenceSchema,
  transitionPersistenceStoreResultSchema,
  transitionReceiptSchema,
  verifiedArtifactReadSchema,
} from "../dist/internal/app-release-schema.js";

type BidirectionallyEqual<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

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
    if (visited.has(declarationFile.href)) continue;
    visited.add(declarationFile.href);

    const declaration = readFileSync(declarationFile, "utf8");
    declarations.push(declaration);
    for (const specifier of localDeclarationSpecifiers(declaration)) {
      pending.push(declarationUrlFor(specifier, declarationFile));
    }
  }

  return declarations.join("\n");
}

describe("App Release Schema/default projections", () => {
  it("keeps every canonical data projection bidirectionally type-equal", () => {
    expectTypeOf<AppId>().toEqualTypeOf<
      Schema.Schema.Type<typeof appIdSchema>
    >();
    expectTypeOf<ReleaseId>().toEqualTypeOf<
      Schema.Schema.Type<typeof releaseIdSchema>
    >();
    expectTypeOf<PublicSurfaceId>().toEqualTypeOf<
      Schema.Schema.Type<typeof publicSurfaceIdSchema>
    >();
    expectTypeOf<ArtifactRef>().toEqualTypeOf<
      Schema.Schema.Type<typeof artifactRefSchema>
    >();
    expectTypeOf<IdempotencyKey>().toEqualTypeOf<
      Schema.Schema.Type<typeof idempotencyKeySchema>
    >();
    expectTypeOf<SourceRevision>().toEqualTypeOf<
      Schema.Schema.Type<typeof sourceRevisionSchema>
    >();
    expectTypeOf<Sha256Digest>().toEqualTypeOf<
      Schema.Schema.Type<typeof sha256DigestSchema>
    >();
    expectTypeOf<StableRoute>().toEqualTypeOf<
      Schema.Schema.Type<typeof stableRouteSchema>
    >();
    expectTypeOf<App>().toEqualTypeOf<Schema.Schema.Type<typeof appSchema>>();
    expectTypeOf<ArtifactProvenance>().toEqualTypeOf<
      Schema.Schema.Type<typeof artifactProvenanceSchema>
    >();
    expectTypeOf<ReleaseArtifact>().toEqualTypeOf<
      Schema.Schema.Type<typeof releaseArtifactSchema>
    >();
    expectTypeOf<Release>().toEqualTypeOf<
      Schema.Schema.Type<typeof releaseSchema>
    >();
    expectTypeOf<PublicSurface>().toEqualTypeOf<
      Schema.Schema.Type<typeof publicSurfaceSchema>
    >();
    const verifiedArtifactReadExact: BidirectionallyEqual<
      VerifiedArtifactRead,
      Schema.Schema.Type<typeof verifiedArtifactReadSchema>
    > = true;
    const artifactReadResultExact: BidirectionallyEqual<
      ArtifactReadResult,
      Schema.Schema.Type<typeof artifactReadResultSchema>
    > = true;
    expectTypeOf(verifiedArtifactReadExact).toEqualTypeOf<true>();
    expectTypeOf(artifactReadResultExact).toEqualTypeOf<true>();
    expectTypeOf<AppReleaseStoreFailure>().toEqualTypeOf<
      Schema.Schema.Type<typeof appReleaseStoreFailureSchema>
    >();
    expectTypeOf<AppRead>().toEqualTypeOf<
      Schema.Schema.Type<typeof appReadSchema>
    >();
    expectTypeOf<AppCreate>().toEqualTypeOf<
      Schema.Schema.Type<typeof appCreateSchema>
    >();
    expectTypeOf<ReleaseRead>().toEqualTypeOf<
      Schema.Schema.Type<typeof releaseReadSchema>
    >();
    expectTypeOf<ReleaseCreate>().toEqualTypeOf<
      Schema.Schema.Type<typeof releaseCreateSchema>
    >();
    expectTypeOf<PublicSurfaceRead>().toEqualTypeOf<
      Schema.Schema.Type<typeof publicSurfaceReadSchema>
    >();
    expectTypeOf<PublicSurfaceCreate>().toEqualTypeOf<
      Schema.Schema.Type<typeof publicSurfaceCreateSchema>
    >();
    expectTypeOf<ReleaseVerification>().toEqualTypeOf<
      Schema.Schema.Type<typeof releaseVerificationSchema>
    >();
    expectTypeOf<ReleaseRevocation>().toEqualTypeOf<
      Schema.Schema.Type<typeof releaseRevocationSchema>
    >();
    expectTypeOf<ReleaseTransition>().toEqualTypeOf<
      Schema.Schema.Type<typeof releaseTransitionSchema>
    >();
    expectTypeOf<TransitionReceipt>().toEqualTypeOf<
      Schema.Schema.Type<typeof transitionReceiptSchema>
    >();
    expectTypeOf<ReleaseLifecycle>().toEqualTypeOf<
      Schema.Schema.Type<typeof releaseLifecycleSchema>
    >();
    expectTypeOf<PublicSurfaceLifecycle>().toEqualTypeOf<
      Schema.Schema.Type<typeof publicSurfaceLifecycleSchema>
    >();
    expectTypeOf<TransitionLookup>().toEqualTypeOf<
      Schema.Schema.Type<typeof transitionLookupSchema>
    >();
    expectTypeOf<TransitionPersistence>().toEqualTypeOf<
      Schema.Schema.Type<typeof transitionPersistenceSchema>
    >();

    expectTypeOf<AppReleaseStoreResult<AppRead>>().toEqualTypeOf<
      Schema.Schema.Type<typeof appReadStoreResultSchema>
    >();
    expectTypeOf<AppReleaseStoreResult<AppCreate>>().toEqualTypeOf<
      Schema.Schema.Type<typeof appCreateStoreResultSchema>
    >();
    expectTypeOf<AppReleaseStoreResult<ReleaseRead>>().toEqualTypeOf<
      Schema.Schema.Type<typeof releaseReadStoreResultSchema>
    >();
    expectTypeOf<AppReleaseStoreResult<ReleaseCreate>>().toEqualTypeOf<
      Schema.Schema.Type<typeof releaseCreateStoreResultSchema>
    >();
    expectTypeOf<AppReleaseStoreResult<PublicSurfaceRead>>().toEqualTypeOf<
      Schema.Schema.Type<typeof publicSurfaceReadStoreResultSchema>
    >();
    expectTypeOf<AppReleaseStoreResult<PublicSurfaceCreate>>().toEqualTypeOf<
      Schema.Schema.Type<typeof publicSurfaceCreateStoreResultSchema>
    >();
    expectTypeOf<AppReleaseStoreResult<ReleaseLifecycle>>().toEqualTypeOf<
      Schema.Schema.Type<typeof releaseLifecycleStoreResultSchema>
    >();
    expectTypeOf<
      AppReleaseStoreResult<{ readonly kind: "recorded" }>
    >().toEqualTypeOf<
      Schema.Schema.Type<typeof releaseVerificationRecordStoreResultSchema>
    >();
    expectTypeOf<AppReleaseStoreResult<TransitionLookup>>().toEqualTypeOf<
      Schema.Schema.Type<typeof transitionLookupStoreResultSchema>
    >();
    expectTypeOf<AppReleaseStoreResult<TransitionPersistence>>().toEqualTypeOf<
      Schema.Schema.Type<typeof transitionPersistenceStoreResultSchema>
    >();
  });

  it("keeps the default declaration and runtime graph Effect-free", () => {
    const declarationGraph = reachableDeclarationGraph(
      new URL("../dist/index.d.ts", import.meta.url),
    );

    expect(declarationGraph).not.toMatch(
      /(?:["']effect(?:\/[^"']*)?["']|\bSchema\s*\.)/u,
    );
    expect(
      Object.values(defaultRoot).some((value) => Schema.isSchema(value)),
    ).toBe(false);
    expect(Object.keys(defaultRoot)).not.toEqual(
      expect.arrayContaining([
        "appIdSchema",
        "releaseSchema",
        "releaseTransitionSchema",
      ]),
    );
  });

  it("defines grammar only in the canonical Schema module", () => {
    const defaultSource = readFileSync(
      new URL("../src/index.ts", import.meta.url),
      "utf8",
    );
    const projectionSource = readFileSync(
      new URL("../src/internal/app-release-contract.ts", import.meta.url),
      "utf8",
    );
    const parserAssignments = [
      ...defaultSource.matchAll(
        /export const (parse\w+) = makeParser\(\s*"(\w+)",\s*(decode\w+),?\s*\);/gu,
      ),
    ].map(([, parser, parserName, decoder]) => ({
      decoder,
      parser,
      parserName,
    }));

    expect(parserAssignments).toEqual([
      { decoder: "decodeAppId", parser: "parseAppId", parserName: "AppId" },
      {
        decoder: "decodeAppTransitionId",
        parser: "parseAppTransitionId",
        parserName: "AppTransitionId",
      },
      {
        decoder: "decodeReleaseId",
        parser: "parseReleaseId",
        parserName: "ReleaseId",
      },
      {
        decoder: "decodePublicSurfaceId",
        parser: "parsePublicSurfaceId",
        parserName: "PublicSurfaceId",
      },
      {
        decoder: "decodeArtifactRef",
        parser: "parseArtifactRef",
        parserName: "ArtifactRef",
      },
      {
        decoder: "decodeIdempotencyKey",
        parser: "parseIdempotencyKey",
        parserName: "IdempotencyKey",
      },
      {
        decoder: "decodeSourceRevision",
        parser: "parseSourceRevision",
        parserName: "SourceRevision",
      },
      {
        decoder: "decodeSha256Digest",
        parser: "parseSha256Digest",
        parserName: "Sha256Digest",
      },
      {
        decoder: "decodeStableRoute",
        parser: "parseStableRoute",
        parserName: "StableRoute",
      },
    ]);
    expect(defaultSource.match(/function makeParser</gu)).toHaveLength(1);
    expect(defaultSource).not.toMatch(/(?:Schema\.|RegExp|\/\^)/u);
    expect(projectionSource).not.toMatch(
      /(?:effect\/Schema|Schema\.|RegExp|\/\^|decodeUnknown)/u,
    );
  });
});
