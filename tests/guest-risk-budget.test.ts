import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeGuestRisk, toBrokerHoldings, yahooSymbolFor } from "@/lib/risk/guest-risk";
import { VIEWER_PAGES, isViewerPage } from "@/lib/auth/roles";
import type { Candle } from "@/lib/data/technicals";

const ROOT = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const GUEST_RISK = code(read("lib/risk/guest-risk.ts"));
const JOB = code(read("app/api/agents/user-holding-risk/route.ts"));

// features/per-user-broker-risk/FEATURE_ARCHITECTURE.md §6:
// "a guest-triggered path may call a broker, and may read cache, but may never
// call an LLM or a metered market-data provider outside the shared cache."
//
// Tracing the candle path made the rule concrete. `fetchYahooCandles` is Yahoo's
// keyless chart endpoint — no API key, no quota. `fetchUsCandles` starts there
// but FALLS BACK through Massive, EODHD, TwelveData and Alpha Vantage, several
// of which are already over budget. Reusing the owner's fetcher would therefore
// have let one guest holding an obscure ticker walk the entire paid chain.
//
// These tests hold that line where it can actually be held: at the imports.

describe("the guest risk path cannot spend provider budget", () => {
  it("imports no metered market-data fetcher", () => {
    for (const metered of ["fetchUsCandles", "fetchMassiveCandles", "fetchEodhdCandles",
                           "fetchTwelveDataCandles", "av-cache", "alpha", "upstox"]) {
      expect(GUEST_RISK.toLowerCase().includes(metered.toLowerCase()),
        `guest risk references ${metered}`).toBe(false);
    }
  });

  it("uses the unmetered keyless source, and only that", () => {
    expect(GUEST_RISK.includes('from "@/lib/data/yahoo-candles"')).toBe(true);
  });

  it("calls no LLM — guests get the deterministic scorer only", () => {
    for (const src of [GUEST_RISK, JOB]) {
      for (const llm of ["anthropic", "openai", "strategyNotes", "strategy-notes"]) {
        expect(src.toLowerCase().includes(llm.toLowerCase()), `references ${llm}`).toBe(false);
      }
    }
  });
});

describe("the job stays inside the guest data plane", () => {
  it("writes only user_* tables — never an owner money-path table", () => {
    for (const ownerTable of ["live_account_snapshots", "holding_risk_snapshots", "holding_risk_runs",
                              "paper_positions", "paper_portfolio", "broker_accounts",
                              "strategy_config", "api_key_vault"]) {
      // `user_holding_risk_runs` legitimately contains "holding_risk_runs", so
      // match the table name only where it is NOT prefixed by `user_`.
      const hit = new RegExp(`(?<!user_)\\b${ownerTable}\\b`).test(JOB);
      expect(hit, `job touches ${ownerTable}`).toBe(false);
    }
  });

  it("scopes every write to a single user id", () => {
    expect(JOB.includes("user_id: userId")).toBe(true);
    expect(JOB.includes("user_id: p.userId")).toBe(true);
  });

  it("is cron-gated, so a signed-in guest cannot trigger other users' runs", () => {
    expect(JOB.includes("verifyCronSecret(req)")).toBe(true);
  });

  it("records a REASON for every user it cannot compute", () => {
    // A money-adjacent report that goes quiet is worse than one that says why.
    for (const reason of ["no_holdings", "client.reason", "skip_reason"]) {
      expect(JOB.includes(reason), `missing ${reason}`).toBe(true);
    }
  });

  it("never returns holdings or figures in the scheduler response", () => {
    const start = JOB.lastIndexOf("return NextResponse.json({\n    ok: true");
    expect(start, "final response not found — the assertion below would be vacuous").toBeGreaterThan(0);
    const response = JOB.slice(start, JOB.indexOf("\n  });", start));
    expect(response.includes("holdings")).toBe(false);
    expect(response.includes("summary")).toBe(false);
  });
});

