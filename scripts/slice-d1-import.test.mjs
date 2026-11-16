import test from "node:test";
import assert from "node:assert/strict";
import { sliceImportStatements } from "./slice-d1-import.mjs";

const sql = `INSERT OR IGNORE INTO symbol_daily_returns (id,symbol) VALUES\n(1,'A'),\n(2,'B');\nINSERT OR IGNORE INTO symbol_daily_returns (id,symbol) VALUES\n(3,'C');\n`;

test("slices D1 SQL only at complete statement and row boundaries", () => {
  const first = sliceImportStatements(sql, 2);
  assert.equal(first.rowCount, 2);
  assert.equal(first.statementCount, 1);
  assert.ok(first.sql.endsWith(";"));
  assert.throws(() => sliceImportStatements(sql, 1), /statement boundary/);
  assert.throws(() => sliceImportStatements(sql, 4), /only 3 were available/);
});

test("rejects unexpected statements and incomplete SQL", () => {
  assert.throws(() => sliceImportStatements("DELETE FROM table;\n", 1), /Unexpected/);
  assert.throws(() => sliceImportStatements("INSERT OR IGNORE INTO table VALUES (1)", 1), /incomplete/);
});

test("resumes a daily chunk at an exact statement boundary", () => {
  const remainder = sliceImportStatements(sql, 1, 2);
  assert.equal(remainder.rowCount, 1);
  assert.equal(remainder.statementCount, 1);
  assert.match(remainder.sql, /\(3,'C'\)/);
  assert.throws(() => sliceImportStatements(sql, 1, 1), /statement boundary/);
});
