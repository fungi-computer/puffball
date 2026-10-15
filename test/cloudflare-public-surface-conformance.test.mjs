import { capturePublicRoutePolicy } from "../dist/public-route-policy.js";
import { configureD1PublicRoutes } from "../dist/public-routes.js";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  AppReleaseImmutableConflictError,
  createAppReleaseCatalog,
  parseAppId,
  parsePublicSurfaceId,
  parseStableRoute,
} from "../dist/index.js";
import {
  APP_RELEASE_D1_FRESH_SCHEMA,
  createD1AppReleaseStore,
} from "../dist/cloudflare.js";

const app = { appId: parseAppId("app_a1surface") };
const otherApp = { appId: parseAppId("app_otherowner") };
const surface = {
  publicSurfaceId: parsePublicSurfaceId("ps_a1surface"),
  appId: app.appId,
  stableRoute: parseStableRoute("/orchid"),
};

const definition = {
  ...surface,
  publisher: {
    kind: "platform",
    teamId: "platform-team",
    userId: "operator",
    requestKey: surface.publicSurfaceId,
  },
};

async function expectFulfilled(promise, expected) {
  const [outcome] = await Promise.allSettled([promise]);
  expect(outcome?.status).toBe("fulfilled");
  if (outcome?.status === "fulfilled") expect(outcome.value).toEqual(expected);
}

function createCatalog() {
  return createAppReleaseCatalog({
    store: createD1AppReleaseStore(env.APP_RELEASE_SURFACE),
    artifactReader: {
      read: async () => ({ kind: "missing" }),
    },
  });
}

describe("App Release Cloudflare PublicSurface conformance", () => {
  it("replays an App-owned caller-supplied PublicSurface after adapter reconstruction", async () => {
    await env.APP_RELEASE_SURFACE.exec(APP_RELEASE_D1_FRESH_SCHEMA);
    await configureD1PublicRoutes(
      env.APP_RELEASE_SURFACE,
      await capturePublicRoutePolicy({
        platformRoutes: [
          { appId: app.appId, stableRoute: surface.stableRoute },
        ],
        structuralRoutes: [],
      }),
    );

    {
      const catalogA = createCatalog();
      await expectFulfilled(catalogA.createApp(app), app);
      await expectFulfilled(catalogA.createApp(otherApp), otherApp);
      await expectFulfilled(catalogA.createPublicSurface(definition), surface);
    }

    const catalogB = createCatalog();
    await expectFulfilled(catalogB.createApp(app), app);
    await expectFulfilled(catalogB.createApp(app), app);
    await expectFulfilled(catalogB.createPublicSurface(definition), surface);
    await expectFulfilled(catalogB.createPublicSurface(definition), surface);

    const changedInputs = await Promise.allSettled([
      catalogB.createPublicSurface({
        ...definition,
        appId: otherApp.appId,
      }),
      catalogB.createPublicSurface({
        ...definition,
        stableRoute: parseStableRoute("/lotus"),
      }),
    ]);

    for (const outcome of changedInputs) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status !== "rejected") continue;
      expect(outcome.reason).toBeInstanceOf(AppReleaseImmutableConflictError);
    }
  });
});
