import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { sqliteD1 } from "../src/testing.js";
import {
  APP_RELEASE_D1_FRESH_SCHEMA,
  createD1AppReleaseStore,
  readD1SurfaceTransitionBasis,
} from "../src/cloudflare.js";
import { capturePublicRoutePolicy } from "../src/public-route-policy.js";
import { configureD1PublicRoutes } from "../src/public-routes.js";
import {
  emptyAppDeclaration,
  parseAppId,
  parsePublicSurfaceId,
  parseStableRoute,
  parseReleaseId,
  parseArtifactRef,
  parseSha256Digest,
  parseSourceRevision,
  parseIdempotencyKey,
  parseAppTransitionId,
} from "../src/index.js";

const close: (() => void)[] = [];
afterEach(() => {
  for (const done of close.splice(0)) done();
});

async function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const database = sqliteD1(sqlite);
  close.push(() => {
    sqlite.close();
  });
  sqlite.exec(APP_RELEASE_D1_FRESH_SCHEMA);
  const appId = parseAppId("app_routeguard");
  const stableRoute = parseStableRoute("/routeguard");
  const policy = await capturePublicRoutePolicy({
    platformRoutes: [{ appId, stableRoute }],
    structuralRoutes: ["/private-apps", "/surfaces"],
  });
  await configureD1PublicRoutes(database, policy);
  const store = createD1AppReleaseStore(database);
  expect((await store.createAppIfAbsent({ appId })).kind).toBe("success");
  const definition = {
    appId,
    stableRoute,
    publicSurfaceId: parsePublicSurfaceId("ps_routeguard"),
    publisher: {
      kind: "platform" as const,
      teamId: "system-team",
      userId: "operator",
      requestKey: "ps_routeguard",
    },
  };
  expect(await store.createPublicSurfaceIfAbsent(definition)).toMatchObject({
    kind: "success",
    value: { kind: "created" },
  });
  const digest = parseSha256Digest(`sha256:${"a".repeat(64)}`);
  const releaseId = parseReleaseId("rel_routeguard");
  await store.createReleaseIfAbsent({
    appId,
    releaseId,
    artifact: {
      artifactRef: parseArtifactRef("artifact:routeguard"),
      artifactDigest: digest,
      provenance: {
        sourceRevision: parseSourceRevision(`git:${"a".repeat(40)}`),
        sourceTreeDigest: digest,
        buildRecipeDigest: digest,
      },
    },
  });
  await store.recordReleaseVerification?.({
    releaseId,
    digest,
    mediaType: "application/vnd.fungi.app+json",
    description: {
      format: "fungi-app-v1",
      ui: null,
      backend: null,
      declaration: emptyAppDeclaration,
    },
  });
  const request = {
    kind: "promotion" as const,
    idempotencyKey: parseIdempotencyKey("idem_publish-routeguard"),
    releaseId,
    publicSurfaceId: definition.publicSurfaceId,
  };
  const receipt = {
    transition: request,
    transitionId: parseAppTransitionId("app_transition_aaaaaaaaaaaaaaaaaaaaa"),
  };
  return { sqlite, database, store, definition, request, receipt };
}

it("commits the claim with its receipt and prevents an unselected Surface from shadowing it", async () => {
  const { database, store, definition, request, receipt } = await fixture();
  expect(await store.persistTransition?.(request, receipt)).toMatchObject({
    kind: "success",
    value: { kind: "created" },
  });
  expect(
    await readD1SurfaceTransitionBasis(
      database,
      definition.stableRoute,
      request.releaseId,
    ),
  ).toMatchObject({
    kind: "success",
    value: { kind: "selected", publicSurfaceId: definition.publicSurfaceId },
  });
  expect(
    await store.createPublicSurfaceIfAbsent({
      ...definition,
      publicSurfaceId: parsePublicSurfaceId("ps_shadow"),
      publisher: { ...definition.publisher, requestKey: "shadow" },
    }),
  ).toEqual({ kind: "success", value: { kind: "conflict" } });
  expect(
    await readD1SurfaceTransitionBasis(
      database,
      definition.stableRoute,
      request.releaseId,
    ),
  ).toMatchObject({
    kind: "success",
    value: { kind: "selected", publicSurfaceId: definition.publicSurfaceId },
  });
});

