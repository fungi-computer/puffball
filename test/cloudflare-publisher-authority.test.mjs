import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { parseAppId } from "../dist/index.js";
import {
  APP_RELEASE_D1_FRESH_SCHEMA,
  createD1TeamAppPublisherRegistry,
} from "../dist/cloudflare.js";

describe("App publisher authority", () => {
  it("stores Publisher Artifacts metadata once with the exact fork parent", async () => {
    const database = env.APP_RELEASE_PUBLISHER;
    try {
      await database.exec(APP_RELEASE_D1_FRESH_SCHEMA);
      await database
        .prepare(
          `INSERT INTO publisher_artifacts_repositories
           (repository_name, provider_id, default_branch, remote, parent_repository)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          "template-shed",
          "provider-template-id",
          "main",
          "https://account.artifacts.cloudflare.net/git/default/template-shed.git",
          null,
        )
        .run();
      await database
        .prepare(
          `INSERT INTO publisher_artifacts_repositories_pending
           (repository_name, provider_id, default_branch, remote, parent_repository, initial_token)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          "team-pending",
          "provider-pending-id",
          "main",
          "https://account.artifacts.cloudflare.net/git/default/team-pending.git",
          "template-shed",
          "initial-token-fixture",
        )
        .run();
      await expect(
        database
          .prepare(
            "UPDATE publisher_artifacts_repositories_pending SET initial_token = ? WHERE repository_name = ?",
          )
          .bind("replacement-token", "team-pending")
          .run(),
      ).rejects.toThrow("write-once");
      await expect(
        database
          .prepare(
            `INSERT INTO publisher_artifacts_repositories_pending
             (repository_name, provider_id, default_branch, remote, parent_repository, initial_token)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            "team-orphan-pending",
            "provider-orphan-pending-id",
            "main",
            "https://account.artifacts.cloudflare.net/git/default/team-orphan-pending.git",
            "missing-template",
            "orphan-token-fixture",
          )
          .run(),
      ).rejects.toThrow();
      await database
        .prepare(
          `INSERT INTO publisher_artifacts_repositories
           (repository_name, provider_id, default_branch, remote, parent_repository)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          "team-inkcap",
          "provider-fork-id",
          "main",
          "https://account.artifacts.cloudflare.net/git/default/team-inkcap.git",
          "template-shed",
        )
        .run();
      await expect(
        database
          .prepare(
            "UPDATE publisher_artifacts_repositories SET remote = ? WHERE repository_name = ?",
          )
          .bind("https://wrong.invalid/repo.git", "team-inkcap")
          .run(),
      ).rejects.toThrow("write-once");
      await expect(
        database
          .prepare(
            "INSERT INTO publisher_artifacts_repositories (repository_name, provider_id, default_branch, remote, parent_repository) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(
            "team-orphan",
            "provider-orphan-id",
            "main",
            "https://account.artifacts.cloudflare.net/git/default/team-orphan.git",
            "missing-template",
          )
          .run(),
      ).rejects.toThrow();
      expect(
        await database
          .prepare(
            "SELECT repository_name, provider_id, default_branch, remote, parent_repository FROM publisher_artifacts_repositories ORDER BY repository_name",
          )
          .all(),
      ).toMatchObject({
        results: [
          {
            repository_name: "team-inkcap",
            provider_id: "provider-fork-id",
            parent_repository: "template-shed",
          },
          {
            repository_name: "template-shed",
            provider_id: "provider-template-id",
            parent_repository: null,
          },
        ],
      });
      await database
        .prepare(
          "DELETE FROM publisher_artifacts_repositories_pending WHERE repository_name = ?",
        )
        .bind("team-pending")
        .run();
      expect(
        await database
          .prepare(
            "SELECT repository_name FROM publisher_artifacts_repositories_pending WHERE repository_name = ?",
          )
          .bind("team-pending")
          .first(),
      ).toBeNull();
    } finally {
      const objects = await database
        .prepare(
          "SELECT type, name FROM sqlite_master WHERE (name LIKE 'app_release_%' OR name LIKE 'publisher_template_%' OR name LIKE 'publisher_%') AND type IN ('trigger', 'view', 'table') ORDER BY CASE WHEN type = 'trigger' THEN 0 WHEN type = 'view' THEN 1 ELSE 2 END, name DESC",
        )
        .all();
      for (const object of objects.results) {
        const kind =
          object.type === "trigger"
            ? "TRIGGER"
            : object.type === "view"
              ? "VIEW"
              : "TABLE";
        const name = String(object.name).replaceAll('"', '""');
        await database.exec(`DROP ${kind} IF EXISTS "${name}"`);
      }
    }
  });

  it("creates one Team-owned App/source and rejects a conflicting claimant", async () => {
    await env.APP_RELEASE_PUBLISHER.exec(APP_RELEASE_D1_FRESH_SCHEMA);
    const registry = createD1TeamAppPublisherRegistry(
      env.APP_RELEASE_PUBLISHER,
    );
    await env.APP_RELEASE_PUBLISHER.prepare(
      `INSERT INTO publisher_template_seed_receipts
       (template_repository, seed_revision, platform_app_id, source_revision,
        source_tree_digest, recipe_json, build_recipe_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "template-shed",
        `git:${"d".repeat(40)}`,
        "app_shed",
        `git:${"e".repeat(40)}`,
        `sha256:${"c".repeat(64)}`,
        "{}",
        `sha256:${"d".repeat(64)}`,
      )
      .run();
    const registration = {
      appId: parseAppId("app_customerinkcap"),
      teamId: "team_orchid",
      source: {
        provider: "artifacts",
        repository: "teams/orchid/apps/inkcap",
        branch: "main",
      },
      templateSeed: {
        appId: "app_shed",
        revision: `git:${"d".repeat(40)}`,
      },
    };

    await expect(registry.register(registration)).resolves.toEqual({
      kind: "created",
      registration,
    });
    await expect(registry.register(registration)).resolves.toEqual({
      kind: "existing",
      registration,
    });
    await expect(
      registry.authorize(registration.appId, registration.teamId),
    ).resolves.toEqual({ kind: "authorized", registration });
    await expect(
      registry.authorize(registration.appId, "team_foreign"),
    ).resolves.toEqual({ kind: "denied" });
    await expect(
      registry.register({ ...registration, teamId: "team_foreign" }),
    ).resolves.toEqual({ kind: "conflict" });
  });

  it("keeps verified template seed receipts append-only", async () => {
    await env.APP_RELEASE_CATALOG.exec(APP_RELEASE_D1_FRESH_SCHEMA);
    const receipt = {
      template_repository: "templates/shed",
      seed_revision: `git:${"a".repeat(40)}`,
      platform_app_id: "app_shed",
      source_revision: `git:${"b".repeat(40)}`,
      source_tree_digest: `sha256:${"c".repeat(64)}`,
    };
    await env.APP_RELEASE_CATALOG.prepare(
      `INSERT INTO publisher_template_seed_receipts
       (template_repository, seed_revision, platform_app_id, source_revision,
        source_tree_digest, recipe_json, build_recipe_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        receipt.template_repository,
        receipt.seed_revision,
        receipt.platform_app_id,
        receipt.source_revision,
        receipt.source_tree_digest,
        "{}",
        `sha256:${"d".repeat(64)}`,
      )
      .run();
    await expect(
      env.APP_RELEASE_CATALOG.prepare(
        "DELETE FROM publisher_template_seed_receipts WHERE template_repository = ?",
      )
        .bind(receipt.template_repository)
        .run(),
    ).rejects.toThrow(/append-only/);
  });
});
