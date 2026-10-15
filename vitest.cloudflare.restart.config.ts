import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      miniflare: {
        d1Databases: ["APP_RELEASE_CATALOG", "APP_RELEASE_SURFACE"],
        r2Buckets: ["APP_RELEASE_ARTIFACTS"],
      },
    }),
  ],
  test: {
    include: [
      "test/cloudflare-catalog-restart.test.mjs",
      "test/cloudflare-public-surface-conformance.test.mjs",
    ],
  },
});
