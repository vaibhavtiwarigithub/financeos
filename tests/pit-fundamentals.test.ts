import { describe, it, expect } from "vitest";
import {
  captureFundamentalsFact,
  getFundamentalsAsOf,
  selectAsOf,
  computeRestatement,
  hashValues,
  type FactRow,
  type PitDbClient,
  type Overview,
} from "@/lib/data/pit-fundamentals";

// ── In-memory fake of the narrow supabase surface pit-fundamentals uses ──────
// Supports .from(t).select().eq().eq() → {data}, .insert(), .update().eq().
// `failMode` lets a test force reads/writes to throw or error, to prove fail-open.
function makeFakeDb(seed: FactRow[] = [], failMode?: "select" | "insert" | "throw") {
  const rows: FactRow[] = seed.map((r, i) => ({ id: r.id ?? `seed-${i}`, ...r }));
  let idc = 0;
  const db: PitDbClient = {
    from() {
      return {
        select() {
          return {
            eq(_c1: string, v1: unknown) {
              return {
                async eq(_c2: string, v2: unknown) {
                  if (failMode === "throw") throw new Error("boom");
                  if (failMode === "select") return { data: null, error: "read failed" };
                  const data = rows.filter((r) => r.symbol === v1 && r.market === v2);
                  return { data: data.map((r) => ({ ...r })), error: undefined };
                },
              };
            },
          };
        },
        async insert(row: Record<string, unknown>) {
          if (failMode === "throw") throw new Error("boom");
          if (failMode === "insert") return { error: "write failed" };
          rows.push({
            symbol: String(row.symbol ?? ""),
            market: String(row.market ?? ""),
            metric_set: String(row.metric_set ?? ""),
            report_period: (row.report_period ?? null) as string | null,
            fiscal_period: (row.fiscal_period ?? null) as string | null,
            filing_date: (row.filing_date ?? null) as string | null,
            values: (row.values ?? {}) as Overview,
            source: (row.source ?? null) as string | null,
            restatement_seq: Number(row.restatement_seq ?? 0),
            is_latest: Boolean(row.is_latest ?? true),
            payload_hash: String(row.payload_hash ?? ""),
            captured_at: String(row.captured_at ?? ""),
            id: `ins-${idc++}`,
          });
          return { error: undefined };
        },
        update(patch: Record<string, unknown>) {
          return {
            async eq(col: string, val: unknown) {
              const t = rows.find((r) => (r as any)[col] === val);
              if (t) Object.assign(t, patch);
              return { error: undefined };
            },
          };
        },
      };
    },
  };
  return { db, rows };
}

const OV = (over: Partial<Overview>): Overview => ({ Symbol: "AAPL", ...over });

describe("pit-fundamentals — as-of read returns as-known values", () => {
  it("returns the vintage known on the as-of date, not a future one", async () => {
    const seed: FactRow[] = [
      {
        id: "q1", symbol: "AAPL", market: "us", metric_set: "ttm_overview",
        report_period: "2026-03-31", fiscal_period: "Q1", filing_date: "2026-04-30",
        values: OV({ PERatio: "25" }), source: "fmp",
        restatement_seq: 0, is_latest: true, payload_hash: "a", captured_at: "2026-04-30T00:00:00Z",
      },
    ];
    const { db } = makeFakeDb(seed);
    // Before the filing date → nothing was known.
    const before = await getFundamentalsAsOf(db, "AAPL", "us", new Date("2026-04-01"));
    expect(before.overview).toEqual({});
    expect(before.vintage).toBeNull();
    // After the filing date → the as-known values.
    const after = await getFundamentalsAsOf(db, "AAPL", "us", new Date("2026-05-15"));
    expect(after.overview.PERatio).toBe("25");
    expect(after.vintage?.fact_id).toBe("q1");
    expect(after.source).toBe("fmp");
  });

  it("falls back to captured_at when filing_date is absent (TTM overview)", () => {
    const rows: FactRow[] = [
      {
        id: "t1", symbol: "X", market: "us", metric_set: "ttm_overview",
        report_period: null, fiscal_period: null, filing_date: null,
        values: OV({ PERatio: "10" }), source: "fmp",
        restatement_seq: 0, is_latest: true, payload_hash: "t1", captured_at: "2026-01-10T00:00:00Z",
      },
    ];
    expect(selectAsOf(rows, new Date("2026-01-05"))?.values).toBeUndefined();
    expect(selectAsOf(rows, new Date("2026-01-05"))).toBeNull();
    expect(selectAsOf(rows, new Date("2026-01-20"))?.values.PERatio).toBe("10");
  });
});

