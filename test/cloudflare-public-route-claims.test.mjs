import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
  APP_RELEASE_D1_FRESH_SCHEMA,
  createD1AppReleaseStore,
  createD1TeamAppPublisherRegistry,
} from "../src/cloudflare.js";
import { capturePublicRoutePolicy } from "../src/public-route-policy.js";
import {
  createD1PublicRouteModeration,
  recordD1PlatformOwnerReplay,
} from "../src/public-route-moderation.js";
import * as publicRoutes from "../src/public-routes.js";
import { configureD1PublicRoutes } from "../src/public-routes.js";
import { emptyAppDeclaration } from "../src/index.js";

it("native D1 commits receipt and claim together and rolls both back when the batch aborts", async () => {
  const db = env.APP_RELEASE_ROUTES;
  await db.exec(APP_RELEASE_D1_FRESH_SCHEMA);
  await configureD1PublicRoutes(
    db,
    await capturePublicRoutePolicy({
      platformRoutes: [
        { appId: "app_nativeclaim", stableRoute: "/nativeclaim" },
      ],
      structuralRoutes: ["/private-apps", "/surfaces"],
    }),
  );
  const store = createD1AppReleaseStore(db);
  await store.createAppIfAbsent({ appId: "app_nativeclaim" });
  expect(
    await store.createPublicSurfaceIfAbsent({
      appId: "app_nativeclaim",
      publicSurfaceId: "ps_nativeclaim",
      stableRoute: "/nativeclaim",
      publisher: {
        kind: "platform",
        teamId: "system-team",
        userId: "operator",
        requestKey: "ps_nativeclaim",
      },
    }),
  ).toMatchObject({ kind: "success", value: { kind: "created" } });
  const digest = `sha256:${"a".repeat(64)}`;
  await store.createReleaseIfAbsent({
    appId: "app_nativeclaim",
    releaseId: "rel_nativeclaim",
    artifact: {
      artifactRef: "artifact:nativeclaim",
      artifactDigest: digest,
      provenance: {
        sourceRevision: `git:${"a".repeat(40)}`,
        sourceTreeDigest: digest,
        buildRecipeDigest: digest,
      },
    },
  });
  expect(
    await store.recordReleaseVerification({
      releaseId: "rel_nativeclaim",
      digest,
      mediaType: "application/vnd.fungi.app+json",
      description: {
        format: "fungi-app-v1",
        ui: null,
        backend: null,
        declaration: emptyAppDeclaration,
      },
    }),
  ).toMatchObject({ kind: "success" });
  const statement = db.prepare(`INSERT INTO app_release_transitions
    (transition_id,operation_kind,idempotency_key,release_id,public_surface_id)
    VALUES ('app_transition_aaaaaaaaaaaaaaaaaaaaa','promotion','idem_nativeclaim','rel_nativeclaim','ps_nativeclaim')`);
  await expect(
    db.batch([
      statement,
      db.prepare("INSERT INTO app_release_apps(app_id) VALUES (NULL)"),
    ]),
  ).rejects.toThrow();
  expect(
    await db
      .prepare("SELECT count(*) AS n FROM app_release_route_claims")
      .first(),
  ).toEqual({ n: 0 });
  expect(
    await db
      .prepare("SELECT count(*) AS n FROM app_release_transitions")
      .first(),
  ).toEqual({ n: 0 });
  await statement.run();
  expect(
    await db
      .prepare("SELECT public_surface_id FROM app_release_route_claims")
      .first(),
  ).toEqual({ public_surface_id: "ps_nativeclaim" });
  // The authenticated operator can replay only the held platform target; ordinary
  // creation remains strict about publisher-user identity.
  const original = {
    appId: "app_nativeclaim",
    publicSurfaceId: "ps_nativeclaim",
    stableRoute: "/nativeclaim",
    publisher: {
      kind: "platform",
      teamId: "system-team",
      userId: "other-operator",
      requestKey: "ps_nativeclaim",
    },
  };
  expect(await store.createPublicSurfaceIfAbsent(original)).toMatchObject({
    kind: "success",
    value: { kind: "conflict" },
  });
  const replay = {
    appId: "app_nativeclaim",
    publicSurfaceId: "ps_nativeclaim",
    stableRoute: "/nativeclaim",
    teamId: "system-team",
    operatorId: "other-operator",
  };
  expect(await recordD1PlatformOwnerReplay(db, replay)).toBe(true);
  expect(
    await db
      .prepare(
        "SELECT publisher_user_id FROM app_release_public_surfaces WHERE public_surface_id='ps_nativeclaim'",
      )
      .first(),
  ).toEqual({ publisher_user_id: "operator" });
  expect(
    await db
      .prepare(
        "SELECT operator_user_id,owner_team_id,publisher_user_id FROM app_release_platform_owner_replays",
      )
      .first(),
  ).toEqual({
    operator_user_id: "other-operator",
    owner_team_id: "system-team",
    publisher_user_id: "operator",
  });
  expect(
    await recordD1PlatformOwnerReplay(db, {
      ...replay,
      operatorId: "operator",
    }),
  ).toBe(false);
  for (const change of [
    { teamId: "customer-team" },
    { appId: "app_other" },
    { stableRoute: "/other" },
  ])
    expect(
      await recordD1PlatformOwnerReplay(db, { ...replay, ...change }),
    ).toBe(false);
  // A customer definition cannot use the operator replay to upgrade its authority.
  expect(
    await store.createPublicSurfaceIfAbsent({
      ...original,
      publisher: { ...original.publisher, kind: "customer" },
    }),
  ).toMatchObject({ kind: "success", value: { kind: "conflict" } });
  expect(
    await db
      .prepare("SELECT count(*) AS n FROM app_release_platform_owner_replays")
      .first(),
  ).toEqual({ n: 1 });
});

