import { describe, expect, it } from "vitest";
import { escapeLedgerHtml, normalizeLiveLedger, normalizePaperLedger, paperLedgerLines } from "./holdings-ledger";
import type { BriefingRiskAccount, BriefingRiskHolding, LiveRiskRunRow } from "./live-risk";

describe("briefing holdings ledger", () => {
  it("retains every paper position beyond the previous ten-row cap and keeps staged open exits", () => {
    const rows = Array.from({ length: 17 }, (_, i) => ({
      symbol: `SYM${i}`,
      market: "us",
      qty: 2,
      avg_cost: 10,
      current_price: 12,
      exit_reason: i === 16 ? "direction_flip_armed:2026-11-04" : null,
      updated_at: "2026-11-04T21:00:00.000Z",
    }));
    const normalized = normalizePaperLedger(rows, "us");
    expect(normalized).toHaveLength(17);
    expect(normalized.map((row) => row.symbol)).toContain("SYM16");
    expect(normalized[0]).toMatchObject({ qty: 2, avgCost: 10, mark: 12, marketValue: 24, pnl: 4, pnlPct: 20 });
  });

  it("keeps paper market isolation and reports malformed numeric fields as unavailable", () => {
    const normalized = normalizePaperLedger([
      { symbol: "AAPL", market: "us", qty: "bad", avg_cost: null, current_price: null },
      { symbol: "RELIANCE.NS", market: "india", qty: 10, avg_cost: 100, current_price: 110 },
    ], "us");
    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({ symbol: "AAPL", qty: null, avgCost: null, mark: null, marketValue: null, pnl: null, pnlPct: null });
    expect(paperLedgerLines(normalized, "$" )[0]).toContain("unavailable");
  });

  it("keeps all live holdings, ordinary holds, and duplicate symbols separate by account", () => {
    const holding = (symbol: string): BriefingRiskHolding => ({
      symbol, qty: 2, averageCost: 10, sourceCapturedAt: "2026-11-04T21:00:00.000Z",
      currentPrice: 12, marketValue: 24, weightPct: 0.02, unrealizedPnlPct: 20,
      score: 50, label: null, posture: "hold", sourcePosture: "hold", reason: null,
      dataConfidence: 1, missingInputs: [], research: null,
    });
    const account = (id: string, holdings: BriefingRiskHolding[]): BriefingRiskAccount => ({
      accountId: id, accountLabel: `Broker ••••${id.slice(-4)}`, broker: "alpaca_live", currency: "USD",
      capturedOn: "2026-11-04", sourceCapturedAt: "2026-11-04T21:00:00.000Z", formulaVersion: "hr-v3",
      dataConfidence: 1, missingInputs: [], sessionsOld: 0, stale: false, totalValue: 1000,
      accountRiskScore: null, accountRiskLabel: null, holdingsTotal: holdings.length,
      allHoldings: holdings, holdingsShown: holdings.slice(0, 3), holdingsOmitted: holdings.length - Math.min(3, holdings.length),
    });
    const ledger = normalizeLiveLedger([
      account("acct-001", [holding("AAPL"), holding("MSFT"), holding("NVDA"), holding("TSLA")]),
      account("acct-002", [holding("AAPL")]),
    ], "us");
    expect(ledger.map((entry) => entry.accountId)).toEqual(["acct-001", "acct-002"]);
    expect(ledger[0].holdings.map((entry) => entry.symbol)).toEqual(["AAPL", "MSFT", "NVDA", "TSLA"]);
    expect(ledger[1].holdings.map((entry) => entry.symbol)).toEqual(["AAPL"]);
  });

  it("keeps currencies and markets separate and does not include the paper adapter as live", () => {
    const base = {
      accountId: "id-1", accountLabel: "Account", broker: "kite", currency: "INR" as const,
      capturedOn: "2026-11-04", sourceCapturedAt: null, formulaVersion: "hr-v3", dataConfidence: null,
      missingInputs: [], sessionsOld: null, stale: true, totalValue: null, accountRiskScore: null,
      accountRiskLabel: null, holdingsTotal: 0, allHoldings: [], holdingsShown: [], holdingsOmitted: 0,
    };
    expect(normalizeLiveLedger([{ ...base, broker: "internal" }], "india")).toEqual([]);
    expect(normalizeLiveLedger([base], "us")).toEqual([]);
    expect(normalizeLiveLedger([base], "india")).toHaveLength(1);
  });

  it("escapes all HTML-sensitive characters before held symbols or labels are rendered", () => {
    expect(escapeLedgerHtml(`<AAPL & "x" 'y'>`)).toBe("&lt;AAPL &amp; &quot;x&quot; &#39;y&#39;&gt;");
  });

  it("shows a newer failed live capture instead of presenting an older completed snapshot as current", () => {
    const holding: BriefingRiskHolding = {
      symbol: "RELIANCE.NS", qty: 3, averageCost: 100, sourceCapturedAt: "2026-11-03T10:00:00Z",
      currentPrice: 110, marketValue: 330, weightPct: null, unrealizedPnlPct: 10,
      score: null, label: null, posture: "hold", sourcePosture: "hold", reason: null,
      dataConfidence: null, missingInputs: [], research: null,
    };
    const account: BriefingRiskAccount = {
      accountId: "kite-user", accountLabel: "Kite ••••user", broker: "kite", currency: "INR",
      capturedOn: "2026-11-03", sourceCapturedAt: "2026-11-03T10:00:00Z", formulaVersion: "hr-v3",
      dataConfidence: null, missingInputs: [], sessionsOld: 1, stale: false, totalValue: 500,
      accountRiskScore: null, accountRiskLabel: null, holdingsTotal: 1,
      allHoldings: [holding], holdingsShown: [holding], holdingsOmitted: 0,
    };
    const failed: LiveRiskRunRow = {
      id: "new-failed", market: "india", currency: "INR", broker: "kite", account_id: "kite-user",
      account_label: "Kite", status: "failed", captured_on: "2026-11-04", source_captured_at: null,
      started_at: "2026-11-04T10:00:00Z", completed_at: null, formula_version: "hr-v3",
      data_confidence: null, missing_inputs: [],
    };
    const ledger = normalizeLiveLedger([account], "india", [failed]);
    expect(ledger[0].snapshotStatus).toBe("complete");
    expect(ledger[0].holdings.map((row) => row.symbol)).toEqual(["RELIANCE.NS"]);
    expect(ledger[0].coverageNote).toMatch(/Latest capture attempt is failed/);
  });

  it("lists an account's latest failed capture as unavailable rather than flat", () => {
    const failed: LiveRiskRunRow = {
      id: "failed-only", market: "us", currency: "USD", broker: "alpaca_live", account_id: "acct-7732",
      account_label: "Alpaca Live", status: "failed", captured_on: "2026-11-04", source_captured_at: null,
      started_at: "2026-11-04T15:00:00Z", completed_at: null, formula_version: "hr-v3",
      data_confidence: null, missing_inputs: [],
    };
    const ledger = normalizeLiveLedger([], "us", [failed]);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ accountId: "acct-7732", snapshotStatus: "failed", holdings: [] });
    expect(ledger[0].coverageNote).toMatch(/no position list is claimed/);
  });
});
