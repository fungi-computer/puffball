import { platformSurface } from "./support/platform-publication.js";
import { describe, expect, it } from "vitest";

import {
  AppReleaseArtifactDigestMismatchError,
  AppReleaseArtifactMissingError,
  AppReleaseArtifactUnavailableError,
  AppReleaseImmutableConflictError,
  AppReleaseTransitionOwnershipConflictError,
  AppReleaseTransitionReleaseRevokedError,
  AppReleaseTransitionReleaseUnverifiedError,
  createAppReleaseCatalog,
  parseAppId,
  parseArtifactRef,
  parseIdempotencyKey,
  parsePublicSurfaceId,
  parseReleaseId,
  parseSha256Digest,
  parseSourceRevision,
  parseStableRoute,
  type App,
  type AppReleaseStoreResult,
  type ArtifactReadResult,
  type ArtifactReader,
  type PublicSurface,
  type PromiseAppReleaseStore,
  type Release,
  type ReleaseLifecycle,
  type ReleaseTransition,
  type TransitionLookup,
  type TransitionPersistence,
  type TransitionReceipt,
  type VerifiedAppDescription,
} from "../dist/index.js";

type FixtureState = {
  readonly apps: Map<string, App>;
  readonly releases: Map<string, Release>;
  readonly surfaces: Map<string, PublicSurface>;
  readonly verified: Map<
    string,
    Readonly<{
      digest: Release["artifact"]["artifactDigest"];
      mediaType: "application/vnd.fungi.app+json";
      description: VerifiedAppDescription;
    }>
  >;
  readonly revoked: Set<string>;
  readonly selected: Map<string, string>;
  readonly receipts: Map<
    string,
    { request: ReleaseTransition; receipt: TransitionReceipt }
  >;
};

const success = <Value>(value: Value): AppReleaseStoreResult<Value> => ({
  kind: "success",
  value,
});

const copyApp = (app: App): App => ({ appId: app.appId });
const present = <Value>(value: Value | undefined): Value => {
  if (value === undefined) throw new Error("Fixture state unexpectedly absent");
  return value;
};
const copyRelease = (release: Release): Release => ({
  releaseId: release.releaseId,
  appId: release.appId,
  artifact: {
    artifactRef: release.artifact.artifactRef,
    artifactDigest: release.artifact.artifactDigest,
    provenance: { ...release.artifact.provenance },
  },
});
const copySurface = (surface: PublicSurface): PublicSurface => ({
  publicSurfaceId: surface.publicSurfaceId,
  appId: surface.appId,
  stableRoute: surface.stableRoute,
});
const copyTransition = (request: ReleaseTransition): ReleaseTransition => ({
  ...request,
});
const copyReceipt = (receipt: TransitionReceipt): TransitionReceipt => ({
  transition: copyTransition(receipt.transition),
  transitionId: receipt.transitionId,
});

function sameTransition(
  left: ReleaseTransition,
  right: ReleaseTransition,
): boolean {
  return (
    left.kind === right.kind &&
    left.releaseId === right.releaseId &&
    left.idempotencyKey === right.idempotencyKey &&
    (left.kind === "revocation" ||
      (right.kind !== "revocation" &&
        left.publicSurfaceId === right.publicSurfaceId))
  );
}

function transitionKey(request: ReleaseTransition): string {
  return `${request.kind}:${request.idempotencyKey}`;
}

