// Owner-approved cache archive and exact-match prune; no production restore mode.
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
export function assertSourceProject(base) {
  const source = new URL(base);
  if (source.href !== `https://${PROJECT}.supabase.co/`) throw new Error("Wrong or insecure source project URL");
  return source.origin;
}
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
export function pruneSql(rows, cutoff, apply = false) {
  if (!rows.length || rows.length > 100 || !/^\d{4}-\d\d-\d\d$/.test(cutoff)) throw new Error("Invalid prune batch");
  const seen = new Set();
  for (const row of rows) {
    rowDigest(row);
    const pk = JSON.stringify([row.cache_key, row.cache_date]);
    if (seen.has(pk) || row.cache_date >= cutoff) throw new Error("Unsafe prune batch");
    seen.add(pk);
  }
  // Match the complete payload cryptographically without uploading bulky raw
  // cached responses back through the Management API. All three other columns
  // still match exactly; these hashes come only from the verified local archive.
  if (rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 2) > 8 * 1024 * 1024) throw new Error("Prune source batch too large");
  const json = JSON.stringify(rows.map(row => ({ cache_key: row.cache_key, cache_date: row.cache_date,
    fetched_at: row.fetched_at, payload_sha256: createHash("sha256").update(row.payload_text).digest("hex") })));
  if (Buffer.byteLength(json) > 512 * 1024) throw new Error("Prune batch too large");
  let tag;
  do { tag = `$archive_${randomBytes(12).toString("hex")}$`; } while (json.includes(tag));
  const ctes = `WITH archived AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset(${tag}${json}${tag}::jsonb)
      AS b(cache_key text,cache_date date,payload_sha256 text,fetched_at timestamptz)
  ), retained AS MATERIALIZED (
    SELECT k.cache_key,n.cache_date FROM (SELECT DISTINCT cache_key FROM archived) k
    CROSS JOIN LATERAL (SELECT c.cache_date FROM public.av_cache c
      WHERE c.cache_key=k.cache_key ORDER BY c.cache_date DESC LIMIT 1 ${apply ? "FOR KEY SHARE" : ""}) n
  )`;
  const predicate = `c.cache_key=b.cache_key AND c.cache_date=b.cache_date
    AND encode(sha256(convert_to(c.payload::text,'UTF8')),'hex')=b.payload_sha256 AND c.fetched_at=b.fetched_at
    AND c.cache_date < DATE '${cutoff}' AND r.cache_key=c.cache_key AND c.cache_date<r.cache_date`;
  return `BEGIN; SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='500ms';
    ${ctes}, affected AS (
      ${apply ? "DELETE FROM public.av_cache c USING archived b,retained r" : "SELECT c.cache_key,c.cache_date FROM public.av_cache c,archived b,retained r"}
      WHERE ${predicate} ${apply ? "RETURNING c.cache_key,c.cache_date" : ""}
    ) SELECT jsonb_build_object('input',${rows.length},'matched',count(*),'applied',${apply},
      'ids',coalesce(jsonb_agg(jsonb_build_array(cache_key,cache_date)),'[]'::jsonb)) AS receipt FROM affected;
    COMMIT;`;
}
let managementNextRequestAt = 0;
async function managementSql(query) {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error("Existing authenticated SQL credential unavailable");
  while (Date.now() < managementNextRequestAt) await new Promise(resolve => setTimeout(resolve, Math.min(10000, managementNextRequestAt - Date.now())));
  managementNextRequestAt = Date.now() + 1000; // At most 60/min, below documented 120/min.
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }), signal: AbortSignal.timeout(25000),
  });
  const remaining = Number(response.headers.get("x-ratelimit-remaining") ?? NaN);
  const reset = Number(response.headers.get("x-ratelimit-reset") ?? NaN);
  if (Number.isFinite(remaining) && remaining <= 10 && Number.isFinite(reset) && reset >= 0 && reset <= 3600) {
    managementNextRequestAt = Math.max(managementNextRequestAt, Date.now() + (reset + 1) * 1000);
  }
  if (!response.ok) {
    const error = new Error(`SQL request failed (${response.status}); do not retry automatically`);
    error.httpStatus = response.status;
    throw error;
  }
  const result = await response.json();
  if (!Array.isArray(result)) throw new Error("Unexpected SQL result; do not retry automatically");
  return result;
}
function durableEvent(file, event) {
  const fd = fs.openSync(file, "a");
  try { fs.writeSync(fd, JSON.stringify(event) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function assertSettledEvents(events) {
  const pending = new Set();
  for (const event of events) {
    if (event.type === "uncertain") throw new Error("Earlier uncertain SQL outcome must be reconciled before continuing");
    if (event.type === "intent") pending.add(event.batchHash);
    if (event.type === "result" || event.type === "rejected") pending.delete(event.batchHash);
  }
  if (pending.size) throw new Error("Earlier unfinished SQL intent must be reconciled before continuing");
}
async function prune(dir, apply) {
  const manifest = await verify(dir);
  const restored = JSON.parse(fs.readFileSync(path.join(dir, "restore-verification.json"), "utf8"));
  if (manifest.syntheticOnly || restored.rowCount !== manifest.rowCount || restored.datasetSha256 !== manifest.datasetSha256
    || restored.postgresMajor !== 17) throw new Error("A matching real PostgreSQL restore receipt is required");
  const planFile = path.join(dir, "prune-plan.json");
  if (apply) {
    const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
    if (plan.datasetSha256 !== manifest.datasetSha256 || plan.inspectedRows !== manifest.rowCount) throw new Error("Complete matching prune plan required");
    for (const name of ["cache.ndjson.gz", "manifest.json", "restore-verification.json", "prune-plan.json"]) {
      const fd = fs.openSync(path.join(dir, name), "r+");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  } else if (fs.existsSync(planFile)) throw new Error("Plan already exists; do not overwrite evidence");
  const [guard] = await managementSql(`SELECT
    (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.av_cache'::regclass AND NOT tgisinternal) AS triggers,
    (SELECT count(*) FROM pg_constraint WHERE contype='f' AND (confrelid='public.av_cache'::regclass OR conrelid='public.av_cache'::regclass)) AS fks,
    (SELECT count(*) FROM pg_rewrite WHERE ev_class='public.av_cache'::regclass AND rulename<>'_RETURN') AS rules;`);
  if (!guard || Number(guard.triggers) || Number(guard.fks) || Number(guard.rules)) throw new Error("Unexpected cache side effects; pruning refused");
  const events = path.join(dir, apply ? "prune-events.ndjson" : "plan-events.ndjson");
  if (apply && fs.existsSync(events)) {
    assertSettledEvents(fs.readFileSync(events, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)));
  }
  const planned = new Map();
  if (!apply && fs.existsSync(events)) {
    for (const line of fs.readFileSync(events, "utf8").split("\n").filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.type === "result") planned.set(event.batchHash, event);
    }
  }
  const inventorySql = "SELECT cache_key,max(cache_date)::text AS cache_date FROM public.av_cache GROUP BY cache_key ORDER BY cache_key;";
  const inventoryFile = path.join(dir, "retained-key-inventory-before.json");
  let before;
  if (apply) {
    before = fs.existsSync(inventoryFile) ? JSON.parse(fs.readFileSync(inventoryFile, "utf8")) : await managementSql(inventorySql);
    if (!fs.existsSync(inventoryFile)) writeJson(inventoryFile, before);
  }
  let batch = [], bytes = 2, inspected = 0, checked = 0, matched = 0, oversized = 0, batches = 0;
  const flush = async () => {
    if (!batch.length) return;
    const batchHash = datasetDigest(batch.map(rowDigest));
    durableEvent(events, { type: "intent", at: new Date().toISOString(), apply, batchHash, rows: batch.length });
    let receipt;
    try {
      receipt = !apply && planned.has(batchHash) ? planned.get(batchHash) : (await managementSql(pruneSql(batch, manifest.cutoff, apply)))[0]?.receipt;
      if (!receipt || receipt.input !== batch.length || receipt.applied !== apply
        || !Number.isSafeInteger(receipt.matched) || receipt.matched < 0 || receipt.matched > batch.length
        || receipt.ids?.length !== receipt.matched) throw new Error("Unexpected prune receipt");
      const allowed = new Set(batch.map(row => JSON.stringify([row.cache_key, row.cache_date])));
      for (const id of receipt.ids) if (!allowed.has(JSON.stringify(id))) throw new Error("Out-of-batch SQL result");
    } catch (error) {
      if ([401, 403, 429].includes(error.httpStatus)) {
        durableEvent(events, { type: "rejected", at: new Date().toISOString(), apply, batchHash, status: error.httpStatus });
        throw error; // Authentication/rate-limit refusal did not execute SQL.
      }
      durableEvent(events, { type: "uncertain", at: new Date().toISOString(), apply, batchHash });
      throw new Error("SQL outcome uncertain or failed; stopped. Reconcile this batch before any retry");
    }
    durableEvent(events, { type: "result", at: new Date().toISOString(), apply, batchHash, ...receipt });
    matched += receipt.matched; checked += batch.length; batches++;
    if (batches % 40 === 0) console.log(JSON.stringify({ applying: apply, batches, inspected: checked + oversized, matched, oversized }));
    batch = []; bytes = 2;
    await new Promise(resolve => setTimeout(resolve, 100));
  };
  for await (const row of archiveRows(dir)) {
    inspected++;
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (size + 2 > 8 * 1024 * 1024) { oversized++; continue; }
    if (batch.length >= 100 || bytes + size > 8 * 1024 * 1024) await flush();
    batch.push(row); bytes += size;
  }
  await flush();
  if (apply) {
    const after = await managementSql(inventorySql);
    const latest = new Map(after.map(row => [row.cache_key, row.cache_date]));
    const lost = before.filter(row => !latest.has(row.cache_key) || latest.get(row.cache_key) < row.cache_date);
    writeJson(path.join(dir, `retained-key-verification-${Date.now()}.json`), { at: new Date().toISOString(), beforeKeys: before.length,
      afterKeys: after.length, missingOrRegressedKeys: lost.length, verified: !lost.length });
    if (lost.length) throw new Error("Retained-key inventory regressed; do not claim verified pruning");
  }
  const summary = { at: new Date().toISOString(), comparison: "exact-key-date-time-and-full-payload-sha256-v2", datasetSha256: manifest.datasetSha256, inspectedRows: inspected, matched, oversized, batches, applied: apply };
  writeJson(path.join(dir, apply ? `prune-result-${Date.now()}.json` : "prune-plan.json"), summary);
  console.log(JSON.stringify(summary));
}
function writeJson(file, data) {
  const fd = fs.openSync(file, "wx");
  try { fs.writeFileSync(fd, JSON.stringify(data, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
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
  const base = assertSourceProject(process.env.NEXT_PUBLIC_SUPABASE_URL);
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
export async function drill(dir, verifyLocal) {
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
    if (verifyLocal) await verifyLocal(query => child("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"], env, query).complete);
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
    else if (mode === "prune-plan") await prune(target, false);
    else if (mode === "prune") {
      const lock = path.join(target, "prune.lock");
      const fd = fs.openSync(lock, "wx");
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); fs.fsyncSync(fd);
        await prune(target, true);
      } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
    }
    else throw new Error("Allowed modes: archive, verify, drill, prune-plan, prune");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