it("refuses replay of held customer claims and removing platform claims", async () => {
  const db = env.APP_RELEASE_REPLAY;
  await db.exec(APP_RELEASE_D1_FRESH_SCHEMA);
  await configureD1PublicRoutes(
    db,
    await capturePublicRoutePolicy({
      platformRoutes: [
        { appId: "app_platformdeny", stableRoute: "/platformdeny" },
      ],
      structuralRoutes: ["/private-apps", "/surfaces"],
    }),
  );
  const store = createD1AppReleaseStore(db);
  await db
    .prepare(
      `INSERT INTO publisher_template_seed_receipts
    (template_repository,seed_revision,platform_app_id,source_revision,source_tree_digest,recipe_json,build_recipe_digest)
    VALUES (?,?,?,?,?,?,?)`,
    )
    .bind(
      "template-shed",
      `git:${"b".repeat(40)}`,
      "app_shed",
      `git:${"b".repeat(40)}`,
      `sha256:${"b".repeat(64)}`,
      "{}",
      `sha256:${"b".repeat(64)}`,
    )
    .run();
  await createD1TeamAppPublisherRegistry(db).register({
    appId: "app_customerdeny",
    teamId: "customer-team",
    source: {
      provider: "artifacts",
      repository: "app_customerdeny",
      branch: "main",
    },
    templateSeed: { appId: "app_shed", revision: `git:${"b".repeat(40)}` },
  });
  for (const kind of ["customer", "platform"]) {
    const name = `${kind}deny`;
    const appId = `app_${name}`;
    await store.createAppIfAbsent({ appId });
    expect(
      await store.createPublicSurfaceIfAbsent({
        appId,
        publicSurfaceId: `ps_${name}`,
        stableRoute: `/${name}`,
        publisher: {
          kind,
          teamId: kind === "platform" ? "system-team" : "customer-team",
          userId: "original-owner",
          requestKey: `ps_${name}`,
        },
      }),
    ).toMatchObject({ kind: "success", value: { kind: "created" } });
    const digest = `sha256:${"b".repeat(64)}`;
    await store.createReleaseIfAbsent({
      appId,
      releaseId: `rel_${name}`,
      artifact: {
        artifactRef: `artifact:${name}`,
        artifactDigest: digest,
        provenance: {
          sourceRevision: `git:${"b".repeat(40)}`,
          sourceTreeDigest: digest,
          buildRecipeDigest: digest,
        },
      },
    });
    await store.recordReleaseVerification({
      releaseId: `rel_${name}`,
      digest,
      mediaType: "application/vnd.fungi.app+json",
      description: {
        format: "fungi-app-v1",
        ui: null,
        backend: null,
        declaration: emptyAppDeclaration,
      },
    });
    await db
      .prepare(
        `INSERT INTO app_release_transitions
      (transition_id,operation_kind,idempotency_key,release_id,public_surface_id) VALUES (?,?,?,?,?)`,
      )
      .bind(
        kind === "customer"
          ? "app_transition_bbbbbbbbbbbbbbbbbbbbb"
          : "app_transition_ccccccccccccccccccccc",
        "promotion",
        `idem_${name}`,
        `rel_${name}`,
        `ps_${name}`,
      )
      .run();
  }
  // A later platform-policy assignment must not upgrade an existing customer claim.
  await configureD1PublicRoutes(
    db,
    await capturePublicRoutePolicy({
      platformRoutes: [
        { appId: "app_platformdeny", stableRoute: "/platformdeny" },
        { appId: "app_customerdeny", stableRoute: "/customerdeny" },
      ],
      structuralRoutes: ["/private-apps", "/surfaces"],
    }),
  );
  expect(
    await recordD1PlatformOwnerReplay(db, {
      appId: "app_customerdeny",
      publicSurfaceId: "ps_customerdeny",
      stableRoute: "/customerdeny",
      teamId: "customer-team",
      operatorId: "other-operator",
    }),
  ).toBe(false);
  // Isolate the claim-state guard: no retirement row may hide its removal.
  await db
    .prepare(
      "UPDATE app_release_route_claims SET state='removing',removal_operation_id='remove-platform' WHERE public_surface_id='ps_platformdeny'",
    )
    .run();
  expect(
    await db
      .prepare(
        "SELECT state FROM app_release_route_claims WHERE public_surface_id='ps_platformdeny'",
      )
      .first(),
  ).toEqual({ state: "removing" });
  expect(
    await recordD1PlatformOwnerReplay(db, {
      appId: "app_platformdeny",
      publicSurfaceId: "ps_platformdeny",
      stableRoute: "/platformdeny",
      teamId: "system-team",
      operatorId: "other-operator",
    }),
  ).toBe(false);
  expect(
    await db
      .prepare("SELECT count(*) AS n FROM app_release_platform_owner_replays")
      .first(),
  ).toEqual({ n: 0 });
});

