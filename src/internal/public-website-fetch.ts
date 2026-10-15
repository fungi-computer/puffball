import type {
  AppReleaseCatalog,
  PublicWebsiteRepresentation,
  StableRoute,
} from "./app-release-contract.js";
import { AppReleasePublicWebsiteNotFoundError } from "./app-release-contract.js";
import { decodeStableRoute } from "./app-release-schema.js";

const htmlContentType = "text/html; charset=utf-8";
const notFoundHtml = "<!doctype html><title>Not found</title>";
const unavailableHtml = "<!doctype html><title>Unavailable</title>";
const methodNotAllowedHtml = "<!doctype html><title>Method not allowed</title>";

export type AppReleasePublicWebsiteFetchHandler = Readonly<{
  fetch(request: Request): Promise<Response>;
}>;

/** Private Fetch projection for the anonymous public-website tracer. */
export function createPublicWebsiteFetchHandler(options: {
  readonly resolvePublicWebsite: AppReleaseCatalog["resolvePublicWebsite"];
}): AppReleasePublicWebsiteFetchHandler {
  return {
    async fetch(request) {
      if (request.method !== "GET") return methodNotAllowed();

      const stableRoute = parsePathname(request.url);
      if (stableRoute === undefined) return notFound();

      try {
        const representation = await options.resolvePublicWebsite(stableRoute);
        return delivered(representation);
      } catch (error) {
        return error instanceof AppReleasePublicWebsiteNotFoundError
          ? notFound()
          : unavailable();
      }
    },
  };
}

function parsePathname(requestUrl: string): StableRoute | undefined {
  if (!URL.canParse(requestUrl)) return undefined;
  const decoded = decodeStableRoute(new URL(requestUrl).pathname);
  return decoded._tag === "Success" ? decoded.success : undefined;
}

function delivered(representation: PublicWebsiteRepresentation): Response {
  return new Response(new Uint8Array(representation.bytes.copy()), {
    status: 200,
    headers: { "content-type": htmlContentType },
  });
}

function notFound(): Response {
  return fixedResponse(notFoundHtml, 404);
}

function unavailable(): Response {
  return fixedResponse(unavailableHtml, 503);
}

function methodNotAllowed(): Response {
  return fixedResponse(methodNotAllowedHtml, 405);
}

function fixedResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": htmlContentType },
  });
}
