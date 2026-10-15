import * as Schema from "effect/Schema";
import {
  appIdSchema,
  stableRouteSchema,
} from "./internal/app-release-schema.js";

/** CTO customer-publication policy. Deployment projects this one configuration. */
export const publicRoutePolicy = {
  version: 1,
  maxPublicRoutesPerTeam: 20,
  maxUnusedSurfacesPerApp: 20,
  releaseCooldownSeconds: 7 * 24 * 60 * 60,
  erasureTombstoneSeconds: 90 * 24 * 60 * 60,
  reservedWords: [
    "admin",
    "administrator",
    "api",
    "assets",
    "auth",
    "billing",
    "botanical",
    "docs",
    "fungi",
    "help",
    "login",
    "logout",
    "oauth",
    "operator",
    "security",
    "settings",
    "signin",
    "signup",
    "static",
    "status",
    "support",
    "www",
  ],
  brandPrefixes: ["fungi"],
  brandWordExceptions: ["fungible", "fungicide"],
} as const;

/** Comparison only: a key never repairs or replaces the canonical route URL. */
export function publicRouteKey(value: string): string {
  return (value.startsWith("/") ? value.slice(1) : value)
    .replaceAll("-", "")
    .replaceAll("_", "")
    .replaceAll("1", "i")
    .replaceAll("l", "i")
    .replaceAll("0", "o")
    .replaceAll("5", "s")
    .replaceAll("3", "e");
}

/** Router prefixes and platform assignments are supplied by their owners. */
export function isReservedPublicRoute(
  route: string,
  structuralRoutes: readonly string[],
): boolean {
  const key = publicRouteKey(route);
  if (
    structuralRoutes.some((value) => publicRouteKey(value) === key) ||
    publicRoutePolicy.reservedWords.some(
      (value) => publicRouteKey(value) === key,
    )
  )
    return true;
  return (
    publicRoutePolicy.brandPrefixes.some((value) =>
      key.startsWith(publicRouteKey(value)),
    ) &&
    !publicRoutePolicy.brandWordExceptions.some(
      (value) => publicRouteKey(value) === key,
    )
  );
}

/** Deployment supplies routes from the platform plan and App-origin router. */
export const publicRouteConfigurationSchema = Schema.Struct({
  platformRoutes: Schema.Array(
    Schema.Struct({
      appId: appIdSchema,
      stableRoute: stableRouteSchema,
    }),
  ),
  structuralRoutes: Schema.Array(stableRouteSchema),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (configuration) => {
        const keys = configuration.platformRoutes.map(({ stableRoute }) =>
          publicRouteKey(stableRoute),
        );
        return new Set(keys).size === keys.length;
      },
      { message: "Platform route assignments conflict" },
    ),
  ),
  Schema.check(
    Schema.makeFilter(
      (configuration) => {
        const structuralKeys = new Set(
          configuration.structuralRoutes.map(publicRouteKey),
        );
        return !configuration.platformRoutes.some(({ stableRoute }) =>
          structuralKeys.has(publicRouteKey(stableRoute)),
        );
      },
      { message: "Platform route assignments conflict with structural routes" },
    ),
  ),
);
export type PublicRouteConfiguration = Schema.Schema.Type<
  typeof publicRouteConfigurationSchema
>;

/** The deployed checksum binds both maintained policy and environment assignments. */
export async function capturePublicRoutePolicy(input: unknown) {
  const decoded = Schema.decodeUnknownSync(publicRouteConfigurationSchema, {
    onExcessProperty: "error",
  })(input);
  const configuration = {
    platformRoutes: [...decoded.platformRoutes].sort((a, b) =>
      a.stableRoute.localeCompare(b.stableRoute),
    ),
    structuralRoutes: [...decoded.structuralRoutes].sort(),
  };
  const json = JSON.stringify({ policy: publicRoutePolicy, configuration });
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json)),
  );
  const digest = Array.from(bytes, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  return { configuration, json, digest, version: publicRoutePolicy.version };
}

/** Decode the deployment JSON at its owned representation boundary. */
export async function capturePublicRoutePolicyFromJson(input: string) {
  return capturePublicRoutePolicy(
    Schema.decodeUnknownSync(
      Schema.fromJsonString(publicRouteConfigurationSchema),
      { onExcessProperty: "error" },
    )(input),
  );
}
