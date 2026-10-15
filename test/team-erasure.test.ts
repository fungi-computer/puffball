import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expect, it } from "vitest";
import { z } from "zod";

const sqlValue = z.union([
  z.string(),
  z.number(),
  z.bigint(),
  z.null(),
  z.instanceof(Uint8Array),
]);
import {
  APP_RELEASE_D1_FRESH_SCHEMA,
  createTeamAppReleaseErasure,
  type AppReleaseD1Database,
  type AppReleaseD1PreparedStatement,
  type ErasureBucket,
} from "../src/cloudflare.js";

it("erases one Team's catalog and exclusive R2 objects, preserves shared objects, and retries", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  sqlite.exec(APP_RELEASE_D1_FRESH_SCHEMA);
  const prepare = (sql: string, values: SQLInputValue[] = []) => ({
    bind: (...next: unknown[]) =>
      prepare(
        sql,
        next.map((value) => sqlValue.parse(value)),
      ),
    first: () => Promise.resolve(sqlite.prepare(sql).get(...values) ?? null),
    all: () =>
      Promise.resolve({
        success: true,
        results: sqlite.prepare(sql).all(...values),
      }),
    run: () => {
      sqlite.prepare(sql).run(...values);
      return Promise.resolve({ success: true, results: [] });
    },
    execute: () => {
      if (/^\s*SELECT\b/u.test(sql))
        return { success: true, results: sqlite.prepare(sql).all(...values) };
      sqlite.prepare(sql).run(...values);
      return { success: true, results: [] };
    },
  });
  const executions = new WeakMap<
    AppReleaseD1PreparedStatement,
    () => ReturnType<ReturnType<typeof prepare>["execute"]>
  >();
  const database: AppReleaseD1Database = {
    prepare: (query) => {
      const statement = prepare(query);
      const register = (
        current: ReturnType<typeof prepare>,
      ): AppReleaseD1PreparedStatement => {
        const bound = {
          ...current,
          bind: (...values: unknown[]) => register(current.bind(...values)),
        };
        executions.set(bound, () => current.execute());
        return bound;
      };
      return register(statement);
    },
    batch: (statements) => {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => {
          const execute = executions.get(statement);
          if (!execute) throw new Error("Unknown fixture statement");
          return execute();
        });
        sqlite.exec("COMMIT");
        return Promise.resolve(results);
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const shared = `artifact:sha256-${"a".repeat(64)}`;
  const exclusive = `artifact:sha256-${"b".repeat(64)}`;
  const objects = new Map([
    [shared, new Uint8Array([1])],
    [exclusive, new Uint8Array([2])],
  ]);
  let interruptR2Once = true;
  const bucket: ErasureBucket = {
    head: (key: string) =>
      Promise.resolve(
        objects.has(key) ? { size: objects.get(key)?.length } : null,
      ),
    get: (key: string) => {
      const bytes = objects.get(key);
      return Promise.resolve(
        bytes
          ? {
              size: bytes.length,
              version: "1",
              arrayBuffer: () => Promise.resolve(Uint8Array.from(bytes).buffer),
            }
          : null,
      );
    },
    delete: (key: string) => {
      if (key === exclusive && interruptR2Once) {
        interruptR2Once = false;
        throw new Error("R2 interrupted after D1 commit");
      }
      objects.delete(key);
      return Promise.resolve();
    },
  };
  try {
    for (const appId of ["app_one", "app_two"])
      sqlite.prepare("INSERT INTO app_release_apps VALUES (?)").run(appId);
    const publishers: [string, string][] = [
      ["app_one", "team_one"],
      ["app_two", "team_two"],
    ];
    for (const [appId, teamId] of publishers)
      sqlite
        .prepare(
          "INSERT INTO app_release_team_publishers(app_id,team_id,source_provider,source_repository,source_branch) VALUES (?,?,'github',?,'main')",
        )
        .run(appId, teamId, appId);
    const releases: [string, string, string][] = [
      ["rel_one", "app_one", shared],
      ["rel_two", "app_two", shared],
      ["rel_three", "app_one", exclusive],
    ];
    for (const [releaseId, appId, ref] of releases)
      sqlite
        .prepare(
          "INSERT INTO app_release_releases VALUES (?,?,?,'digest','source','tree','recipe')",
        )
        .run(releaseId, appId, ref);
    sqlite
      .prepare(
        "INSERT INTO app_release_transitions(transition_id,operation_kind,idempotency_key,release_id) VALUES ('trans_other','revocation','idem_other','rel_two')",
      )
      .run();
    const transition = sqlite
      .prepare(
        "SELECT sequence FROM app_release_transitions WHERE transition_id='trans_other'",
      )
      .get();
    const sequence = Number(transition?.sequence);
    if (!Number.isSafeInteger(sequence) || sequence <= 0)
      throw new Error("Other App transition was not created");
    sqlite
      .prepare(
        "INSERT INTO app_release_transition_obligation_teams(sequence,team_id,state) VALUES (?,'team_one','pending'),(?,'team_two','pending')",
      )
      .run(sequence, sequence);
    sqlite
      .prepare(
        "INSERT INTO app_release_transition_obligation_pages(sequence,cursor_is_initial,cursor_key,complete,team_ids_json) VALUES (?,1,'initial',1,?)",
      )
      .run(sequence, JSON.stringify(["team_one", "team_two"]));
    const eraser = createTeamAppReleaseErasure(database, bucket);
    const plan = await eraser.preflight("team_one");
    expect(plan.apps).toEqual([{ appId: "app_one", keys: [exclusive] }]);
    await expect(
      eraser.verifyManifest("team_one", ["app_one", "app_two"], [exclusive]),
    ).rejects.toThrow("unscoped App");
    await expect(
      eraser.verifyManifest("team_one", ["app_one"], [exclusive, shared]),
    ).rejects.toThrow("unscoped R2 object");
    await expect(
      eraser.verifyManifest("team_one", ["app_one"], [exclusive]),
    ).resolves.toMatchObject({ teamId: "team_one" });
    await expect(eraser.erase("team_one")).rejects.toThrow("R2 interrupted");
    expect(
      sqlite.prepare("SELECT app_id FROM app_release_erasure_jobs").all(),
    ).toEqual([{ app_id: "app_one" }]);
    expect(objects.has(exclusive)).toBe(true);
    expect(await eraser.erase("team_one")).toEqual({ apps: 1 });
    expect(
      (await eraser.readback("team_one", ["app_one"], [exclusive])).clear,
    ).toBe(true);
    expect(objects.has(shared)).toBe(true);
    expect(objects.has(exclusive)).toBe(false);
    expect(
      sqlite
        .prepare("SELECT team_id FROM app_release_transition_obligation_teams")
        .all(),
    ).toEqual([{ team_id: "team_two" }]);
    expect(
      sqlite
        .prepare(
          "SELECT team_ids_json FROM app_release_transition_obligation_pages",
        )
        .get(),
    ).toEqual({ team_ids_json: '["team_two"]' });
    expect(await eraser.erase("team_one")).toEqual({ apps: 0 });
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() =>
      sqlite
        .prepare("DELETE FROM app_release_apps WHERE app_id='app_two'")
        .run(),
    ).toThrow("append-only");
  } finally {
    sqlite.close();
  }
});