describe("risk is computed from what the broker actually gave us", () => {
  const candles = (n: number, seed: number): Candle[] =>
    Array.from({ length: n }, (_, i) => ({
      date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      open: 100 + i * seed, high: 101 + i * seed, low: 99 + i * seed,
      close: 100 + i * seed + (i % 3), volume: 1000,
    })) as unknown as Candle[];

  it("drops an unpriced holding and SAYS so, rather than valuing it at zero", () => {
    // A zero-valued position silently shrinks every concentration percentage
    // that follows, which is the opposite of what a risk page is for.
    const { holdings, unpriced } = toBrokerHoldings(
      [
        { symbol: "RELIANCE", quantity: 10, averageCost: 100, lastPrice: 120, currency: "INR" },
        { symbol: "WEIRDCO", quantity: 5, averageCost: 50, lastPrice: null, currency: "INR" },
      ],
      "india",
    );
    expect(holdings.map((h) => h.symbol)).toEqual(["RELIANCE.NS"]);
    expect(unpriced).toEqual(["WEIRDCO"]);
  });

  it("asks Yahoo the same question the owner's path does for Indian symbols", () => {
    expect(yahooSymbolFor("RELIANCE", "india")).toBe("RELIANCE.NS");
    expect(yahooSymbolFor("RELIANCE.NS", "india")).toBe("RELIANCE.NS");
    expect(yahooSymbolFor("AAPL", "us")).toBe("AAPL");
  });

  it("reports a symbol with no history as uncovered, not as uncorrelated", () => {
    // "unknown" and "zero correlation" are different claims. Conflating them
    // would understate concentration risk on exactly the obscure holdings where
    // history is missing.
    return computeGuestRisk(
      [
        { symbol: "AAA", quantity: 1, averageCost: 10, lastPrice: 100, currency: "INR" },
        { symbol: "BBB", quantity: 1, averageCost: 10, lastPrice: 100, currency: "INR" },
      ],
      "india",
      { fetchCandles: async (sym) => (sym.startsWith("AAA") ? candles(120, 1) : []) },
    ).then((res) => {
      expect(res.coverage.covered).toBe(1);
      expect(res.coverage.uncovered).toEqual(["BBB.NS"]);
      expect(res.clusters["BBB.NS"].computable).toBe(false);
      expect(res.clusters["BBB.NS"].avgCorr).toBeNull();
    });
  });

  it("never reaches the network when a candle source is supplied", async () => {
    // Proves the injection point is real: if computeGuestRisk ignored it and
    // called Yahoo itself, this would not be a meaningful budget guarantee.
    let asked: string[] = [];
    await computeGuestRisk(
      [{ symbol: "AAA", quantity: 1, averageCost: 10, lastPrice: 100, currency: "USD" }],
      "us",
      { fetchCandles: async (s) => { asked.push(s); return candles(80, 1); } },
    );
    expect(asked).toEqual(["AAA"]);
  });
});

describe("the guest risk page never becomes the owner's risk page", () => {
  // This is a scar, not a hypothetical. The guest page was first written to
  // `app/dashboard/risk/page.tsx`, which is the OWNER's Daily Per-Holding Risk
  // dashboard over the owner's live account book — overwriting it, and, since
  // the path was simultaneously added to VIEWER_PAGES, aiming the owner's book
  // at every guest. Caught before commit; asserted here so it cannot recur.
  it("does not expose /dashboard/risk to viewers", () => {
    expect(isViewerPage("/dashboard/risk")).toBe(false);
    expect(VIEWER_PAGES).not.toContain("/dashboard/risk");
  });

  it("serves the guest page from its own path, which exists", () => {
    expect(isViewerPage("/dashboard/my-risk")).toBe(true);
    expect(read("app/dashboard/my-risk/page.tsx").includes("Your Risk Analytics")).toBe(true);
  });

  it("leaves the owner's risk page as the owner's component", () => {
    expect(read("app/dashboard/risk/page.tsx").includes("PortfolioRiskPage")).toBe(true);
  });

  it("no viewer page is a prefix that swallows an owner page", () => {
    // `/dashboard/risk` must not be reachable as a subpath of any viewer entry.
    for (const page of VIEWER_PAGES) {
      expect("/dashboard/risk".startsWith(`${page}/`), `${page} swallows /dashboard/risk`).toBe(false);
    }
  });
});
