import test from "node:test";
import assert from "node:assert/strict";
import { compareD1Rows } from "./verify-d1-symbol-daily-returns.mjs";

const row = { id: 1, symbol: "AAPL", market: "us", session_date: "2026-01-02", previous_session_date: "2026-01-01",
  available_at: "2026-01-02 00:00:00.000001+00", available_at_us: 1767312000000001, source: "test",
  price_basis: "adjusted_close", close: "12.30", previous_close: "12.20", simple_return: "0.0081967",
  input_fingerprint: "abc", created_at: "2026-01-02 00:00:02+00" };

test("verifies exact D1 row values and computes a deterministic parity receipt", () => {
  const proof = compareD1Rows([row], [structuredClone(row)]);
  assert.deepEqual({ rows: proof.rows, minId: proof.minId, maxId: proof.maxId }, { rows: 1, minId: 1, maxId: 1 });
  assert.match(proof.rowDigestSha256, /^[a-f0-9]{64}$/);
});

test("fails on numeric-text coercion, missing rows, or reordered rows", () => {
  const numericCoercion = { ...row, close: 12.3 };
  assert.throws(() => compareD1Rows([row], [numericCoercion]), /parity mismatch/);
  assert.throws(() => compareD1Rows([row], []), /row count/);
  assert.throws(() => compareD1Rows([row, { ...row, id: 2 }], [{ ...row, id: 2 }, row]), /parity mismatch/);
});
