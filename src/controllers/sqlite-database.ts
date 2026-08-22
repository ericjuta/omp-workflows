import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type SqliteStatement = {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

export type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

type BunSqliteDatabase = new (
  filePath: string,
  options?: { readonly?: boolean; create?: boolean },
) => SqliteDatabase;

type NodeSqliteDatabase = new (
  filePath: string,
  options?: { readOnly?: boolean; timeout?: number; enableForeignKeyConstraints?: boolean },
) => SqliteDatabase;

/** Node sqlite returns undefined for a miss; bun:sqlite returns null. */
export function normalizeSqliteRow<T>(value: unknown): T | undefined {
  return value == null ? undefined : (value as T);
}

export function wrapSqliteDatabase(database: SqliteDatabase): SqliteDatabase {
  return {
    exec(sql) {
      database.exec(sql);
    },
    close() {
      database.close();
    },
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        run: (...params) => statement.run(...params),
        get: (...params) => normalizeSqliteRow(statement.get(...params)),
        all: (...params) => statement.all(...params),
      };
    },
  };
}

export function openSqliteDatabase(
  filePath: string,
  options: { readOnly?: boolean } = {},
): SqliteDatabase {
  const readOnly = options.readOnly === true;
  if (process.versions.bun !== undefined) {
    const { Database } = require("bun:sqlite") as { Database: BunSqliteDatabase };
    return wrapSqliteDatabase(new Database(filePath, { readonly: readOnly, create: !readOnly }));
  }
  // DatabaseSync enforces this at the SQLite connection boundary; keep writes
  // out of the wrapper rather than trying to classify arbitrary SQL strings.
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: NodeSqliteDatabase };
  return wrapSqliteDatabase(
    new DatabaseSync(filePath, {
      readOnly,
      timeout: 5000,
      enableForeignKeyConstraints: true,
    }),
  );
}

export function execSqlitePragma(database: SqliteDatabase, assignment: string): unknown[] {
  return database.prepare(`PRAGMA ${assignment}`).all();
}

export function runSqliteTransaction<T>(database: SqliteDatabase, task: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const value = task();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
