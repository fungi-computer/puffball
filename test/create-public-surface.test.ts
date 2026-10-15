import { describe, expect, it } from "vitest";

import {
  createAppReleaseCatalog,
  parseAppId,
  parsePublicSurfaceId,
  parseStableRoute,
  AppReleaseImmutableConflictError,
  AppReleaseSurfaceOwnerAppAbsentError,
  type ArtifactReader,
  type PublicSurface,
} from "../dist/index.js";
import { createDeterministicMemoryAppReleaseStore } from "../dist/effect.js";

describe("App Release public Surface", () => {
  it("refuses platform routes that shadow structural routes at memory-store admission", () => {
    for (const stableRoute of ["/surfaces", "/surfac3s"]) {
      expect(() =>
        createDeterministicMemoryAppReleaseStore({
          routes: {
            platformRoutes: [
              {
                appId: parseAppId("app_fixtureproof"),
                stableRoute: parseStableRoute(stableRoute),
              },
            ],
            structuralRoutes: [parseStableRoute("/surfaces")],
          },
        }),
      ).toThrow("Platform route assignments conflict with structural routes");
    }
  });

  it("creates one App-owned PublicSurface once", async () => {
    let artifactReaderCalls = 0;
    const artifactReader: ArtifactReader = {
      read: () => {
        artifactReaderCalls += 1;
        return Promise.resolve({ kind: "missing" });
      },
    };
    const catalog = createAppReleaseCatalog({
      store: createDeterministicMemoryAppReleaseStore({
        routes: {
          platformRoutes: [
            {
              appId: parseAppId("app_orchid"),
              stableRoute: parseStableRoute("/orchid"),
            },
            {
              appId: parseAppId("app_lotus"),
              stableRoute: parseStableRoute("/lotus"),
            },
          ],
          structuralRoutes: [],
        },
      }),
      artifactReader,
    });
    const app = { appId: parseAppId("app_orchid") };
    const surface: PublicSurface = {
      publicSurfaceId: parsePublicSurfaceId("ps_orchid"),
      appId: app.appId,
      stableRoute: parseStableRoute("/orchid"),
    };

    await expect(catalog.createApp(app)).resolves.toEqual(app);

    const createSurface = () =>
      catalog
        .createPublicSurface({
          ...surface,
          publisher: {
            kind: "platform",
            teamId: "platform-team",
            userId: "operator",
            requestKey: surface.publicSurfaceId,
          },
        })
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          () => ({ status: "rejected" as const }),
        );
    const created = await createSurface();
    const replayed = await createSurface();

    expect(artifactReaderCalls).toBe(0);
    expect([created, replayed]).toEqual([
      { status: "fulfilled", value: surface },
      { status: "fulfilled", value: surface },
    ]);
  });
});

it("rejects a public Surface whose owner App does not exist", async () => {
  let artifactReaderCalls = 0;
  const artifactReader: ArtifactReader = {
    read: () => {
      artifactReaderCalls += 1;
      return Promise.resolve({ kind: "missing" });
    },
  };
  const catalog = createAppReleaseCatalog({
    store: createDeterministicMemoryAppReleaseStore({
      routes: {
        platformRoutes: [
          {
            appId: parseAppId("app_orchid"),
            stableRoute: parseStableRoute("/orchid"),
          },
          {
            appId: parseAppId("app_lotus"),
            stableRoute: parseStableRoute("/lotus"),
          },
        ],
        structuralRoutes: [],
      },
    }),
    artifactReader,
  });
  const appId = parseAppId("app_uncreated");
  const surface: PublicSurface = {
    publicSurfaceId: parsePublicSurfaceId("ps_uncreated"),
    appId,
    stableRoute: parseStableRoute("/uncreated"),
  };

  const outcome = catalog.createPublicSurface({
    ...surface,
    publisher: {
      kind: "platform",
      teamId: "platform-team",
      userId: "operator",
      requestKey: surface.publicSurfaceId,
    },
  });

  await expect(outcome).rejects.toBeInstanceOf(
    AppReleaseSurfaceOwnerAppAbsentError,
  );
  await expect(outcome).rejects.toMatchObject({ appId });
  expect(artifactReaderCalls).toBe(0);
});

it("App Release public Surface rejects changed immutable ownership or route for its ID", async () => {
  let artifactReaderCalls = 0;
  const artifactReader: ArtifactReader = {
    read: () => {
      artifactReaderCalls += 1;
      return Promise.resolve({ kind: "missing" as const });
    },
  };
  const catalog = createAppReleaseCatalog({
    store: createDeterministicMemoryAppReleaseStore({
      routes: {
        platformRoutes: [
          {
            appId: parseAppId("app_orchid"),
            stableRoute: parseStableRoute("/orchid"),
          },
          {
            appId: parseAppId("app_lotus"),
            stableRoute: parseStableRoute("/lotus"),
          },
        ],
        structuralRoutes: [],
      },
    }),
    artifactReader,
  });
  const firstApp = { appId: parseAppId("app_orchid") };
  const secondApp = { appId: parseAppId("app_lotus") };
  const surface: PublicSurface = {
    publicSurfaceId: parsePublicSurfaceId("ps_garden"),
    appId: firstApp.appId,
    stableRoute: parseStableRoute("/orchid"),
  };

  await expect(catalog.createApp(firstApp)).resolves.toEqual(firstApp);
  await expect(catalog.createApp(secondApp)).resolves.toEqual(secondApp);
  await expect(
    catalog.createPublicSurface({
      ...surface,
      publisher: {
        kind: "platform",
        teamId: "platform-team",
        userId: "operator",
        requestKey: surface.publicSurfaceId,
      },
    }),
  ).resolves.toEqual(surface);

  const changedInputs = await Promise.allSettled([
    catalog.createPublicSurface({
      ...surface,
      publisher: {
        kind: "platform",
        teamId: "platform-team",
        userId: "operator",
        requestKey: surface.publicSurfaceId,
      },
      appId: secondApp.appId,
    }),
    catalog.createPublicSurface({
      ...surface,
      publisher: {
        kind: "platform",
        teamId: "platform-team",
        userId: "operator",
        requestKey: surface.publicSurfaceId,
      },
      stableRoute: parseStableRoute("/lotus"),
    }),
  ]);

  for (const outcome of changedInputs) {
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") continue;
    // SAFETY: The discriminant above narrows this settled result to a rejection;
    // the foreign reason is intentionally inspected only as an unknown value.
    const reason: unknown = outcome.reason as unknown;
    expect(reason).toBeInstanceOf(AppReleaseImmutableConflictError);
  }
  expect(artifactReaderCalls).toBe(0);
});