/** A storage-neutral host fixture with private generic state and all optional operations. */
function createHostFixtureStore(): PromiseAppReleaseStore {
  const state: FixtureState = {
    apps: new Map(),
    releases: new Map(),
    surfaces: new Map(),
    verified: new Map(),
    revoked: new Set(),
    selected: new Map(),
    receipts: new Map(),
  };
  return {
    readApp: async (appId) => {
      await Promise.resolve();
      return success(
        state.apps.has(appId)
          ? { kind: "found", app: copyApp(present(state.apps.get(appId))) }
          : { kind: "absent" },
      );
    },
    createAppIfAbsent: async (app) => {
      await Promise.resolve();
      const existing = state.apps.get(app.appId);
      if (existing)
        return success({ kind: "existing", app: copyApp(existing) });
      state.apps.set(app.appId, copyApp(app));
      return success({ kind: "created", app: copyApp(app) });
    },
    readRelease: async (releaseId) => {
      await Promise.resolve();
      return success(
        state.releases.has(releaseId)
          ? {
              kind: "found",
              release: copyRelease(present(state.releases.get(releaseId))),
            }
          : { kind: "absent" },
      );
    },
    createReleaseIfAbsent: async (release) => {
      await Promise.resolve();
      const existing = state.releases.get(release.releaseId);
      if (existing)
        return success({ kind: "existing", release: copyRelease(existing) });
      state.releases.set(release.releaseId, copyRelease(release));
      return success({ kind: "created", release: copyRelease(release) });
    },
    readPublicSurface: async (publicSurfaceId) => {
      await Promise.resolve();
      return success(
        state.surfaces.has(publicSurfaceId)
          ? {
              kind: "found",
              surface: copySurface(
                present(state.surfaces.get(publicSurfaceId)),
              ),
            }
          : { kind: "absent" },
      );
    },
    createPublicSurfaceIfAbsent: async (surface) => {
      await Promise.resolve();
      const existing = state.surfaces.get(surface.publicSurfaceId);
      if (existing)
        return success({ kind: "existing", surface: copySurface(existing) });
      state.surfaces.set(surface.publicSurfaceId, copySurface(surface));
      return success({ kind: "created", surface: copySurface(surface) });
    },
    readReleaseLifecycle: async (releaseId) => {
      await Promise.resolve();
      const release = state.releases.get(releaseId);
      const lifecycle: ReleaseLifecycle =
        release === undefined
          ? { kind: "absent" }
          : {
              kind: "found",
              release: copyRelease(release),
              verification: state.verified.has(releaseId)
                ? {
                    kind: "verified",
                    ...present(state.verified.get(releaseId)),
                  }
                : { kind: "unverified" },
              revocation: state.revoked.has(releaseId)
                ? { kind: "revoked" }
                : { kind: "active" },
            };
      return success(lifecycle);
    },
    recordReleaseVerification: async (input) => {
      await Promise.resolve();
      if (!state.releases.has(input.releaseId))
        return { kind: "failure", failure: { kind: "unavailable" } };
      state.verified.set(input.releaseId, {
        digest: input.digest,
        mediaType: input.mediaType,
        description: input.description,
      });
      return success({ kind: "recorded" as const });
    },
    readTransition: async (
      request,
    ): Promise<AppReleaseStoreResult<TransitionLookup>> => {
      await Promise.resolve();
      const saved = state.receipts.get(transitionKey(request));
      if (!saved) return success({ kind: "absent" });
      return success(
        sameTransition(request, saved.request)
          ? { kind: "found", receipt: copyReceipt(saved.receipt) }
          : { kind: "conflict" },
      );
    },
    persistTransition: async (
      request,
      receipt,
    ): Promise<AppReleaseStoreResult<TransitionPersistence>> => {
      await Promise.resolve();
      const key = transitionKey(request);
      const saved = state.receipts.get(key);
      if (saved)
        return success(
          sameTransition(request, saved.request)
            ? { kind: "existing", receipt: copyReceipt(saved.receipt) }
            : { kind: "conflict" },
        );
      const retained = {
        request: copyTransition(request),
        receipt: copyReceipt(receipt),
      };
      state.receipts.set(key, retained);
      if (request.kind === "revocation") state.revoked.add(request.releaseId);
      else state.selected.set(request.publicSurfaceId, request.releaseId);
      return success({ kind: "created", receipt: copyReceipt(receipt) });
    },
  };
}

const digest = (character: string) =>
  parseSha256Digest(`sha256:${character.repeat(64)}`);
const app = (name: string): App => ({ appId: parseAppId(`app_${name}`) });
const release = (owner: App, name: string, character: string): Release => ({
  releaseId: parseReleaseId(`rel_${name.replaceAll("-", "")}`),
  appId: owner.appId,
  artifact: {
    artifactRef: parseArtifactRef(`artifact:${name}`),
    artifactDigest: digest(character),
    provenance: {
      sourceRevision: parseSourceRevision(`git:${character.repeat(40)}`),
      sourceTreeDigest: digest("b"),
      buildRecipeDigest: digest("c"),
    },
  },
});

