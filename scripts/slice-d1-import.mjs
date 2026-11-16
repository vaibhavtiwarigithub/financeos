import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export function sliceImportStatements(sql, rowCount, skipRows = 0) {
  if (typeof sql !== "string" || !Number.isSafeInteger(rowCount) || rowCount < 1
    || !Number.isSafeInteger(skipRows) || skipRows < 0) throw new Error("Invalid D1 import slice request");
  const statements = sql.split(/(?<=;)\r?\n/).map(statement => statement.replace(/^\r?\n+/, "")).filter(Boolean);
  if (statements.some(statement => !statement.endsWith(";"))) {
    throw new Error("D1 import contains an incomplete SQL statement");
  }
  const perStatement = statements.map(statement => {
    const m = /^INSERT OR IGNORE[\s\S]*?VALUES\r?\n([\s\S]*);$/.exec(statement);
    if (!m) throw new Error("Unexpected D1 import SQL statement");
    return (m[1].match(/^\(/gm) ?? []).length;
  });
  const selected = [];
  let skipped = 0;
  let rows = 0;
  for (let i = 0; i < statements.length && rows < rowCount; i++) {
    const count = perStatement[i];
    if (skipped < skipRows) {
      if (skipped + count > skipRows) throw new Error("Skip row count must end at a statement boundary");
      skipped += count;
      continue;
    }
    if (rows + count > rowCount) throw new Error("Slice row count must end at a statement boundary");
    selected.push(statements[i]);
    rows += count;
  }
  if (skipped !== skipRows) throw new Error(`Requested skip of ${skipRows} rows but only ${skipped} were available`);
  if (rows !== rowCount) throw new Error(`Requested ${rowCount} rows but only ${rows} were available`);
  return { sql: selected.join("\n"), rowCount: rows, statementCount: selected.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [inputFile, outputFile, rowText, skipText = "0"] = process.argv.slice(2);
  try {
    const root = path.resolve(process.env.LOCALAPPDATA ?? "", "Kairos", "backups", "database", "d1-imports");
    const input = path.resolve(inputFile ?? "");
    const output = path.resolve(outputFile ?? "");
    if (!input.startsWith(root + path.sep) || !output.startsWith(root + path.sep)) throw new Error("Use only owner-local D1 import files");
    const result = sliceImportStatements(fs.readFileSync(input, "utf8"), Number(rowText), Number(skipText));
    fs.writeFileSync(output, result.sql, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ rowCount: result.rowCount, skippedRows: Number(skipText), statements: result.statementCount,
      bytes: Buffer.byteLength(result.sql), sha256: createHash("sha256").update(result.sql).digest("hex") }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "D1 import slicing failed");
    process.exitCode = 1;
  }
}
