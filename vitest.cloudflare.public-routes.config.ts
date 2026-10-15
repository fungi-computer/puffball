import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      miniflare: {
        d1Databases: [
          "APP_RELEASE_ROUTES",
          "APP_RELEASE_REPLAY",
          "APP_RELEASE_POLICY",
          "APP_RELEASE_OWNED",
        ],
      },
    }),
  ],
  test: { include: ["test/cloudflare-public-route-claims.test.mjs"] },
});
