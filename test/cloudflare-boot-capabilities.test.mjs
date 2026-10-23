import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  APP_RELEASE_D1_FRESH_SCHEMA,
  createD1BootCapabilityRows,
} from "../dist/cloudflare.js";

/**
 * Short-lived boot capability leases in the catalog D1: the storage behind
 * the Hub's BootCapabilityStore. Only a token digest is stored, each lease
 * has a bounded lifetime, and leases are deleted on revoke or expiry.
 */

const database = () => env.APP_RELEASE_PUBLISHER;
const digest = (letter) => letter.repeat(64);
const lease = (id, expiresAt) => ({
  tokenDigest: digest(id === "lease-a" ? "a" : id === "lease-b" ? "b" : "c"),
  leaseId: id,
  releaseId: "rel_bootcap01",
  leaseJson: JSON.stringify({ id, expiresAt }),
  expiresAt,
  now: 0,
});

beforeAll(async () => {
  for (const statement of APP_RELEASE_D1_FRESH_SCHEMA.split(";\n"))
    if (statement.trim() !== "") await database().prepare(statement).run();
  await database()
    .prepare("INSERT INTO app_release_apps (app_id) VALUES (?)")
    .bind("app_bootcap")
    .run();
  await database()
    .prepare(
      `INSERT INTO app_release_releases (release_id, app_id, artifact_ref,
         artifact_digest, source_revision, source_tree_digest, build_recipe_digest)
       VALUES ('rel_bootcap01', 'app_bootcap', 'artifact:x', 'sha256:x', 'git:x', 'sha256:x', 'sha256:x')`,
    )
    .run();
});

describe("boot capability leases in the catalog", () => {
  it("resolves an issued lease by its token digest until it expires", async () => {
    const rows = createD1BootCapabilityRows(database());
    await rows.issue(lease("lease-a", 1_000));
    await expect(rows.resolve(digest("a"), 999)).resolves.toBe(
      JSON.stringify({ id: "lease-a", expiresAt: 1_000 }),
    );
    await expect(rows.resolve(digest("a"), 1_000)).resolves.toBeNull();
    // Expired leases are deleted, not merely hidden.
    const left = await database()
      .prepare(
        "SELECT COUNT(*) AS n FROM app_release_boot_capabilities WHERE lease_id = ?",
      )
      .bind("lease-a")
      .first();
    expect(left).toEqual({ n: 0 });
  });

  it("deletes a lease on revoke", async () => {
    const rows = createD1BootCapabilityRows(database());
    await rows.issue(lease("lease-b", 5_000));
    await rows.revoke("lease-b");
    await expect(rows.resolve(digest("b"), 10)).resolves.toBeNull();
  });

  it("stores only a 64-hex token digest, never a raw token", async () => {
    const rows = createD1BootCapabilityRows(database());
    await expect(
      rows.issue({
        ...lease("lease-c", 5_000),
        tokenDigest: "raw-token-value",
      }),
    ).rejects.toThrow();
  });

  it("refuses a lifetime beyond the bounded maximum", async () => {
    const rows = createD1BootCapabilityRows(database());
    await expect(
      rows.issue({ ...lease("lease-c", 10_000_000), now: 0 }),
    ).rejects.toThrow();
  });

  it("purges every expired lease when a new one is issued", async () => {
    const rows = createD1BootCapabilityRows(database());
    await rows.issue(lease("lease-a", 100));
    await rows.issue({ ...lease("lease-c", 50_000), now: 200 });
    const expired = await database()
      .prepare(
        "SELECT COUNT(*) AS n FROM app_release_boot_capabilities WHERE expires_at <= ?",
      )
      .bind(200)
      .first();
    expect(expired).toEqual({ n: 0 });
  });
});
