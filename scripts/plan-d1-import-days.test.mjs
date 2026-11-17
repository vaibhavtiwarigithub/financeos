import test from "node:test";
import assert from "node:assert/strict";
import { buildDailyChunks, DEFAULT_INDEX_COUNT, DEFAULT_ROWS_PER_DAY } from "./plan-d1-import-days.mjs";

function insertRows(count) {
  const statements = [];
  for (let offset = 0; offset < count; offset += 50) {
    const rows = Array.from({ length: Math.min(50, count - offset) }, (_, index) => `(${offset + index + 1},'AAPL','us','2026-01-02')`).join(",\n");
    statements.push(`INSERT OR IGNORE INTO symbol_daily_returns (id,symbol,market,session_date) VALUES\n${rows};`);
  }
  return `${statements.join("\n")}\n`;
}

test("splits exact import statements under indexed D1 daily write budget", () => {
  const files = [{ filename: "first.sql", sql: insertRows(100) }, { filename: "second.sql", sql: insertRows(150) }];
  const plan = buildDailyChunks(files, { rowsPerDay: 100, indexCount: 1 });
  assert.deepEqual(plan.map(({ day, rowCount, estimatedRowsWritten, estimatedWriteHeadroom }) =>
    ({ day, rowCount, estimatedRowsWritten, estimatedWriteHeadroom })), [
    { day: 1, rowCount: 100, estimatedRowsWritten: 200, estimatedWriteHeadroom: 99_800 },
    { day: 2, rowCount: 100, estimatedRowsWritten: 200, estimatedWriteHeadroom: 99_800 },
    { day: 3, rowCount: 50, estimatedRowsWritten: 100, estimatedWriteHeadroom: 99_900 },
  ]);
  assert.equal(plan.flatMap(chunk => chunk.statements).join("\n"), `${files[0].sql.trimEnd()}\n${files[1].sql.trimEnd()}`);
});

test("rejects unexpected SQL, unsafe daily budgets, and index assumptions", () => {
  assert.throws(() => buildDailyChunks([{ sql: "DELETE FROM symbol_daily_returns;" }]), /unexpected statement/);
  assert.throws(() => buildDailyChunks([{ sql: insertRows(1) }], { rowsPerDay: 101 }), /Invalid D1 daily import budget/);
  assert.throws(() => buildDailyChunks([{ sql: insertRows(1) }], { rowsPerDay: 50, indexCount: 5 }), /Invalid D1 daily import budget/);
});

test("defaults to the two-index free-tier import ceiling with write headroom", () => {
  assert.equal(DEFAULT_ROWS_PER_DAY, 20_000);
  assert.equal(DEFAULT_INDEX_COUNT, 2);
  const plan = buildDailyChunks([{ sql: insertRows(20_000) }]);
  assert.equal(plan[0].rowCount, 20_000);
  assert.equal(plan[0].estimatedRowsWritten, 60_000);
  assert.equal(plan[0].estimatedWriteHeadroom, 40_000);
});