it("native policy projection keeps platform and structural normalized keys disjoint", async () => {
  const db = env.APP_RELEASE_POLICY;
  await db.exec(APP_RELEASE_D1_FRESH_SCHEMA);
  const policy = await capturePublicRoutePolicy({
    platformRoutes: [
      { appId: "app_fixtureproof", stableRoute: "/f1xtur3pr00f" },
    ],
    structuralRoutes: ["/surfaces", "/private-apps"],
  });
  await configureD1PublicRoutes(db, policy);
  const before = await db
    .prepare("SELECT digest FROM app_release_route_policy WHERE singleton=1")
    .first();
  for (const [platform, structural] of [
    ["/surfaces", "/surfaces"],
    ["/surfac3s", "/surfaces"],
    ["/surfaces", "/surfac3s"],
    ["/privateapps", "/private-apps"],
    ["/private-apps", "/privateapps"],
  ]) {
    await expect(
      (async () => {
        await configureD1PublicRoutes(
          db,
          await capturePublicRoutePolicy({
            platformRoutes: [
              { appId: "app_fixtureproof", stableRoute: platform },
            ],
            structuralRoutes: [structural],
          }),
        );
      })(),
    ).rejects.toThrow(
      "Platform route assignments conflict with structural routes",
    );
    expect(
      await db
        .prepare(
          "SELECT digest FROM app_release_route_policy WHERE singleton=1",
        )
        .first(),
    ).toEqual(before);
  }
  expect(
    await db
      .prepare(
        "SELECT count(*) AS overlaps FROM app_release_platform_routes p JOIN app_release_reserved_route_keys r ON r.route_key=p.route_key WHERE r.match_kind='exact'",
      )
      .first(),
  ).toEqual({ overlaps: 0 });
  expect(
    await db
      .prepare("SELECT stable_route,route_key FROM app_release_platform_routes")
      .all(),
  ).toMatchObject({
    results: [{ stable_route: "/f1xtur3pr00f", route_key: "fixtureproof" }],
  });
  expect(
    await db
      .prepare(
        "SELECT word,route_key FROM app_release_reserved_route_keys WHERE word IN ('/surfaces','/private-apps') ORDER BY word",
      )
      .all(),
  ).toMatchObject({
    results: [
      { word: "/private-apps", route_key: "privateapps" },
      { word: "/surfaces", route_key: "surfaces" },
    ],
  });
});

