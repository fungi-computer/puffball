import {
  parseAppId,
  parseStableRoute,
  type PublicSurface,
  type PublicSurfaceDefinition,
} from "../../dist/index.js";

/** Explicit operator-owned route assignments for the catalog's platform fixture Apps. */
export const fixturePlatformRoutes = {
  routes: {
    structuralRoutes: [],
    platformRoutes: [
      ["app_orchid", "/orchid"],
      ["app_orchid", "/lotus"],
      ["app_generationlaw", "/generationlaw"],
      ["app_gated", "/gated"],
    ].map(([appId, stableRoute]) => ({
      appId: parseAppId(appId),
      stableRoute: parseStableRoute(stableRoute),
    })),
  },
};

/** Fixtures name the admitted operator; the catalog still returns only Surface facts. */
export function platformSurface(
  surface: PublicSurface,
): PublicSurfaceDefinition {
  return {
    ...surface,
    publisher: {
      kind: "platform",
      teamId: "platform-fixture-team",
      userId: "fixture-operator",
      requestKey: surface.publicSurfaceId,
    },
  };
}
