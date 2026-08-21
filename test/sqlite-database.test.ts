import { describe, expect, it } from "vitest";
import { normalizeSqliteRow } from "../src/controllers/sqlite-database.js";

describe("normalizeSqliteRow", () => {
  it("treats bun null and node undefined misses as missing", () => {
    expect(normalizeSqliteRow(null)).toBeUndefined();
    expect(normalizeSqliteRow(undefined)).toBeUndefined();
    expect(normalizeSqliteRow({ live: 1 })).toEqual({ live: 1 });
  });
});
