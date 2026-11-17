import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { SupabaseClient } from "@supabase/supabase-js";

const MAX_ARCHIVE_ROWS = 10_000;
const MAX_COMPRESSED_BYTES = 25_000_000;
const ARCHIVE_PATH = "/v1/archive/india-news-snapshots";
const DIGEST_RE = /^[0-9a-f]{32}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

type Candidate = {
  cutoff: string;
  row_count: number;
  min_id: number | null;
  max_id: number | null;
  ordered_row_digest: string | null;
  rows: Array<Record<string, unknown>>;
};

export class IndiaNewsSnapshotArchiveError extends Error {}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseCandidate(value: unknown): Candidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new IndiaNewsSnapshotArchiveError("Archive candidate is invalid");
  const candidate = value as Candidate;
  if (!Number.isSafeInteger(candidate.row_count) || candidate.row_count < 0 || candidate.row_count > MAX_ARCHIVE_ROWS
    || !Array.isArray(candidate.rows) || candidate.rows.length !== candidate.row_count
    || typeof candidate.cutoff !== "string" || !Number.isFinite(Date.parse(candidate.cutoff))) {
    throw new IndiaNewsSnapshotArchiveError("Archive candidate exceeds its verified bounds");
  }
  if (candidate.row_count === 0) {
    if (candidate.min_id !== null || candidate.max_id !== null || candidate.ordered_row_digest !== null) {
      throw new IndiaNewsSnapshotArchiveError("Empty archive candidate has unexpected bounds");
    }
    return candidate;
  }
  if (!Number.isSafeInteger(candidate.min_id) || !Number.isSafeInteger(candidate.max_id)
    || (candidate.min_id as number) < 1 || (candidate.max_id as number) < (candidate.min_id as number)
    || typeof candidate.ordered_row_digest !== "string" || !DIGEST_RE.test(candidate.ordered_row_digest)) {
    throw new IndiaNewsSnapshotArchiveError("Archive candidate digest or bounds are invalid");
  }
  let previousId = 0;
  for (const row of candidate.rows) {
    if (!row || typeof row !== "object" || Array.isArray(row) || !Number.isSafeInteger(row.id) || (row.id as number) <= previousId) {
      throw new IndiaNewsSnapshotArchiveError("Archive candidate rows are not strictly ordered by id");
    }
    previousId = row.id as number;
  }
  if (candidate.rows[0].id !== candidate.min_id || candidate.rows[candidate.rows.length - 1].id !== candidate.max_id) {
    throw new IndiaNewsSnapshotArchiveError("Archive candidate row bounds do not match its manifest");
  }
  return candidate;
}

async function checkedResponse(response: Response, label: string): Promise<Response> {
  if (!response.ok) throw new IndiaNewsSnapshotArchiveError(`${label} failed (${response.status})`);
  return response;
}

/**
 * Archive the entire expired seven-day snapshot cohort to private R2 and verify
 * its downloaded bytes before asking Postgres to recheck and prune it.
 */
export async function archiveExpiredIndiaNewsSnapshots(svc: SupabaseClient, now = new Date()): Promise<number> {
  // Leave a one-minute clock-skew cushion relative to Postgres's own
  // transaction_timestamp() retention guard.
  const cutoff = new Date(now.getTime() - 7 * 86_400_000 - 60_000).toISOString();
  const { data, error } = await svc.rpc("get_india_news_snapshots_archive_candidate", { p_cutoff: cutoff });
  if (error) throw new IndiaNewsSnapshotArchiveError("Could not read the exact expired snapshot cohort");
  const candidate = parseCandidate(data);
  if (candidate.row_count === 0) return 0;
  if (Date.parse(candidate.cutoff) !== Date.parse(cutoff)) throw new IndiaNewsSnapshotArchiveError("Candidate cutoff differs from the requested retention boundary");

  const endpoint = process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_URL;
  const token = process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_TOKEN;
  if (!endpoint || !token || token.length < 32) throw new IndiaNewsSnapshotArchiveError("Private archive endpoint is not configured");

  const payload = Buffer.from(candidate.rows.map(row => JSON.stringify(row)).join("\n") + "\n", "utf8");
  const compressed = gzipSync(payload, { level: 9 });
  if (compressed.byteLength > MAX_COMPRESSED_BYTES) throw new IndiaNewsSnapshotArchiveError("Archive cohort exceeds the upload size bound");
  const archiveSha256 = sha256(compressed);
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/gzip",
    "Content-Length": String(compressed.byteLength),
    "X-Kairos-Cutoff": cutoff,
    "X-Kairos-Row-Count": String(candidate.row_count),
    "X-Kairos-Min-Id": String(candidate.min_id),
    "X-Kairos-Max-Id": String(candidate.max_id),
    "X-Kairos-Source-Digest": candidate.ordered_row_digest as string,
    "X-Kairos-Archive-Sha256": archiveSha256,
  };
  const baseUrl = new URL(endpoint);
  const archiveUrl = new URL(ARCHIVE_PATH, baseUrl);
  await checkedResponse(await fetch(archiveUrl, { method: "POST", headers, body: compressed }), "Private archive upload");

  const objectUrl = new URL(`${ARCHIVE_PATH}/${candidate.ordered_row_digest}/${archiveSha256}`, baseUrl);
  const downloaded = await checkedResponse(await fetch(objectUrl, { headers: { Authorization: `Bearer ${token}` } }), "Private archive read-back");
  const downloadedBytes = new Uint8Array(await downloaded.arrayBuffer());
  if (downloadedBytes.byteLength !== compressed.byteLength || sha256(downloadedBytes) !== archiveSha256) {
    throw new IndiaNewsSnapshotArchiveError("Private archive read-back checksum does not match the uploaded cohort");
  }

  const manifestUrl = new URL(`${ARCHIVE_PATH}/${candidate.ordered_row_digest}/${archiveSha256}/manifest`, baseUrl);
  const manifestResponse = await checkedResponse(await fetch(manifestUrl, { headers: { Authorization: `Bearer ${token}` } }), "Private archive manifest read-back");
  let manifest: Record<string, unknown>;
  try { manifest = await manifestResponse.json() as Record<string, unknown>; }
  catch { throw new IndiaNewsSnapshotArchiveError("Private archive manifest is invalid"); }
  if (manifest.rowCount !== candidate.row_count || manifest.minId !== candidate.min_id || manifest.maxId !== candidate.max_id
    || manifest.cutoff !== cutoff || manifest.sourceDigest !== candidate.ordered_row_digest
    || manifest.archiveSha256 !== archiveSha256 || manifest.archiveBytes !== compressed.byteLength) {
    throw new IndiaNewsSnapshotArchiveError("Private archive manifest does not match the source cohort");
  }

  const { data: pruneData, error: pruneError } = await svc.rpc("prune_archived_india_news_snapshots", {
    p_cutoff: cutoff,
    p_expected_rows: candidate.row_count,
    p_expected_min_id: candidate.min_id,
    p_expected_max_id: candidate.max_id,
    p_expected_digest: candidate.ordered_row_digest,
  });
  if (pruneError || !pruneData || typeof pruneData !== "object"
    || (pruneData as Record<string, unknown>).deleted_rows !== candidate.row_count) {
    throw new IndiaNewsSnapshotArchiveError("Source cohort changed or failed its final exact-match prune check");
  }
  return candidate.row_count;
}

export const __test = { parseCandidate, sha256, DIGEST_RE, SHA256_RE };
