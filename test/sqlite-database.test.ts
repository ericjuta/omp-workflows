import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeSqliteRow,
  openSqliteDatabase,
  wrapSqliteDatabase,
  type SqliteDatabase,
} from "../src/controllers/sqlite-database.js";
import { makeTempDir } from "./helpers.js";

describe("normalizeSqliteRow", () => {
  it("treats bun null and node undefined misses as missing", () => {
    expect(normalizeSqliteRow(null)).toBeUndefined();
    expect(normalizeSqliteRow(undefined)).toBeUndefined();
    expect(normalizeSqliteRow({ live: 1 })).toEqual({ live: 1 });
  });
});

describe("wrapSqliteDatabase", () => {
  it("normalizes a null statement miss", () => {
    const database: SqliteDatabase = {
      exec() {},
      close() {},
      prepare: () => ({
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
        get: () => null,
        all: () => [],
      }),
    };

    expect(wrapSqliteDatabase(database).prepare("SELECT 1").get()).toBeUndefined();
  });

  it("keeps the runtime database connection read-only", async () => {
    const file = path.join(await makeTempDir("sqlite-readonly"), "store.sqlite");
    const writer = openSqliteDatabase(file);
    writer.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
    writer.close();

    const reader = openSqliteDatabase(file, { readOnly: true });
    try {
      expect(() => reader.prepare("INSERT INTO items (id) VALUES (?)").run(1)).toThrow(/readonly/i);
    } finally {
      reader.close();
    }
  });
});