describe("pit-fundamentals — restatement does not retroactively change a past as-of read", () => {
  const original: FactRow = {
    id: "orig", symbol: "AAPL", market: "us", metric_set: "ttm_overview",
    report_period: "2026-03-31", fiscal_period: "Q1", filing_date: "2026-04-30",
    values: OV({ PERatio: "25" }), source: "fmp",
    restatement_seq: 0, is_latest: true, payload_hash: "orig", captured_at: "2026-04-30T00:00:00Z",
  };
  const restated: FactRow = {
    id: "restate", symbol: "AAPL", market: "us", metric_set: "ttm_overview",
    report_period: "2026-03-31", fiscal_period: "Q1", filing_date: "2026-08-01",
    values: OV({ PERatio: "40" }), source: "fmp",
    restatement_seq: 1, is_latest: true, payload_hash: "restate", captured_at: "2026-08-01T00:00:00Z",
  };

  it("a past as-of read is unchanged after a later restatement is appended", async () => {
    const { db, rows } = makeFakeDb([original]);
    const pastBefore = await getFundamentalsAsOf(db, "AAPL", "us", new Date("2026-06-01"));
    expect(pastBefore.overview.PERatio).toBe("25");

    // Later restatement lands.
    rows.push({ ...restated });

    // The SAME past as-of read still sees the originally-known value.
    const pastAfter = await getFundamentalsAsOf(db, "AAPL", "us", new Date("2026-06-01"));
    expect(pastAfter.overview.PERatio).toBe("25");
    expect(pastAfter.vintage?.restatement_seq).toBe(0);

    // A read after the restatement's filing date sees the new value.
    const now = await getFundamentalsAsOf(db, "AAPL", "us", new Date("2026-09-01"));
    expect(now.overview.PERatio).toBe("40");
    expect(now.vintage?.restatement_seq).toBe(1);
  });

  it("computeRestatement appends a new vintage and flags the prior latest", () => {
    const d = computeRestatement([original], {
      symbol: "AAPL", market: "us", values: OV({ PERatio: "40" }), source: "fmp",
      metricSet: "ttm_overview", reportPeriod: "2026-03-31", fiscalPeriod: "Q1",
      filingDate: "2026-08-01", now: new Date("2026-08-01T00:00:00Z"),
    });
    expect(d.skip).toBe(false);
    expect(d.flipId).toBe("orig");
    expect(d.row?.restatement_seq).toBe(1);
    expect(d.row?.is_latest).toBe(true);
  });

  it("computeRestatement dedups an identical re-fetch (skip)", () => {
    const hash = hashValues("AAPL", "us", "ttm_overview", "2026-03-31", "fmp", OV({ PERatio: "25" }));
    const existing: FactRow = { ...original, payload_hash: hash };
    const d = computeRestatement([existing], {
      symbol: "AAPL", market: "us", values: OV({ PERatio: "25" }), source: "fmp",
      metricSet: "ttm_overview", reportPeriod: "2026-03-31", fiscalPeriod: "Q1",
      filingDate: "2026-04-30", now: new Date("2026-05-01T00:00:00Z"),
    });
    expect(d.skip).toBe(true);
    expect(d.row).toBeNull();
  });
});

describe("pit-fundamentals — capture-on-fetch is fail-open (never breaks scoring)", () => {
  it("append then flip is persisted on the happy path", async () => {
    const { db, rows } = makeFakeDb();
    const v1 = await captureFundamentalsFact(db, {
      symbol: "AAPL", market: "us", values: OV({ PERatio: "25" }), source: "fmp",
      now: new Date("2026-04-30T00:00:00Z"),
    });
    expect(v1?.restatement_seq).toBe(0);
    // Changed value → new vintage seq 1, prior flipped to is_latest=false.
    const v2 = await captureFundamentalsFact(db, {
      symbol: "AAPL", market: "us", values: OV({ PERatio: "40" }), source: "fmp",
      now: new Date("2026-08-01T00:00:00Z"),
    });
    expect(v2?.restatement_seq).toBe(1);
    expect(rows.length).toBe(2);
    expect(rows.filter((r) => r.is_latest).length).toBe(1);
  });

  it("identical re-fetch is deduped (no second row)", async () => {
    const { db, rows } = makeFakeDb();
    const payload = OV({ PERatio: "25" });
    await captureFundamentalsFact(db, { symbol: "AAPL", market: "us", values: payload, source: "fmp", now: new Date("2026-04-30T00:00:00Z") });
    await captureFundamentalsFact(db, { symbol: "AAPL", market: "us", values: { ...payload }, source: "fmp", now: new Date("2026-05-02T00:00:00Z") });
    expect(rows.length).toBe(1);
  });

  it("a write error resolves to null instead of throwing", async () => {
    const { db } = makeFakeDb([], "insert");
    await expect(
      captureFundamentalsFact(db, { symbol: "AAPL", market: "us", values: OV({ PERatio: "25" }), source: "fmp" }),
    ).resolves.toBeNull();
  });

  it("a client that throws is swallowed (capture never propagates)", async () => {
    const { db } = makeFakeDb([], "throw");
    await expect(
      captureFundamentalsFact(db, { symbol: "AAPL", market: "us", values: OV({ PERatio: "25" }), source: "fmp" }),
    ).resolves.toBeNull();
    // And the read path is equally fail-open.
    await expect(getFundamentalsAsOf(db, "AAPL", "us", new Date())).resolves.toEqual({ overview: {}, vintage: null, source: null });
  });

  it("empty / non-Symbol payloads are ignored (nothing meaningful to archive)", async () => {
    const { db, rows } = makeFakeDb();
    await captureFundamentalsFact(db, { symbol: "AAPL", market: "us", values: {}, source: "fmp" });
    expect(rows.length).toBe(0);
  });
});
