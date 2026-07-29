/**
 * Governed historical-evidence acquisition.
 *
 * No application or money-path module imports this file. It is an explicit local
 * operator tool whose output feeds only the sealed historical replay harness.
 *
 * Examples:
 *   node scripts/evidence-data.mjs fetch-fred
 *   node scripts/evidence-data.mjs fetch-sec --from 2024q1 --to 2026q1
 *   node scripts/evidence-data.mjs fetch-nse --from 2024-01-01 --to 2024-12-31
 *   node scripts/evidence-data.mjs fetch-nse-actions --from 2024-01-01 --to 2024-12-31
 *   node scripts/evidence-data.mjs fetch-sp500
 *   node scripts/evidence-data.mjs catalog
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_CODE_SHA256 = sha256(fs.readFileSync(fileURLToPath(import.meta.url)));
const DEFAULT_STORE = path.join(os.homedir(), ".kairos", "evidence");
const STORE = path.resolve(process.env.KAIROS_EVIDENCE_DIR || DEFAULT_STORE);
const SCHEMA_VERSION = "kairos.evidence-dataset.v1";
const USER_AGENT = "Kairos FinanceOS historical research vterminater@gmail.com";
const ALLOWED_HOSTS = new Set([
  "api.stlouisfed.org",
  "fred.stlouisfed.org",
  "www.sec.gov",
  "data.sec.gov",
  "archives.nseindia.com",
  "nsearchives.nseindia.com",
  "www.nseindia.com",
  "api.github.com",
  "raw.githubusercontent.com",
]);

export const FRED_SERIES = [
  "DGS2", "DGS10", "UNRATE", "PAYEMS", "GDPC1", "CPIAUCSL",
  "RSAFS", "FEDFUNDS", "DGORDER", "DFEDTARL", "DFEDTARU",
];

function isoNow() {
  return new Date().toISOString();
}

export function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function assertAllowedUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error(`Only HTTPS sources are allowed: ${rawUrl}`);
  if (!ALLOWED_HOSTS.has(url.hostname)) throw new Error(`Source host is not allowlisted: ${url.hostname}`);
  if (url.username || url.password) throw new Error("Credentials must not appear in source URLs");
  return url;
}

export function safeArchiveEntries(entries) {
  for (const raw of entries) {
    const entry = String(raw).replaceAll("\\", "/");
    if (!entry || entry.startsWith("/") || /^[A-Za-z]:\//.test(entry)) return false;
    const parts = entry.split("/");
    if (parts.some((part) => part === ".." || part === "")) return false;
  }
  return true;
}

function ensureWithinStore(target) {
  const resolved = path.resolve(target);
  const prefix = STORE.endsWith(path.sep) ? STORE : `${STORE}${path.sep}`;
  if (resolved !== STORE && !resolved.startsWith(prefix)) {
    throw new Error(`Refusing path outside evidence store: ${resolved}`);
  }
  return resolved;
}

async function ensureDir(dir) {
  await fsp.mkdir(ensureWithinStore(dir), { recursive: true });
}

async function hashFile(file) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function parseEnvFile(name) {
  const envPath = path.join(ROOT, ".env.local");
  if (!fs.existsSync(envPath)) return undefined;
  const body = fs.readFileSync(envPath, "utf8");
  return body.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim().replace(/^"|"$/g, "");
}

async function fetchWithRetry(url, options = {}) {
  assertAllowedUrl(url);
  const displayUrl = new URL(url);
  for (const key of ["api_key", "apikey", "apiKey", "token", "api_token"]) {
    if (displayUrl.searchParams.has(key)) displayUrl.searchParams.set(key, "REDACTED");
  }
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, ...(options.headers || {}) },
        signal: AbortSignal.timeout(options.timeoutMs || 120_000),
      });
      if (response.ok) return response;
      if (response.status === 404 && options.allowMissing) return null;
      if (response.status !== 429 && response.status < 500) {
        const detail = (await response.text()).replaceAll(/\s+/g, " ").slice(0, 500);
        const error = new Error(`${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`);
        error.permanent = true;
        throw error;
      }
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      if (error?.permanent) throw new Error(
        `Download failed for ${displayUrl}: ${error instanceof Error ? error.message : error}`,
      );
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500 * (attempt + 1)));
  }
  throw new Error(`Download failed for ${displayUrl}: ${lastError instanceof Error ? lastError.message : lastError}`);
}

async function atomicDownload(url, destination, options = {}) {
  const target = ensureWithinStore(destination);
  await ensureDir(path.dirname(target));
  if (fs.existsSync(target)) {
    const stat = await fsp.stat(target);
    return { relativePath: path.relative(STORE, target).replaceAll("\\", "/"), sourceUrl: url,
      sha256: await hashFile(target), bytes: stat.size, mediaType: options.mediaType || "application/octet-stream" };
  }
  const response = await fetchWithRetry(url, options);
  if (response === null) return null;
  const partial = `${target}.partial`;
  await fsp.rm(partial, { force: true });
  const handle = await fsp.open(partial, "wx");
  try {
    if (!response.body) throw new Error("Response body is empty");
    for await (const chunk of response.body) await handle.write(chunk);
  } finally {
    await handle.close();
  }
  const stat = await fsp.stat(partial);
  if (stat.size === 0) {
    await fsp.rm(partial, { force: true });
    throw new Error(`Downloaded empty file from ${url}`);
  }
  await fsp.rename(partial, target);
  return {
    relativePath: path.relative(STORE, target).replaceAll("\\", "/"),
    sourceUrl: url,
    sha256: await hashFile(target),
    bytes: stat.size,
    mediaType: options.mediaType || response.headers.get("content-type") || "application/octet-stream",
  };
}

export function buildManifest(input) {
  const base = {
    schemaVersion: SCHEMA_VERSION,
    datasetId: input.datasetId,
    sourceId: input.sourceId,
    sourceAuthority: input.sourceAuthority,
    evidenceClass: input.evidenceClass,
    market: input.market,
    dataKinds: input.dataKinds,
    sourceVersion: input.sourceVersion,
    retrievedAt: input.retrievedAt || isoNow(),
    files: [...input.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    coverage: input.coverage,
    normalization: input.normalization || {
      schemaVersion: input.normalizationSchema || "raw.v1",
      codeGitSha: input.codeGitSha || "unbound",
      status: "pending",
    },
    limitations: input.limitations || [],
  };
  // Retrieval time is audit metadata, not dataset identity. The same bytes,
  // source version, normalization, and limitations must remain idempotent when
  // an operator reruns the command later.
  const fingerprintBase = { ...base };
  delete fingerprintBase.retrievedAt;
  return { ...base, datasetFingerprint: sha256(canonicalJson(fingerprintBase)) };
}

async function writeManifest(manifest) {
  const dir = path.join(STORE, "manifests");
  await ensureDir(dir);
  const target = ensureWithinStore(path.join(dir, `${manifest.datasetId}.json`));
  if (fs.existsSync(target)) {
    const existing = JSON.parse(await fsp.readFile(target, "utf8"));
    if (existing.datasetFingerprint !== manifest.datasetFingerprint) {
      throw new Error(`Manifest ${manifest.datasetId} already exists with a different fingerprint`);
    }
    return existing;
  }
  const partial = `${target}.partial`;
  await fsp.writeFile(partial, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  await fsp.rename(partial, target);
  return manifest;
}

function gitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  } catch {
    return "unbound";
  }
}

function normalizerIdentity(schemaVersion) {
  return {
    schemaVersion,
    codeGitSha: gitSha(),
    codeSha256: RUN_CODE_SHA256,
    status: "valid",
  };
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) args._.push(token);
    else args[token.slice(2)] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return args;
}

function quarterRange(from, to) {
  const match = (value) => String(value).toLowerCase().match(/^(\d{4})q([1-4])$/);
  const a = match(from);
  const b = match(to);
  if (!a || !b) throw new Error("Quarter must be YYYYqN");
  const start = Number(a[1]) * 4 + Number(a[2]) - 1;
  const end = Number(b[1]) * 4 + Number(b[2]) - 1;
  if (start > end) throw new Error("--from must not be after --to");
  return Array.from({ length: end - start + 1 }, (_, offset) => {
    const value = start + offset;
    return `${Math.floor(value / 4)}q${(value % 4) + 1}`;
  });
}

const SEC_METRICS = new Map(Object.entries({
  RevenueFromContractWithCustomerExcludingAssessedTax: "revenue",
  Revenues: "revenue",
  SalesRevenueNet: "revenue",
  SalesRevenueGoodsNet: "revenue",
  NetIncomeLoss: "net_income",
  OperatingIncomeLoss: "operating_income",
  Assets: "assets",
  Liabilities: "liabilities",
  StockholdersEquity: "equity",
  StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest: "equity",
  EarningsPerShareDiluted: "eps_diluted",
  EarningsPerShareBasic: "eps_basic",
  CashAndCashEquivalentsAtCarryingValue: "cash",
  NetCashProvidedByUsedInOperatingActivities: "operating_cash_flow",
  PaymentsToAcquirePropertyPlantAndEquipment: "capital_expenditure",
  LongTermDebtCurrent: "long_term_debt_current",
  LongTermDebtNoncurrent: "long_term_debt_noncurrent",
}));

function compactDate(value) {
  const text = String(value || "");
  return /^\d{8}$/.test(text)
    ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
    : null;
}

function nextDay(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return ymd(date);
}

function tsvRecord(headers, line) {
  const values = line.split("\t");
  return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
}

export function normalizeSecNumericFact(submission, numeric, statement, sourceHash) {
  const metric = SEC_METRICS.get(String(numeric?.tag ?? ""));
  if (!metric || !submission || !statement) return null;
  if (String(numeric.coreg || "").trim() || String(numeric.segments || "").trim()) return null;
  const form = String(submission.form || "").toUpperCase();
  if (!/^(10-K|10-Q|20-F|40-F)(\/A)?$/.test(form)) return null;
  const filedAt = compactDate(submission.filed);
  const periodEnd = compactDate(numeric.ddate);
  const value = Number(numeric.value);
  const qtrs = Number(numeric.qtrs);
  if (!filedAt || !periodEnd || !Number.isFinite(value) || !Number.isInteger(qtrs) || qtrs < 0) return null;
  const unit = String(numeric.uom || "");
  if (!["USD", "USD/shares"].includes(unit)) return null;
  const instantMetric = ["assets", "liabilities", "equity", "cash", "long_term_debt_current", "long_term_debt_noncurrent"].includes(metric);
  if ((instantMetric && qtrs !== 0) || (!instantMetric && qtrs === 0)) return null;
  const accepted = String(submission.accepted || "").trim();
  const acceptedAt = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(accepted)
    ? accepted.replace(" ", "T")
    : null;
  return {
    cik: String(submission.cik || "").padStart(10, "0"),
    accession: String(submission.adsh || ""),
    symbol_at_filing: null,
    company_name: String(submission.name || ""),
    form,
    filed_at: filedAt,
    accepted_at_sec_local: acceptedAt,
    available_on: nextDay(filedAt),
    period_start: null,
    period_end: periodEnd,
    fiscal_year: Number(submission.fy) || null,
    fiscal_period: String(submission.fp || "") || null,
    duration_quarters: qtrs,
    metric,
    taxonomy: String(numeric.version || ""),
    tag: String(numeric.tag || ""),
    unit,
    value,
    statement,
    source_file_sha256: sourceHash,
  };
}

async function listArchive(zipPath) {
  const { stdout } = await execFileAsync("tar", ["-tf", zipPath], { maxBuffer: 10 * 1024 * 1024 });
  const entries = stdout.split(/\r?\n/).filter(Boolean);
  if (!safeArchiveEntries(entries)) throw new Error(`Unsafe archive member in ${zipPath}`);
  return entries;
}

async function normalizeSecArchives(files, quarters) {
  const normalizedDir = path.join(
    STORE,
    "normalized",
    "sec-fsds",
    `${quarters[0]}-${quarters.at(-1)}-v5`,
  );
  await ensureDir(normalizedDir);
  const normalizedPath = path.join(normalizedDir, "primary-statement-facts.jsonl");
  const partial = `${normalizedPath}.partial`;
  await fsp.rm(partial, { force: true });
  const output = fs.createWriteStream(partial, { flags: "wx" });
  let factCount = 0;
  try {
    for (const file of files) {
      const zipPath = path.join(STORE, file.relativePath);
      const tempDir = path.join(STORE, "tmp", `sec-${path.basename(zipPath, ".zip")}-${file.sha256.slice(0, 12)}`);
      await fsp.rm(tempDir, { recursive: true, force: true });
      await ensureDir(tempDir);
      try {
        await execFileAsync("tar", ["-xf", zipPath, "-C", tempDir, "sub.txt", "pre.txt", "num.txt"]);
        const submissions = new Map();
        const subLines = readline.createInterface({
          input: fs.createReadStream(path.join(tempDir, "sub.txt")),
          crlfDelay: Infinity,
        });
        let subHeaders = null;
        for await (const line of subLines) {
          if (!subHeaders) { subHeaders = line.split("\t"); continue; }
          const row = tsvRecord(subHeaders, line);
          if (/^(10-K|10-Q|20-F|40-F)(\/A)?$/i.test(row.form || "")) submissions.set(row.adsh, row);
        }

        const statements = new Map();
        const preLines = readline.createInterface({
          input: fs.createReadStream(path.join(tempDir, "pre.txt")),
          crlfDelay: Infinity,
        });
        let preHeaders = null;
        for await (const line of preLines) {
          if (!preHeaders) { preHeaders = line.split("\t"); continue; }
          const row = tsvRecord(preHeaders, line);
          if (!SEC_METRICS.has(row.tag) || !submissions.has(row.adsh)) continue;
          const key = `${row.adsh}|${row.tag}|${row.version}`;
          if (!statements.has(key)) statements.set(key, row.stmt);
        }

        const seen = new Set();
        const numLines = readline.createInterface({
          input: fs.createReadStream(path.join(tempDir, "num.txt")),
          crlfDelay: Infinity,
        });
        let numHeaders = null;
        for await (const line of numLines) {
          if (!numHeaders) { numHeaders = line.split("\t"); continue; }
          const row = tsvRecord(numHeaders, line);
          const statement = statements.get(`${row.adsh}|${row.tag}|${row.version}`);
          const fact = normalizeSecNumericFact(submissions.get(row.adsh), row, statement, file.sha256);
          if (!fact) continue;
          const key = [
            fact.accession, fact.metric, fact.tag, fact.period_end,
            fact.duration_quarters, fact.unit, fact.value,
          ].join("|");
          if (seen.has(key)) continue;
          seen.add(key);
          if (!output.write(`${JSON.stringify(fact)}\n`)) await once(output, "drain");
          factCount++;
        }
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
      process.stdout.write(`SEC normalized ${path.basename(zipPath)}: ${factCount} cumulative facts\n`);
    }
  } finally {
    output.end();
    await once(output, "close");
  }
  if (!factCount) throw new Error("SEC normalizer produced no primary-statement facts");
  if (fs.existsSync(normalizedPath)) {
    const [existingHash, partialHash] = await Promise.all([
      hashFile(normalizedPath),
      hashFile(partial),
    ]);
    if (existingHash !== partialHash) {
      throw new Error("Normalized SEC facts changed for an existing dataset version");
    }
    await fsp.rm(partial, { force: true });
  } else {
    await fsp.rename(partial, normalizedPath);
  }
  const stat = await fsp.stat(normalizedPath);
  return {
    record: {
      relativePath: path.relative(STORE, normalizedPath).replaceAll("\\", "/"),
      sourceUrl: "derived:sec-primary-statement-facts",
      sha256: await hashFile(normalizedPath),
      bytes: stat.size,
      mediaType: "application/x-ndjson",
    },
    factCount,
  };
}

async function fetchSec(args) {
  const quarters = quarterRange(args.from || "2024q1", args.to || "2026q1");
  const files = [];
  for (const quarter of quarters) {
    const url = `https://www.sec.gov/files/dera/data/financial-statement-data-sets/${quarter}.zip`;
    const target = path.join(STORE, "raw", "sec-fsds", quarter, `${quarter}.zip`);
    const record = await atomicDownload(url, target, { mediaType: "application/zip" });
    const entries = await listArchive(target);
    const lower = new Set(entries.map((entry) => path.basename(entry).toLowerCase()));
    for (const required of ["sub.txt", "num.txt", "pre.txt", "tag.txt"]) {
      if (!lower.has(required)) throw new Error(`${quarter}.zip is missing ${required}`);
    }
    files.push(record);
    process.stdout.write(`SEC ${quarter}: ${record.bytes} bytes ${record.sha256.slice(0, 12)}\n`);
  }
  const normalized = await normalizeSecArchives(files, quarters);
  files.push(normalized.record);
  return writeManifest(buildManifest({
    datasetId: `sec-fsds-${quarters[0]}-${quarters.at(-1)}-v5`,
    sourceId: "sec-financial-statement-data-sets",
    sourceAuthority: "official",
    evidenceClass: "promotion_candidate",
    market: "us",
    dataKinds: ["fundamental"],
    sourceVersion: `${quarters[0]}..${quarters.at(-1)}`,
    files,
    coverage: { start: quarters[0], end: quarters.at(-1), expectedFiles: quarters.length, receivedFiles: files.length - 1 },
    normalization: normalizerIdentity("sec-primary-statement-facts.jsonl.v2"),
    limitations: [
      "Primary financial statements only; not every XBRL disclosure.",
      "Daily replay uses the next calendar day after filing as a conservative availability date.",
      "SEC FSDS has no point-in-time ticker mapping; records are keyed by CIK and accession.",
      `Normalizer retained ${normalized.factCount} non-dimensional primary-statement facts after form, unit, and duration checks.`,
    ],
  }));
}

function fredApiKey() {
  return process.env.FRED_API_KEY || parseEnvFile("FRED_API_KEY");
}

export function normalizeFredObservations(seriesId, observations) {
  return observations.map((row) => ({
    series_id: seriesId,
    observation_date: String(row.date),
    realtime_start: String(row.realtime_start),
    realtime_end: String(row.realtime_end),
    value: row.value === "." ? null : Number(row.value),
  })).filter((row) =>
    /^\d{4}-\d{2}-\d{2}$/.test(row.observation_date) &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.realtime_start) &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.realtime_end) &&
    (row.value === null || Number.isFinite(row.value)),
  );
}

async function fetchFred() {
  const key = fredApiKey();
  if (!key) throw new Error("FRED_API_KEY is required in the environment or .env.local");
  const files = [];
  const vintageDate = new Date().toISOString().slice(0, 10);
  const normalizedDir = path.join(STORE, "normalized", "fred-vintages", `${vintageDate}-v5`);
  await ensureDir(normalizedDir);
  const firstRealtimeYear = 1991;
  const today = new Date().toISOString().slice(0, 10);
  const lastRealtimeYear = Number(today.slice(0, 4));
  const realtimeWindows = [];
  const initialReleaseFallbackSeries = [];
  const nonPitFallbackSeries = new Set(["RSAFS", "FEDFUNDS", "DGORDER"]);
  for (let year = firstRealtimeYear; year <= lastRealtimeYear; year += 4) {
    realtimeWindows.push({
      start: `${year}-01-01`,
      end: year + 3 >= lastRealtimeYear ? today : `${year + 3}-12-31`,
    });
  }
  for (const seriesId of FRED_SERIES) {
    const normalizedByKey = new Map();
    let noAlfred = false;
    for (const window of realtimeWindows) {
      const sourceUrl = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&file_type=json&output_type=1&limit=100000&realtime_start=${window.start}&realtime_end=${window.end}`;
      const requestUrl = `${sourceUrl}&api_key=${encodeURIComponent(key)}`;
      const rawTarget = path.join(
        STORE, "raw", "fred-vintages", vintageDate, seriesId,
        `${window.start}_${window.end}.json`,
      );
      await ensureDir(path.dirname(rawTarget));
      let raw;
      if (fs.existsSync(rawTarget)) {
        raw = await fsp.readFile(rawTarget);
      } else {
        let response;
        try {
          response = await fetchWithRetry(requestUrl);
        } catch (error) {
          if (String(error).includes("does not exist in ALFRED")) {
            noAlfred = true;
            break;
          }
          throw error;
        }
        raw = Buffer.from(await response.arrayBuffer());
        const partial = `${rawTarget}.partial`;
        await fsp.writeFile(partial, raw, { flag: "wx" });
        await fsp.rename(partial, rawTarget);
      }
      const parsed = JSON.parse(raw.toString("utf8"));
      for (const row of normalizeFredObservations(seriesId, parsed.observations || [])) {
        const rowKey = [
          row.series_id, row.observation_date, row.realtime_start,
          row.realtime_end, row.value,
        ].join("|");
        normalizedByKey.set(rowKey, row);
      }
      const stat = await fsp.stat(rawTarget);
      files.push({
        relativePath: path.relative(STORE, rawTarget).replaceAll("\\", "/"),
        sourceUrl,
        sha256: await hashFile(rawTarget),
        bytes: stat.size,
        mediaType: "application/json",
      });
    }
    if (noAlfred) {
      initialReleaseFallbackSeries.push(seriesId);
      const sourceUrl = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`;
      const rawTarget = path.join(
        STORE, "raw", "fred-vintages", vintageDate, seriesId, "latest-history.csv",
      );
      let raw;
      if (fs.existsSync(rawTarget)) {
        raw = await fsp.readFile(rawTarget);
      } else {
        const response = await fetchWithRetry(sourceUrl);
        raw = Buffer.from(await response.arrayBuffer());
        const partial = `${rawTarget}.partial`;
        await fsp.writeFile(partial, raw, { flag: "wx" });
        await fsp.rename(partial, rawTarget);
      }
      const rows = raw.toString("utf8").split(/\r?\n/).filter(Boolean);
      const headers = parseCsvLine(rows.shift() || "").map((header) => header.trim());
      const dateIndex = headers.findIndex((header) => /^(DATE|observation_date)$/i.test(header));
      const valueIndex = headers.findIndex((header) => header.toUpperCase() === seriesId);
      if (dateIndex < 0 || valueIndex < 0) throw new Error(`Unexpected FRED graph CSV for ${seriesId}`);
      for (const line of rows) {
        const fields = parseCsvLine(line);
        const date = String(fields[dateIndex] ?? "");
        const rawValue = fields[valueIndex];
        const value = rawValue === "." || rawValue === "" ? null : Number(rawValue);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || (value !== null && !Number.isFinite(value))) continue;
        const normalized = {
          series_id: seriesId,
          observation_date: date,
          realtime_start: date,
          realtime_end: "9999-12-31",
          value,
          availability_clock: nonPitFallbackSeries.has(seriesId)
            ? "latest_only_not_point_in_time"
            : "observation_date_eod",
          replay_eligible: !nonPitFallbackSeries.has(seriesId),
        };
        normalizedByKey.set(`${seriesId}|${date}|initial`, normalized);
      }
      const stat = await fsp.stat(rawTarget);
      files.push({
        relativePath: path.relative(STORE, rawTarget).replaceAll("\\", "/"),
        sourceUrl,
        sha256: await hashFile(rawTarget),
        bytes: stat.size,
        mediaType: "text/csv",
      });
    }
    const normalized = [...normalizedByKey.values()].sort((a, b) =>
      a.observation_date.localeCompare(b.observation_date) ||
      a.realtime_start.localeCompare(b.realtime_start) ||
      a.realtime_end.localeCompare(b.realtime_end),
    );
    if (!normalized.length) throw new Error(`FRED ${seriesId} returned no valid vintage observations`);
    const normalizedTarget = path.join(normalizedDir, `${seriesId}.jsonl`);
    const normalizedBody = `${normalized.map((row) => JSON.stringify(row)).join("\n")}\n`;
    if (fs.existsSync(normalizedTarget)) {
      const existing = await fsp.readFile(normalizedTarget, "utf8");
      if (existing !== normalizedBody) throw new Error(`Normalized FRED output changed for ${seriesId}`);
    } else {
      await fsp.writeFile(normalizedTarget, normalizedBody, { flag: "wx" });
    }
    const normalizedStat = await fsp.stat(normalizedTarget);
    files.push({
      relativePath: path.relative(STORE, normalizedTarget).replaceAll("\\", "/"),
      sourceUrl: `derived:${seriesId}:fred-vintages.jsonl.v1`,
      sha256: await hashFile(normalizedTarget),
      bytes: normalizedStat.size,
      mediaType: "application/x-ndjson",
    });
    process.stdout.write(`FRED ${seriesId}: ${normalized.length} vintage rows\n`);
  }
  return writeManifest(buildManifest({
    datasetId: `fred-alfred-macro-vintages-${vintageDate}-v5`,
    sourceId: "fred-alfred",
    sourceAuthority: "official",
    evidenceClass: "promotion_candidate",
    market: "us",
    dataKinds: ["macro"],
    sourceVersion: "all-realtime-periods",
    files,
    coverage: {
      start: `${firstRealtimeYear}-01-01`,
      end: today,
      expectedFiles: files.length,
      receivedFiles: files.length,
    },
    normalization: normalizerIdentity("fred-vintages.jsonl.v1"),
    limitations: [
      "ALFRED real-time revision coverage is acquired from 1991 onward.",
      "Coverage begins at each series' own first observation.",
      "Daily replay must select by realtime interval, not latest value.",
      `FRED-only series use latest-history CSV when ALFRED is unavailable: ${initialReleaseFallbackSeries.join(",") || "none"}.`,
      `Monthly latest-only fallbacks are explicitly non-PIT and cannot enter replay: ${[...nonPitFallbackSeries].join(",")}.`,
    ],
  }));
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

export function nseBhavcopyUrl(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${dateText}`);
  // UDiFF was distributed in parallel before the June 21, 2024 legacy cutoff;
  // the official archive contains it from the start of 2024. Prefer the stable
  // UDiFF shape for the entire year.
  if (dateText >= "2024-01-01") {
    return `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${dateText.replaceAll("-", "")}_F_0000.csv.zip`;
  }
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase();
  const year = date.getUTCFullYear();
  return `https://nsearchives.nseindia.com/content/historical/EQUITIES/${year}/${month}/cm${day}${month}${year}bhav.csv.zip`;
}

function dateRange(from, to) {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) throw new Error("Invalid date range");
  const dates = [];
  for (const date = new Date(start); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(ymd(date));
  }
  return dates;
}

function monthRange(from, to) {
  const start = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${to.slice(0, 7)}-01T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    throw new Error("Invalid month range");
  }
  const months = [];
  for (const date = new Date(start); date <= end; date.setUTCMonth(date.getUTCMonth() + 1)) {
    const monthStart = new Date(date);
    const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
    months.push({
      from: ymd(monthStart) < from ? from : ymd(monthStart),
      to: ymd(monthEnd) > to ? to : ymd(monthEnd),
    });
  }
  return months;
}

export function parseCsvLine(line) {
  const fields = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === "\"") {
      if (quoted && line[index + 1] === "\"") { value += "\""; index++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      fields.push(value.trim());
      value = "";
    } else value += char;
  }
  fields.push(value.trim());
  return fields;
}

function nseDisplayDate(value) {
  const text = String(value || "").trim();
  if (text === "-" || !text) return null;
  const match = text.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/);
  if (!match) return null;
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const month = months.indexOf(match[2].toUpperCase()) + 1;
  if (!month) return null;
  return `${match[3]}-${String(month).padStart(2, "0")}-${String(Number(match[1])).padStart(2, "0")}`;
}

export function normalizeNseCorporateAction(row, sourceHash) {
  if (String(row?.series ?? "").toUpperCase() !== "EQ") return null;
  const subject = String(row?.subject ?? "").trim();
  const exDate = nseDisplayDate(row?.exDate);
  const recordDate = nseDisplayDate(row?.recDate);
  const broadcastDate = nseDisplayDate(row?.caBroadcastDate);
  const symbol = String(row?.symbol ?? "").trim().toUpperCase();
  const isin = String(row?.isin ?? "").trim().toUpperCase();
  if (!symbol || !exDate || !subject) return null;

  let actionType = "other";
  let adjustmentStatus = "not_price_adjusting";
  let ratioOrAmount = null;
  let adjustmentFactor = null;
  let amountInr = null;
  const bonus = subject.match(/\bBonus\s+(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/i);
  const split = subject.match(/\b(?:Face Value )?Split\b[\s\S]*?From\s+Rs\.?\s*(\d+(?:\.\d+)?)[\s\S]*?To\s+(?:Rs\.?|Re)\s*(\d+(?:\.\d+)?)/i);
  const rights = subject.match(/\bRights\s+(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/i);
  const dividendMatches = [...subject.matchAll(/\b(?:Rs\.?|Re)\s*(\d+(?:\.\d+)?)\s*(?:\/-)?\s*Per Share\b/gi)];

  if (bonus) {
    const issued = Number(bonus[1]);
    const held = Number(bonus[2]);
    actionType = "bonus";
    ratioOrAmount = `${issued}:${held}`;
    adjustmentFactor = held > 0 ? 1 + issued / held : null;
    adjustmentStatus = adjustmentFactor && Number.isFinite(adjustmentFactor) ? "parsed" : "ambiguous";
  } else if (split) {
    const oldFace = Number(split[1]);
    const newFace = Number(split[2]);
    actionType = "split";
    ratioOrAmount = `${oldFace}:${newFace}`;
    adjustmentFactor = newFace > 0 ? oldFace / newFace : null;
    adjustmentStatus = adjustmentFactor && Number.isFinite(adjustmentFactor) ? "parsed" : "ambiguous";
  } else if (rights) {
    actionType = "rights";
    ratioOrAmount = `${rights[1]}:${rights[2]}`;
    adjustmentStatus = "unsupported_adjustment";
  } else if (dividendMatches.length) {
    actionType = "dividend";
    amountInr = dividendMatches.reduce((sum, match) => sum + Number(match[1]), 0);
    ratioOrAmount = amountInr;
    adjustmentStatus = Number.isFinite(amountInr) ? "parsed" : "ambiguous";
  }

  return {
    market: "india",
    exchange: "NSE",
    symbol,
    isin: isin || null,
    action_type: actionType,
    subject,
    ex_date: exDate,
    record_date: recordDate,
    ratio_or_amount: ratioOrAmount,
    adjustment_factor: adjustmentFactor,
    amount_inr: amountInr,
    currency: "INR",
    announced_at: broadcastDate,
    availability_clock: broadcastDate ? "broadcast_date" : "ex_date_conservative",
    adjustment_status: adjustmentStatus,
    source_file_sha256: sourceHash,
  };
}

function numberField(value) {
  const parsed = Number(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeNseRow(headers, values, sourceHash) {
  const row = Object.fromEntries(headers.map((header, index) => [header.trim().toUpperCase().replaceAll(" ", "_"), values[index]?.trim() ?? ""]));
  const udiff = "TCKRSYMB" in row;
  const series = udiff ? row.SCTYSRS : row.SERIES;
  if (series !== "EQ") return null;
  const normalized = {
    market: "india",
    exchange: "NSE",
    symbol: udiff ? row.TCKRSYMB : row.SYMBOL,
    session_date: udiff ? row.TRADDT : parseNseDate(row.TIMESTAMP || row.DATE1),
    open: numberField(udiff ? row.OPNPRIC : row.OPEN),
    high: numberField(udiff ? row.HGHPRIC : row.HIGH),
    low: numberField(udiff ? row.LWPRIC : row.LOW),
    close: numberField(udiff ? row.CLSPRIC : row.CLOSE),
    volume: numberField(udiff ? row.TTLTRADGVOL : row.TOTTRDQTY),
    turnover: numberField(udiff ? row.TTLTRFVAL : row.TOTTRDVAL),
    currency: "INR",
    price_basis: "raw",
    source_file_sha256: sourceHash,
  };
  if (!normalized.symbol || !/^\d{4}-\d{2}-\d{2}$/.test(normalized.session_date)) return null;
  const prices = [normalized.open, normalized.high, normalized.low, normalized.close];
  if (prices.some((value) => value === null || value <= 0) || normalized.volume === null || normalized.volume < 0) return null;
  if (normalized.high < Math.max(normalized.open, normalized.close) || normalized.low > Math.min(normalized.open, normalized.close)) return null;
  return normalized;
}

export function assertNseSessionDate(row, expectedDate, archiveName = "archive") {
  if (row.session_date !== expectedDate) {
    throw new Error(
      `NSE archive ${archiveName} contains ${row.session_date}; expected ${expectedDate}`,
    );
  }
}

function parseNseDate(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/);
  if (match) {
    const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
    const month = months.indexOf(match[2].toUpperCase()) + 1;
    const rawYear = Number(match[3]);
    const year = match[3].length === 2
      ? rawYear >= 70 ? 1900 + rawYear : 2000 + rawYear
      : rawYear;
    if (month > 0) return `${year}-${String(month).padStart(2, "0")}-${String(Number(match[1])).padStart(2, "0")}`;
  }
  return "";
}

async function normalizeNseArchive(zipPath, sourceHash, expectedDate, output) {
  const entries = await listArchive(zipPath);
  const csvEntries = entries.filter((entry) => entry.toLowerCase().endsWith(".csv"));
  if (csvEntries.length !== 1) throw new Error(`Expected one CSV in ${zipPath}, found ${csvEntries.length}`);
  const tempDir = path.join(STORE, "tmp", sha256(zipPath).slice(0, 16));
  await ensureDir(tempDir);
  await execFileAsync("tar", ["-xf", zipPath, "-C", tempDir]);
  const csvPath = ensureWithinStore(path.join(tempDir, csvEntries[0]));
  const stream = fs.createReadStream(csvPath);
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let headers = null;
  let accepted = 0;
  let rejected = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (!headers) { headers = parseCsvLine(line); continue; }
    const row = normalizeNseRow(headers, parseCsvLine(line), sourceHash);
    if (!row) { rejected++; continue; }
    assertNseSessionDate(row, expectedDate, path.basename(zipPath));
    output.write(`${JSON.stringify(row)}\n`);
    accepted++;
  }
  await fsp.rm(tempDir, { recursive: true, force: true });
  if (!headers || accepted === 0) throw new Error(`No valid EQ rows in ${zipPath}`);
  return { accepted, rejected };
}

async function fetchNse(args) {
  const from = args.from || "2024-01-01";
  const to = args.to || new Date().toISOString().slice(0, 10);
  const candidates = dateRange(from, to);
  const files = [];
  const missingWeekdays = [];
  for (const date of candidates) {
    const url = nseBhavcopyUrl(date);
    const target = path.join(STORE, "raw", "nse-bhavcopy", date.slice(0, 4), `${date}.zip`);
    const record = await atomicDownload(url, target, {
      allowMissing: true,
      mediaType: "application/zip",
      timeoutMs: 20_000,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) KairosResearch/1.0" },
    });
    if (record) {
      files.push(record);
      if (files.length % 25 === 0) process.stdout.write(`NSE: ${files.length}/${candidates.length} files\n`);
    } else missingWeekdays.push(date);
  }
  if (!files.length) throw new Error("NSE returned no files for the requested range");

  const normalizedDir = path.join(STORE, "normalized", "nse-bhavcopy", `${from}-${to}-v6`);
  await ensureDir(normalizedDir);
  const normalizedPath = path.join(normalizedDir, "daily-bars.jsonl");
  const normalizedPartial = `${normalizedPath}.partial`;
  await fsp.rm(normalizedPartial, { force: true });
  const output = fs.createWriteStream(normalizedPartial, { flags: "wx" });
  let acceptedRows = 0;
  let rejectedRows = 0;
  try {
    for (const file of files) {
      const expectedDate = path.basename(file.relativePath, ".zip");
      const result = await normalizeNseArchive(
        path.join(STORE, file.relativePath),
        file.sha256,
        expectedDate,
        output,
      );
      acceptedRows += result.accepted;
      rejectedRows += result.rejected;
    }
  } finally {
    await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()));
  }
  if (fs.existsSync(normalizedPath)) {
    const [existingHash, partialHash] = await Promise.all([hashFile(normalizedPath), hashFile(normalizedPartial)]);
    if (existingHash !== partialHash) throw new Error("Normalized NSE output changed for an existing dataset version");
    await fsp.rm(normalizedPartial, { force: true });
  } else {
    await fsp.rename(normalizedPartial, normalizedPath);
  }
  const normalizedStat = await fsp.stat(normalizedPath);
  const normalizedHash = await hashFile(normalizedPath);
  files.push({
    relativePath: path.relative(STORE, normalizedPath).replaceAll("\\", "/"),
    sourceUrl: "derived:validated-nse-bhavcopy",
    sha256: normalizedHash,
    bytes: normalizedStat.size,
    mediaType: "application/x-ndjson",
  });
  return writeManifest(buildManifest({
    datasetId: `nse-bhavcopy-${from}-${to}-v6`,
    sourceId: "nse-bhavcopy",
    sourceAuthority: "official",
    evidenceClass: "diagnostic",
    market: "india",
    dataKinds: ["ohlcv", "universe"],
    sourceVersion: `${from}..${to}`,
    files,
    coverage: { start: from, end: to, expectedFiles: candidates.length, receivedFiles: files.length - 1 },
    normalization: normalizerIdentity("nse-daily-bars.jsonl.v2"),
    limitations: [
      `Unreconciled non-weekend dates without files: ${missingWeekdays.join(",") || "none"}.`,
      "Raw prices are not corporate-action-adjusted.",
      "Evidence remains diagnostic until exchange-calendar and corporate-action manifests are bound.",
      `Normalizer accepted ${acceptedRows} EQ rows and rejected/skipped ${rejectedRows} non-EQ or invalid rows.`,
    ],
  }));
}

async function fetchNseActions(args) {
  const from = args.from || "2024-01-01";
  const to = args.to || new Date().toISOString().slice(0, 10);
  const months = monthRange(from, to);
  const files = [];
  const rows = [];
  const landingUrl = "https://www.nseindia.com/companies-listing/corporate-filings-actions";
  const landing = await fetchWithRetry(landingUrl, {
    timeoutMs: 30_000,
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) KairosResearch/1.0" },
  });
  const cookies = typeof landing.headers.getSetCookie === "function"
    ? landing.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ")
    : String(landing.headers.get("set-cookie") || "").split(",").map((value) => value.split(";", 1)[0]).join("; ");

  for (const month of months) {
    const display = (date) => date.split("-").reverse().join("-");
    const sourceUrl = `https://www.nseindia.com/api/corporates-corporateActions?index=equities&from_date=${display(month.from)}&to_date=${display(month.to)}`;
    const target = path.join(STORE, "raw", "nse-corporate-actions", `${month.from}_${month.to}.json`);
    await ensureDir(path.dirname(target));
    let body;
    if (fs.existsSync(target)) {
      body = await fsp.readFile(target);
    } else {
      const response = await fetchWithRetry(sourceUrl, {
        timeoutMs: 30_000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) KairosResearch/1.0",
          Referer: landingUrl,
          Cookie: cookies,
          Accept: "application/json,text/plain,*/*",
        },
      });
      body = Buffer.from(await response.arrayBuffer());
      const partial = `${target}.partial`;
      await fsp.writeFile(partial, body, { flag: "wx" });
      await fsp.rename(partial, target);
    }
    const parsed = JSON.parse(body.toString("utf8"));
    if (!Array.isArray(parsed)) throw new Error(`Unexpected NSE corporate-action response for ${month.from}`);
    const sourceHash = await hashFile(target);
    for (const row of parsed) {
      const normalized = normalizeNseCorporateAction(row, sourceHash);
      if (normalized) rows.push(normalized);
    }
    const stat = await fsp.stat(target);
    files.push({
      relativePath: path.relative(STORE, target).replaceAll("\\", "/"),
      sourceUrl,
      sha256: sourceHash,
      bytes: stat.size,
      mediaType: "application/json",
    });
  }
  rows.sort((a, b) =>
    a.ex_date.localeCompare(b.ex_date) ||
    a.symbol.localeCompare(b.symbol) ||
    a.subject.localeCompare(b.subject),
  );
  const unique = [...new Map(rows.map((row) => [
    `${row.symbol}|${row.ex_date}|${row.subject}|${row.isin || ""}`,
    row,
  ])).values()];
  if (!unique.length) throw new Error("NSE returned no normalized EQ corporate actions");
  const normalizedDir = path.join(STORE, "normalized", "nse-corporate-actions", `${from}-${to}-v5`);
  await ensureDir(normalizedDir);
  const normalizedPath = path.join(normalizedDir, "corporate-actions.jsonl");
  const body = `${unique.map((row) => JSON.stringify(row)).join("\n")}\n`;
  if (fs.existsSync(normalizedPath)) {
    if (await fsp.readFile(normalizedPath, "utf8") !== body) {
      throw new Error("Normalized NSE corporate actions changed for an existing dataset version");
    }
  } else {
    await fsp.writeFile(normalizedPath, body, { flag: "wx" });
  }
  const stat = await fsp.stat(normalizedPath);
  files.push({
    relativePath: path.relative(STORE, normalizedPath).replaceAll("\\", "/"),
    sourceUrl: "derived:validated-nse-corporate-actions",
    sha256: await hashFile(normalizedPath),
    bytes: stat.size,
    mediaType: "application/x-ndjson",
  });
  const ambiguous = unique.filter((row) =>
    row.adjustment_status === "ambiguous" || row.adjustment_status === "unsupported_adjustment",
  ).length;
  return writeManifest(buildManifest({
    datasetId: `nse-corporate-actions-${from}-${to}-v5`,
    sourceId: "nse-corporate-actions",
    sourceAuthority: "official",
    evidenceClass: "diagnostic",
    market: "india",
    dataKinds: ["corporate_action"],
    sourceVersion: `${from}..${to}`,
    files,
    coverage: { start: from, end: to, expectedFiles: months.length, receivedFiles: months.length },
    normalization: normalizerIdentity("nse-corporate-actions.jsonl.v1"),
    limitations: [
      "NSE does not consistently expose announcement/broadcast timestamps; affected rows use ex-date as a conservative availability clock.",
      "Rights issues are retained but are not mechanically adjusted without subscription-price and entitlement treatment.",
      `${ambiguous} price-affecting rows are ambiguous or unsupported and must fail closed in an adjusted-return derivation.`,
    ],
  }));
}