it("replays the same request with its canonical minted Surface and rejects changed material", async () => {
  const { store, definition } = await fixture();
  expect(
    await store.createPublicSurfaceIfAbsent({
      ...definition,
      publicSurfaceId: parsePublicSurfaceId("ps_retry"),
    }),
  ).toMatchObject({
    kind: "success",
    value: {
      kind: "existing",
      surface: { publicSurfaceId: definition.publicSurfaceId },
    },
  });
  expect(
    await store.createPublicSurfaceIfAbsent({
      ...definition,
      publisher: { ...definition.publisher, userId: "different-operator" },
    }),
  ).toEqual({ kind: "success", value: { kind: "conflict" } });
});

it("does not claim on a guarded zero-row insert or an idempotency conflict", async () => {
  const { sqlite, store, request, receipt } = await fixture();
  await store.persistTransition?.(
    {
      kind: "revocation",
      idempotencyKey: parseIdempotencyKey("idem_revoke"),
      releaseId: request.releaseId,
    },
    {
      transitionId: parseAppTransitionId(
        "app_transition_bbbbbbbbbbbbbbbbbbbbb",
      ),
      transition: {
        kind: "revocation",
        idempotencyKey: parseIdempotencyKey("idem_revoke"),
        releaseId: request.releaseId,
      },
    },
  );
  expect(await store.persistTransition?.(request, receipt)).toEqual({
    kind: "success",
    value: { kind: "lifecycle-conflict" },
  });
  expect(
    sqlite.prepare("SELECT count(*) AS n FROM app_release_route_claims").get(),
  ).toEqual({ n: 0 });
});

it("database guards refuse OR IGNORE and OR REPLACE bypasses with no partial claim", async () => {
  const { sqlite, request } = await fixture();
  for (const conflict of ["IGNORE", "REPLACE"]) {
    expect(() =>
      sqlite
        .prepare(
          `INSERT OR ${conflict} INTO app_release_transitions
      (transition_id,operation_kind,idempotency_key,release_id,public_surface_id) VALUES (?,?,?,?,?)`,
        )
        .run(
          `app_transition_${conflict.toLowerCase().padEnd(21, "x")}`,
          "promotion",
          conflict,
          request.releaseId,
          "ps_foreign",
        ),
    ).toThrow();
  }
  expect(
    sqlite.prepare("SELECT count(*) AS n FROM app_release_route_claims").get(),
  ).toEqual({ n: 0 });
});

