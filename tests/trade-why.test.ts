import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { explainTradeWhy, type StageEventRow } from "@/lib/trading/trade-why";

const now = new Date("2026-09-15T16:00:00Z");
const ev = (stage: string, outcome: string, reason: string, created_at: string, detail: any = null, signal_id: string | null = "sig-1"): StageEventRow =>
  ({ signal_id, stage, outcome, reason, detail, created_at });
const RAW_CODE = /\b[a-z]+_[a-z_]+\b/; // snake_case internal code leaking into UI text

describe("explainTradeWhy — production reason shapes", () => {
  it("filled execution => bought, with score vs threshold and fill", () => {
    const w = explainTradeWhy({ market: "us", now, events: [
      ev("research", "passed", "Eligible: long direction and score 72 >= threshold 60", "2026-09-15T15:06:00Z"),
      ev("portfolio_constructor", "shrunk", "Sized 7.4% (proposed 20.0%)", "2026-09-15T15:15:09Z", {
        adjustments: ["name_cap: 20.00% -> 12.00% (existing 0.00%, cap 12%)", "gross_cap: 12.00% -> 7.39% (book+candidates would be 84.61%, cap 80%)"] }),
      ev("execution", "filled", "5.406803 @ 136.25", "2026-09-15T15:15:10Z"),
    ] });
    expect(w.outcome).toBe("bought");
    expect(w.headline).toBe("Bought 09-15: score 72 cleared threshold 60 and there was room.");
    expect(w.bullets).toContain("Filled 5.406803 @ $136.25.");
    expect(w.bullets.join(" ")).toContain("Sized 7.4% of the portfolio (proposed 20%)");
  });

  it("multi-clause constructor denial => not bought, binding limit + sector, shadow stages ignored", () => {
    const reason = "portfolio_constructor_denied: name_cap: 20.00% -> 12.00% (existing 0.00%, cap 12%); gross_cap: 12.00% -> 0.00% (book+candidates would be 92.00%, cap 80%); stacked_bet(Energy): 0.00% -> 0.00% (sector already holds 3 positions); denied: scaled size 0.000% below minimum viable 0.5%";
    const w = explainTradeWhy({ market: "us", now, events: [
      ev("research", "passed", "Eligible: long direction and score 72 >= threshold 60", "2026-09-15T15:06:36Z"),
      ev("risk_plan", "passed", "ledger_percentile bound to fill", "2026-09-15T15:15:21Z"),
      ev("portfolio_constructor", "rejected", reason, "2026-09-15T15:15:22.3Z", { adjustments: reason.replace("portfolio_constructor_denied: ", "").split("; ") }),
      ev("execution", "rejected", "portfolio_constructor_no_room", "2026-09-15T15:15:22.8Z", { rotReason: "execute_disabled", noRoom: true }),
      // newer shadow rows must never become the reason
      ev("correlation_shadow", "would_deny", "WOULD DENY (shadow only): pair CVX/OXY 0.826 > 0.7", "2026-09-15T15:15:30Z"),
      ev("earnings_risk_shadow", "measured", "event_outside_horizon", "2026-09-15T15:15:31Z"),
    ] });
    expect(w.outcome).toBe("not_bought");
    expect(w.headline).toBe("Not bought 09-15: the portfolio is already at its 80% invested limit (this buy would take it to 92%) and Energy already holds 3 positions, so the remaining room (0%) is below the 0.5% minimum trade size.");
    const all = [w.headline, ...w.bullets].join(" ");
    expect(all).not.toMatch(/WOULD DENY|correlation|shadow/i);
    expect(all).toContain("Research: score 72 cleared threshold 60.");
    expect(all).toContain("Swapping out a weaker holding is switched off");
    expect(all).not.toMatch(RAW_CODE);
  });

  it("sector_cap / vol_budget clauses are explained", () => {
    const reason = "portfolio_constructor_denied: name_cap: 20.00% -> 12.00% (existing 0.00%, cap 12%); vol_budget: 12.00% -> 0.30% (est portfolio vol 31.20% > cap 25%); sector_cap(Technology): 0.30% -> 0.20% (sector total would be 30.20%, cap 30%); denied: scaled size 0.200% below minimum viable 0.5%";
    const w = explainTradeWhy({ market: "us", now, events: [ev("portfolio_constructor", "rejected", reason, "2026-09-15T15:00:00Z")] });
    expect(w.headline).toContain("estimated portfolio volatility (31.2%) is above its 25% limit");
    expect(w.bullets.join(" ")).toContain("Technology would reach 30.2% of the portfolio against a 30% sector limit");
  });

  it("max_open_names => not bought with position count", () => {
    const w = explainTradeWhy({ market: "india", now, events: [
      ev("portfolio_constructor", "deferred", "max_open_names_rotation_candidate", "2026-09-15T07:45:11Z", { cap: 15, current: 15 }),
      ev("execution", "rejected", "max_open_names (15)", "2026-09-15T07:45:13Z", { atNameCap: true }),
    ] });
    expect(w.outcome).toBe("not_bought");
    expect(w.headline).toBe("Not bought 09-15: the portfolio already holds the maximum number of open positions (15).");
    expect(w.bullets[0]).toBe("Open positions: 15 of 15.");
  });

  it("reentry cooldown and deferred-only chains", () => {
    expect(explainTradeWhy({ market: "us", now, events: [ev("reentry_gate", "rejected", "reentry_cooldown", "2026-09-14T19:15:00Z")] }).headline)
      .toBe("Not bought 09-14: it was sold within the last 3 trading days (re-entry cooldown).");
    expect(explainTradeWhy({ market: "us", now, events: [ev("portfolio_constructor", "deferred", "max_open_names_rotation_candidate", "2026-09-14T19:15:00Z", { cap: 10, current: 10 })] }).outcome)
      .toBe("not_bought");
  });

  it("research rejected / abstained => no trade", () => {
    expect(explainTradeWhy({ market: "us", now, events: [ev("research", "rejected", "Rejected: score 54 < threshold 60", "2026-09-15T15:08:00Z")] }).headline)
      .toBe("No trade 09-15: score 54 is below the threshold 60.");
    const a = explainTradeWhy({ market: "us", now, events: [ev("research", "rejected", "Abstained: thesis response was missing a parseable direction", "2026-09-15T15:08:00Z")] });
    expect(a.outcome).toBe("no_trade");
    expect(a.headline).not.toMatch(RAW_CODE);
  });

  it("unknown trading reason falls back to a readable sentence, never a raw code", () => {
    const w = explainTradeWhy({ market: "us", now, events: [ev("execution", "rejected", "rpc_fill_denied:some_new_guard", "2026-09-15T15:00:00Z")] });
    expect(w.headline).toBe("Not bought 09-15: a paper-trading safety check stopped the order.");
  });

  it("shadow-only rows are not a decision", () => {
    const w = explainTradeWhy({ market: "us", now, events: [ev("correlation_shadow", "would_deny", "WOULD DENY (shadow only): pair C/LNC 0.8 > 0.7", "2026-09-15T15:00:00Z")] });
    expect(w).toEqual({ outcome: "unknown", headline: "Not researched yet", bullets: [], at: null });
  });
});

