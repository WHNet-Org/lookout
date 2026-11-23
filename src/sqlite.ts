import { readdirSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { SqlDatabase, SqlResult, SqlValue } from "./store.ts";

export function migrateSqlite(database: DatabaseSync): void {
  const directory = new URL("../migrations/", import.meta.url);
  database.exec("CREATE TABLE IF NOT EXISTS lookout_migrations (name TEXT PRIMARY KEY) STRICT");
  const applied = database.prepare("SELECT 1 FROM lookout_migrations WHERE name = ?");
  const record = database.prepare("INSERT INTO lookout_migrations (name) VALUES (?)");
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec("BEGIN IMMEDIATE");
    try {
      if (!applied.get(file)) {
        database.exec(readFileSync(new URL(file, directory), "utf8"));
        record.run(file);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

export function sqliteDatabase(database: DatabaseSync): SqlDatabase {
  function execute(sql: string, params: SqlValue[] = []): SqlResult {
    const statement = database.prepare(sql);
    if (statement.columns().length > 0) {
      const rows = statement.all(...params);
      return { rows, changes: rows.length };
    }
    return { rows: [], changes: Number(statement.run(...params).changes) };
  }

  return {
    async execute(sql, params) {
      return execute(sql, params);
    },
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(({ sql, params }) => execute(sql, params));
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
