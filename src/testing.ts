import type { DatabaseSync } from "node:sqlite";
import * as Schema from "effect/Schema";
import {
  watchdogSqliteValueSchema,
  type WatchdogSqliteValue,
} from "@fungi.computer/watchdog";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import type {
  AppReleaseD1Database,
  AppReleaseD1PreparedStatement,
  AppReleaseD1QueryResult,
} from "./cloudflare.js";

const decodeBindings = Schema.decodeUnknownSync(
  Schema.Array(watchdogSqliteValueSchema),
);
const decodeChanges = Schema.decodeUnknownSync(
  Schema.Struct({ changes: Schema.Number }),
);

/**
 * Adapt caller-owned Node SQLite to the catalog's D1 transport for tests and
 * quick starts. The caller applies schema and closes the database. This is not
 * a Cloudflare emulator or an isolation boundary.
 */
export function sqliteD1(sqlite: DatabaseSync): AppReleaseD1Database {
  const owner = fromNodeSqlite(sqlite);
  const executions = new WeakMap<
    AppReleaseD1PreparedStatement,
    () => AppReleaseD1QueryResult
  >();
  const prepare = (
    sql: string,
    values: readonly WatchdogSqliteValue[] = [],
  ): AppReleaseD1PreparedStatement => {
    const execute = () => {
      const before = decodeChanges(
        owner.sql.exec("SELECT total_changes() AS changes").one(),
      ).changes;
      const results = owner.sql.exec(sql, ...values).toArray();
      const after = decodeChanges(
        owner.sql.exec("SELECT total_changes() AS changes").one(),
      ).changes;
      const { changes } = decodeChanges(
        owner.sql.exec("SELECT changes() AS changes").one(),
      );
      return {
        success: true,
        results,
        meta: { changes: after === before ? 0 : changes },
      };
    };
    const statement: AppReleaseD1PreparedStatement = {
      bind: (...next) => prepare(sql, decodeBindings(next)),
      first: () =>
        Promise.resolve().then(
          () => owner.sql.exec(sql, ...values).toArray()[0] ?? null,
        ),
      all: () =>
        Promise.resolve().then(() => ({
          success: true,
          results: owner.sql.exec(sql, ...values).toArray(),
        })),
      run: () => Promise.resolve().then(execute),
    };
    executions.set(statement, execute);
    return statement;
  };
  return {
    prepare,
    batch: (statements) =>
      Promise.resolve().then(() =>
        owner.transactionSync(() =>
          statements.map((statement) => {
            const execute = executions.get(statement);
            if (execute === undefined)
              throw new Error("Statement belongs to a different database");
            return execute();
          }),
        ),
      ),
  };
}