describe("explainTradeWhy — fallbacks", () => {
  it("2: newer research on a different signal beats an old trading chain; stale dates are prefixed", () => {
    const w = explainTradeWhy({ market: "us", now, events: [
      ev("execution", "rejected", "max_open_names (10)", "2026-08-12T15:00:00Z", null, "old"),
      ev("research", "passed", "Eligible: long direction and score 80 >= threshold 60", "2026-09-15T15:00:00Z", null, "new"),
    ] });
    expect(w.headline).toBe("Eligible 09-15: score 80 cleared threshold 60, but the paper trader has not acted on this signal.");
    const old = explainTradeWhy({ market: "us", now, events: [ev("execution", "rejected", "max_open_names (10)", "2026-08-12T15:00:00Z")] });
    expect(old.headline).toBe("As of 08-12: not bought — the portfolio already holds the maximum number of open positions (10).");
  });

  it("3: decision_observations row when no stage events exist", () => {
    const w = explainTradeWhy({ market: "india", now, events: [], observation: { ts: "2026-07-20T05:00:00Z", analyst_score: 48, score_threshold: 60, direction: "neutral", entry_eligible: false } });
    expect(w.outcome).toBe("no_trade");
    expect(w.headline).toBe("As of 07-20: no trade — score 48 is below the threshold 60.");
    expect(w.at).toBe("2026-07-20T05:00:00Z");
  });

  it("4: last paper trade when no events exist, with exit reason; a later exit overrides an older decision", () => {
    const sold = explainTradeWhy({ market: "us", now, events: [], lastTrade: { side: "sell", date: "2026-09-10T15:00:00Z", reason: "stop_hit" } });
    expect(sold).toMatchObject({ outcome: "sold", headline: "Sold 09-10: the price hit the stop-loss." });
    const over = explainTradeWhy({ market: "us", now,
      events: [ev("execution", "filled", "5 @ 59.20", "2026-09-01T15:00:00Z")],
      lastTrade: { side: "sell", date: "2026-09-12T15:00:00Z", reason: "time_stop (12 market days > 10d, grandfathered)" } });
    expect(over.headline).toBe("Sold 09-12: held 12 market days, past the 10-day holding limit.");
    const sameFill = explainTradeWhy({ market: "us", now,
      events: [ev("execution", "filled", "5 @ 59.20", "2026-09-01T15:00:00Z")],
      lastTrade: { side: "buy", date: "2026-09-01T15:00:01Z" } });
    expect(sameFill.bullets).toContain("Filled 5 @ $59.20.");
  });

  it("5: nothing at all => not researched yet", () => {
    expect(explainTradeWhy({ market: "us", now, events: [] }).headline).toBe("Not researched yet");
  });
});