async function fetchSp500() {
  const commitResponse = await fetchWithRetry("https://api.github.com/repos/hanshof/sp500_constituents/commits/main");
  const commitBody = await commitResponse.json();
  const commit = String(commitBody?.sha ?? "");
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Could not resolve an immutable S&P fixture commit");
  const url = `https://raw.githubusercontent.com/hanshof/sp500_constituents/${commit}/sp_500_historical_components.csv`;
  const target = path.join(STORE, "raw", "sp500-community", commit, "sp_500_historical_components.csv");
  const file = await atomicDownload(url, target, { mediaType: "text/csv" });
  const header = (await fsp.readFile(target, "utf8")).split(/\r?\n/, 1)[0].toLowerCase();
  if (!header.includes("date") || !header.includes("tickers")) {
    throw new Error("Historical S&P fixture has an unexpected header");
  }
  return writeManifest(buildManifest({
    datasetId: `sp500-community-${commit.slice(0, 12)}-v5`,
    sourceId: "hanshof-sp500-constituents",
    sourceAuthority: "community",
    evidenceClass: "diagnostic",
    market: "us",
    dataKinds: ["universe"],
    sourceVersion: file.sha256,
    files: [file],
    coverage: { start: "1996-01-02", end: new Date().toISOString().slice(0, 10), receivedFiles: 1 },
    normalization: normalizerIdentity("community-sp500.csv.v1"),
    limitations: ["Community-maintained and Wikipedia-derived; not authoritative promotion evidence.", "S&P 500 membership is not Kairos' broad liquid-equity universe."],
  }));
}

