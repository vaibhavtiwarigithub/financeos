import { describe, expect, it } from "vitest";
import { BENCHMARK_REGISTRY_VERSION, benchmarkFor, primaryBenchmarkContractErrors } from "@/lib/data/benchmark-registry";

describe("benchmark registry", () => {
  it("makes portfolio and research purpose explicit instead of silently mixing them", () => {
    expect(benchmarkFor("us", "portfolio")).toMatchObject({ symbol: "VOO", purpose: "portfolio", version: BENCHMARK_REGISTRY_VERSION });
    expect(benchmarkFor("us", "research")).toMatchObject({ symbol: "SPY", purpose: "research", version: BENCHMARK_REGISTRY_VERSION });
  });
  it("keeps India on the one declared NIFTY 50 identity", () => {
    expect(benchmarkFor("india", "portfolio").symbol).toBe("^NSEI");
    expect(benchmarkFor("india", "research").symbol).toBe("^NSEI");
  });
  it("fails closed when the editable primary table drifts from the registry", () => {
    expect(primaryBenchmarkContractErrors([
      { market: "us", symbol: "VOO", is_primary: true },
      { market: "india", symbol: "^NSEI", is_primary: true },
    ])).toEqual([]);
    expect(primaryBenchmarkContractErrors([
      { market: "us", symbol: "SPY", is_primary: true },
      { market: "india", symbol: "^NSEI", is_primary: true },
    ])).toEqual(["us: primary SPY does not match registry VOO"]);
  });
});