it("retires without revocation, binds operator intent and completes with a seven-day hold", async () => {
  const { sqlite, database, store, request, receipt, definition } =
    await fixture();
  const { createD1PublicRouteModeration } =
    await import("../src/public-route-moderation.js");
  await store.persistTransition?.(request, receipt);
  let seconds = 1_800_000_000;
  sqlite.function("unixepoch", () => seconds);
  const moderation = createD1PublicRouteModeration(
    database,
    () => seconds * 1000,
  );
  const command = {
    operationId: "removal-a",
    operatorId: "operator-a",
    reason: "Squatting review",
    target: {
      publicSurfaceId: definition.publicSurfaceId,
      appId: definition.appId,
      teamId: "system-team",
      stableRoute: definition.stableRoute,
    },
  };
  expect(await moderation.prepareRemoval(command)).toMatchObject({
    kind: "recorded",
    operation: { state: "pending" },
  });
  expect(
    await readD1SurfaceTransitionBasis(
      database,
      definition.stableRoute,
      request.releaseId,
    ),
  ).toEqual({ kind: "success", value: { kind: "absent" } });
  expect(await store.readReleaseLifecycle?.(request.releaseId)).toMatchObject({
    kind: "success",
    value: { revocation: { kind: "active" } },
  });
  expect(
    await moderation.prepareRemoval({ ...command, reason: "Changed reason" }),
  ).toEqual({ kind: "conflict" });
  expect(await moderation.pending()).toHaveLength(1);
  seconds += 100;
  expect(
    await moderation.complete(command.operationId, "operator-b"),
  ).toMatchObject({ kind: "recorded", operation: { state: "complete" } });
  expect(
    sqlite
      .prepare(
        "SELECT phase,operator_id FROM app_release_route_operation_steps ORDER BY recorded_at",
      )
      .all(),
  ).toEqual([
    { phase: "prepared", operator_id: "operator-a" },
    { phase: "completed", operator_id: "operator-b" },
  ]);
  const reallow = {
    ...command,
    operationId: "allow-a",
    operatorId: "operator-c",
    reason: "Appeal accepted",
  };
  expect(
    await moderation.prepareReallow(reallow, command.operationId),
  ).toMatchObject({ kind: "recorded" });
  expect(
    await moderation.complete(reallow.operationId, "operator-c"),
  ).toMatchObject({ kind: "recorded" });
  const fresh = {
    ...definition,
    publicSurfaceId: parsePublicSurfaceId("ps_fresh"),
    publisher: { ...definition.publisher, requestKey: "fresh" },
  };
  seconds += 7 * 24 * 60 * 60 - 1;
  expect(await store.createPublicSurfaceIfAbsent(fresh)).toEqual({
    kind: "success",
    value: { kind: "conflict" },
  });
  seconds++;
  expect(await store.createPublicSurfaceIfAbsent(fresh)).toMatchObject({
    kind: "success",
    value: { kind: "created" },
  });
  expect(
    await store.persistTransition?.(
      { ...request, idempotencyKey: parseIdempotencyKey("idem_retired") },
      {
        transition: {
          ...request,
          idempotencyKey: parseIdempotencyKey("idem_retired"),
        },
        transitionId: parseAppTransitionId(
          "app_transition_ccccccccccccccccccccc",
        ),
      },
    ),
  ).toEqual({ kind: "success", value: { kind: "lifecycle-conflict" } });
  await store.persistTransition?.(
    {
      ...request,
      publicSurfaceId: fresh.publicSurfaceId,
      idempotencyKey: parseIdempotencyKey("idem_fresh"),
    },
    {
      transition: {
        ...request,
        publicSurfaceId: fresh.publicSurfaceId,
        idempotencyKey: parseIdempotencyKey("idem_fresh"),
      },
      transitionId: parseAppTransitionId(
        "app_transition_ddddddddddddddddddddd",
      ),
    },
  );
  seconds++;
  await moderation.complete(command.operationId, "operator-d");
  expect(
    await readD1SurfaceTransitionBasis(
      database,
      definition.stableRoute,
      request.releaseId,
    ),
  ).toMatchObject({
    kind: "success",
    value: { kind: "selected", publicSurfaceId: fresh.publicSurfaceId },
  });
});

it("rolls back the removal phase when its audit cannot commit", async () => {
  const { sqlite, database, store, request, receipt, definition } =
    await fixture();
  const { createD1PublicRouteModeration } =
    await import("../src/public-route-moderation.js");
  await store.persistTransition?.(request, receipt);
  sqlite.exec(
    "CREATE TRIGGER fail_audit BEFORE INSERT ON app_release_route_operation_steps BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
  );
  expect(
    await createD1PublicRouteModeration(database).prepareRemoval({
      operationId: "failed-removal",
      operatorId: "operator",
      reason: "Audit must commit",
      target: {
        publicSurfaceId: definition.publicSurfaceId,
        appId: definition.appId,
        teamId: "system-team",
        stableRoute: definition.stableRoute,
      },
    }),
  ).toEqual({ kind: "unavailable" });
  expect(
    await readD1SurfaceTransitionBasis(
      database,
      definition.stableRoute,
      request.releaseId,
    ),
  ).toMatchObject({ kind: "success", value: { kind: "selected" } });
  expect(
    sqlite
      .prepare("SELECT count(*) AS n FROM app_release_surface_retirements")
      .get(),
  ).toEqual({ n: 0 });
});

