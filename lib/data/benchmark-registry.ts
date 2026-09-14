// One versioned authority for every market benchmark identity.
//
// A benchmark purpose is part of the data contract. VOO and SPY both represent
// US large-cap exposure, but they are distinct instruments with distinct return
// series; callers must state why they are using one rather than hard-code a
// convenient ticker. Historical rows retain their recorded symbol/version.

export const BENCHMARK_REGISTRY_VERSION = "benchmark-registry-v1";

export type BenchmarkMarket = "us" | "india";
export type BenchmarkPurpose = "portfolio" | "research" | "risk" | "strategy_replay" | "live" | "allocation";

export type BenchmarkDefinition = {
  symbol: string;
  label: string;
  purpose: BenchmarkPurpose;
  market: BenchmarkMarket;
  version: typeof BENCHMARK_REGISTRY_VERSION;
};

const REGISTRY: Record<BenchmarkMarket, Record<BenchmarkPurpose, Omit<BenchmarkDefinition, "market" | "purpose" | "version">>> = {
  us: {
    // The paper/live NAV contract already records VOO. Do not rewrite historic
    // NAV rows to SPY; new readers must use this same declared identity.
    portfolio: { symbol: "VOO", label: "S&P 500 (VOO)" },
    // SPY remains the research/risk series because its long, liquid cached
    // history underlies existing frozen labels. It is NOT interchangeable with
    // the portfolio comparator; the purpose label makes the distinction visible.
    research: { symbol: "SPY", label: "S&P 500 (SPY)" },
    risk: { symbol: "SPY", label: "S&P 500 (SPY)" },
    strategy_replay: { symbol: "VOO", label: "S&P 500 (VOO)" },
    // Live-account snapshots use the portfolio comparison identity. It remains
    // a separate purpose so a live path cannot silently borrow research SPY.
    live: { symbol: "VOO", label: "S&P 500 (VOO)" },
    allocation: { symbol: "VOO", label: "S&P 500 (VOO)" },
  },
  india: {
    portfolio: { symbol: "^NSEI", label: "NIFTY 50" },
    research: { symbol: "^NSEI", label: "NIFTY 50" },
    risk: { symbol: "^NSEI", label: "NIFTY 50" },
    strategy_replay: { symbol: "^NSEI", label: "NIFTY 50" },
    live: { symbol: "^NSEI", label: "NIFTY 50" },
    allocation: { symbol: "^NSEI", label: "NIFTY 50" },
  },
};

export function benchmarkFor(market: BenchmarkMarket, purpose: BenchmarkPurpose): BenchmarkDefinition {
  return { ...REGISTRY[market][purpose], market, purpose, version: BENCHMARK_REGISTRY_VERSION };
}

export function benchmarkSymbolFor(market: BenchmarkMarket, purpose: BenchmarkPurpose): string {
  return benchmarkFor(market, purpose).symbol;
}

/**
 * The editable `benchmarks` table may offer secondary display comparators, but
 * its single primary per market is the source used to materialize book-level
 * observations. It must agree with this versioned registry or the scorecard
 * would label one instrument with another's levels.
 */
export function primaryBenchmarkContractErrors(rows: Array<{
  market: string;
  symbol?: string | null;
  provider_symbol?: string | null;
  is_primary?: boolean | null;
}>): string[] {
  const errors: string[] = [];
  for (const market of ["us", "india"] as const) {
    const primary = rows.filter((row) => row.market === market && row.is_primary);
    const expected = benchmarkSymbolFor(market, "portfolio");
    if (primary.length !== 1) {
      errors.push(`${market}: expected exactly one primary benchmark, found ${primary.length}`);
      continue;
    }
    const actual = String(primary[0].provider_symbol ?? primary[0].symbol ?? "");
    if (actual !== expected) errors.push(`${market}: primary ${actual || "(missing symbol)"} does not match registry ${expected}`);
  }
  return errors;
}
