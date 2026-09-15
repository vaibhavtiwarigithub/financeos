import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
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

/**
 * Every route file reachable under a viewer prefix, not just the one AT it.
 *
 * `matchesPrefix` in lib/auth/roles.ts admits subpaths, so `/api/user-risk`
 * also admits `/api/user-risk/prefs`. Sweeping only the prefix file left those
 * subpath routes viewer-reachable but unchecked — a route added there could
 * have called a provider and no test would have noticed.
 */
function routeFilesUnder(prefix: string): string[] {
  const dir = resolve(ROOT, `app${prefix}`);
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = resolve(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name === "route.ts") files.push(full);
    }
  };
  visit(dir);
  return files;
}

/** An exact route admits only its own file; its children are not viewer-reachable. */
function viewerFilesFor(route: { prefix: string; exact?: boolean }): string[] {
  return route.exact ? [routeFileFor(route.prefix)] : routeFilesUnder(route.prefix);
}

const PROVIDER_IMPORT =/from\s+"[^"]*(provider|massive|alphavantage|alpha-vantage|finnhub|yahoo|gdelt|broker|mcp|anthropic|openai)[^"]*"/i;

describe("viewer-reachable route sweep", () => {
  it("every declared viewer route actually exists", () => {
    for (const route of VIEWER_API_ROUTES) {
      expect(existsSync(routeFileFor(route.prefix)), route.prefix).toBe(true);
    }
  });

  it("no viewer-reachable route makes an outbound call", () => {
    for (const route of VIEWER_API_ROUTES) {
      for (const file of viewerFilesFor(route)) {
        const src = readFileSync(file, "utf8");
        expect(src.includes("https://"), `${file} contains an outbound URL`).toBe(false);
        expect(/\bfetch\s*\(/.test(src), `${file} calls fetch()`).toBe(false);
      }
    }
  });

  it("actually sweeps the subpath routes, not just the prefix files", () => {
    // Guards the guard: if routeFilesUnder silently returned nothing, the test
    // above would pass vacuously.
    expect(routeFilesUnder("/api/user-risk").length).toBeGreaterThan(1);
  });

  it("no viewer-reachable route imports a provider, broker or LLM module", () => {
    for (const route of VIEWER_API_ROUTES) {
      for (const file of viewerFilesFor(route)) {
        const src = readFileSync(file, "utf8");
        const hit = src.match(PROVIDER_IMPORT);
        expect(hit?.[0] ?? null, `${file} imports ${hit?.[0]}`).toBeNull();
      }
    }
  });

  it("every shared-read route re-checks a server-side role in the handler", () => {
    // Middleware is defense in depth, not the only security boundary. A route
    // remains safe if it is invoked outside the normal browser navigation path.
    for (const route of VIEWER_API_ROUTES) {
      const file = routeFileFor(route.prefix);
      const src = readFileSync(file, "utf8");
      expect(
        src.includes("requireViewerOrOwner") || src.includes("getSessionRole"),
        `${file} lacks its handler authorization gate`,
      ).toBe(true);
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
