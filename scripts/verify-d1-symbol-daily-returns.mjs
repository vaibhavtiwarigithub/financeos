import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readVerifiedR2Rows } from "./import-d1-symbol-daily-returns.mjs";

const COLUMNS = ["id", "symbol", "market", "session_date", "previous_session_date", "available_at", "available_at_us",
  "source", "price_basis", "close", "previous_close", "simple_return", "input_fingerprint", "created_at"];

function canonical(row) { return JSON.stringify(COLUMNS.map(column => row[column])); }
function digest(rows) {
  const hash = createHash("sha256");
  for (const row of rows) hash.update(canonical(row)).update("\n");
  return hash.digest("hex");
}

export function compareD1Rows(expected, actual) {
  if (expected.length !== actual.length) throw new Error(`D1 row count ${actual.length} does not match source count ${expected.length}`);
  for (let i = 0; i < expected.length; i++) {
    for (const column of COLUMNS) {
      if (expected[i][column] !== actual[i][column]) throw new Error(`D1 parity mismatch at row ${i + 1}, column ${column}`);
    }
  }
  return { rows: expected.length, minId: expected[0]?.id ?? null, maxId: expected.at(-1)?.id ?? null,
    rowDigestSha256: digest(expected) };
}

export function verifyD1QueryDump({ archiveDir, queryDumpPath, queryDumpPaths, expectedRows, startRow = 0 }) {
  if (!Number.isSafeInteger(expectedRows) || expectedRows < 1 || !Number.isSafeInteger(startRow) || startRow < 0) {
    throw new Error("Expected D1 row count and start row must be valid integers");
  }
  const outputRoot = path.resolve(process.env.LOCALAPPDATA ?? "", "Kairos", "backups", "database", "d1-imports");
  const paths = queryDumpPaths ?? [queryDumpPath];
  if (!Array.isArray(paths) || paths.length < 1) throw new Error("At least one D1 query output is required");
  const actual = [];
  let rowsRead = 0;
  let d1Bytes = 0;
  for (const candidate of paths) {
    const dumpPath = path.resolve(candidate ?? "");
    if (!dumpPath.startsWith(outputRoot + path.sep)) throw new Error("D1 query output must stay in the owner-local backup directory");
    const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
    const result = Array.isArray(dump) ? dump[0] : dump;
    if (!result?.success || !Array.isArray(result.results) || !Number.isSafeInteger(result.meta?.rows_read)
      || result.meta.rows_read > 400_000 || !Number.isSafeInteger(result.meta?.size_after) || result.meta.size_after > 500_000_000) {
      throw new Error("D1 query metadata is missing, outside the guard, or unsuccessful");
    }
    actual.push(...result.results);
    rowsRead += result.meta.rows_read;
    d1Bytes = Math.max(d1Bytes, result.meta.size_after);
  }
  if (rowsRead > 5_000_000) throw new Error("D1 parity reads exceed the 5 million daily Free limit");
  const { allRows } = readVerifiedR2Rows({ archiveDir });
  const expected = allRows.slice(startRow, startRow + expectedRows);
  const proof = compareD1Rows(expected, actual);
  return { ...proof, startRow, rowsRead, d1Bytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [archiveDir, second, third, ...rest] = process.argv.slice(2);
  try {
    const legacy = !/^\d+$/.test(second ?? "");
    const proof = legacy
      ? verifyD1QueryDump({ archiveDir, queryDumpPath: second, expectedRows: Number(third) })
      : verifyD1QueryDump({ archiveDir, expectedRows: Number(second), startRow: Number(third), queryDumpPaths: rest });
    console.log(JSON.stringify({ verified: true, ...proof }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "D1 data verification failed");
    process.exitCode = 1;
  }
}
