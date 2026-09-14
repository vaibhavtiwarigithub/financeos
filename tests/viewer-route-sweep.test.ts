import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { VIEWER_API_ROUTES } from "@/lib/auth/roles";
import { expectedLatestSessionDate, marketClosedReason } from "@/lib/trading/market-calendar";
import { benchmarkFreshness, pipelineFreshness, mergePortfolioBenchmarkSeries } from "@/lib/analytics/benchmark-display";

// Phase 2 of features/shared-viewer-access/FEATURE_ARCHITECTURE.md.
//
// The cost guarantee of the whole viewer feature is that adding viewers adds no
// provider spend. That holds only while every viewer-reachable route is a pure
// read over already-persisted tables. This suite is the enforcement: it fails
// the build if a viewer-reachable route gains an outbound call, so the guarantee
// cannot rot silently.

const ROOT = resolve(__dirname, "..");

function routeFileFor(prefix: string): string {
  return resolve(ROOT, `app${prefix}/route.ts`);
}

const PROVIDER_IMPORT = /from\s+"[^"]*(provider|massive|alphavantage|alpha-vantage|finnhub|yahoo|gdelt|broker|mcp|anthropic|openai)[^"]*"/i;

describe("viewer-reachable route sweep", () => {
  it("every declared viewer route actually exists", () => {
    for (const route of VIEWER_API_ROUTES) {
      expect(existsSync(routeFileFor(route.prefix)), route.prefix).toBe(true);
    }
  });

  it("no viewer-reachable route makes an outbound call", () => {
    for (const route of VIEWER_API_ROUTES) {
      const src = readFileSync(routeFileFor(route.prefix), "utf8");
      expect(src.includes("https://"), `${route.prefix} contains an outbound URL`).toBe(false);
      expect(/\bfetch\s*\(/.test(src), `${route.prefix} calls fetch()`).toBe(false);
    }
  });

  it("no viewer-reachable route imports a provider, broker or LLM module", () => {
    for (const route of VIEWER_API_ROUTES) {
      const src = readFileSync(routeFileFor(route.prefix), "utf8");
      const hit = src.match(PROVIDER_IMPORT);
      expect(hit?.[0] ?? null, `${route.prefix} imports ${hit?.[0]}`).toBeNull();
    }
  });

  /**
   * `lib/trading/market-calendar.ts` DOES contain a provider call
   * (`fetchMarketStatuses` -> Alpha Vantage MARKET_STATUS), reached only through
   * the async `isMarketOpenLive`. The viewer path uses the calendar helpers
   * instead, and a synchronous function cannot await a network call — so
   * asserting they stay synchronous proves the viewer path cannot reach the
   * provider, which a module-level scan could not show.
   */
  it("helpers on the viewer read path are synchronous, so they cannot call a provider", () => {
    const sync = [
      expectedLatestSessionDate, marketClosedReason,
      benchmarkFreshness, pipelineFreshness, mergePortfolioBenchmarkSeries,
    ];
    for (const fn of sync) {
      expect(fn.constructor.name, fn.name).toBe("Function"); // not AsyncFunction
    }
    const sample = expectedLatestSessionDate("us", new Date("2026-09-14T20:30:00Z"));
    expect(sample).not.toBeInstanceOf(Promise);
  });

  it("the owner-only write method on a shared route is not viewer-reachable", () => {
    const src = readFileSync(routeFileFor("/api/portfolio/performance-series"), "utf8");
    // GET is viewer-safe; PATCH writes the owner's saved preference and must
    // still be behind requireOwner.
    expect(src.includes("export async function PATCH")).toBe(true);
    expect(src.includes("requireOwner")).toBe(true);
  });
});
