import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { archiveExpiredIndiaNewsSnapshots, IndiaNewsSnapshotArchiveError } from "./india-news-snapshot-archive";

const savedUrl = process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_URL;
const savedToken = process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_TOKEN;
const token = "test-private-archive-token-with-at-least-32-characters";
const now = new Date("2026-11-16T15:00:00.000Z");
const cutoff = new Date(now.getTime() - 7 * 86_400_000 - 60_000).toISOString();
const digest = "80bff5cb61b3ad12093a1215eb340c32";
const rows = [{ id: 12, fetched_at: "2026-11-01T00:00:00+00:00", symbol: "AAPL", payload: { title: "x" } }];
const candidate = { cutoff: cutoff.replace("Z", "+00:00"), row_count: 1, min_id: 12, max_id: 12, ordered_row_digest: digest, rows };

afterEach(() => {
  if (savedUrl === undefined) delete process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_URL;
  else process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_URL = savedUrl;
  if (savedToken === undefined) delete process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_TOKEN;
  else process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_TOKEN = savedToken;
  vi.unstubAllGlobals();
});

function service(candidateData: unknown = candidate) {
  const calls: Array<{ name: string; args: unknown }> = [];
  return {
    calls,
    rpc: vi.fn(async (name: string, args: unknown) => {
      calls.push({ name, args });
      if (name.startsWith("get_")) return { data: candidateData, error: null };
      return { data: { deleted_rows: candidate.row_count }, error: null };
    }),
  } as unknown as SupabaseClient & { calls: typeof calls; rpc: ReturnType<typeof vi.fn> };
}

function configure() {
  process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_URL = "https://archive.test";
  process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_TOKEN = token;
}

describe("scheduled India news cold archive", () => {
  it("does nothing when there is no expired cohort", async () => {
    configure();
    const svc = service({ cutoff, row_count: 0, min_id: null, max_id: null, ordered_row_digest: null, rows: [] });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await archiveExpiredIndiaNewsSnapshots(svc, now)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(svc.rpc).toHaveBeenCalledTimes(1);
  });

  it("uploads and downloads the exact object and manifest before pruning", async () => {
    configure();
    const svc = service();
    let uploaded = new Uint8Array();
    const manifest = { rowCount: 1, minId: 12, maxId: 12, cutoff, sourceDigest: digest,
      archiveSha256: "pending", archiveBytes: 1 };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        uploaded = new Uint8Array(init.body as ArrayBuffer);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes(`/v1/archive/india-news-snapshots/${digest}/`) && !url.endsWith("/manifest")) return new Response(uploaded, { status: 200 });
      if (url.includes(`/v1/archive/india-news-snapshots/${digest}/`) && url.endsWith("/manifest")) {
        const { createHash } = await import("node:crypto");
        manifest.archiveSha256 = createHash("sha256").update(uploaded).digest("hex");
        manifest.archiveBytes = uploaded.byteLength;
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await archiveExpiredIndiaNewsSnapshots(svc, now)).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(svc.rpc).toHaveBeenCalledTimes(2);
    expect(svc.calls[1].name).toBe("prune_archived_india_news_snapshots");
    expect(svc.calls[1].args).toMatchObject({ p_cutoff: cutoff, p_expected_rows: 1, p_expected_min_id: 12, p_expected_max_id: 12, p_expected_digest: digest });
  });

  it("retains source rows when the downloaded object does not match the upload", async () => {
    configure();
    const svc = service();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return new Response("{}", { status: 200 });
      return new Response("different archive", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(archiveExpiredIndiaNewsSnapshots(svc, now)).rejects.toBeInstanceOf(IndiaNewsSnapshotArchiveError);
    expect(svc.rpc).toHaveBeenCalledTimes(1);
    expect(svc.calls[0].name).toBe("get_india_news_snapshots_archive_candidate");
  });

  it("retains source rows when the R2 upload fails", async () => {
    configure();
    const svc = service();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 507 })));
    await expect(archiveExpiredIndiaNewsSnapshots(svc, now)).rejects.toThrow("Private archive upload failed (507)");
    expect(svc.rpc).toHaveBeenCalledTimes(1);
  });

  it("rejects unordered or oversized candidates before any upload", async () => {
    configure();
    const svc = service({ ...candidate, rows: [{ ...rows[0], id: 13 }, { ...rows[0], id: 12 }], row_count: 2, min_id: 12, max_id: 13 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(archiveExpiredIndiaNewsSnapshots(svc, now)).rejects.toBeInstanceOf(IndiaNewsSnapshotArchiveError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