it("lists only a Team's live published customer routes, following promotion and rollback", async () => {
  const db = env.APP_RELEASE_OWNED;
  await db.exec(APP_RELEASE_D1_FRESH_SCHEMA);
  await configureD1PublicRoutes(
    db,
    await capturePublicRoutePolicy({
      platformRoutes: [
        { appId: "app_ownedplatform", stableRoute: "/ownedplatform" },
      ],
      structuralRoutes: ["/private-apps", "/surfaces"],
    }),
  );
  const digest = `sha256:${"b".repeat(64)}`;
  const revision = `git:${"b".repeat(40)}`;
  await db
    .prepare(
      `INSERT INTO publisher_template_seed_receipts
    (template_repository,seed_revision,platform_app_id,source_revision,source_tree_digest,recipe_json,build_recipe_digest)
    VALUES (?,?,?,?,?,?,?)`,
    )
    .bind("template-shed", revision, "app_shed", revision, digest, "{}", digest)
    .run();
  const store = createD1AppReleaseStore(db);
  const registry = createD1TeamAppPublisherRegistry(db);
  const create = async (name, teamId, kind = "customer") => {
    const appId = `app_${name}`;
    // Even platform Apps can have a qualifying publisher row; kind still gates custody.
    await registry.register({
      appId,
      teamId,
      source: { provider: "artifacts", repository: appId, branch: "main" },
      templateSeed: { appId: "app_shed", revision },
    });
    await store.createAppIfAbsent({ appId });
    expect(
      await store.createPublicSurfaceIfAbsent({
        appId,
        publicSurfaceId: `ps_${name}`,
        stableRoute: `/${name}`,
        publisher: {
          kind,
          teamId,
          userId: "seller-owner",
          requestKey: `ps_${name}`,
        },
      }),
    ).toMatchObject({ kind: "success", value: { kind: "created" } });
    await store.createReleaseIfAbsent({
      appId,
      releaseId: `rel_${name}`,
      artifact: {
        artifactRef: `artifact:${name}`,
        artifactDigest: digest,
        provenance: {
          sourceRevision: revision,
          sourceTreeDigest: digest,
          buildRecipeDigest: digest,
        },
      },
    });
    await store.recordReleaseVerification({
      releaseId: `rel_${name}`,
      digest,
      mediaType: "application/vnd.fungi.app+json",
      description: {
        format: "fungi-app-v1",
        ui: null,
        backend: null,
        declaration: emptyAppDeclaration,
      },
    });
  };
  const select = (name, releaseId, operationKind, key) =>
    db
      .prepare(
        `INSERT INTO app_release_transitions
    (transition_id,operation_kind,idempotency_key,release_id,public_surface_id) VALUES (?,?,?,?,?)`,
      )
      .bind(
        `app_transition_${key.padEnd(21, "a")}`,
        operationKind,
        `idem_${key}`,
        releaseId,
        `ps_${name}`,
      )
      .run();
  await create("ownedfirst", "seller-team");
  await create("ownedsecond", "seller-team");
  await create("ownedforeign", "other-team");
  await create("ownedunpublished", "seller-team");
  await create("ownedremoved", "seller-team");
  await create("ownedplatform", "seller-team", "platform");
  await select("ownedfirst", "rel_ownedfirst", "promotion", "first");
  await select("ownedsecond", "rel_ownedsecond", "promotion", "second");
  await select("ownedforeign", "rel_ownedforeign", "promotion", "foreign");
  await select("ownedplatform", "rel_ownedplatform", "promotion", "platform");
  await select("ownedremoved", "rel_ownedremoved", "promotion", "removed");
  // Isolate each custody exclusion: no other marker may hide a missing clause.
  for (const name of [
    "ownedremoving",
    "ownedretired",
    "ownedblocked",
    "ownedmismatch",
  ]) {
    await create(
      name,
      name === "ownedmismatch" ? "publisher-other-team" : "seller-team",
    );
    await select(name, `rel_${name}`, "promotion", name);
  }
  await db
    .prepare(
      "UPDATE app_release_route_claims SET state='removing', removal_operation_id='fixture-removing' WHERE public_surface_id='ps_ownedremoving'",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO app_release_surface_retirements(public_surface_id,operation_id) VALUES ('ps_ownedretired','fixture-retired')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO app_release_team_route_blocks(team_id,route_key,stable_route,removal_operation_id) SELECT team_id,route_key,stable_route,'fixture-blocked' FROM app_release_route_claims WHERE public_surface_id='ps_ownedblocked'",
    )
    .run();
  await db
    .prepare(
      "UPDATE app_release_route_claims SET team_id='seller-team' WHERE public_surface_id='ps_ownedmismatch'",
    )
    .run();
  const moderation = createD1PublicRouteModeration(db);
  expect(
    await moderation.prepareRemoval({
      operationId: "seller-removed",
      operatorId: "operator",
      reason: "Moderation fixture",
      target: {
        appId: "app_ownedremoved",
        publicSurfaceId: "ps_ownedremoved",
        teamId: "seller-team",
        stableRoute: "/ownedremoved",
      },
    }),
  ).toMatchObject({ kind: "recorded" });
  // A pending removal still has its claim; the custody predicate must exclude it.
  expect(
    (await publicRoutes.listD1OwnedPublicRoutes(db, "seller-team")).map(
      ({ publicSurfaceId }) => publicSurfaceId,
    ),
  ).not.toContain("ps_ownedremoved");
  expect(
    await publicRoutes.ownsD1PublicRoute(db, {
      teamId: "seller-team",
      appId: "app_ownedremoved",
      stableRoute: "/ownedremoved",
    }),
  ).toBe(false);
  expect(await moderation.complete("seller-removed", "operator")).toMatchObject(
    { kind: "recorded" },
  );
  const first = {
    appId: "app_ownedfirst",
    publicSurfaceId: "ps_ownedfirst",
    stableRoute: "/ownedfirst",
    releaseId: "rel_ownedfirst",
  };
  const second = {
    appId: "app_ownedsecond",
    publicSurfaceId: "ps_ownedsecond",
    stableRoute: "/ownedsecond",
    releaseId: "rel_ownedsecond",
  };
  expect(await publicRoutes.listD1OwnedPublicRoutes(db, "seller-team")).toEqual(
    [first, second],
  );
  expect(await publicRoutes.listD1OwnedPublicRoutes(db, "absent-team")).toEqual(
    [],
  );
  expect(await publicRoutes.listD1OwnedPublicRoutes(db, "other-team")).toEqual([
    {
      appId: "app_ownedforeign",
      publicSurfaceId: "ps_ownedforeign",
      stableRoute: "/ownedforeign",
      releaseId: "rel_ownedforeign",
    },
  ]);
  for (const name of ["ownedfirst", "ownedsecond"]) {
    expect(
      await publicRoutes.ownsD1PublicRoute(db, {
        teamId: "seller-team",
        appId: `app_${name}`,
        stableRoute: `/${name}`,
      }),
    ).toBe(true);
  }
  for (const name of [
    "ownedforeign",
    "ownedplatform",
    "ownedunpublished",
    "ownedremoved",
    "ownedremoving",
    "ownedretired",
    "ownedblocked",
    "ownedmismatch",
  ]) {
    expect(
      await publicRoutes.ownsD1PublicRoute(db, {
        teamId: "seller-team",
        appId: `app_${name}`,
        stableRoute: `/${name}`,
      }),
    ).toBe(false);
  }
  expect(
    await publicRoutes.ownsD1PublicRoute(db, {
      teamId: "other-team",
      appId: "app_ownedforeign",
      stableRoute: "/ownedforeign",
    }),
  ).toBe(true);
  expect(
    await publicRoutes.ownsD1PublicRoute(db, {
      teamId: "seller-team",
      appId: "app_ownedsecond",
      stableRoute: "/ownedfirst",
    }),
  ).toBe(false);
  await store.createReleaseIfAbsent({
    appId: "app_ownedfirst",
    releaseId: "rel_ownednew",
    artifact: {
      artifactRef: "artifact:ownednew",
      artifactDigest: digest,
      provenance: {
        sourceRevision: revision,
        sourceTreeDigest: digest,
        buildRecipeDigest: digest,
      },
    },
  });
  await store.recordReleaseVerification({
    releaseId: "rel_ownednew",
    digest,
    mediaType: "application/vnd.fungi.app+json",
    description: {
      format: "fungi-app-v1",
      ui: null,
      backend: null,
      declaration: emptyAppDeclaration,
    },
  });
  await select("ownedfirst", "rel_ownednew", "promotion", "new");
  expect(await publicRoutes.listD1OwnedPublicRoutes(db, "seller-team")).toEqual(
    [{ ...first, releaseId: "rel_ownednew" }, second],
  );
  await select("ownedfirst", "rel_ownedfirst", "rollback", "back");
  expect(await publicRoutes.listD1OwnedPublicRoutes(db, "seller-team")).toEqual(
    [first, second],
  );
});
