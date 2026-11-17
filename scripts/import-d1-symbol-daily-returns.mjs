import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { timestampToEpochMicros, VERSION, DATASET } from "./partition-symbol-daily-returns.mjs";

export const IMPORT_ROWS_PER_FILE = 40_000;
export const INSERT_ROWS_PER_STATEMENT = 50;
const COLUMNS = ["id", "symbol", "market", "session_date", "previous_session_date", "available_at", "available_at_us",
  "source", "price_basis", "close", "previous_close", "simple_return", "input_fingerprint", "created_at"];

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function quote(value) {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Non-integer numeric value in D1 import row");
    return String(value);
  }
  if (typeof value !== "string" || value.includes("\0")) throw new Error("Invalid text value in D1 import row");
  return `'${value.replaceAll("'", "''")}'`;
}

export function toD1Row(row) {
  const id = Number(row.id);
  if (!Number.isSafeInteger(id) || id <= 0 || !/^(us|india)$/.test(row.market)
    || !/^\d{4}-\d{2}-\d{2}$/.test(row.session_date) || !/^(adjusted_close|raw_close)$/.test(row.price_basis)) {
    throw new Error("Invalid symbol_daily_returns row for D1");
  }
  return { id, symbol: row.symbol, market: row.market, session_date: row.session_date,
    previous_session_date: row.previous_session_date, available_at: row.available_at,
    available_at_us: timestampToEpochMicros(row.available_at), source: row.source,
    price_basis: row.price_basis, close: row.close, previous_close: row.previous_close,
    simple_return: row.simple_return, input_fingerprint: row.input_fingerprint, created_at: row.created_at };
}

export function insertSql(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > INSERT_ROWS_PER_STATEMENT) {
    throw new Error(`D1 insert statement must contain 1-${INSERT_ROWS_PER_STATEMENT} rows`);
  }
  const values = rows.map(row => `(${COLUMNS.map(column => quote(row[column])).join(",")})`).join(",\n");
  const sql = `INSERT OR IGNORE INTO symbol_daily_returns (${COLUMNS.join(",")}) VALUES\n${values};\n`;
  if (Buffer.byteLength(sql) >= 100_000) throw new Error("D1 statement exceeds the 100 KB query limit");
  return sql;
}

export function buildImportFiles(rows, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const files = [];
  for (let offset = 0, part = 0; offset < rows.length; offset += IMPORT_ROWS_PER_FILE, part++) {
    const chunk = rows.slice(offset, offset + IMPORT_ROWS_PER_FILE);
    const statements = [];
    for (let start = 0; start < chunk.length; start += INSERT_ROWS_PER_STATEMENT) {
      statements.push(insertSql(chunk.slice(start, start + INSERT_ROWS_PER_STATEMENT)));
    }
    if (statements.length > 1000) throw new Error("D1 file exceeds the 1,000-statement batch limit");
    const content = statements.join("\n");
    const filename = `symbol_daily_returns_${String(part + 1).padStart(3, "0")}.sql`;
    fs.writeFileSync(path.join(outputDir, filename), content, { flag: "wx", mode: 0o600 });
    files.push({ filename, rowCount: chunk.length, statementCount: statements.length,
      bytes: Buffer.byteLength(content), sha256: sha256(content) });
  }
  return files;
}

export function readVerifiedR2Rows({ archiveDir }) {
  const base = path.resolve(process.env.LOCALAPPDATA ?? "", "Kairos", "backups", "database", "r2-partitions", "symbol-daily-returns-v1");
  const archive = path.resolve(archiveDir ?? "");
  if (process.platform !== "win32" || archive !== base) throw new Error("Use the owner-local verified R2 partition download");
  const manifestBytes = fs.readFileSync(path.join(archive, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const downloadedManifest = fs.readFileSync(path.join(archive, "r2-roundtrip", "manifest.json"));
  if (sha256(manifestBytes) !== sha256(downloadedManifest) || manifest.version !== VERSION || manifest.dataset !== DATASET
    || manifest.table !== "public.symbol_daily_returns" || manifest.sourceRows !== 261678
    || manifest.sourceOrderedDigest !== "846c84ce7217a485a509e13cc3539921" || !Array.isArray(manifest.partitions)) {
    throw new Error("R2 partition manifest failed its source and round-trip checks");
  }
  const allRows = [];
  const ids = new Set();
  for (const partition of manifest.partitions) {
    if (!/^(us|india)\/\d{4}-\d{2}\.jsonl\.gz$/.test(partition.key)
      || !Number.isSafeInteger(partition.rowCount) || !/^[a-f0-9]{64}$/.test(partition.sha256)) throw new Error("Invalid R2 partition manifest entry");
    const localName = partition.key.replaceAll("/", "-");
    const downloadPath = path.join(archive, "r2-roundtrip", localName);
    const bytes = fs.readFileSync(downloadPath);
    if (bytes.length !== partition.compressedBytes || sha256(bytes) !== partition.sha256) throw new Error(`R2 round-trip checksum mismatch for ${partition.key}`);
    const text = gunzipSync(bytes).toString("utf8");
    const lines = text.trimEnd().split("\n");
    if (lines.length !== partition.rowCount) throw new Error(`Partition row count mismatch for ${partition.key}`);
    for (const line of lines) {
      const sourceRow = JSON.parse(line);
      const [partitionMarket, filename] = partition.key.split("/");
      if (sourceRow.market !== partitionMarket || sourceRow.session_date.slice(0, 7) !== filename.slice(0, 7)) {
        throw new Error(`Partition row does not match its market/month: ${partition.key}`);
      }
      const row = toD1Row(sourceRow);
      if (ids.has(row.id)) throw new Error("Duplicate primary ID across verified R2 partitions");
      ids.add(row.id);
      allRows.push(row);
    }
  }
  if (allRows.length !== manifest.sourceRows) throw new Error("Combined R2 partition count does not match source");
  allRows.sort((a, b) => a.id - b.id);
  if (allRows[0]?.id !== 1 || allRows.at(-1)?.id !== 4256041) throw new Error("Combined R2 partition ID bounds do not match source");
  return { manifest, manifestSha256: sha256(manifestBytes), allRows };
}

export function loadVerifiedR2Partitions({ archiveDir, outputDir }) {
  const outputRoot = path.resolve(process.env.LOCALAPPDATA ?? "", "Kairos", "backups", "database", "d1-imports");
  const output = path.resolve(outputDir ?? "");
  if (!output.startsWith(outputRoot + path.sep)) throw new Error("D1 import files must stay in the owner-local backup directory");
  const { manifest, manifestSha256, allRows } = readVerifiedR2Rows({ archiveDir });
  const files = buildImportFiles(allRows, output);
  const transfer = { dataset: manifest.dataset, schemaVersion: VERSION, sourceManifestSha256: manifestSha256,
    sourceRows: manifest.sourceRows, sourceOrderedDigest: manifest.sourceOrderedDigest,
    r2RoundTripVerified: true, generatedAt: new Date().toISOString(), files };
  fs.writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify(transfer, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return transfer;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [archiveDir, outputDir] = process.argv.slice(2);
  try {
    const result = loadVerifiedR2Partitions({ archiveDir, outputDir });
    console.log(JSON.stringify({ rowCount: result.sourceRows, chunks: result.files.length,
      totalSqlBytes: result.files.reduce((sum, file) => sum + file.bytes, 0),
      sourceManifestSha256: result.sourceManifestSha256 }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "D1 import generation failed");
    process.exitCode = 1;
  }
}