async function catalog() {
  const dir = path.join(STORE, "manifests");
  await ensureDir(dir);
  const manifests = [];
  for (const name of (await fsp.readdir(dir)).filter((entry) => entry.endsWith(".json")).sort()) {
    manifests.push(JSON.parse(await fsp.readFile(path.join(dir, name), "utf8")));
  }
  const summary = manifests.map((manifest) => ({
    datasetId: manifest.datasetId,
    sourceId: manifest.sourceId,
    market: manifest.market,
    evidenceClass: manifest.evidenceClass,
    coverage: manifest.coverage,
    fingerprint: manifest.datasetFingerprint,
    status: manifest.normalization?.status,
    currentNormalizer: manifest.normalization?.codeSha256 === RUN_CODE_SHA256,
  }));
  await fsp.writeFile(path.join(STORE, "catalog.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ store: STORE, datasets: summary }, null, 2)}\n`);
  return summary;
}

async function main() {
  await ensureDir(STORE);
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  let manifest;
  if (command === "fetch-sec") manifest = await fetchSec(args);
  else if (command === "fetch-fred") manifest = await fetchFred(args);
  else if (command === "fetch-nse") manifest = await fetchNse(args);
  else if (command === "fetch-nse-actions") manifest = await fetchNseActions(args);
  else if (command === "fetch-sp500") manifest = await fetchSp500(args);
  else if (command === "catalog") return catalog();
  else throw new Error("Command required: fetch-fred | fetch-sec | fetch-nse | fetch-nse-actions | fetch-sp500 | catalog");
  process.stdout.write(`manifest ${manifest.datasetId} ${manifest.datasetFingerprint}\n`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch(async (error) => {
    const quarantine = path.join(STORE, "quarantine", `failed-${Date.now()}.json`);
    try {
      await ensureDir(path.dirname(quarantine));
      await fsp.writeFile(quarantine, `${JSON.stringify({ failedAt: isoNow(), error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
    } catch {}
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