function readerFor(
  outcomes: Map<string, ArtifactReadResult>,
  calls: {
    readonly artifactRef: Release["artifact"]["artifactRef"];
    readonly expectedDigest: Release["artifact"]["artifactDigest"];
  }[] = [],
): ArtifactReader {
  return {
    read: async ({ artifactRef, expectedDigest }) => {
      await Promise.resolve();
      const isChild = artifactRef.endsWith(".ui");
      const rootRef = isChild
        ? parseArtifactRef(artifactRef.slice(0, -3))
        : artifactRef;
      const outcome = outcomes.get(rootRef) ?? { kind: "missing" as const };
      calls.push({ artifactRef, expectedDigest });
      if (outcome.kind !== "verified") return outcome;
      if (!isChild) {
        const childRef = parseArtifactRef(`${artifactRef}.ui`);
        const childDigest = digest("9");
        const childBytes = outcome.bytes.copy();
        const manifest = new TextEncoder().encode(
          JSON.stringify({
            format: "fungi-app-v1",
            ui: {
              artifactRef: childRef,
              digest: childDigest,
              version: "v1",
              byteLength: childBytes.byteLength,
              mediaType: "text/html; charset=utf-8",
            },
          }),
        );
        return {
          kind: "verified" as const,
          digest: expectedDigest,
          mediaType: "application/vnd.fungi.app+json" as const,
          bytes: {
            byteLength: manifest.byteLength,
            copy: () => manifest.slice(),
          },
          byteLength: manifest.byteLength,
        };
      }
      return {
        ...outcome,
        digest: expectedDigest,
        bytes: {
          byteLength: outcome.byteLength,
          copy: () => outcome.bytes.copy(),
        },
      };
    },
  };
}

