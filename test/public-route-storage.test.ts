import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import {
  publicRoutePolicy,
  publicRouteKey,
} from "../src/public-route-policy.js";
import { routeKeySql } from "../src/internal/public-route-sql.js";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

it("enforces the policy key in SQLite rather than trusting the writer", () => {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`CREATE TABLE policy_input (
    value TEXT NOT NULL, route_key TEXT NOT NULL CHECK(route_key = ${routeKeySql("value")})
  ) STRICT`);
  const insert = database.prepare("INSERT INTO policy_input VALUES (?, ?)");
  expect(() => insert.run("/my-app", "foreignkey")).toThrow();
  for (const value of [
    "/adm1n",
    "/admln",
    "/supp0rt",
    "/5ecur1ty",
    "/my_app",
    "/my-app",
    ...publicRoutePolicy.reservedWords,
    ...publicRoutePolicy.brandWordExceptions,
    ...publicRoutePolicy.brandPrefixes,
  ])
    expect(() => insert.run(value, publicRouteKey(value))).not.toThrow();
  expect(
    database
      .prepare("SELECT route_key FROM policy_input WHERE value=?")
      .get("/adm1n"),
  ).toEqual({ route_key: "admin" });
});
