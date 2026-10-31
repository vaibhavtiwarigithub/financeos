"use client";

import { useState } from "react";
import type { GuardianOutcomeHorizon, GuardianOutcomePayload } from "@/types";

const T = { surface: "#13151C", border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#969BA8", green: "#34D399", red: "#F87171", amber: "#FBBF24", accent: "#818CF8" };
const pct = (v: number | null | undefined) => v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const color = (v: number | null | undefined) => v == null ? T.muted : v >= 0 ? T.green : T.red;
export default function GuardianOutcomeScorecard({ data }: { data: GuardianOutcomePayload }) {
  const [horizon, setHorizon] = useState<GuardianOutcomeHorizon>(10);
  const summary = data.summary.find(s => s.horizon === horizon);
  const money = (v: number | null | undefined) => v == null ? "—" : new Intl.NumberFormat(data.market === "india" ? "en-IN" : "en-US", { style: "currency", currency: data.currency, maximumFractionDigits: 2 }).format(v);
  const cells = [
    ["Average added return", pct(summary?.meanDeltaPct), "stop minus holding · modeled cost"],
    ["Median added return", pct(summary?.medianDeltaPct), "not a realized return"],
    ["Notional-weighted benefit", pct(summary?.weightedDeltaPct), `${summary?.pricedQuantityCount ?? 0} with frozen quantity`],
    ["Modeled monetary difference", money(summary?.monetaryDelta), "scenario total · not portfolio P/L"],
  ];
  return <div style={{ marginTop: 20, paddingTop: 18, borderTop: `1px solid ${T.border}` }}>
    <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
      <h3 style={{ color: T.text, fontSize: 14, margin: 0 }}>Do Guardian’s suggested stops help?</h3>
      <span style={{ fontSize: 10, color: T.amber, letterSpacing: ".06em" }}>EXACT SUGGESTIONS · MEASUREMENT ONLY</span>
    </div>
    <p style={{ color: T.sub, fontSize: 12, lineHeight: 1.6, margin: "8px 0" }}>
      Compare the frozen suggested stop with continuing to hold the same shares. Both start at the next regular session’s open after the suggestion date—not your original purchase price. The modeled stop result freezes at the first stop touch (using the worse of the open or stop for a gap); current holdings P/L elsewhere can keep changing unless a broker fill actually closes the shares. Same-day intraday moves are unobserved. Target-trigger reductions appear separately in Sell / reduce follow-up; missing cost basis or fill evidence is never presented as realized P/L.
    </p>
    <div role="group" aria-label="Guardian outcome horizon" style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "12px 0" }}>
      {([2, 5, 10, 20] as const).map(h => <button key={h} type="button" aria-pressed={horizon === h} onClick={() => setHorizon(h)}
        style={{ background: horizon === h ? T.accent : T.surface, color: horizon === h ? "#fff" : T.sub, border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 10px", cursor: "pointer", fontSize: 12 }}>{h} sessions</button>)}
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(165px,1fr))", gap: 8 }}>
      {cells.map(([label, value, note]) => <div key={label} style={{ minWidth: 0, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, padding: 12 }}>
        <div style={{ color: T.sub, fontSize: 11 }}>{label}</div><div style={{ color: T.text, fontWeight: 750, fontSize: 18, marginTop: 5 }}>{value}</div><div style={{ color: T.muted, fontSize: 10, marginTop: 4 }}>{note}</div>
      </div>)}
    </div>
    <p style={{ color: T.sub, fontSize: 11, lineHeight: 1.6 }}>
      {summary?.evaluated ?? 0} evaluated / {data.suggestions} stored suggestions · {data.legacy} legacy/ungraded.
      {data.evaluatedAt ? ` Evaluated ${new Date(data.evaluatedAt).toLocaleString()}.` : " Awaiting a successful nightly evaluation."}
      {summary?.evaluated ? ` Stops touched: ${summary.touched}. Benefit ${summary.savedPctPoints.toFixed(2)} vs upside sacrificed ${summary.sacrificedPctPoints.toFixed(2)} summed percentage points (not money). Daily drawdown bounds: hold ${pct(summary.meanHoldDrawdownPct)}, stop ${pct(summary.meanStopDrawdownPct)}.` : " No performance claim is available yet."}
    </p>
    {data.rows.length === 0 ? <div style={{ color: T.amber, fontSize: 12, lineHeight: 1.6, padding: 12, background: T.surface, borderRadius: 8 }}>
      No app-generated stop suggestions have been recorded for {data.market === "india" ? "India" : "US"}. Existing broker stops/GTTs are not app advice. This does not create a suggestion, arm protection, or enable trading.
    </div> : <div role="region" aria-label="Guardian suggestion outcomes" tabIndex={0} style={{ overflowX: "auto", maxWidth: "100%" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 680, fontSize: 11 }}>
        <thead><tr>{["Suggested", "Symbol / stop", "Stop vs hold", "Outcome state", "Response evidence"].map(label => <th key={label} style={{ textAlign: "left", color: T.muted, padding: "8px 6px", borderBottom: `1px solid ${T.border}` }}>{label}</th>)}</tr></thead>
        <tbody>{data.rows.map(r => {
          const o = r.outcomes.find(x => x.horizon === horizon);
          return <tr key={r.id}>
            <td style={{ color: T.sub, padding: "9px 6px", borderBottom: `1px solid ${T.border}`, verticalAlign: "top" }}>{new Date(r.issuedAt).toLocaleDateString()}<div style={{ fontSize: 10 }}>{new Date(r.issuedAt).toLocaleTimeString()}</div></td>
            <td style={{ color: T.text, padding: "9px 6px", borderBottom: `1px solid ${T.border}`, verticalAlign: "top" }}><strong>{r.symbol}</strong><div>Stop {money(r.stop)}</div><div style={{ color: T.muted }}>Frozen qty {r.qty ?? "unknown"}</div></td>
            <td style={{ padding: "9px 6px", borderBottom: `1px solid ${T.border}`, verticalAlign: "top", color: color(o?.netDeltaPct) }}><strong>{pct(o?.netDeltaPct)}</strong><div style={{ color: T.muted }}>{money(o?.monetaryDelta)} modeled</div>{o?.state === "ready" && <div style={{ color: T.sub }}>Gross delta {pct(o.grossDeltaPct)}<br/>Hold {pct(o.holdReturnPct)} · stop {pct(o.stopReturnPct)}</div>}</td>
            <td style={{ color: T.sub, padding: "9px 6px", borderBottom: `1px solid ${T.border}`, verticalAlign: "top", maxWidth: 250 }}><strong>{o?.state.replaceAll("_", " ") ?? "unknown"}</strong><details style={{ marginTop: 4 }}><summary style={{ cursor: "pointer" }}>Method / reason</summary><div style={{ lineHeight: 1.6 }}>{o?.reason}<br/>{o?.startSession} → {o?.endSession}<br/>Source: {r.source}<br/>Version: {r.version ?? "legacy / unknown"}<br/>{o?.touchedOn ? `Touched ${o.touchedOn}; modeled fill ${money(o.stopFillPrice)}` : "No verified touch in this evaluated window."}</div></details></td>
            <td style={{ color: T.sub, padding: "9px 6px", borderBottom: `1px solid ${T.border}`, verticalAlign: "top", maxWidth: 260 }}><strong>{r.response.state.replaceAll("_", " ")}</strong><div style={{ marginTop: 3 }}>{r.response.reason}</div>{r.response.fillPrice != null && <div style={{ marginTop: 3 }}>Confirmed {r.response.fillQty} shares @ {money(r.response.fillPrice)}<br/>{r.response.filledAt}<br/>Sale vs hypothetical hold: {money(o?.confirmedSaleVsHoldMoney)} gross; not realized profit.</div>}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>}
    {data.rowsTruncated && <p style={{ color: T.amber, fontSize: 11 }}>Only the latest 100 rows are displayed; summary includes all stored suggestions.</p>}
    <details style={{ color: T.muted, fontSize: 11, lineHeight: 1.6, marginTop: 12 }}><summary style={{ cursor: "pointer" }}>Costs, uncertainty and exclusions</summary>
      <p>Evaluator version describes measurement, not the source stop formula. The source stop-formula version is currently unrecorded; it is never inferred from today’s code.</p>
      Frozen first suggestions and non-overlapping 20-session windows are used per account/symbol; repeat revisions do not inflate the result. These remain descriptive, correlated observations—not proof of causality or statistically independent wins. An illustrative 10 bps (0.10%) extra sell cost is charged only when the simulated stop exits; this is not a broker fee estimate. Gaps sell at the worse of the open and stop. Cash earns no interest and is not reinvested. Drawdown figures are conservative daily high-before-low bounds, not observed intraday paths. Missing/corporate-action windows and legacy advice are ungraded, never zero. Arming, stop touches and snapshot changes do not prove execution. Actual lot-level realized P/L and taxes are not known from these forecasts. No automated stop-rule changes.
    </details>
  </div>;
}