it("keeps revocation recipients in buyer references after seller Surfaces are erased", async () => {
  const { sqlite, database, store, request, receipt, definition } =
    await fixture();
  const { createD1BuyerReferences } =
    await import("../src/buyer-references.js");
  await store.persistTransition?.(request, receipt);
  const buyers = createD1BuyerReferences(database);
  expect(
    await buyers.retain({
      buyerTeamId: "buyer-team",
      installationId: "buyer-installation",
      appId: definition.appId,
      releaseId: request.releaseId,
      artifactDigest: parseSha256Digest(`sha256:${"a".repeat(64)}`),
      publicSurfaceId: definition.publicSurfaceId,
      stableRoute: definition.stableRoute,
      acquisitionVersion: 1,
      acquisitionDecisionId: "acquisition-a",
      selectionSequence: 1,
    }),
  ).toBe(true);
  // Fault injection at the review's erasure boundary: no Surface or selection row remains.
  sqlite.exec(`INSERT INTO app_release_erasure_scope VALUES (1,'app_routeguard');
    DELETE FROM app_release_route_claims;
    DELETE FROM app_release_transitions;
    DELETE FROM app_release_public_surfaces;
    DELETE FROM app_release_erasure_scope;`);
  const revocation = {
    kind: "revocation" as const,
    releaseId: request.releaseId,
    idempotencyKey: parseIdempotencyKey("idem_buyerrevoked"),
  };
  const revoked = {
    transition: revocation,
    transitionId: parseAppTransitionId("app_transition_eeeeeeeeeeeeeeeeeeeee"),
  };
  expect(await store.persistTransition?.(revocation, revoked)).toMatchObject({
    kind: "success",
    value: { kind: "created" },
  });
  const obligation = await store.transitionObligations.readByTransitionId(
    revoked.transitionId,
  );
  expect(obligation).toMatchObject({
    kind: "success",
    value: { affectedSurfaces: [], affectedBuyerApps: [definition.appId] },
  });
});

it("keeps an acquired release usable after unlist and refuses it after a safety revocation", async () => {
  const { database, store, request, receipt, definition } = await fixture();
  const { createD1BuyerReferences } =
    await import("../src/buyer-references.js");
  const { createD1PublicRouteModeration } =
    await import("../src/public-route-moderation.js");
  await store.persistTransition?.(request, receipt);
  const buyers = createD1BuyerReferences(database);
  const identity = {
    buyerTeamId: "buyer-team",
    installationId: "buyer-installation",
    releaseId: request.releaseId,
  };
  expect(
    await buyers.retain({
      ...identity,
      appId: definition.appId,
      artifactDigest: parseSha256Digest(`sha256:${"a".repeat(64)}`),
      publicSurfaceId: definition.publicSurfaceId,
      stableRoute: definition.stableRoute,
      acquisitionVersion: 1,
      acquisitionDecisionId: "acquisition-a",
      selectionSequence: 1,
    }),
  ).toBe(true);
  const moderation = createD1PublicRouteModeration(database);
  expect(
    await moderation.prepareRemoval({
      operationId: "unlist-keep-buyers",
      operatorId: "operator",
      reason: "Squatting",
      target: {
        appId: definition.appId,
        publicSurfaceId: definition.publicSurfaceId,
        stableRoute: definition.stableRoute,
        teamId: definition.publisher.teamId,
      },
    }),
  ).toMatchObject({ kind: "recorded" });
  expect(
    await moderation.complete("unlist-keep-buyers", "operator"),
  ).toMatchObject({ kind: "recorded" });
  expect(await buyers.readRetained(identity)).toMatchObject({
    appId: definition.appId,
    releaseId: request.releaseId,
  });
  const revoke = {
    kind: "revocation" as const,
    releaseId: request.releaseId,
    idempotencyKey: parseIdempotencyKey("idem_safety-buyers"),
  };
  expect(
    await store.persistTransition?.(revoke, {
      transition: revoke,
      transitionId: parseAppTransitionId(
        "app_transition_fffffffffffffffffffff",
      ),
    }),
  ).toMatchObject({ kind: "success", value: { kind: "created" } });
  expect(await buyers.readRetained(identity)).toBeNull();
});

