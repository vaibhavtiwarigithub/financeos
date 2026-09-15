import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isViewerApiRoute, isViewerPage } from "@/lib/auth/roles";

const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const read = (p: string) => code(readFileSync(p, "utf8"));

// 2026-09-15: viewers get Earnings Calendar, Research → Daily Funnel and Score
// Tracker, and the Deep Dive page stops 403ing ("Failed to load CORDSCABLE.NS:
// Forbidden"). Markets stays owner-only. Nothing a viewer reaches may call a
// provider or the LLM, write, or expose the owner's live broker book.

describe("the viewer allowlist admits exactly the approved surface", () => {
  it("pages", () => {
    for (const p of ["/dashboard/research-journal", "/dashboard/calendar", "/dashboard/research/CORDSCABLE.NS"]) {
      expect(isViewerPage(p), p).toBe(true);
    }
    for (const p of ["/dashboard/markets", "/dashboard/risk", "/dashboard/live-portfolio", "/dashboard/scanner"]) {
      expect(isViewerPage(p), p).toBe(false);
    }
  });

  it("routes a viewer page needs", () => {
    for (const p of [
      "/api/agents/research-journal", "/api/charts/score-history", "/api/scores/point-detail",
      "/api/research/price", "/api/research/scores", "/api/research/trades",
      "/api/research/fundamentals/cached", "/api/calendar/earnings/cached",
    ]) {
      expect(isViewerApiRoute(p, "GET"), p).toBe(true);
    }
  });

  it("never the provider, LLM, live-book or learning routes beside them", () => {
    for (const p of [
      "/api/agents/research-journal/context",   // Alpha Vantage per click
      "/api/agents/research-journal/evolution", // learning internals
      "/api/research/fundamentals",             // Finnhub / FMP / Alpha Vantage
      "/api/calendar/earnings",                 // Alpha Vantage refresh
      "/api/calendar/earnings-india",           // NSE / Yahoo live
      "/api/live-portfolio", "/api/watchlist", "/api/strategies/versions",
      "/api/markets/overview", "/api/markets/quotes", "/api/agent-mind/macro-read",
      "/api/options/chain", "/api/charts/symbol-peers", "/api/markets/quote",
    ]) {
      expect(isViewerApiRoute(p, "GET"), p).toBe(false);
    }
    expect(isViewerApiRoute("/api/research/trades", "POST")).toBe(false);
  });
});

describe("role-aware routes never give a viewer the owner's live book", () => {
  it("Daily Funnel skips the live snapshot and live fills for a viewer", () => {
    const src = read("app/api/agents/research-journal/route.ts");
    expect(src.includes("requireViewerOrOwner(req)")).toBe(true);
    expect(src.includes('const includeLive = role === "owner"')).toBe(true);
    expect(src.includes("if (activeAccount && includeLive) {")).toBe(true);
    const liveRead = src.indexOf('from("live_account_snapshots")');
    const guard = src.indexOf("if (activeAccount && includeLive) {");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(liveRead);
  });

  it("Deep Dive trades read live proposals and orders only for the owner", () => {
    const src = read("app/api/research/trades/route.ts");
    expect(/includeLive\s*\?\s*supabase\.from\("trade_proposals"\)/.test(src)).toBe(true);
    expect(/includeLive\s*\?\s*supabase\.from\("broker_orders"\)/.test(src)).toBe(true);
  });

  it("Deep Dive price serves a viewer stored candles before any provider backfill", () => {
    const src = read("app/api/research/price/route.ts");
    const viewerBranch = src.indexOf('if (role !== "owner")');
    expect(viewerBranch).toBeGreaterThan(-1);
    expect(viewerBranch).toBeLessThan(src.indexOf("fetchPriceHistory(symbol"));
    expect(src.slice(viewerBranch, src.indexOf("fetchPriceHistory(symbol")).includes('from("price_cache")')).toBe(true);
  });
});

describe("viewer pages do not fire owner-only or provider requests", () => {
  it("Research page shows viewers only the Daily Funnel and Score Tracker tabs", () => {
    const src = read("app/dashboard/research-journal/page.tsx");
    expect(src.includes('const VIEWER_TABS: readonly JournalTab[] = ["funnel", "scores"]')).toBe(true);
    expect(src.includes('const tabs = role === "owner" ? ALL_TABS : VIEWER_TABS')).toBe(true);
    expect(src.includes("visibleTab === \"funnel\"")).toBe(true);
  });

  it("Daily Funnel offers the provider-backed news button to the owner only", () => {
    const src = read("components/dashboard/ResearchFunnel.tsx");
    expect(src.includes('{role === "owner" && <button type="button" onClick={() => loadCurrentContext(s.symbol)}')).toBe(true);
  });

  it("Score Tracker skips watchlist, live portfolio and strategy versions for a viewer", () => {
    const src = read("components/dashboard/ScoreTrackerPanel.tsx");
    expect(/isOwner\s*\?\s*fetch\(`\/api\/watchlist/.test(src)).toBe(true);
    expect(/isOwner && market === "us"\s*\?\s*fetch\("\/api\/live-portfolio"\)/.test(src)).toBe(true);
    expect(src.includes("if (isOwner) fetch(`/api/strategies/versions")).toBe(true);
  });

  it("Deep Dive asks a viewer's fundamentals from the stored route", () => {
    const src = read("app/dashboard/research/[symbol]/page.tsx");
    expect(src.includes("/api/research/fundamentals/cached?symbol=")).toBe(true);
    expect(src.includes('role === "owner"')).toBe(true);
  });

  it("Calendar uses the stored US route for a viewer and never the live routes", () => {
    const src = read("components/dashboard/CalendarPage.tsx");
    expect(src.includes('isIndia ? null : "/api/calendar/earnings/cached"')).toBe(true);
    expect(src.includes('if (role !== "owner" || !earningsEndpoint) return;')).toBe(true);
  });

  it("the provider-heavy symbol page sends a viewer to Deep Dive and mounts nothing first", () => {
    const src = read("components/dashboard/SymbolDetailPage.tsx");
    expect(src.includes('if (role === "viewer") router.replace(`/dashboard/research/')).toBe(true);
    expect(src.includes('if (role !== "owner") {')).toBe(true);
  });
});
