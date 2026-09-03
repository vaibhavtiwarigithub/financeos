import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const route = readFileSync("app/api/calendar/earnings/expectations/capability/route.ts", "utf8");

describe("earnings expectations capability route safety contract", () => {
  it("is owner-gated and makes GET planning-only", () => {
    expect(route.match(/requireOwner\(\)/g)?.length).toBe(2);
    const getBody = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
    expect(getBody).not.toContain("providerCachedFetch(");
    expect(getBody).toContain('mode: "plan_only"');
    expect(getBody).toContain("external_calls_made: 0");
  });

  it("requires explicit confirmation and a hard six-symbol cap", () => {
    expect(route).toContain("EARNINGS_EXPECTATIONS_CONFIRMATION");
    expect(route).toContain("requested > EARNINGS_EXPECTATIONS_MAX_SYMBOLS");
    expect(route).toContain("if (!cacheHit && remaining <= 0)");
    expect(route).toContain('outcome: "skipped_no_budget"');
  });

  it("never persists estimates or registers a shadow/trading consumer", () => {
    expect(route).not.toContain("earnings_expectation_snapshots");
    expect(route).not.toContain("edge_signals");
    expect(route).not.toContain("edge_ic_history");
    expect(route).not.toContain("paper_positions");
    expect(route).not.toContain("trade_proposals");
    expect(route).not.toContain("ShadowLifecycle");
  });

  it("uses the canonical provider guard and writes a redacted audit ledger", () => {
    expect(route).toContain('providerCachedFetch(\n        "alpha_vantage"');
    expect(route).toContain('.from("provider_call_ledger").insert({');
    expect(route).not.toContain("source_url:");
    expect(route).not.toContain("apikey:");
    expect(route).toContain("maxStaleAgeDays: 0");
  });
});
