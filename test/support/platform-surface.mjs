import { capturePublicRoutePolicy } from "../../dist/public-route-policy.js";
import { configureD1PublicRoutes } from "../../dist/public-routes.js";

/** Test fixture acts as the admitted platform operator, then invokes the one real Surface writer. */
export async function createFixturePlatformSurface(catalog, database, surface) {
  const previous = await database
    .prepare(
      "SELECT config_json FROM app_release_route_policy WHERE singleton=1",
    )
    .first();
  const routes =
    previous === null
      ? { platformRoutes: [], structuralRoutes: [] }
      : JSON.parse(previous.config_json).configuration;
  if (
    !routes.platformRoutes.some(
      (route) => route.stableRoute === surface.stableRoute,
    )
  ) {
    routes.platformRoutes.push({
      appId: surface.appId,
      stableRoute: surface.stableRoute,
    });
    await configureD1PublicRoutes(
      database,
      await capturePublicRoutePolicy(routes),
    );
  }
  return catalog.createPublicSurface({
    ...surface,
    publisher: {
      kind: "platform",
      teamId: "platform-fixture",
      userId: "fixture-operator",
      requestKey: surface.publicSurfaceId,
    },
  });
}
