import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { sqliteD1 } from "../src/testing.js";
import { APP_RELEASE_D1_FRESH_SCHEMA } from "../src/cloudflare.js";
const opened: DatabaseSync[] = [];
afterEach(() => {
  for (const database of opened.splice(0)) database.close();
});
function open() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  opened.push(sqlite);
  return { sqlite, database: sqliteD1(sqlite) };
}

it("executes D1 statements and decodes native scalar and blob rows", async () => {
  const fixture = open();
  fixture.sqlite.exec(
    "CREATE TABLE rows (id INTEGER PRIMARY KEY, text TEXT, bytes BLOB)",
  );
  const bytes = new Uint8Array([3, 9]).buffer;
  expect(
    await fixture.database
      .prepare("INSERT INTO rows VALUES (?, ?, ?)")
      .bind(1, "hello", bytes)
      .run(),
  ).toMatchObject({ success: true, meta: { changes: 1 } });
  expect(
    await fixture.database.prepare("SELECT id FROM rows").run(),
  ).toMatchObject({ meta: { changes: 0 } });
  expect(
    await fixture.database
      .prepare("SELECT * FROM rows WHERE id = ?")
      .bind(1)
      .first(),
  ).toEqual({ id: 1, text: "hello", bytes });
  expect(
    await fixture.database
      .prepare("SELECT * FROM rows WHERE id = ?")
      .bind(2)
      .first(),
  ).toBeNull();
  expect(
    await fixture.database.prepare("SELECT id FROM rows").all(),
  ).toMatchObject({ results: [{ id: 1 }] });
});

it("rolls back a failed batch and permits a later batch", async () => {
  const fixture = open();
  fixture.sqlite.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY)");
  const insert = fixture.database.prepare("INSERT INTO rows VALUES (?)");
  await expect(
    fixture.database.batch([insert.bind(1), insert.bind(1)]),
  ).rejects.toThrow();
  expect(
    await fixture.database.prepare("SELECT id FROM rows").all(),
  ).toMatchObject({ results: [] });
  await fixture.database.batch([insert.bind(1), insert.bind(2)]);
  expect(
    await fixture.database.prepare("SELECT id FROM rows ORDER BY id").all(),
  ).toMatchObject({ results: [{ id: 1 }, { id: 2 }] });
});

it("refuses a foreign statement without committing earlier batch writes", async () => {
  const first = open();
  const second = open();
  first.sqlite.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY)");
  await expect(
    first.database.batch([
      first.database.prepare("INSERT INTO rows VALUES (1)"),
      second.database.prepare("SELECT 1"),
    ]),
  ).rejects.toThrow("different database");
  expect(
    await first.database.prepare("SELECT id FROM rows").all(),
  ).toMatchObject({ results: [] });
});

it("accepts the canonical App Release schema with foreign keys enforced", async () => {
  const fixture = open();
  fixture.sqlite.exec(APP_RELEASE_D1_FRESH_SCHEMA);
  expect(await fixture.database.prepare("PRAGMA foreign_keys").first()).toEqual(
    { foreign_keys: 1 },
  );
  expect(
    await fixture.database.prepare("PRAGMA foreign_key_check").all(),
  ).toMatchObject({ results: [] });
  expect(
    await fixture.database.prepare("SELECT app_id FROM app_release_apps").all(),
  ).toMatchObject({ results: [] });
});
