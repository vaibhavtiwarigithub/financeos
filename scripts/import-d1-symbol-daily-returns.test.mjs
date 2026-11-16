import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildImportFiles, insertSql, toD1Row } from "./import-d1-symbol-daily-returns.mjs";
import { timestampToEpochMicros } from "./partition-symbol-daily-returns.mjs";

const sourceRow = {
  id: "1", symbol: "A'B", market: "us", session_date: "2026-01-02", previous_session_date: "2026-01-01",
  available_at: "2026-01-02 00:00:00.000001+00", source: "test", price_basis: "adjusted_close",
  close: "12.30", previous_close: "12.20", simple_return: "0.0081967213", input_fingerprint: "abc",
  created_at: "2026-01-02 00:00:01+00",
};

test("maps verified PostgreSQL rows to D1 while preserving decimals and timestamp precision", () => {
  const mapped = toD1Row(sourceRow);
  assert.equal(mapped.id, 1);
  assert.equal(mapped.symbol, "A'B");
  assert.equal(mapped.close, "12.30");
  assert.equal(mapped.simple_return, "0.0081967213");
  assert.equal(mapped.available_at_us, timestampToEpochMicros(sourceRow.available_at));
});

test("creates escaped idempotent SQL inserts below D1 per-statement byte limit", () => {
  const sql = insertSql([toD1Row(sourceRow)]);
  assert.match(sql, /INSERT OR IGNORE INTO symbol_daily_returns/);
  assert.match(sql, /'A''B'/);
  assert.match(sql, /'12\.30'/);
  assert.ok(Buffer.byteLength(sql) < 100_000);
  assert.throws(() => insertSql([]), /must contain/);
});

test("chunks local bulk SQL into bounded files with integrity metadata", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kairos-d1-test-"));
  try {
    const rows = Array.from({ length: 111 }, (_, i) => ({ ...toD1Row(sourceRow), id: i + 1 }));
    const files = buildImportFiles(rows, dir);
    assert.equal(files.length, 1);
    assert.equal(files[0].rowCount, 111);
    assert.equal(files[0].statementCount, 3);
    assert.equal(fs.readFileSync(path.join(dir, files[0].filename), "utf8").match(/INSERT OR IGNORE/g).length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
