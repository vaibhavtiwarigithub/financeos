/**
 * Network-free adapter from a hash-bound local evidence dataset to replay raws.
 *
 * This module never downloads. Acquisition is an explicit operator action through
 * scripts/evidence-data.mjs. A replay first verifies every manifest file, then
 * converts only the requested records into the existing packet assembler contract.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { RawRecord } from "./packet-assembler";

export interface LocalEvidenceFile {
  relativePath: string;
  sourceUrl: string;
  sha256: string;
  bytes: number;
  mediaType: string;
}

export interface LocalEvidenceManifest {
  schemaVersion: "kairos.evidence-dataset.v1";
  datasetId: string;
  sourceId: string;
  sourceAuthority: "official" | "community" | "manual";
  evidenceClass: "promotion_candidate" | "diagnostic" | "reference";
  market: "us" | "india" | "global";
  files: LocalEvidenceFile[];
  normalization: { status: "pending" | "valid" | "quarantined"; schemaVersion: string };
  datasetFingerprint: string;
  [key: string]: unknown;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function hashFile(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function storeRoot(manifestPath: string): string {
  return path.resolve(path.dirname(manifestPath), "..");
}

function resolveManifestFile(manifestPath: string, relativePath: string): string {
  const root = storeRoot(manifestPath);
  const target = path.resolve(root, relativePath);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!target.startsWith(prefix)) throw new Error(`Manifest path escapes evidence store: ${relativePath}`);
  return target;
}

function verifyFingerprint(manifest: LocalEvidenceManifest): void {
  const { datasetFingerprint, ...base } = manifest;
  delete (base as Record<string, unknown>).retrievedAt;
  const actual = sha256(canonicalJson(base));
  if (actual !== datasetFingerprint) throw new Error(`Dataset fingerprint mismatch: ${manifest.datasetId}`);
}

export async function verifyLocalEvidenceManifest(manifestPath: string): Promise<LocalEvidenceManifest> {
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as LocalEvidenceManifest;
  if (manifest.schemaVersion !== "kairos.evidence-dataset.v1") throw new Error("Unsupported evidence manifest schema");
  if (manifest.normalization?.status !== "valid") throw new Error(`Dataset is not valid: ${manifest.normalization?.status}`);
  verifyFingerprint(manifest);
  for (const entry of manifest.files) {
    if (entry.sourceUrl.startsWith("derived:") || entry.sourceUrl.startsWith("https://")) {
      const file = resolveManifestFile(manifestPath, entry.relativePath);
      const stat = await fsp.stat(file);
      if (stat.size !== entry.bytes) throw new Error(`Byte-count mismatch: ${entry.relativePath}`);
      if (await hashFile(file) !== entry.sha256) throw new Error(`File hash mismatch: ${entry.relativePath}`);
    } else {
      throw new Error(`Unsupported manifest source URL: ${entry.sourceUrl}`);
    }
  }
  return manifest;
}

/**
 * Verify once, then expose bounded normalized-row streams without re-hashing a
 * multi-gigabyte dataset for each pass. The returned closure can resolve only
 * files already named and hashed by this exact manifest.
 */
export async function openVerifiedLocalEvidenceDataset(manifestPath: string): Promise<{
  manifest: LocalEvidenceManifest;
  rows: (relativePathSuffix: string) => AsyncGenerator<Record<string, unknown>>;
}> {
  const manifest = await verifyLocalEvidenceManifest(manifestPath);
  return {
    manifest,
    rows(relativePathSuffix: string) {
      const matches = manifest.files.filter((entry) =>
        entry.mediaType === "application/x-ndjson"
        && entry.relativePath.endsWith(relativePathSuffix),
      );
      if (matches.length !== 1) {
        throw new Error(
          `Expected exactly one verified ${relativePathSuffix} file in ${manifest.datasetId}; found ${matches.length}`,
        );
      }
      return jsonLines(resolveManifestFile(manifestPath, matches[0].relativePath));
    },
  };
}

async function* jsonLines(file: string): AsyncGenerator<Record<string, unknown>> {
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim()) yield JSON.parse(line) as Record<string, unknown>;
  }
}

const SEC_TAG_PRIORITY = new Map([
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "Revenues",
  "SalesRevenueNet",
  "SalesRevenueGoodsNet",
  "NetIncomeLoss",
  "OperatingIncomeLoss",
  "StockholdersEquity",
  "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
].map((tag, index) => [tag, index]));

export async function loadLocalNsePriceRaws(
  manifestPath: string,
  options: { symbol: string; from?: string; through: string },
): Promise<RawRecord[]> {
  const manifest = await verifyLocalEvidenceManifest(manifestPath);
  if (manifest.sourceId !== "nse-bhavcopy" || manifest.market !== "india") {
    throw new Error("Manifest is not an India NSE bhavcopy dataset");
  }
  const entry = manifest.files.find((file) => file.mediaType === "application/x-ndjson" && file.relativePath.endsWith("daily-bars.jsonl"));
  if (!entry) throw new Error("NSE normalized daily-bars file is absent");
  const raws: RawRecord[] = [];
  for await (const row of jsonLines(resolveManifestFile(manifestPath, entry.relativePath))) {
    const date = String(row.session_date ?? "");
    if (row.symbol !== options.symbol || date > options.through || (options.from && date < options.from)) continue;
    raws.push({
      itemType: "ohlcv",
      symbol: options.symbol,
      source: manifest.sourceId,
      sourceTier: 1,
      date,
      payload: row,
    });
  }
  return raws;
}

