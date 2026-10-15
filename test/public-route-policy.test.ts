import { describe, expect, it } from "vitest";
import {
  capturePublicRoutePolicy,
  capturePublicRoutePolicyFromJson,
  publicRouteKey,
  isReservedPublicRoute,
} from "../src/public-route-policy.js";

describe("customer public route policy", () => {
  it("gives spelling variants one reservation and abuse-block key", () => {
    for (const spelling of ["/myapp", "/my-app", "/my_app"])
      expect(publicRouteKey(spelling)).toBe("myapp");
    for (const spelling of ["/admin", "/adm1n", "/admln"])
      expect(publicRouteKey(spelling)).toBe("admin");
    expect(publicRouteKey("/supp0rt")).toBe("support");
    expect(publicRouteKey("/5ecur1ty")).toBe("security");
    expect(publicRouteKey("/h3lp")).toBe("heip");
  });

  it("protects reserved identities without claiming ordinary English words", () => {
    for (const route of [
      "/admin",
      "/adm1n",
      "/supp0rt",
      "/s1gnin",
      "/fungi",
      "/fungi-app",
      "/fungiofficial",
      "/fung1-official",
    ])
      expect(isReservedPublicRoute(route, [])).toBe(true);
    for (const route of ["/fungible", "/fungicide", "/my-notes"])
      expect(isReservedPublicRoute(route, [])).toBe(false);
  });

  it("protects the router and platform assignments before publication", () => {
    const structuralRoutes = ["/private-apps", "/surfaces", "/tourtois"];
    expect(isReservedPublicRoute("/privateapps", structuralRoutes)).toBe(true);
    expect(isReservedPublicRoute("/surfac3s", structuralRoutes)).toBe(true);
    expect(isReservedPublicRoute("/t0urt0is", structuralRoutes)).toBe(true);
    expect(isReservedPublicRoute("/private-notes", structuralRoutes)).toBe(
      false,
    );
  });
});

describe("deployment route configuration", () => {
  it.each([
    ["/surfaces", "/surfaces"],
    ["/surfaces", "/surfac3s"],
    ["/surfac3s", "/surfaces"],
    ["/private-apps", "/privateapps"],
    ["/privateapps", "/private-apps"],
    ["/5urfac35", "/surfaces"],
    ["/surfaces", "/5urfac35"],
    ["/1nsta11ed-apps", "/installed-apps"],
    ["/installed-apps", "/1nsta11ed-apps"],
  ])(
    "refuses platform %s colliding with structural %s",
    async (platform, structural) => {
      const input = {
        platformRoutes: [{ appId: "app_fixtureproof", stableRoute: platform }],
        structuralRoutes: [structural],
      };
      await expect(capturePublicRoutePolicy(input)).rejects.toThrow(
        "Platform route assignments conflict with structural routes",
      );
      await expect(
        capturePublicRoutePolicyFromJson(JSON.stringify(input)),
      ).rejects.toThrow(
        "Platform route assignments conflict with structural routes",
      );
    },
  );
});

describe("canonical route grammar before policy comparison", () => {
  it.each([
    "/Surfaces",
    "/surfaces/",
    "/./surfaces",
    "/notes/../surfaces",
    "/%73urfaces",
    "/surfac%65s",
    "/private_apps",
  ])("refuses non-canonical %s in either roster", async (route) => {
    for (const input of [
      {
        platformRoutes: [{ appId: "app_fixtureproof", stableRoute: route }],
        structuralRoutes: ["/surfaces"],
      },
      {
        platformRoutes: [
          { appId: "app_fixtureproof", stableRoute: "/surfaces" },
        ],
        structuralRoutes: [route],
      },
    ]) {
      await expect(capturePublicRoutePolicy(input)).rejects.toThrow();
      await expect(
        capturePublicRoutePolicyFromJson(JSON.stringify(input)),
      ).rejects.toThrow();
    }
  });

  it("accepts disjoint assignments including intentionally reserved platform identities", async () => {
    const policy = await capturePublicRoutePolicy({
      platformRoutes: [{ appId: "app_settings", stableRoute: "/settings" }],
      structuralRoutes: ["/surfaces", "/private-apps", "/installed-apps"],
    });
    expect(policy.configuration.platformRoutes).toEqual([
      { appId: "app_settings", stableRoute: "/settings" },
    ]);
  });
});

it("still refuses normalized collisions between two platform assignments", async () => {
  await expect(
    capturePublicRoutePolicy({
      platformRoutes: [
        { appId: "app_first", stableRoute: "/surfaces" },
        { appId: "app_second", stableRoute: "/surfac3s" },
      ],
      structuralRoutes: [],
    }),
  ).rejects.toThrow("Platform route assignments conflict");
});