// Contract guard: the Why column is only as complete as the stage log. Every
// paper-trade path that skips a signal or fills one must write a stage event.
describe("stage-log contract (keeps Why populated for future symbols)", () => {
  const src = readFileSync("app/api/agents/paper-trade/route.ts", "utf8");

  function regionsFor(token: string): string[] {
    const out: string[] = [];
    for (let i = src.indexOf(token); i >= 0; i = src.indexOf(token, i + 1)) {
      const prev = src.lastIndexOf("continue;", i);
      const next = src.indexOf("continue;", i);
      out.push(token === "skipped.push(" ? src.slice(i, next < 0 ? undefined : next) : src.slice(prev < 0 ? 0 : prev, next < 0 ? undefined : next));
    }
    return out;
  }

  it("every skipped.push is followed by logStage before its continue", () => {
    const regions = regionsFor("skipped.push(");
    expect(regions.length).toBeGreaterThanOrEqual(15);
    regions.forEach((r) => expect(r.includes("logStage("), `skip without stage log:\n${r.slice(0, 160)}`).toBe(true));
  });

  it("every filled.push sits beside an execution/filled stage log", () => {
    const regions = regionsFor("filled.push(");
    expect(regions.length).toBeGreaterThanOrEqual(2);
    regions.forEach((r) => expect(/stage: "execution", outcome: "filled"/.test(r), r.slice(0, 160)).toBe(true));
  });

  it("research still logs a research stage with passed/rejected", () => {
    const agent = readFileSync("lib/research-agent.ts", "utf8");
    expect(agent).toContain('from("pipeline_stage_events").insert(');
    expect(agent).toContain('stage: "research"');
    expect(agent).toContain('outcome: entryEligible ? "passed" : "rejected"');
  });
});
