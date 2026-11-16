import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createGzip, gunzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

export const DATASET = "symbol-daily-returns";
export const VERSION = 1;
export const COLUMNS = [
  "id", "symbol", "market", "session_date", "previous_session_date", "available_at",
  "source", "price_basis", "close", "previous_close", "simple_return", "input_fingerprint", "created_at",
];

function decodeCopyField(value) {
  if (value === "\\N") return null;
  return value.replace(/\\([0-7]{1,3}|x[0-9a-fA-F]{1,2}|.)/g, (match, escape) => {
    if (/^[0-7]/.test(escape)) return String.fromCharCode(Number.parseInt(escape, 8));
    if (escape[0] === "x") return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    return ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\" })[escape] ?? escape;
  });
}

export function timestampToEpochMicros(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2})(?::?(\d{2}))?)$/.exec(value);
  if (!match) throw new Error("Invalid PostgreSQL timestamp with time zone");
  const [, year, month, day, hour, minute, second, fraction = "", zone, sign, offsetHour = "0", offsetMinute = "0"] = match;
  const utcMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  const check = new Date(utcMs);
  if (check.getUTCFullYear() !== Number(year) || check.getUTCMonth() !== Number(month) - 1
    || check.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || Number(offsetHour) > 23 || Number(offsetMinute) > 59) throw new Error("Out-of-range PostgreSQL timestamp");
  const offset = zone === "Z" ? 0 : (Number(offsetHour) * 60 + Number(offsetMinute)) * (sign === "+" ? 1 : -1);
  const micros = BigInt(utcMs) * 1000n + BigInt(fraction.padEnd(6, "0") || "0") - BigInt(offset) * 60_000_000n;
  const result = Number(micros);
  if (!Number.isSafeInteger(result)) throw new Error("PostgreSQL timestamp exceeds safe integer microseconds");
  return result;
}

export function parseCopyRows(sql) {
  const marker = `COPY public.symbol_daily_returns (${COLUMNS.join(", ")}) FROM stdin;\n`;
  const start = sql.indexOf(marker);
  if (start < 0) throw new Error("Expected the verified symbol_daily_returns COPY section");
  const bodyStart = start + marker.length;
  const end = sql.indexOf("\n\\.\n", bodyStart);
  if (end < 0) throw new Error("COPY section has no terminator");
  const lines = sql.slice(bodyStart, end).split("\n");
  const rows = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (!line) continue;
    const fields = line.split("\t");
    if (fields.length !== COLUMNS.length) throw new Error(`COPY row ${lineIndex + 1} has ${fields.length} fields`);
    const row = Object.fromEntries(COLUMNS.map((column, index) => [column, decodeCopyField(fields[index])]));
    if (!/^\d+$/.test(row.id) || !/^(us|india)$/.test(row.market)
      || !/^\d{4}-\d{2}-\d{2}$/.test(row.session_date)
      || !/^\d{4}-\d{2}$/.test(row.session_date.slice(0, 7))) {
      throw new Error(`COPY row ${lineIndex + 1} violates the table export contract`);
    }
    row.available_at_us = timestampToEpochMicros(row.available_at);
    rows.push(row);
  }
  return rows;
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

export function partitionRows(rows) {
  const partitions = new Map();
  const ids = new Set();
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isSafeInteger(id) || id <= 0 || ids.has(id)) throw new Error("Source rows must have unique positive IDs");
    ids.add(id);
    const key = `${row.market}/${row.session_date.slice(0, 7)}`;
    const partition = partitions.get(key) ?? [];
    partition.push(row);
    partitions.set(key, partition);
  }
  return partitions;
}