it("tombstones a seller's route during scoped erasure without deleting a buyer's verified release", async () => {
  const { sqlite, database, store, request, receipt, definition } =
    await fixture();
  const { createD1BuyerReferences } =
    await import("../src/buyer-references.js");
  const { createTeamAppReleaseErasure } = await import("../src/cloudflare.js");
  await store.persistTransition?.(request, receipt);
  // The registration is the erasure owner's input; Surface creation and selection above use the real writer.
  sqlite
    .prepare(
      "INSERT INTO app_release_team_publishers(app_id,team_id,source_provider,source_repository,source_branch) VALUES (?,?,'github',?,'main')",
    )
    .run(definition.appId, "system-team", definition.appId);
  const buyers = createD1BuyerReferences(database);
  const identity = {
    buyerTeamId: "buyer-team",
    installationId: "buyer-installation",
    releaseId: request.releaseId,
  };
  await buyers.retain({
    ...identity,
    appId: definition.appId,
    artifactDigest: parseSha256Digest(`sha256:${"a".repeat(64)}`),
    publicSurfaceId: definition.publicSurfaceId,
    stableRoute: definition.stableRoute,
    acquisitionVersion: 1,
    acquisitionDecisionId: "acquisition-a",
    selectionSequence: 1,
  });
  const { createD1PublicRouteModeration } =
    await import("../src/public-route-moderation.js");
  const moderation = createD1PublicRouteModeration(database);
  const removal = {
    operationId: "interrupted-before-erasure",
    operatorId: "operator",
    reason: "Private review detail",
    target: {
      appId: definition.appId,
      publicSurfaceId: definition.publicSurfaceId,
      stableRoute: definition.stableRoute,
      teamId: "system-team",
    },
  };
  expect(await moderation.prepareRemoval(removal)).toMatchObject({
    kind: "recorded",
  });
  const deleted: string[] = [];
  const eraser = createTeamAppReleaseErasure(database, {
    head: () => Promise.resolve({}),
    get: () => Promise.resolve(null),
    delete: (key) => {
      deleted.push(key);
      return Promise.resolve();
    },
  });
  await eraser.erase("system-team");
  expect(await buyers.readRetained(identity)).toMatchObject({
    releaseId: request.releaseId,
  });
  expect(
    await store.readPublicSurface(definition.publicSurfaceId),
  ).toMatchObject({ kind: "success", value: { kind: "absent" } });
  expect(await store.readRelease(request.releaseId)).toMatchObject({
    kind: "success",
    value: { kind: "found" },
  });
  expect(deleted).toEqual([]);
  expect(
    await eraser.readback("system-team", [definition.appId], []),
  ).toMatchObject({
    clear: false,
    personalClear: true,
    retainedArtifacts: [{ state: "pending", releaseIds: [request.releaseId] }],
  });
  expect(await moderation.prepareRemoval(removal)).toEqual({
    kind: "conflict",
  });
  expect(await moderation.pending()).toEqual([]);
  expect(
    sqlite
      .prepare(
        "SELECT state,reason,team_id='system-team' AS seller_link FROM app_release_route_operations",
      )
      .get(),
  ).toEqual({
    state: "superseded-by-erasure",
    reason: "Erased",
    seller_link: 0,
  });
  expect(
    sqlite
      .prepare(
        "SELECT cause,until_s>unixepoch()+89*24*60*60 AS held FROM app_release_route_holds",
      )
      .get(),
  ).toEqual({ cause: "erasure", held: 1 });
  expect(
    sqlite
      .prepare(
        "SELECT count(*) AS n FROM app_release_team_publishers WHERE team_id='system-team'",
      )
      .get(),
  ).toEqual({ n: 0 });
  const { createD1ArtifactDispositions } =
    await import("../src/artifact-dispositions.js");
  const dispositions = createD1ArtifactDispositions(database);
  const pending = await dispositions.pending();
  expect(pending).toMatchObject([
    {
      app_id: definition.appId,
      state: "pending",
      releaseIds: [request.releaseId],
    },
  ]);
  const disposition = pending[0];
  if (disposition === null || disposition === undefined)
    throw new Error("Missing held-artifact disposition");
  expect(
    await dispositions.prepare({
      dispositionId: disposition.disposition_id,
      requestId: "retain-erased-app",
      operatorId: "operator-a",
      reason: "Keep buyer installs working",
      action: { kind: "retain-detached" },
    }),
  ).toMatchObject({ kind: "recorded" });
  expect(
    await dispositions.prepare({
      dispositionId: disposition.disposition_id,
      requestId: "retain-erased-app",
      operatorId: "operator-a",
      reason: "Changed reason",
      action: { kind: "retain-detached" },
    }),
  ).toEqual({ kind: "conflict" });
  expect(
    await dispositions.complete(disposition.disposition_id, "operator-b"),
  ).toMatchObject({ kind: "recorded", disposition: { state: "retained" } });
  expect(await dispositions.pending()).toEqual([]);
  expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("binds a safety takedown to its reason and target and audits only completed revocations", async () => {
  const { database, store, request, receipt, definition } = await fixture();
  const { createD1SafetyTakedowns } = await import("../src/safety-takedown.js");
  await store.persistTransition?.(request, receipt);
  const safety = createD1SafetyTakedowns(database);
  const command = {
    operationId: "safety-a",
    operatorId: "operator-a",
    appId: definition.appId,
    stableRoute: definition.stableRoute,
    reason: "Malware",
  };
  expect(await safety.prepare(command)).toMatchObject({
    kind: "recorded",
    releaseIds: [request.releaseId],
  });
  const republish = {
    ...request,
    idempotencyKey: parseIdempotencyKey("idem_safety-republish"),
  };
  expect(
    await store.persistTransition?.(republish, {
      transition: republish,
      transitionId: parseAppTransitionId(
        "app_transition_hhhhhhhhhhhhhhhhhhhhh",
      ),
    }),
  ).toMatchObject({ kind: "success", value: { kind: "lifecycle-conflict" } });
  const { createD1BuyerReferences } =
    await import("../src/buyer-references.js");
  expect(
    await createD1BuyerReferences(database).retain({
      buyerTeamId: "late-buyer",
      installationId: "late-install",
      appId: definition.appId,
      releaseId: request.releaseId,
      artifactDigest: parseSha256Digest(`sha256:${"a".repeat(64)}`),
      publicSurfaceId: definition.publicSurfaceId,
      stableRoute: definition.stableRoute,
      acquisitionVersion: 1,
      acquisitionDecisionId: "late",
      selectionSequence: 1,
    }),
  ).toBe(false);
  expect(
    await safety.prepare({ ...command, reason: "Different reason" }),
  ).toEqual({ kind: "conflict" });
  expect(await safety.complete(command.operationId, "operator-b")).toEqual({
    kind: "conflict",
  });
  expect(await safety.pending()).toMatchObject([
    { operation_id: command.operationId },
  ]);
  const revoked = {
    kind: "revocation" as const,
    releaseId: request.releaseId,
    idempotencyKey: parseIdempotencyKey("idem_safety-a"),
  };
  await store.persistTransition?.(revoked, {
    transition: revoked,
    transitionId: parseAppTransitionId("app_transition_ggggggggggggggggggggg"),
  });
  expect(await safety.complete(command.operationId, "operator-b")).toEqual({
    kind: "conflict",
  });
  const obligations = await store.transitionObligations.read({});
  if (obligations.kind !== "success" || obligations.value.length !== 1)
    throw new Error("Missing safety obligation");
  const sequence = obligations.value[0]?.sequence;
  if (sequence === undefined) throw new Error("Missing safety sequence");
  await store.transitionObligations.recordTeamRecipientPage(sequence, {
    teamIds: [],
    complete: true,
  });
  await store.transitionObligations.acknowledge(sequence);
  expect(await safety.complete(command.operationId, "operator-b")).toEqual({
    kind: "recorded",
  });
  expect(await safety.pending()).toEqual([]);
});

it.each(["delivered", "recipient-erased"] as const)(
  "settles captured buyer notices only with a receipt or audited recipient erasure: %s",
  async (outcome) => {
    const { sqlite, database, store, request, receipt, definition } =
      await fixture();
    const { createD1BuyerReferences } =
      await import("../src/buyer-references.js");
    const { createTeamAppReleaseErasure } =
      await import("../src/cloudflare.js");
    const { createD1ArtifactDispositions } =
      await import("../src/artifact-dispositions.js");
    await store.persistTransition?.(request, receipt);
    sqlite
      .prepare(
        "INSERT INTO app_release_team_publishers(app_id,team_id,source_provider,source_repository,source_branch) VALUES (?,?,'github',?,'main')",
      )
      .run(definition.appId, "system-team", definition.appId);
    const buyers = createD1BuyerReferences(database);
    for (const installationId of ["buyer-install-a", "buyer-install-b"]) {
      expect(
        await buyers.retain({
          buyerTeamId: "buyer-team",
          installationId,
          releaseId: request.releaseId,
          appId: definition.appId,
          artifactDigest: parseSha256Digest(`sha256:${"a".repeat(64)}`),
          publicSurfaceId: definition.publicSurfaceId,
          stableRoute: definition.stableRoute,
          acquisitionVersion: 1,
          acquisitionDecisionId: "acquisition-a",
          selectionSequence: 1,
        }),
      ).toBe(true);
    }
    await createTeamAppReleaseErasure(database, {
      head: () => Promise.resolve({}),
      get: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
    }).erase("system-team");
    const dispositions = createD1ArtifactDispositions(database);
    const disposition = (await dispositions.pending())[0];
    if (disposition == null) throw new Error("Missing disposition");
    const id = disposition.disposition_id;
    expect(await dispositions.noticeRecipients(id)).toEqual([
      { teamId: "buyer-team", receipt: null, erasedBy: null, erasedAt: null },
    ]);
    const command = {
      dispositionId: id,
      requestId: "revoke-erased-app",
      operatorId: "operator-a",
      reason: "Unsafe retained code",
      action: { kind: "revoke-with-notice" as const },
    };
    expect(await dispositions.prepare(command)).toMatchObject({
      kind: "recorded",
    });
    const revoked = {
      kind: "revocation" as const,
      releaseId: request.releaseId,
      idempotencyKey: parseIdempotencyKey("idem_erasure-notices"),
    };
    await store.persistTransition?.(revoked, {
      transition: revoked,
      transitionId: parseAppTransitionId(
        "app_transition_jjjjjjjjjjjjjjjjjjjjj",
      ),
    });
    expect(await dispositions.complete(id, "operator-b")).toEqual({
      kind: "conflict",
    });
    expect(
      await dispositions.recordNoticeReceipt(
        id,
        "foreign-team",
        "foreign-receipt",
      ),
    ).toBe(false);
    if (outcome === "delivered") {
      expect(
        await dispositions.recordNoticeReceipt(
          id,
          "buyer-team",
          "inbox-receipt-a",
        ),
      ).toBe(true);
      expect(
        await dispositions.recordNoticeRecipientErased(
          id,
          "buyer-team",
          "operator-b",
        ),
      ).toBe(false);
      expect(
        await dispositions.recordNoticeReceipt(
          id,
          "buyer-team",
          "changed-receipt",
        ),
      ).toBe(false);
    } else {
      expect(
        await dispositions.recordNoticeRecipientErased(
          id,
          "foreign-team",
          "operator-b",
        ),
      ).toBe(false);
      expect(
        await dispositions.recordNoticeRecipientErased(
          id,
          "buyer-team",
          "operator-b",
        ),
      ).toBe(true);
      expect(
        await dispositions.recordNoticeReceipt(
          id,
          "buyer-team",
          "inbox-receipt-a",
        ),
      ).toBe(false);
      const settled = await dispositions.noticeRecipients(id);
      expect(settled).toMatchObject([
        {
          teamId: "buyer-team",
          receipt: null,
          erasedBy: "operator-b",
        },
      ]);
      expect(settled[0]?.erasedAt).toBeGreaterThan(0);
    }
    // Notice delivery alone cannot acknowledge still-pending release invalidation.
    expect(await dispositions.complete(id, "operator-b")).toEqual({
      kind: "conflict",
    });
    const obligation = await store.transitionObligations.readByTransitionId(
      parseAppTransitionId("app_transition_jjjjjjjjjjjjjjjjjjjjj"),
    );
    if (obligation.kind !== "success" || "kind" in obligation.value)
      throw new Error("Missing revocation obligation");
    const sequence = obligation.value.sequence;
    await store.transitionObligations.recordTeamRecipientPage(sequence, {
      teamIds: ["buyer-team"],
      complete: true,
    });
    await store.transitionObligations.recordTeamRecipientOutcome(
      sequence,
      "buyer-team",
      "applied",
    );
    expect(
      await store.transitionObligations.acknowledge(sequence),
    ).toMatchObject({ kind: "success", value: { state: "acknowledged" } });
    expect(await dispositions.complete(id, "operator-b")).toMatchObject({
      kind: "recorded",
      disposition: { state: "revoked" },
    });
  },
);

it("replays retained installation custody across newer acquisition decisions without losing its latest basis", async () => {
  const { database, store, request, receipt, definition } = await fixture();
  const { createD1BuyerReferences } =
    await import("../src/buyer-references.js");
  await store.persistTransition?.(request, receipt);
  const buyers = createD1BuyerReferences(database);
  const input = {
    buyerTeamId: "buyer-team",
    installationId: "buyer-install",
    appId: definition.appId,
    releaseId: request.releaseId,
    artifactDigest: parseSha256Digest(`sha256:${"a".repeat(64)}`),
    publicSurfaceId: definition.publicSurfaceId,
    stableRoute: definition.stableRoute,
    acquisitionVersion: 1,
    acquisitionDecisionId: "acquisition-one",
    selectionSequence: 1,
  };
  expect(await buyers.retain(input)).toBe(true);
  expect(
    await buyers.retain({
      ...input,
      acquisitionVersion: 2,
      acquisitionDecisionId: "acquisition-two",
    }),
  ).toBe(true);
  expect(await buyers.retain(input)).toBe(true);
  expect(await buyers.read(input)).toMatchObject({
    acquisitionVersion: 2,
    acquisitionDecisionId: "acquisition-two",
  });
  expect(
    await buyers.retain({
      ...input,
      artifactDigest: parseSha256Digest(`sha256:${"b".repeat(64)}`),
    }),
  ).toBe(false);
});
