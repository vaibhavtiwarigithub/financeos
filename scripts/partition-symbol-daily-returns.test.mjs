import test from "node:test";
import assert from "node:assert/strict";
import { COLUMNS, parseCopyRows, partitionRows, timestampToEpochMicros } from "./partition-symbol-daily-returns.mjs";

const marker = `COPY public.symbol_daily_returns (${COLUMNS.join(", ")}) FROM stdin;\n`;
const row = (id, symbol, market, date, fingerprint = "f") => [id, symbol, market, date, date,
  `${date} 12:00:00+00`, "provider", "raw_close", "12.30", "12.20", "0.0081967213", fingerprint,
  `${date} 12:01:00+00`].join("\t");

test("parses COPY text rows and preserves decimal/timestamp text without SQL coercion", () => {
  const parsed = parseCopyRows(`${marker}${row("1", "BRK.B", "us", "2026-01-02")}\n\\.\n`);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].symbol, "BRK.B");
  assert.equal(parsed[0].close, "12.30");
  assert.equal(parsed[0].available_at, "2026-01-02 12:00:00+00");
  assert.equal(parsed[0].available_at_us, timestampToEpochMicros("2026-01-02 12:00:00+00"));
});

test("normalizes PostgreSQL timestamp offsets without losing microseconds", () => {
  assert.equal(timestampToEpochMicros("2026-01-02 00:00:00.000001+00"), 1767312000000001);
  assert.equal(timestampToEpochMicros("2026-01-02 05:30:00.000001+05:30"), 1767312000000001);
  assert.throws(() => timestampToEpochMicros("2026-02-30 00:00:00+00"), /Out-of-range/);
});

test("decodes PostgreSQL COPY escapes and nulls", () => {
  const parsed = parseCopyRows(`${marker}${row("1", "A\\tB", "us", "2026-01-02", "line\\n\\\\quote")}\n\\.\n`);
  assert.equal(parsed[0].symbol, "A\tB");
  assert.equal(parsed[0].input_fingerprint, "line\n\\quote");
  const withNull = row("1", "A", "us", "2026-01-02").replace("\tprovider\traw_close", "\t\\N\traw_close");
  assert.equal(parseCopyRows(`${marker}${withNull}\n\\.\n`)[0].source, null);
});

test("rejects malformed source sections and duplicate IDs without assuming source order", () => {
  assert.throws(() => parseCopyRows("COPY missing"), /Expected the verified/);
  assert.throws(() => parseCopyRows(`${marker}1\ttoo-few\n\\.\n`), /has 2 fields/);
  assert.throws(() => partitionRows([
    { id: "3", market: "us", session_date: "2026-01-01" },
    { id: "3", market: "us", session_date: "2026-01-02" },
  ]), /unique positive IDs/);
});

test("partitions by market and UTC month while retaining original row order", () => {
  const rows = [
    { id: "1", market: "us", session_date: "2026-01-05" },
    { id: "2", market: "india", session_date: "2026-01-05" },
    { id: "3", market: "us", session_date: "2026-02-02" },
  ];
  const partitions = partitionRows(rows);
  assert.deepEqual([...partitions.keys()], ["us/2026-01", "india/2026-01", "us/2026-02"]);
  assert.deepEqual(partitions.get("us/2026-01").map(item => item.id), ["1"]);
});
