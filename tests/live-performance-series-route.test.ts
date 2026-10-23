import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const h = vi.hoisted(() => ({
  owner: true, viewer: true, reads: [] as string[], writes: [] as any[],
  rows: [] as any[], failTable: "", benchmarkId: "voo",
}));
vi.mock("@/lib/auth/require-owner", () => ({ requireOwner: async () =>
  h.owner ? null : NextResponse.json({ error: "owner_required" }, { status: 403 }) }));
vi.mock("@/lib/auth/session-role", () => ({ requireViewerOrOwner: async () => ({
  gate: h.owner || h.viewer ? null : NextResponse.json({ error: "unauthorized" }, { status: 401 }),
}) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({
  from(table: string) {
    h.reads.push(table);
    const values: Record<string, unknown> = {};
    const data = () => table === "benchmarks" ? [
      { id: "voo", label: "VOO", provider_symbol: "VOO", symbol: "VOO", is_primary: true },
      { id: "qqq", label: "QQQ", provider_symbol: "QQQ", symbol: "QQQ", is_primary: false },
    ].filter(b => !values.id || b.id === values.id)
      : table === "live_performance" ? h.rows
      : table === "benchmark_price_observations" ? [
        { date: "2026-10-19", close: values.benchmark_id === "qqq" ? 300 : 200 },
        { date: "2026-10-20", close: 202 }, { date: "2026-10-21", close: 204 },
      ] : [];
    const error = () => table === h.failTable ? { message: "test database failure" } : null;
    const chain: any = {
      select: () => chain, eq: (key: string, value: unknown) => { values[key] = value; return chain; },
      or: () => chain, order: () => chain,
      maybeSingle: async () => ({ data: table === "app_settings" ? { value: h.benchmarkId } : data()[0] ?? null, error: error() }),
      range: async (from: number, to: number) => ({ data: data().slice(from, to + 1), error: error() }),
      upsert: async (payload: any) => { h.writes.push(payload); return { error: error() }; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: data(), error: error() }).then(resolve),
    };
    return chain;
  },
}) }));

import { GET, PATCH } from "@/app/api/portfolio/performance-series/route";
import { GET as compatibility } from "@/app/api/live-portfolio/performance/route";

const req = (params = "market=us&book=live") => new NextRequest(`https://test.invalid/api/portfolio/performance-series?${params}`);
beforeEach(() => {
  h.owner = true; h.viewer = true; h.reads = []; h.writes = []; h.failTable = ""; h.benchmarkId = "voo";
  h.rows = [
    { account_id: "a", date: "2026-10-19", equity: 100, market: "us", currency: "USD" },
    { account_id: "a", date: "2026-10-21", equity: 105, market: "us", currency: "USD" },
  ];
});

describe("live performance canonical API", () => {
  it("offers the configured benchmark choices, exact marks and an explicit unadjusted-equity contract", async () => {
    const response = await GET(req());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ book: "live", metric_kind: "unadjusted_account_equity_change", cash_flow_adjusted: false });
    expect(body.benchmarks).toHaveLength(2);
    expect(body.series).toEqual([
      { date: "2026-10-19", nav: 100, bench_nav: 200 },
      { date: "2026-10-20", nav: null, bench_nav: 202 },
      { date: "2026-10-21", nav: 105, bench_nav: 204 },
    ]);
    expect(h.reads).not.toContain("paper_performance");
    expect(h.reads).not.toContain("live_account_snapshots");
  });

  it("changes the comparator, not the equity base or account set", async () => {
    const a = await (await GET(req())).json();
    const b = await (await GET(req("market=us&book=live&benchmarkId=qqq"))).json();
    expect(a.series.map((r: any) => r.nav)).toEqual(b.series.map((r: any) => r.nav));
    expect(b.selected_benchmark.id).toBe("qqq");
    expect(b.series[0].bench_nav).toBe(300);
  });

  it("does not fall back to paper when India has no live history", async () => {
    h.rows = [];
    const body = await (await GET(req("market=india&book=live"))).json();
    expect(body.series).toEqual([]);
    expect(h.reads).not.toContain("paper_performance");
  });

  it("does not fall back to all accounts when every account chip is deselected", async () => {
    expect((await (await GET(req("market=us&book=live&accounts="))).json()).series).toEqual([]);
  });

  it("fails visibly on a failed live history query, rather than estimating a replacement", async () => {
    h.failTable = "live_performance";
    expect((await GET(req())).status).toBe(500);
    expect(h.reads).not.toContain("paper_performance");
  });

  it("denies viewers before any service read for both entry points", async () => {
    h.owner = false;
    expect((await GET(req())).status).toBe(403);
    expect((await compatibility(req("market=us&book=paper"))).status).toBe(403);
    expect(h.reads).toEqual([]);
  });

  it("preserves the viewer-safe paper path and its EOD source", async () => {
    h.owner = false;
    expect((await GET(req("market=us&book=paper"))).status).toBe(200);
    expect(h.reads).toContain("paper_performance");
    expect(h.reads).not.toContain("live_performance");
  });

  it.each(["market=crypto&book=live", "market=us&book=unknown"])("rejects unsupported scope %s", async params => {
    expect((await GET(req(params))).status).toBe(400);
    expect(h.reads).toEqual([]);
  });

  it("keeps saved live display selection separate from paper and the governed primary", async () => {
    const response = await PATCH(new NextRequest("https://test.invalid/api/portfolio/performance-series", {
      method: "PATCH", body: JSON.stringify({ market: "us", book: "live", benchmarkId: "qqq" }),
      headers: { "Content-Type": "application/json" },
    }));
    expect(response.status).toBe(200);
    expect(h.writes).toEqual([expect.objectContaining({ key: "live_portfolio_default_benchmark_us", value: "qqq" })]);
    expect(h.writes[0]).not.toHaveProperty("is_primary");
  });
});