export async function loadLocalFredMacroRaws(
  manifestPath: string,
  options: { seriesId: string; asOf: string },
): Promise<RawRecord[]> {
  const manifest = await verifyLocalEvidenceManifest(manifestPath);
  if (manifest.sourceId !== "fred-alfred") throw new Error("Manifest is not a FRED/ALFRED dataset");
  const entry = manifest.files.find((file) =>
    file.mediaType === "application/x-ndjson" && file.relativePath.endsWith(`/${options.seriesId}.jsonl`),
  );
  if (!entry) throw new Error(`FRED normalized series is absent: ${options.seriesId}`);
  const raws: RawRecord[] = [];
  for await (const row of jsonLines(resolveManifestFile(manifestPath, entry.relativePath))) {
    if (row.replay_eligible === false) continue;
    const realtimeStart = String(row.realtime_start ?? "");
    const realtimeEnd = String(row.realtime_end ?? "");
    const observationDate = String(row.observation_date ?? "");
    if (realtimeStart > options.asOf || realtimeEnd < options.asOf || observationDate > options.asOf) continue;
    raws.push({
      itemType: "macro",
      symbol: options.seriesId,
      source: manifest.sourceId,
      sourceTier: 1,
      realtimeStart,
      payload: row,
    });
  }
  return raws;
}

export async function loadLocalNseCorporateActionRaws(
  manifestPath: string,
  options: { symbol: string; through: string },
): Promise<RawRecord[]> {
  const manifest = await verifyLocalEvidenceManifest(manifestPath);
  if (manifest.sourceId !== "nse-corporate-actions" || manifest.market !== "india") {
    throw new Error("Manifest is not an India NSE corporate-action dataset");
  }
  const entry = manifest.files.find((file) =>
    file.mediaType === "application/x-ndjson" &&
    file.relativePath.endsWith("/corporate-actions.jsonl"),
  );
  if (!entry) throw new Error("NSE normalized corporate-action file is absent");
  const raws: RawRecord[] = [];
  for await (const row of jsonLines(resolveManifestFile(manifestPath, entry.relativePath))) {
    const exDate = String(row.ex_date ?? "");
    if (row.symbol !== options.symbol || exDate > options.through) continue;
    raws.push({
      itemType: "corporate_action",
      symbol: options.symbol,
      source: manifest.sourceId,
      sourceTier: 1,
      announcedAt: row.announced_at ? String(row.announced_at) : undefined,
      exDate,
      payload: row,
    });
  }
  return raws;
}

export async function loadLocalSecFundamentalRaws(
  manifestPath: string,
  options: { cik: string; symbol: string; asOf: string },
): Promise<RawRecord[]> {
  const manifest = await verifyLocalEvidenceManifest(manifestPath);
  if (manifest.sourceId !== "sec-financial-statement-data-sets" || manifest.market !== "us") {
    throw new Error("Manifest is not a US SEC financial-statement dataset");
  }
  const entry = manifest.files.find((file) =>
    file.mediaType === "application/x-ndjson" &&
    file.relativePath.endsWith("/primary-statement-facts.jsonl"),
  );
  if (!entry) throw new Error("SEC normalized primary-statement facts are absent");
  const cik = options.cik.padStart(10, "0");
  const groups = new Map<string, Record<string, unknown>[]>();
  for await (const row of jsonLines(resolveManifestFile(manifestPath, entry.relativePath))) {
    const availableOn = String(row.available_on ?? "");
    if (row.cik !== cik || availableOn > options.asOf) continue;
    const key = [
      row.accession,
      row.metric,
      row.period_end,
      row.duration_quarters,
      row.unit,
    ].join("|");
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const raws: RawRecord[] = [];
  for (const group of groups.values()) {
    const values = new Set(group.map((row) => String(row.value)));
    if (values.size !== 1) continue;
    group.sort((a, b) =>
      (SEC_TAG_PRIORITY.get(String(a.tag)) ?? Number.MAX_SAFE_INTEGER) -
      (SEC_TAG_PRIORITY.get(String(b.tag)) ?? Number.MAX_SAFE_INTEGER),
    );
    const row = group[0];
    const availableOn = String(row.available_on ?? "");
    raws.push({
      itemType: "fundamental",
      symbol: options.symbol,
      source: manifest.sourceId,
      sourceTier: 1,
      filedAt: availableOn,
      periodEnd: String(row.period_end ?? ""),
      payload: row,
    });
  }
  return raws.sort((a, b) =>
    String((a.payload as Record<string, unknown>).available_on).localeCompare(
      String((b.payload as Record<string, unknown>).available_on),
    ),
  );
}
