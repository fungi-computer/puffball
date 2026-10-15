import {
  AppReleasePublicWebsiteNotFoundError,
  createAppReleaseCatalog,
  parseAppId,
  parseStableRoute,
} from "@fungi.computer/puffball";
import { createDeterministicMemoryAppReleaseStore } from "@fungi.computer/puffball/effect";

const catalog = createAppReleaseCatalog({
  store: createDeterministicMemoryAppReleaseStore(),
  artifactReader: { read: async () => ({ kind: "missing" }) },
});

await catalog.createApp({ appId: parseAppId("app_hello") });
try {
  await catalog.resolvePublicWebsite(parseStableRoute("/hello"));
} catch (error) {
  if (!(error instanceof AppReleasePublicWebsiteNotFoundError)) throw error;
  console.log(error.name); // AppReleasePublicWebsiteNotFoundError
}