describe("App Release host fixture conformance", () => {
  it("proves create-once immutability, owned surfaces, and verified lifecycle transitions", async () => {
    const first = app("orchid");
    const second = app("lotus");
    const releaseA = release(first, "orchid-a", "a");
    const releaseB = release(first, "orchid-b", "b");
    const foreignRelease = release(second, "lotus-a", "d");
    const surface: PublicSurface = {
      publicSurfaceId: parsePublicSurfaceId("ps_orchid"),
      appId: first.appId,
      stableRoute: parseStableRoute("/orchid"),
    };
    const bytes = new TextEncoder().encode("<!doctype html><p>orchid</p>");
    const outcomes = new Map<string, ArtifactReadResult>([
      [
        releaseA.artifact.artifactRef,
        {
          kind: "verified",
          digest: releaseA.artifact.artifactDigest,
          mediaType: "text/html; charset=utf-8",
          bytes: { byteLength: bytes.byteLength, copy: () => bytes.slice() },
          byteLength: bytes.byteLength,
        },
      ],
      [
        releaseB.artifact.artifactRef,
        {
          kind: "verified",
          digest: releaseB.artifact.artifactDigest,
          mediaType: "text/html; charset=utf-8",
          bytes: { byteLength: bytes.byteLength, copy: () => bytes.slice() },
          byteLength: bytes.byteLength,
        },
      ],
      [
        foreignRelease.artifact.artifactRef,
        {
          kind: "verified",
          digest: foreignRelease.artifact.artifactDigest,
          mediaType: "text/html; charset=utf-8",
          bytes: { byteLength: bytes.byteLength, copy: () => bytes.slice() },
          byteLength: bytes.byteLength,
        },
      ],
    ]);
    const readerCalls: {
      readonly artifactRef: Release["artifact"]["artifactRef"];
      readonly expectedDigest: Release["artifact"]["artifactDigest"];
    }[] = [];
    const catalog = createAppReleaseCatalog({
      store: createHostFixtureStore(),
      artifactReader: readerFor(outcomes, readerCalls),
    });

    await expect(catalog.createApp(first)).resolves.toEqual(first);
    await expect(catalog.createApp(first)).resolves.toEqual(first);
    await expect(catalog.createApp(second)).resolves.toEqual(second);
    await expect(catalog.createRelease(releaseA)).resolves.toEqual(releaseA);
    await expect(catalog.createRelease(releaseA)).resolves.toEqual(releaseA);
    await expect(
      catalog.createRelease({ ...releaseA, appId: second.appId }),
    ).rejects.toBeInstanceOf(AppReleaseImmutableConflictError);
    await expect(
      catalog.createPublicSurface(platformSurface(surface)),
    ).resolves.toEqual(surface);
    await expect(
      catalog.createPublicSurface(
        platformSurface({ ...surface, appId: second.appId }),
      ),
    ).rejects.toBeInstanceOf(AppReleaseImmutableConflictError);
    await expect(
      catalog.createPublicSurface(
        platformSurface({
          ...surface,
          stableRoute: parseStableRoute("/lotus"),
        }),
      ),
    ).rejects.toBeInstanceOf(AppReleaseImmutableConflictError);

    const snapshot = await catalog.verifyReleaseArtifact(releaseA.releaseId);
    const expectedManifest = new TextEncoder().encode(
      JSON.stringify({
        format: "fungi-app-v1",
        ui: {
          artifactRef: parseArtifactRef(`${releaseA.artifact.artifactRef}.ui`),
          digest: digest("9"),
          version: "v1",
          byteLength: bytes.byteLength,
          mediaType: "text/html; charset=utf-8",
        },
      }),
    );
    expect(snapshot.mediaType).toBe("application/vnd.fungi.app+json");
    expect(snapshot.byteLength).toBe(expectedManifest.byteLength);
    expect(snapshot.bytes.byteLength).toBe(expectedManifest.byteLength);
    const copy = snapshot.bytes.copy();
    copy[0] = (copy[0] ?? 0) ^ 255;
    expect(snapshot.bytes.copy()).toEqual(expectedManifest);
    await expect(catalog.createRelease(releaseB)).resolves.toEqual(releaseB);
    await expect(catalog.createRelease(foreignRelease)).resolves.toEqual(
      foreignRelease,
    );
    await expect(
      catalog.verifyReleaseArtifact(releaseB.releaseId),
    ).resolves.toMatchObject({ kind: "verified" });
    await expect(
      catalog.verifyReleaseArtifact(foreignRelease.releaseId),
    ).resolves.toMatchObject({ kind: "verified" });
    expect(readerCalls).toEqual([
      {
        artifactRef: releaseA.artifact.artifactRef,
        expectedDigest: releaseA.artifact.artifactDigest,
      },
      {
        artifactRef: parseArtifactRef(`${releaseA.artifact.artifactRef}.ui`),
        expectedDigest: digest("9"),
      },
      {
        artifactRef: releaseB.artifact.artifactRef,
        expectedDigest: releaseB.artifact.artifactDigest,
      },
      {
        artifactRef: parseArtifactRef(`${releaseB.artifact.artifactRef}.ui`),
        expectedDigest: digest("9"),
      },
      {
        artifactRef: foreignRelease.artifact.artifactRef,
        expectedDigest: foreignRelease.artifact.artifactDigest,
      },
      {
        artifactRef: parseArtifactRef(
          `${foreignRelease.artifact.artifactRef}.ui`,
        ),
        expectedDigest: digest("9"),
      },
    ]);

    const promoteA: ReleaseTransition = {
      kind: "promotion",
      publicSurfaceId: surface.publicSurfaceId,
      releaseId: releaseA.releaseId,
      idempotencyKey: parseIdempotencyKey("idem_promote_a"),
    };
    const revokeA: ReleaseTransition = {
      kind: "revocation",
      releaseId: releaseA.releaseId,
      idempotencyKey: parseIdempotencyKey("idem_revoke_a"),
    };
    const rollbackB: ReleaseTransition = {
      kind: "rollback",
      publicSurfaceId: surface.publicSurfaceId,
      releaseId: releaseB.releaseId,
      idempotencyKey: parseIdempotencyKey("idem_rollback_b"),
    };
    const promoted = await catalog.transition(promoteA);
    await expect(catalog.transition(promoteA)).resolves.toEqual(promoted);
    await expect(catalog.transition(revokeA)).resolves.toMatchObject({
      transition: revokeA,
    });
    await expect(catalog.transition(promoteA)).resolves.toEqual(promoted);
    await expect(catalog.transition(rollbackB)).resolves.toMatchObject({
      transition: rollbackB,
    });

    const foreignTransition: ReleaseTransition = {
      kind: "promotion",
      publicSurfaceId: surface.publicSurfaceId,
      releaseId: foreignRelease.releaseId,
      idempotencyKey: parseIdempotencyKey("idem_foreign"),
    };
    await expect(catalog.transition(foreignTransition)).rejects.toBeInstanceOf(
      AppReleaseTransitionOwnershipConflictError,
    );
  });

  it("projects unavailable, missing, and digest-mismatch reader outcomes as typed failures", async () => {
    const owner = app("reader");
    const cases = [
      ["unavailable", AppReleaseArtifactUnavailableError],
      ["missing", AppReleaseArtifactMissingError],
      ["digest-mismatch", AppReleaseArtifactDigestMismatchError],
    ] as const;
    for (const [kind, failure] of cases) {
      const item = release(owner, kind, "e");
      const outcome: ArtifactReadResult =
        kind === "digest-mismatch"
          ? { kind, actualDigest: digest("f") }
          : { kind };
      const catalog = createAppReleaseCatalog({
        store: createHostFixtureStore(),
        artifactReader: readerFor(
          new Map([[item.artifact.artifactRef, outcome]]),
        ),
      });
      await catalog.createApp(owner);
      await catalog.createRelease(item);
      await expect(
        catalog.verifyReleaseArtifact(item.releaseId),
      ).rejects.toBeInstanceOf(failure);
    }
  });

  it("rejects promotion of an unverified or revoked Release", async () => {
    const owner = app("gated");
    const item = release(owner, "gated-a", "f");
    const surface: PublicSurface = {
      publicSurfaceId: parsePublicSurfaceId("ps_gated"),
      appId: owner.appId,
      stableRoute: parseStableRoute("/gated"),
    };
    const store = createHostFixtureStore();
    const catalog = createAppReleaseCatalog({
      store,
      artifactReader: readerFor(new Map()),
    });
    await catalog.createApp(owner);
    await catalog.createPublicSurface(platformSurface(surface));
    await catalog.createRelease(item);
    const request: ReleaseTransition = {
      kind: "promotion",
      publicSurfaceId: surface.publicSurfaceId,
      releaseId: item.releaseId,
      idempotencyKey: parseIdempotencyKey("idem_unverified"),
    };
    await expect(catalog.transition(request)).rejects.toBeInstanceOf(
      AppReleaseTransitionReleaseUnverifiedError,
    );
    const verifiedBytes = new TextEncoder().encode("<p>verified</p>");
    const verifiedCatalog = createAppReleaseCatalog({
      store,
      artifactReader: readerFor(
        new Map([
          [
            item.artifact.artifactRef,
            {
              kind: "verified",
              digest: item.artifact.artifactDigest,
              mediaType: "text/html; charset=utf-8",
              bytes: {
                byteLength: verifiedBytes.byteLength,
                copy: () => verifiedBytes.slice(),
              },
              byteLength: verifiedBytes.byteLength,
            },
          ],
        ]),
      ),
    });
    await verifiedCatalog.verifyReleaseArtifact(item.releaseId);
    const revoke: ReleaseTransition = {
      kind: "revocation",
      releaseId: item.releaseId,
      idempotencyKey: parseIdempotencyKey("idem_gated_revoke"),
    };
    await catalog.transition(revoke);
    await expect(
      verifiedCatalog.transition({
        ...request,
        idempotencyKey: parseIdempotencyKey("idem_revoked"),
      }),
    ).rejects.toBeInstanceOf(AppReleaseTransitionReleaseRevokedError);
  });
});
