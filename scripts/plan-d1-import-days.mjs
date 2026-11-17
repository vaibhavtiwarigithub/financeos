import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

// Reserve at least 40% of the Free daily write allowance for application
// traffic and DDL/index/accounting overhead across every D1 database.
export const DEFAULT_ROWS_PER_DAY = 20_000;
export const DEFAULT_INDEX_COUNT = 2;

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

export function splitInsertStatements(sql) {
  if (typeof sql !== "string" || sql.length === 0) throw new Error("D1 import SQL is empty");
  const statements = sql.split(/(?<=;)\r?\n/).map(statement => statement.replace(/^\r?\n+/, "")).filter(Boolean);
  if (statements.some(statement => !statement.endsWith(";"))) throw new Error("D1 import contains an incomplete SQL statement");
  return statements.map(statement => {
    if (!/^INSERT OR IGNORE INTO symbol_daily_returns \([a-z_,]+\) VALUES\r?\n/.test(statement)) {
      throw new Error("D1 import contains an unexpected statement");
    }
    const rowCount = (statement.match(/^\(/gm) ?? []).length;
    if (rowCount < 1 || rowCount > 50 || Buffer.byteLength(statement) >= 100_000) {
      throw new Error("D1 import statement is outside its row or byte bounds");
    }
    return { statement, rowCount };
  });
}

export function buildDailyChunks(inputFiles, { rowsPerDay = DEFAULT_ROWS_PER_DAY, indexCount = DEFAULT_INDEX_COUNT } = {}) {
  if (!Array.isArray(inputFiles) || inputFiles.length === 0 || !Number.isSafeInteger(rowsPerDay)
    || rowsPerDay < 50 || rowsPerDay > 49_000 || rowsPerDay % 50 !== 0
    || !Number.isSafeInteger(indexCount) || indexCount < 0 || indexCount > 4) {
    throw new Error("Invalid D1 daily import budget");
  }
  const statements = [];
  for (const input of inputFiles) statements.push(...splitInsertStatements(input.sql));
  const chunks = [];
  let current = [];
  let currentRows = 0;
  for (const item of statements) {
    if (currentRows && currentRows + item.rowCount > rowsPerDay) {
      chunks.push({ statements: current.map(value => value.statement), rowCount: currentRows });
      current = [];
      currentRows = 0;
    }
    if (currentRows + item.rowCount > rowsPerDay) throw new Error("A D1 statement cannot fit in the daily row budget");
    current.push(item);
    currentRows += item.rowCount;
  }
  if (current.length) chunks.push({ statements: current.map(value => value.statement), rowCount: currentRows });
  return chunks.map((chunk, index) => ({ ...chunk, day: index + 1,
    estimatedRowsWritten: chunk.rowCount * (1 + indexCount),
    estimatedWriteHeadroom: 100_000 - chunk.rowCount * (1 + indexCount) }));
}

function isWithin(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export function writeDailyPlan({ inputPaths, outputDir, rowsPerDay, indexCount }) {
  const localAppData = process.env.LOCALAPPDATA;
  if (process.platform !== "win32" || !localAppData) throw new Error("Use the owner-local Windows D1 backup directory");
  const root = path.resolve(localAppData, "Kairos", "backups", "database", "d1-imports");
  const output = path.resolve(outputDir ?? "");
  if (!isWithin(root, output)) throw new Error("D1 daily plan must stay in the owner-local backup directory");
  const sources = inputPaths.map(value => path.resolve(value));
  if (sources.some(value => !isWithin(root, value))) throw new Error("D1 plan inputs must stay in the owner-local backup directory");
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(output).length) throw new Error("D1 plan output directory must be empty");
  const inputs = sources.map(sourcePath => {
    const sql = fs.readFileSync(sourcePath, "utf8");
    return { filename: path.basename(sourcePath), sql, bytes: Buffer.byteLength(sql), sha256: sha256(sql) };
  });
  const chunks = buildDailyChunks(inputs, { rowsPerDay, indexCount });
  const files = chunks.map(({ statements, ...chunk }) => {
    const filename = `day-${String(chunk.day).padStart(2, "0")}.sql`;
    const sql = `${statements.join("\n")}\n`;
    fs.writeFileSync(path.join(output, filename), sql, { flag: "wx", mode: 0o600 });
    return { ...chunk, filename, statementCount: statements.length, bytes: Buffer.byteLength(sql), sha256: sha256(sql) };
  });
  const manifest = { format: "kairos-d1-daily-import-plan-v1", generatedAt: new Date().toISOString(),
    rowsPerUtcDay: rowsPerDay, indexedColumns: indexCount, maximumRowsWrittenPerDay: 100_000,
    totalRows: files.reduce((sum, file) => sum + file.rowCount, 0), inputs: inputs.map(({ filename, bytes, sha256: hash }) => ({ filename, bytes, sha256: hash })), files };
  fs.writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [outputDir, ...inputPaths] = process.argv.slice(2);
  try {
    if (!outputDir || inputPaths.length === 0) throw new Error("Usage: plan-d1-import-days.mjs <output-dir> <source-sql...>");
    const result = writeDailyPlan({ inputPaths, outputDir, rowsPerDay: DEFAULT_ROWS_PER_DAY, indexCount: DEFAULT_INDEX_COUNT });
    console.log(JSON.stringify({ totalRows: result.totalRows, days: result.files.map(({ day, filename, rowCount, estimatedRowsWritten, estimatedWriteHeadroom, sha256 }) =>
      ({ day, filename, rowCount, estimatedRowsWritten, estimatedWriteHeadroom, sha256 })) }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "D1 daily import planning failed");
    process.exitCode = 1;
  }
}
