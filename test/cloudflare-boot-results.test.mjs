import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  APP_RELEASE_D1_FRESH_SCHEMA,
  createD1ReleaseBootResults,
} from "../dist/cloudflare.js";

/**
 * One boot result per Release and check version, beside the Release in the
 * global catalog. Whoever runs the check first (the publisher at submission
 * or the Hub at first install) writes it; both read it; nobody rechecks.
 */

const database = () => env.APP_RELEASE_CATALOG;

beforeAll(async () => {
  for (const statement of APP_RELEASE_D1_FRESH_SCHEMA.split(";\n"))
    if (statement.trim() !== "") await database().prepare(statement).run();
  await database()
    .prepare("INSERT INTO app_release_apps (app_id) VALUES (?)")
    .bind("app_bootresult")
    .run();
  for (const releaseId of ["rel_bootresulta", "rel_bootresultb"])
    await database()
      .prepare(
        `INSERT INTO app_release_releases (release_id, app_id, artifact_ref,
           artifact_digest, source_revision, source_tree_digest, build_recipe_digest)
         VALUES (?, 'app_bootresult', 'artifact:x', 'sha256:x', 'git:x', 'sha256:x', 'sha256:x')`,
      )
      .bind(releaseId)
      .run();
});

const passed = { kind: "passed" };
const refused = {
  kind: "refused",
  code: "ui_mount_failed",
  diagnostics: {
    failedPredicate: "candidate_not_mounted",
    finalUrlPath: "/_boot/rel_bootresulta/index.html",
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    droppedCount: 0,
  },
};

describe("release boot results in the global catalog", () => {
  it("reads absent before any check has run", async () => {
    const results = createD1ReleaseBootResults(database());
    await expect(
      results.read({ releaseId: "rel_bootresulta", checkVersion: "boot-v1" }),
    ).resolves.toEqual({ kind: "absent" });
  });

  it("keeps the first writer's result; a later writer reads it back", async () => {
    const results = createD1ReleaseBootResults(database());
    const key = { releaseId: "rel_bootresulta", checkVersion: "boot-v1" };
    await expect(
      results.recordIfAbsent({ ...key, result: refused, checkedAt: 10 }),
    ).resolves.toEqual({ kind: "recorded", result: refused, checkedAt: 10 });
    await expect(
      results.recordIfAbsent({ ...key, result: passed, checkedAt: 20 }),
    ).resolves.toEqual({ kind: "recorded", result: refused, checkedAt: 10 });
    await expect(results.read(key)).resolves.toEqual({
      kind: "recorded",
      result: refused,
      checkedAt: 10,
    });
  });

  it("keys results by check version, so a new check version runs again", async () => {
    const results = createD1ReleaseBootResults(database());
    await expect(
      results.read({ releaseId: "rel_bootresulta", checkVersion: "boot-v2" }),
    ).resolves.toEqual({ kind: "absent" });
    await results.recordIfAbsent({
      releaseId: "rel_bootresultb",
      checkVersion: "boot-v1",
      result: passed,
      checkedAt: 30,
    });
    await expect(
      results.read({ releaseId: "rel_bootresultb", checkVersion: "boot-v1" }),
    ).resolves.toEqual({ kind: "recorded", result: passed, checkedAt: 30 });
  });

  it("refuses a result for a Release the catalog does not hold", async () => {
    const results = createD1ReleaseBootResults(database());
    await expect(
      results.recordIfAbsent({
        releaseId: "rel_bootresultmissing",
        checkVersion: "boot-v1",
        result: passed,
        checkedAt: 40,
      }),
    ).rejects.toThrow();
  });

  it("never rewrites a recorded result", async () => {
    await expect(
      database()
        .prepare(
          "UPDATE app_release_boot_results SET outcome_json = ? WHERE release_id = ?",
        )
        .bind(JSON.stringify(passed), "rel_bootresulta")
        .run(),
    ).rejects.toThrow();
  });
});
