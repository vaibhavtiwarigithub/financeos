import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { mirrorSymbolDailyReturns, readSymbolDailyReturnsArchive, readSymbolDailyReturnsOr, SymbolReturnsArchiveError } from "./symbol-daily-returns-archive";

const savedUrl = process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_URL;
const savedToken = process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_TOKEN;
const sample = { id: 1, symbol: "AAPL", market: "us" };

afterEach(() => {
  if (savedUrl === undefined) delete process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_URL;
  else process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_URL = savedUrl;
  if (savedToken === undefined) delete process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_TOKEN;
  else process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_TOKEN = savedToken;
});

function configure() {
  process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_URL = "https://archive.example";
  process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_TOKEN = "a-long-test-token-with-at-least-32-characters";
}

describe("readSymbolDailyReturnsArchive", () => {
  it("fetches bounded pages with server-only authorization and preserves query filters", async () => {
    configure();
    const urls: URL[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      urls.push(url);
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_TOKEN}`);
      const offset = Number(url.searchParams.get("offset"));
      return Response.json(offset === 0
        ? { rows: Array.from({ length: 5_000 }, (_, index) => ({ ...sample, id: index + 1 })), offset: 0, limit: 5_000, hasMore: true }
        : { rows: [{ ...sample, id: 5_001 }], offset: 5_000, limit: 1, hasMore: false });
    }) as typeof fetch;
    const result = await readSymbolDailyReturnsArchive<{ id: number; symbol: string; market: string }>({ market: "us", since: "2026-01-01", until: "2026-02-01",
      symbols: ["AAPL", "MSFT"], availableAtOrBefore: "2026-01-31T23:59:59.123456Z", sort: "available_at_asc" },
    { maxRows: 5_001, fetchImpl });
    expect(result).toHaveLength(5_001);
    expect(result.at(-1)?.id).toBe(5_001);
    expect(urls).toHaveLength(2);
    expect(urls[0].searchParams.getAll("symbol")).toEqual(["AAPL", "MSFT"]);
    expect(urls[0].searchParams.get("availableAtOrBefore")).toBe("2026-01-31T23:59:59.123456Z");
    expect(urls[1].searchParams.get("offset")).toBe("5000");
  });

  it("fails closed for missing configuration, server errors, and malformed pages", async () => {
    delete process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_URL;
    await expect(readSymbolDailyReturnsArchive({ market: "us", since: "2026-01-01", until: "2026-01-02" }))
      .rejects.toBeInstanceOf(SymbolReturnsArchiveError);
    configure();
    await expect(readSymbolDailyReturnsArchive({ market: "us", since: "2026-01-01", until: "2026-01-02" },
      { fetchImpl: vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch }))
      .rejects.toMatchObject({ status: 503 });
    await expect(readSymbolDailyReturnsArchive({ market: "us", since: "2026-01-01", until: "2026-01-02" },
      { fetchImpl: vi.fn(async () => Response.json({ rows: "not-an-array" })) as typeof fetch }))
      .rejects.toThrow("page contract mismatch");
  });

  it("does not silently truncate over-budget datasets or allow a larger override", async () => {
    configure();
    const fetchImpl = vi.fn(async () => Response.json({ rows: [sample], offset: 0, limit: 1, hasMore: true })) as typeof fetch;
    await expect(readSymbolDailyReturnsArchive({ market: "us", since: "2026-01-01", until: "2026-01-02" },
      { maxRows: 1, fetchImpl })).rejects.toThrow("exceeds the application row budget");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(readSymbolDailyReturnsArchive({ market: "us", since: "2026-01-01", until: "2026-01-02" },
      { maxRows: 100_001, fetchImpl })).rejects.toThrow("exceeds the application row budget");
  });

  it("supports only the caller's explicit bounded market-wide limit", async () => {
    configure();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("marketWide")).toBe("true");
      expect(url.searchParams.getAll("symbol")).toEqual([]);
      return Response.json({ rows: [sample], offset: 0, limit: 1, hasMore: true });
    }) as typeof fetch;
    await expect(readSymbolDailyReturnsArchive({ market: "us", since: "2026-01-01", until: "2026-01-02",
      marketWide: true, resultLimit: 1, sort: "available_at_desc" }, { maxRows: 1, fetchImpl }))
      .resolves.toEqual([sample]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe("readSymbolDailyReturnsOr", () => {
  it("keeps Supabase authoritative until the explicit read switch is enabled", async () => {
    delete process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_READS;
    const supabaseRead = vi.fn(async () => [sample]);
    await expect(readSymbolDailyReturnsOr({ market: "us", since: "2026-01-01", until: "2026-01-02" }, supabaseRead))
      .resolves.toEqual([sample]);
    expect(supabaseRead).toHaveBeenCalledOnce();
  });

  it("fails closed without a Supabase fallback after the explicit read switch is enabled", async () => {
    configure();
    process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_READS = "true";
    const supabaseRead = vi.fn(async () => [sample]);
    await expect(readSymbolDailyReturnsOr({ market: "us", since: "2026-01-01", until: "2026-01-02" }, supabaseRead,
      { fetchImpl: vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch }))
      .rejects.toMatchObject({ status: 503 });
    expect(supabaseRead).not.toHaveBeenCalled();
  });
});

describe("mirrorSymbolDailyReturns", () => {
  it("is inert when no runtime archive endpoint is configured", async () => {
    delete process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_URL;
    const fetchImpl = vi.fn() as typeof fetch;
    await expect(mirrorSymbolDailyReturns([{ id: 1 }], { fetchImpl }))
      .resolves.toEqual({ configured: false, accepted: 0, inserted: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends append-only mirror rows in bounded, acknowledged batches", async () => {
    configure();
    const bodies: Array<{ rows: unknown[] }> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { rows: unknown[] };
      bodies.push(body);
      return Response.json({ accepted: body.rows.length, inserted: body.rows.length });
    }) as typeof fetch;
    const rows = Array.from({ length: 55 }, (_, id) => ({ id: id + 1 }));
    await expect(mirrorSymbolDailyReturns(rows, { fetchImpl })).resolves.toEqual({ configured: true, accepted: 55, inserted: 55 });
    expect(bodies.map(batch => batch.rows.length)).toEqual([10, 10, 10, 10, 10, 5]);
  });

  it("rejects an unacknowledged write instead of marking the mirror complete", async () => {
    configure();
    await expect(mirrorSymbolDailyReturns([{ id: 1 }], {
      fetchImpl: vi.fn(async () => Response.json({ accepted: 0, inserted: 0 })) as typeof fetch,
    })).rejects.toThrow("acknowledgement is inconsistent");
  });
});
