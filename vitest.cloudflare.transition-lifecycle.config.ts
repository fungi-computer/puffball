import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      miniflare: {
        d1Databases: ["APP_RELEASE_CATALOG"],
      },
    }),
  ],
  test: {
    include: ["test/cloudflare-transition-lifecycle-race.test.mjs"],
  },
});
