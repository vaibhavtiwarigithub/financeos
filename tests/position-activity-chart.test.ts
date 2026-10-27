import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { fmtMoney } from "@/lib/format-money";
import type { PositionActivitySeries } from "@/lib/portfolio/position-history";

// Compile the isolated view without changing Next's preserve-JSX configuration.
const compiled = ts.transpileModule(readFileSync("components/dashboard/PositionActivityChart.tsx", "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const output: { default?: React.ComponentType<any> } = {};
new Function("require", "exports", "React", compiled)((name: string) => name.includes("format-money") ? { fmtMoney } : { PAPER_BOOK_T: {} }, output, React);
const PositionActivityChart = output.default!;
const activity: PositionActivitySeries = { status: "ready", reconstructedQty: 1,
  events: [
    { at: "2026-10-01T15:00:00Z", side: "buy", quantity: 2, fillPrice: 100, notional: 200, quantityAfter: 2, realizedPnl: null, reason: "entry" },
    { at: "2026-10-02T15:00:00Z", side: "sell", quantity: 1, fillPrice: 90, notional: 90, quantityAfter: 1, realizedPnl: -10, reason: "partial" },
  ], planPoints: [{ at: "2026-10-03T15:00:00Z", stopLoss: 85, target: 120, source: "current_snapshot" }], planHistoryStatus: "not_recorded" };
const render = (data: PositionActivitySeries) => renderToStaticMarkup(React.createElement(PositionActivityChart, { activity: data, currentQty: 1, currency: "$" }));

describe("position ladder presentation", () => {
  it("shows lot P/L on sales, no buy P/L, and current stop/target without inventing old changes", () => {
    const html = render(activity);
    expect(html).toContain("Gross realized P/L on sales: −$10");
    expect(html).toContain("No realized P/L on a buy");
    expect(html).toContain("Stop $85");
    expect(html).toContain("Target $120");
    expect(html).toContain("Earlier stop/target changes were not recorded");
    expect(html).toContain("before fees/taxes");
    expect(html).toContain("Trade and stop/target details");
  });
  it("keeps unknown profit unknown and still shows current levels when share reconciliation fails", () => {
    const html = render({ ...activity, status: "reconciliation_mismatch" });
    expect(html).toContain("fills do not reconcile");
    expect(html).not.toContain("Gross realized P/L on sales");
    expect(html).toContain("Current stop: $85");
  });
  it("does not report zero profit for an incomplete sale cost", () => {
    const html = render({ ...activity, events: activity.events.map(e => ({ ...e, realizedPnl: null })) });
    expect(html).toContain("Sale P/L unavailable");
    expect(html).not.toContain("Gross realized P/L on sales: +$0");
  });
});
