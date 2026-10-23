import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      miniflare: {
        d1Databases: ["APP_RELEASE_CATALOG", "APP_RELEASE_PUBLISHER"],
        r2Buckets: ["APP_RELEASE_ARTIFACTS"],
      },
    }),
  ],
  test: {
    include: [
      "test/cloudflare-bindings.smoke.test.mjs",
      "test/cloudflare-catalog-conformance.test.mjs",
      "test/cloudflare-publisher-authority.test.mjs",
      "test/cloudflare-boot-results.test.mjs",
      "test/cloudflare-boot-capabilities.test.mjs",
    ],
  },
});