export async function partitionVerifiedArchive({ sourceDir, outputDir }) {
  const root = path.resolve(process.env.LOCALAPPDATA ?? "", "Kairos", "backups", "database", "table-archives", "2026-11-16", "symbol_daily_returns_full");
  const source = path.resolve(sourceDir ?? "");
  const output = path.resolve(outputDir ?? "");
  if (process.platform !== "win32" || source !== root || !fs.existsSync(path.join(source, "manifest.json"))) {
    throw new Error("Source must be the existing owner-local verified daily-return archive");
  }
  const privateRoot = path.resolve(process.env.LOCALAPPDATA, "Kairos", "backups", "database", "r2-partitions");
  if (!output.startsWith(privateRoot + path.sep)) throw new Error("Partition output must stay in the owner-local backup directory");
  const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
  if (manifest.table !== "public.symbol_daily_returns" || manifest.verification !== "Restored locally from extracted full PostgreSQL backup; count, bounds and ordered digest match live production"
    || manifest.row_count !== 261678 || !/^[a-f0-9]{64}$/.test(manifest.data_sql_gzip_sha256)) {
    throw new Error("Verified source manifest mismatch");
  }
  const archive = fs.readFileSync(path.join(source, "data.sql.gz"));
  if (sha256(archive) !== manifest.data_sql_gzip_sha256) throw new Error("Source archive SHA-256 mismatch");
  const sql = gunzipSync(archive).toString("utf8");
  const rows = parseCopyRows(sql);
  const ids = rows.map(row => Number(row.id));
  const idBounds = ids.reduce((bounds, id) => ({ min: Math.min(bounds.min, id), max: Math.max(bounds.max, id) }),
    { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY });
  if (rows.length !== manifest.row_count || idBounds.min !== manifest.min_id || idBounds.max !== manifest.max_id) {
    throw new Error("Parsed row count or ID bounds do not match the verified source manifest");
  }
  const partitions = partitionRows(rows);
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const partitionMetadata = [];
  let totalBytes = 0;
  for (const [marketMonth, partitionRows] of [...partitions].sort(([a], [b]) => a.localeCompare(b))) {
    const [market, month] = marketMonth.split("/");
    const key = `${market}/${month}.jsonl.gz`;
    const jsonl = `${partitionRows.map(row => JSON.stringify(row)).join("\n")}\n`;
    const compressed = await new Promise((resolve, reject) => {
      const chunks = [];
      const gzip = createGzip({ level: 9, mtime: 0 });
      gzip.on("data", chunk => chunks.push(chunk));
      gzip.on("error", reject);
      gzip.on("end", () => resolve(Buffer.concat(chunks)));
      Readable.from([jsonl]).pipe(gzip);
    });
    const filename = path.join(output, `${market}-${month}.jsonl.gz`);
    fs.writeFileSync(filename, compressed, { mode: 0o600 });
    const bounds = partitionRows.reduce((acc, row) => {
      const id = Number(row.id);
      const date = row.session_date;
      return { minId: Math.min(acc.minId, id), maxId: Math.max(acc.maxId, id),
        minDate: acc.minDate < date ? acc.minDate : date, maxDate: acc.maxDate > date ? acc.maxDate : date };
    }, { minId: Number.POSITIVE_INFINITY, maxId: Number.NEGATIVE_INFINITY, minDate: "9999-99-99", maxDate: "0000-00-00" });
    partitionMetadata.push({ key, rowCount: partitionRows.length, minId: bounds.minId, maxId: bounds.maxId,
      minDate: bounds.minDate, maxDate: bounds.maxDate, compressedBytes: compressed.length,
      uncompressedBytes: Buffer.byteLength(jsonl), sha256: sha256(compressed) });
    totalBytes += compressed.length;
  }
  const index = { version: VERSION, dataset: DATASET, table: "public.symbol_daily_returns", projectRef: manifest.project_ref,
    sourceManifestSha256: sha256(fs.readFileSync(path.join(source, "manifest.json"))), sourceRows: rows.length,
    sourceOrderedDigest: manifest.ordered_row_digest, columns: COLUMNS, generatedAt: new Date().toISOString(), partitions: partitionMetadata };
  fs.writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return { partitionCount: partitionMetadata.length, rowCount: rows.length, compressedBytes: totalBytes, index };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [sourceDir, outputDir] = process.argv.slice(2);
  try {
    const result = await partitionVerifiedArchive({ sourceDir, outputDir });
    console.log(JSON.stringify({ partitionCount: result.partitionCount, rowCount: result.rowCount, compressedBytes: result.compressedBytes,
      manifestSha256: sha256(fs.readFileSync(path.join(outputDir, "manifest.json"))) }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Partition generation failed");
    process.exitCode = 1;
  }
}
