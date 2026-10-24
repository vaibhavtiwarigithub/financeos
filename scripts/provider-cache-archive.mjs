// Local-only archive tooling. No production delete or restore is implemented.
// Native PostgreSQL tools verify a real local jsonb/timestamptz round trip.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createGzip, createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const PROJECT = "dionkikgdmlaotvtbnfr";
const BIN = "C:/Program Files/PostgreSQL/17/bin";
function assertPrivateDirectory(dir) {
  const check = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    '$a=Get-Acl -LiteralPath $env:KAIROS_ARCHIVE_DIRECTORY; $s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if(-not $a.AreAccessRulesProtected){exit 1}; foreach($r in $a.Access){if($r.IsInherited -or $r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $s){exit 1}}; if($a.Access.Count -lt 1){exit 1}; exit 0'],
  { env: { ...process.env, PSModulePath: path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/Modules"), KAIROS_ARCHIVE_DIRECTORY: dir }, windowsHide: true, stdio: "ignore", timeout: 10000 });
  if (check.status !== 0) throw new Error(`Archive directory must have an explicit current-account-only ACL (check status ${check.status}, ${check.error?.code ?? "no process error"})`);
}
export function canonicalTimestamp(value) {
  const match = /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(?:Z|\+00(?::00)?)$/.exec(value);
  if (!match) throw new Error("Unexpected timestamp representation");
  return `${match[1]}T${match[2]}.${(match[3] ?? "").padEnd(6, "0")}Z`;
}
export function rowDigest(row) {
  if (typeof row.payload_text !== "string" || typeof row.cache_key !== "string"
    || !/^\d{4}-\d\d-\d\d$/.test(row.cache_date)) throw new Error("Invalid archive row");
  return createHash("sha256").update(JSON.stringify([
    row.cache_key, row.cache_date, row.payload_text, canonicalTimestamp(row.fetched_at),
  ])).digest("hex");
}
export function datasetDigest(hashes) {
  return createHash("sha256").update([...hashes].sort().join("\n")).digest("hex");
}
export function csvRow(row) {
  return [row.cache_key, row.cache_date, row.payload_text, row.fetched_at]
    .map(value => `"${value.replaceAll('"', '""')}"`).join(",") + "\n";
}
export function isArchivable(row, latestDate, cutoff) {
  return row.cache_date < cutoff && typeof latestDate === "string" && latestDate > row.cache_date;
}
async function fileHash(file) {
  const h = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}
async function* archiveRows(dir) {
  const lines = createInterface({ input: fs.createReadStream(path.join(dir, "cache.ndjson.gz")).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) if (line) yield JSON.parse(line);
}
function writeJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { flag: "wx" }); }
async function pages(base, key, select, cutoff) {
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  let cursor = null;
  // Metadata is small; payload pages are consumed by the callback below.
  return { async each(consume) {
    for (;;) {
      const u = new URL("/rest/v1/av_cache", base);
      u.searchParams.set("select", select);
      u.searchParams.set("order", "cache_key.asc,cache_date.asc");
      u.searchParams.set("limit", select.includes("payload") ? "25" : "1000");
      if (cutoff) u.searchParams.set("cache_date", `lt.${cutoff}`);
      if (cursor) {
        const quoted = `"${cursor.cache_key.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
        u.searchParams.set("or", `(cache_key.gt.${quoted},and(cache_key.eq.${quoted},cache_date.gt.${cursor.cache_date}))`);
      }
      const response = await fetch(u, { headers, signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error(`Archive read failed (${response.status})`);
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new Error("Invalid archive response");
      if (!rows.length) break;
      for (const row of rows) await consume(row);
      const last = rows.at(-1);
      if (cursor && cursor.cache_key === last.cache_key && cursor.cache_date === last.cache_date) throw new Error("Archive cursor did not advance");
      cursor = last;
    }
  } };
}
export async function verify(dir) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  if (m.version !== 1 || m.project !== PROJECT || m.table !== "public.av_cache"
    || !Number.isSafeInteger(m.rowCount) || m.rowCount < 0
    || !/^\d{4}-\d\d-\d\d$/.test(m.cutoff)) throw new Error("Wrong archive identity/contract");
  if (await fileHash(path.join(dir, "cache.ndjson.gz")) !== m.compressedSha256) throw new Error("Compressed checksum mismatch");
  const hashes = [], seen = new Set();
  for await (const row of archiveRows(dir)) {
    const pk = JSON.stringify([row.cache_key, row.cache_date]);
    if (seen.has(pk) || !(row.cache_date < m.cutoff)) throw new Error("Duplicate or out-of-scope archive row");
    seen.add(pk); hashes.push(rowDigest(row));
  }
  if (hashes.length !== m.rowCount || datasetDigest(hashes) !== m.datasetSha256) throw new Error("Dataset checksum/count mismatch");
  return m;
}
async function archive(dir) {
  const { default: env } = await import("@next/env");
  env.loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (new URL(base).hostname !== `${PROJECT}.supabase.co`) throw new Error("Wrong source project");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Read credential unavailable");
  const startedAt = new Date().toISOString();
  const cutoff = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
  const latest = new Map();
  await (await pages(base, key, "cache_key,cache_date")).each(row => {
    if (!latest.has(row.cache_key) || latest.get(row.cache_key) < row.cache_date) latest.set(row.cache_key, row.cache_date);
  });
  const gzip = createGzip({ level: 6 });
  const file = path.join(dir, "cache.ndjson.gz");
  const output = fs.createWriteStream(file, { flags: "wx" });
  const done = finished(output);
  done.catch(() => {});
  gzip.on("error", error => output.destroy(error));
  output.on("error", error => gzip.destroy(error));
  gzip.pipe(output);
  const hashes = [];
  try {
    await (await pages(base, key, "cache_key,cache_date,payload::text,fetched_at", cutoff)).each(async raw => {
      if (!isArchivable(raw, latest.get(raw.cache_key), cutoff)) return;
      const row = { cache_key: raw.cache_key, cache_date: raw.cache_date, payload_text: raw.payload, fetched_at: raw.fetched_at };
      hashes.push(rowDigest(row));
      if (!gzip.write(JSON.stringify(row) + "\n")) await once(gzip, "drain");
      if (hashes.length % 2000 === 0) console.log(JSON.stringify({ archivedRows: hashes.length }));
    });
    gzip.end(); await done;
  } catch (error) {
    gzip.end();
    await done.catch(() => {});
    writeJson(path.join(dir, "incomplete-export.json"), {
      state: "incomplete-not-a-verified-backup", failedAt: new Date().toISOString(),
      exportedRows: hashes.length, productionRowsDeleted: 0,
      nextAction: "Do not prune; a complete new export and successful restore drill are required",
    });
    throw error;
  }
  const manifest = {
    version: 1, project: PROJECT, table: "public.av_cache", startedAt, finishedAt: new Date().toISOString(), cutoff,
    predicate: "cache_date < cutoff AND a newer cache_date exists for the same key; latest-date metadata frozen before export",
    rowCount: hashes.length, datasetSha256: datasetDigest(hashes), compressedSha256: await fileHash(file),
    compressedBytes: fs.statSync(file).size, payloadEncoding: "PostgreSQL jsonb text (no JavaScript numeric parsing)",
    snapshot: "bounded REST export; not a transactional database snapshot; later pruning must recheck exact unchanged rows",
    productionRowsDeleted: 0,
  };
  writeJson(path.join(dir, "manifest.json"), manifest);
  await verify(dir);
  console.log(JSON.stringify({ archiveVerified: true, rows: manifest.rowCount, compressedBytes: manifest.compressedBytes, directory: dir }));
}
function child(program, args, env = {}, input, streaming = false, collectOutput = true) {
  // A detached PostgreSQL server must not inherit pipe handles that keep pg_ctl's
  // Node close event open after pg_ctl exits on Windows.
  const p = spawn(path.join(BIN, `${program}.exe`), args, { env: { ...process.env, ...env }, windowsHide: true, stdio: program === "pg_ctl" ? "ignore" : ["pipe", "pipe", "pipe"] });
  let stdout = "";
  if (collectOutput) p.stdout?.on("data", data => { stdout += data; });
  p.stdin?.on("error", () => {}); // Completion reports a failed child without exposing input.
  p.stderr?.resume(); // Never print raw connection diagnostics or payloads.
  const complete = new Promise((resolve, reject) => {
    p.on("error", () => reject(new Error(`${program} could not start`)));
    p.on("close", code => code === 0 ? resolve(stdout) : reject(new Error(`${program} failed (exit ${code}); data preserved`)));
  });
  complete.catch(() => {}); // Streaming producers await this after input has drained.
  if (!streaming) p.stdin?.end(input);
  return { p, complete };
}
async function drill(dir) {
  const manifest = await verify(dir);
  const dataDir = path.join(dir, "restore-drill");
  if (fs.existsSync(dataDir)) throw new Error("Restore drill directory already exists; do not overwrite");
  const pwFile = path.join(dir, "drill-password.tmp");
  const password = randomBytes(32).toString("hex");
  fs.writeFileSync(pwFile, password + "\n", { flag: "wx" });
  const env = { PGHOST: "127.0.0.1", PGPORT: "55439", PGDATABASE: "postgres", PGUSER: "archive_verifier", PGPASSWORD: password, PGCONNECT_TIMEOUT: "5", PGCLIENTENCODING: "UTF8" };
  let started = false, attemptedStart = false;
  try {
    await child("initdb", ["-D", dataDir, "-U", env.PGUSER, "--encoding=UTF8", "--locale=C", "--auth=scram-sha-256", `--pwfile=${pwFile}`]).complete;
    attemptedStart = true;
    await child("pg_ctl", ["-D", dataDir, "-l", path.join(dir, "restore-drill-server.log"), "-o", "-h 127.0.0.1 -p 55439", "-w", "start"]).complete;
    started = true;
    const ddl = "CREATE TABLE av_cache(cache_key text NOT NULL,cache_date date NOT NULL,payload jsonb NOT NULL,fetched_at timestamptz NOT NULL,PRIMARY KEY(cache_key,cache_date));\n";
    await child("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"], env, ddl).complete;
    const copy = child("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"], env, undefined, true);
    // Stream COPY input; keep payload numbers as PostgreSQL text throughout.
    copy.p.stdin.write("COPY av_cache(cache_key,cache_date,payload,fetched_at) FROM STDIN WITH (FORMAT csv);\n");
    for await (const row of archiveRows(dir)) if (!copy.p.stdin.write(csvRow(row))) await once(copy.p.stdin, "drain");
    copy.p.stdin.end("\\.\n"); await copy.complete;
    const query = "SELECT json_build_array(cache_key,cache_date::text,payload::text,to_char(fetched_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')) FROM av_cache;";
    const restored = child("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"], env, query, false, false);
    const hashes = [];
    const lines = createInterface({ input: restored.p.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      const [cache_key, cache_date, payload_text, fetched_at] = JSON.parse(line);
      hashes.push(rowDigest({ cache_key, cache_date, payload_text, fetched_at }));
    }
    await restored.complete;
    if (hashes.length !== manifest.rowCount || datasetDigest(hashes) !== manifest.datasetSha256) throw new Error("PostgreSQL round-trip mismatch");
    writeJson(path.join(dir, "restore-verification.json"), { verifiedAt: new Date().toISOString(), postgresMajor: 17, rowCount: hashes.length, datasetSha256: datasetDigest(hashes), productionRowsDeleted: 0 });
    console.log(JSON.stringify({ postgresRestoreVerified: true, rows: hashes.length, directory: dir }));
  } finally {
    try {
      if (started || (attemptedStart && fs.existsSync(path.join(dataDir, "postmaster.pid")))) {
        await child("pg_ctl", ["-D", dataDir, "-m", "fast", "-w", "stop"]).complete;
      }
    } finally { fs.unlinkSync(pwFile); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode, dir] = process.argv.slice(2);
  const root = path.resolve(process.env.LOCALAPPDATA ?? "", "Kairos/backups/provider-cache");
  const target = path.resolve(dir ?? ".");
  if (process.platform !== "win32" || !target.startsWith(root + path.sep) || !fs.existsSync(target)
    || !fs.realpathSync(target).startsWith(fs.realpathSync(root) + path.sep)) {
    console.error("Use an existing owner-protected provider-cache archive directory outside the repo"); process.exitCode = 1;
  } else try {
    assertPrivateDirectory(target);
    if (mode === "archive") await archive(target);
    else if (mode === "verify") console.log(JSON.stringify({ verified: true, rows: (await verify(target)).rowCount }));
    else if (mode === "drill") await drill(target);
    else throw new Error("Allowed modes: archive, verify, drill (none delete production data)");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
