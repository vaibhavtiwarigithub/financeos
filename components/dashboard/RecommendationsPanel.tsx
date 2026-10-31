"use client";

import { useEffect, useMemo, useState } from "react";
import GuardianOutcomeScorecard from "./GuardianOutcomeScorecard";
import type { GuardianOutcomePayload } from "@/types";
import { hypotheticalReductionImpact } from "@/lib/live-recommendations/display";

// Live Portfolio: every recommendation shown for the live book, what was done about it, and how it fared against the symbol and SPY, plus
// the Guardian scorecard and the daily stop-rule revision note. Owner-only stored rows (/api/live-portfolio/recommendations). Display only:
// nothing here places or changes an order, stop or Guardian setting. Client component: no server-module imports.

type Mark = {
  status: string; response_account: string | null; response_detail: string | null; sessions_since: number; last_price: number | null;
  symbol_return_pct: number | null; benchmark_return_pct: number | null; excess_pct: number | null; pnl_pct: number | null; pnl_basis: "actual" | "hypothetical" | null;
  level_touched: boolean | null; level_touched_on: string | null; pnl_if_level_pct: number | null;
};
type Row = { id: number; kind: string; account_id: string; symbol: string; issued_at: string; reference_price: number | null; level_price: number | null; qty_suggested: number | null; rationale: string | null; mark: Mark | null; guardian_contract?: { version?: string } | null };
type Arm = { id: string; label: string; n: number; meanRetPct: number | null; stoppedShare: number | null; savedPts: number; costPts: number };
type Payload = { error?: string; asOf: string; rows: Row[]; revision: { revised_on: string; sample: number; distinct_symbols: number; arms: Arm[]; note: string } | null; guardianPlanEvents: number; guardianOutcomes?: GuardianOutcomePayload };

const T = { card: "#1A1D27", border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280", green: "#34D399", red: "#F87171", amber: "#FBBF24", accent: "#818CF8" };
const KIND: Record<string, string> = { buy_idea: "Buy idea", guardian_stop: "Guardian stop", exit_signal: "Exit signal" };
const STATUS: Record<string, { label: string; color: string }> = {
  taken: { label: "Taken / inferred", color: T.green }, followed: { label: "Reduction inferred", color: T.green }, not_taken: { label: "Not observed", color: T.sub }, ignored: { label: "No reduction observed", color: T.amber },
  expired_unanswered: { label: "Expired, no decision", color: T.amber }, pending: { label: "Open", color: T.accent }, watching: { label: "Watching", color: T.accent },
};
const pct = (v: number | null | undefined) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
const px = (v: number | null | undefined) => (v == null ? "—" : `$${Number(v).toFixed(2)}`);
const tone = (v: number | null | undefined) => (v == null ? T.muted : v >= 0 ? T.green : T.red);
const avg = (xs: Array<number | null | undefined>) => { const k = xs.filter((x): x is number => x != null); return k.length ? k.reduce((a, b) => a + b, 0) / k.length : null; };

type SortKey = "date" | "symbol" | "kind" | "ref" | "level" | "status" | "pnl" | "ret" | "spy" | "excess";
const COLS: Array<{ key: SortKey; label: string; numeric: boolean }> = [
  { key: "date", label: "Date", numeric: true }, { key: "symbol", label: "Symbol", numeric: false }, { key: "kind", label: "Type", numeric: false },
  { key: "ref", label: "Price then", numeric: true }, { key: "level", label: "Stop / level", numeric: true }, { key: "status", label: "What happened", numeric: false },
  { key: "pnl", label: "P/L now / stop frozen", numeric: true }, { key: "ret", label: "Symbol", numeric: true }, { key: "spy", label: "SPY", numeric: true }, { key: "excess", label: "vs SPY", numeric: true },
];
const sortVal = (r: Row, k: SortKey): number | string | null => {
  const m = r.mark;
  switch (k) {
    case "date": return Date.parse(r.issued_at); case "symbol": return r.symbol; case "kind": return KIND[r.kind] ?? r.kind; case "ref": return r.reference_price;
    case "level": return r.level_price; case "status": return m ? STATUS[m.status]?.label ?? m.status : null; case "pnl": return m?.pnl_pct ?? null;
    case "ret": return m?.symbol_return_pct ?? null; case "spy": return m?.benchmark_return_pct ?? null; case "excess": return m?.excess_pct ?? null;
  }
};
type Filter = "all" | "taken" | "not_taken" | "unanswered" | "guardian" | "downside";
const FILTERS: Array<{ id: Filter; label: string; test: (r: Row) => boolean }> = [
  { id: "all", label: "All", test: () => true },
  { id: "taken", label: "Taken", test: (r) => ["taken", "followed"].includes(r.mark?.status ?? "") },
  { id: "not_taken", label: "Not taken", test: (r) => ["not_taken", "ignored"].includes(r.mark?.status ?? "") },
  { id: "unanswered", label: "Expired / open", test: (r) => ["expired_unanswered", "pending", "watching"].includes(r.mark?.status ?? "") },
  { id: "guardian", label: "Guardian stops", test: (r) => r.kind === "guardian_stop" },
  { id: "downside", label: "Sell / reduce", test: (r) => r.kind !== "buy_idea" },
];

export default function RecommendationsPanel() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "date", dir: -1 });
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let active = true;
    fetch("/api/live-portfolio/recommendations", { cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw new Error(`Recommendations unavailable (${r.status})`); return r.json(); })
      .then((b) => { if (active) setData(b); })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : "Recommendations unavailable"); });
    return () => { active = false; };
  }, []);

  const rows = useMemo(() => {
    const test = FILTERS.find((f) => f.id === filter)!.test;
    const list = (data?.rows ?? []).filter(test);
    return [...list].sort((a, b) => {
      const x = sortVal(a, sort.key); const y = sortVal(b, sort.key);
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; // empty values sink in both directions
      return (typeof x === "string" ? x.localeCompare(String(y)) : (x as number) - (y as number)) * sort.dir;
    });
  }, [data, filter, sort]);

  const kpi = useMemo(() => {
    const all = data?.rows ?? [];
    const ideas = all.filter((r) => r.kind === "buy_idea");
    const by = (s: string[]) => ideas.filter((r) => s.includes(r.mark?.status ?? ""));
    const taken = by(["taken"]); const notTaken = by(["not_taken", "expired_unanswered"]);
    const allStops = all.filter((r) => r.kind === "guardian_stop");
    const stops = allStops.filter(r => !r.guardian_contract);
    const downside = all.filter((r) => r.kind !== "buy_idea").sort((a, b) => Date.parse(b.issued_at) - Date.parse(a.issued_at));
    return { total: all.length, ideas: ideas.length, taken: taken.length, notTaken: by(["not_taken"]).length, expired: by(["expired_unanswered"]).length, open: by(["pending"]).length,
      takenExcess: avg(taken.map((r) => r.mark?.excess_pct)), notTakenExcess: avg(notTaken.map((r) => r.mark?.excess_pct)),
      alerts: allStops.length, stops, touched: stops.filter((r) => r.mark?.level_touched).length, exits: all.filter((r) => r.kind === "exit_signal").length, downside };
  }, [data]);

  const head = (c: (typeof COLS)[number]) => (
    <th key={c.key} style={{ textAlign: c.numeric ? "right" : "left", padding: "6px 8px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", color: sort.key === c.key ? T.text : T.muted }}
      onClick={() => setSort((s) => (s.key === c.key ? { key: c.key, dir: (-s.dir) as 1 | -1 } : { key: c.key, dir: c.numeric ? -1 : 1 }))}>
      {c.label}{sort.key === c.key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
    </th>
  );
  const status = (r: Row) => { const s = r.mark ? STATUS[r.mark.status] : null; return <span title={r.mark?.response_detail ?? ""} style={{ color: s?.color ?? T.muted, fontWeight: 600 }}>{s?.label ?? "Not marked yet"}</span>; };
  const plTag = (m: Mark | null, r?: Row) => (m?.pnl_basis === "actual" ? "current unrealized estimate" : m?.pnl_basis === "hypothetical" ? (r?.kind === "exit_signal" ? "since exit signal" : "if bought") : "");
  const eventDetail = (r: Row) => {
    if (r.kind === "guardian_stop") return r.mark?.level_touched
      ? `Guardian stop ${px(r.level_price)} was touched on ${r.mark.level_touched_on ?? "the recorded session"}. Frozen level-only result: ${pct(r.mark.pnl_if_level_pct)}; this is not a confirmed fill.`
      : `Guardian suggested stop: ${px(r.level_price)}. No stop touch is verified in the stored marks.`;
    if (r.kind === "exit_signal") {
      const action = r.rationale?.split(":", 1)[0];
      const label = action === "partial_target" ? "Partial target reached" : action === "stop_full" || action === "target_full" ? "Full exit trigger recorded" : "Exit-ladder action recorded";
      return `${label}: ${r.rationale ?? "sell/reduce signal"}. Trigger price and proposed quantity are frozen at the signal; no confirmed fill or cost basis is recorded, so realized P/L at that trigger is unavailable.`;
    }
    return null;
  };
  const stopFrozen = (r: Row) => r.kind === "guardian_stop" && r.mark?.level_touched === true;

  const kpiCell = (label: string, value: string, sub?: string, color: string = T.text) => (
    <div style={{ background: "#13151C", border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 12px", minWidth: 0 }}>
      <div style={{ color: T.muted, fontSize: 11 }}>{label}</div>
      <div style={{ color, fontSize: 18, fontWeight: 750, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ color: T.sub, fontSize: 11, marginTop: 2 }}>{sub}</div>}
    </div>
  );

  return (
    <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 20, marginBottom: 20 }}>
      <style>{`.rec-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}.rec-table{display:none}.rec-cards{display:grid;gap:8px}@media(min-width:760px){.rec-table{display:block;overflow-x:auto}.rec-cards{display:none}}`}</style>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div>
          <div style={{ color: T.text, fontWeight: 750, fontSize: 15 }}>Recommendations & Guardian scorecard</div>
          <div style={{ color: T.sub, fontSize: 12, marginTop: 4, maxWidth: 760, lineHeight: 1.5 }}>
            Everything the system suggested for your live accounts, whether you acted on it, and how it did against the stock itself and SPY. Display only: nothing here places an order or changes a stop.
            {data?.asOf ? ` Updated ${data.asOf}.` : ""}
          </div>
        </div>
        <button onClick={() => setOpen((o) => !o)} style={{ background: "transparent", color: T.sub, border: `1px solid ${T.border}`, borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer" }}>{open ? "Collapse" : "Expand"}</button>
      </div>
      {error && <div style={{ color: T.red, fontSize: 12, marginTop: 12 }}>{error}</div>}
      {!data && !error && <div style={{ color: T.muted, fontSize: 12, marginTop: 12 }}>Loading recommendations…</div>}
      {data && open && (
        <>
          {data.guardianOutcomes && <GuardianOutcomeScorecard data={data.guardianOutcomes} />}
          <div className="rec-grid" style={{ marginTop: 14 }}>
            {kpiCell("Buy ideas issued", String(kpi.ideas), `${kpi.exits} exit signals · ${kpi.stops.length} Guardian stops`)}
            {kpiCell("Taken", String(kpi.taken), kpi.takenExcess == null ? "no result yet" : `avg ${pct(kpi.takenExcess)} vs SPY`, tone(kpi.takenExcess))}
            {kpiCell("Not taken", String(kpi.notTaken + kpi.expired), kpi.notTakenExcess == null ? "no result yet" : `avg ${pct(kpi.notTakenExcess)} vs SPY if bought`, tone(kpi.notTakenExcess))}
            {kpiCell("Expired, no decision", String(kpi.expired), `${kpi.open} still open`, kpi.expired ? T.amber : T.text)}
            {kpiCell("Guardian stop records", String(kpi.alerts), `${kpi.touched} legacy levels touched · ${data.guardianPlanEvents} plan events (not alerts)`)}
          </div>

          <div style={{ marginTop: 16, border: `1px solid ${T.border}`, borderRadius: 10, padding: 14, background: "#13151C" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <div style={{ color: T.text, fontWeight: 750, fontSize: 13 }}>Sell / reduce ideas and downside follow-up</div>
              <div style={{ color: kpi.downside.length ? T.amber : T.muted, fontSize: 11 }}>{kpi.downside.length} stored recommendations{kpi.downside[0] ? ` · latest ${kpi.downside[0].issued_at.slice(0, 10)}` : ""}</div>
            </div>
            <div style={{ color: T.sub, fontSize: 11, marginTop: 5, lineHeight: 1.5 }}>
              These are explicit Guardian stops or exit-ladder reductions for live holdings. A falling price or a lower score alone is not treated as a sell idea. Response is inferred from account snapshots and can miss same-day round trips.
            </div>
            {kpi.downside.length === 0 ? (
              <div style={{ color: T.muted, fontSize: 12, marginTop: 10 }}>No downside/reduction recommendations are stored. This does not prove that no holding needed review; it means no qualifying recommendation was recorded.</div>
            ) : (
              <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                {kpi.downside.map((r) => {
                  const impact = r.kind === "exit_signal" && ["ignored", "not_taken"].includes(r.mark?.status ?? "")
                    ? hypotheticalReductionImpact(r.qty_suggested, r.reference_price, r.mark?.last_price ?? null) : null;
                  return <div key={`downside-${r.id}`} style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))", gap: "6px 12px", fontSize: 11 }}>
                    <div><div style={{ color: T.muted }}>Issued</div><div style={{ color: T.text }}>{r.issued_at.slice(0, 10)}</div></div>
                    <div><div style={{ color: T.muted }}>Symbol / idea</div><div style={{ color: T.text, fontWeight: 700 }}>{r.symbol} · {KIND[r.kind] ?? r.kind}</div></div>
                    <div><div style={{ color: T.muted }}>Response</div><div>{status(r)}</div></div>
                    <div><div style={{ color: T.muted }}>Signal → latest close</div><div style={{ color: T.text }}>{px(r.reference_price)} → {px(r.mark?.last_price)}</div></div>
                    <div><div style={{ color: T.muted }}>Proposed reduction</div><div style={{ color: T.text }}>{r.qty_suggested != null ? `${Number(r.qty_suggested).toLocaleString()} shares` : r.level_price != null ? `stop ${px(r.level_price)}` : "quantity not recorded"}</div></div>
                    <div><div style={{ color: T.muted }}>Move since idea / vs SPY</div><div style={{ color: tone(r.mark?.symbol_return_pct) }}>{pct(r.mark?.symbol_return_pct)} / {pct(r.mark?.excess_pct)}</div></div>
                    {impact != null && <div style={{ gridColumn: "1 / -1", color: tone(impact), fontWeight: 650 }}>If the suggested quantity had been reduced at the recorded signal price: {impact >= 0 ? "$" : "−$"}{Math.abs(impact).toFixed(2)} hypothetical value difference versus holding it to the latest close.</div>}
                    {r.mark?.response_detail && <div style={{ gridColumn: "1 / -1", color: T.muted }}>{r.mark.response_detail}</div>}
                    {r.kind === "exit_signal" && impact != null && <div style={{ gridColumn: "1 / -1", color: T.muted }}>Counterfactual only: not actual realized P/L or proof the recommendation caused an outcome. It excludes fees, spread, slippage, taxes, later trades, and intraday price path.</div>}
                  </div>;
                })}
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 16 }}>
            {FILTERS.map((f) => (
              <button key={f.id} onClick={() => setFilter(f.id)} style={{ background: filter === f.id ? T.accent : "transparent", color: filter === f.id ? "#fff" : T.sub, border: `1px solid ${T.border}`, borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}>{f.label}</button>
            ))}
            <select aria-label="Sort" value={`${sort.key}:${sort.dir}`} onChange={(e) => { const [k, d] = e.target.value.split(":"); setSort({ key: k as SortKey, dir: Number(d) as 1 | -1 }); }}
              style={{ marginLeft: "auto", background: "#13151C", color: T.sub, border: `1px solid ${T.border}`, borderRadius: 6, padding: "4px 8px", fontSize: 12 }}>
              {COLS.flatMap((c) => [<option key={`${c.key}1`} value={`${c.key}:-1`}>{c.label} ↓</option>, <option key={`${c.key}2`} value={`${c.key}:1`}>{c.label} ↑</option>])}
            </select>
          </div>

          {rows.length === 0 ? <div style={{ color: T.muted, fontSize: 12, marginTop: 14 }}>Nothing matches this filter yet.</div> : (
            <>
              <div className="rec-table" style={{ marginTop: 12 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead><tr style={{ borderBottom: `1px solid ${T.border}` }}>{COLS.map(head)}</tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} style={{ borderTop: `1px solid ${T.border}`, color: T.text }} title={r.rationale ?? ""}>
                        <td style={{ padding: "6px 8px", textAlign: "right", whiteSpace: "nowrap" }}>{r.issued_at.slice(0, 10)}</td>
                        <td style={{ padding: "6px 8px", fontWeight: 700 }}>{r.symbol}</td>
                        <td style={{ padding: "6px 8px", color: T.sub }}>{KIND[r.kind] ?? r.kind}</td>
                        <td style={{ padding: "6px 8px", textAlign: "right" }}>{px(r.reference_price)}</td>
                        <td style={{ padding: "6px 8px", textAlign: "right" }}>{px(r.level_price)}</td>
                        <td style={{ padding: "6px 8px" }}><div>{status(r)}</div>{eventDetail(r) && <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.4, marginTop: 3 }}>{eventDetail(r)}</div>}</td>
                        <td style={{ padding: "6px 8px", textAlign: "right", color: tone(stopFrozen(r) ? r.mark?.pnl_if_level_pct : r.mark?.pnl_pct) }}>
                          {stopFrozen(r) ? <><div>{pct(r.mark?.pnl_if_level_pct)}</div><span style={{ color: T.muted, fontSize: 10 }}>frozen at stop · level-only</span><div style={{ color: T.sub, fontSize: 10, marginTop: 3 }}>Current {pct(r.mark?.pnl_pct)} {plTag(r.mark, r)}</div></>
                            : <>{pct(r.mark?.pnl_pct)} <span style={{ color: T.muted, fontSize: 10 }}>{plTag(r.mark, r)}</span></>}
                        </td>
                        <td style={{ padding: "6px 8px", textAlign: "right", color: tone(r.mark?.symbol_return_pct) }}>{pct(r.mark?.symbol_return_pct)}</td>
                        <td style={{ padding: "6px 8px", textAlign: "right", color: tone(r.mark?.benchmark_return_pct) }}>{pct(r.mark?.benchmark_return_pct)}</td>
                        <td style={{ padding: "6px 8px", textAlign: "right", color: tone(r.mark?.excess_pct) }}>{pct(r.mark?.excess_pct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="rec-cards" style={{ marginTop: 12 }}>
                {rows.map((r) => (
                  <div key={r.id} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <div><span style={{ color: T.text, fontWeight: 750 }}>{r.symbol}</span> <span style={{ color: T.sub, fontSize: 12 }}>{KIND[r.kind] ?? r.kind} · {r.issued_at.slice(0, 10)}</span></div>
                      <div style={{ fontSize: 12 }}>{status(r)}</div>
                    </div>
                    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 8, fontSize: 12, color: T.sub }}>
                      <span>Then {px(r.reference_price)}</span>
                      {r.level_price != null && <span>Level {px(r.level_price)}</span>}
                      {stopFrozen(r) ? <span style={{ color: tone(r.mark?.pnl_if_level_pct) }}>Frozen stop result {pct(r.mark?.pnl_if_level_pct)} (level-only) · current {pct(r.mark?.pnl_pct)} {plTag(r.mark, r)}</span>
                        : <span style={{ color: tone(r.mark?.pnl_pct) }}>P/L {pct(r.mark?.pnl_pct)} {plTag(r.mark, r)}</span>}
                      <span>SPY {pct(r.mark?.benchmark_return_pct)}</span>
                      <span style={{ color: tone(r.mark?.excess_pct) }}>vs SPY {pct(r.mark?.excess_pct)}</span>
                    </div>
                    {eventDetail(r) && <div style={{ color: T.sub, fontSize: 11, lineHeight: 1.5, marginTop: 6 }}>{eventDetail(r)}</div>}
                    {r.mark?.response_detail && <div style={{ color: T.muted, fontSize: 11, marginTop: 6 }}>{r.mark.response_detail}</div>}
                  </div>
                ))}
              </div>
            </>
          )}

          <div style={{ marginTop: 22, color: T.text, fontWeight: 700, fontSize: 13 }}>Legacy Guardian references (not exact-stop performance)</div>
          {kpi.stops.length === 0 ? (
            <div style={{ color: T.sub, fontSize: 12, marginTop: 6 }}>No legacy/unversioned stop references. Frozen suggestions and their exact-stop outcomes appear above.</div>
          ) : (
            <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
              {kpi.stops.map((r) => {
                const m = r.mark; const dist = m?.last_price != null && r.level_price ? (m.last_price / r.level_price - 1) * 100 : null;
                return (
                  <div key={r.id} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 12, fontSize: 12, color: T.sub, lineHeight: 1.6 }}>
                    <span style={{ color: T.text, fontWeight: 750 }}>{r.symbol}</span>: sell at <b style={{ color: T.text }}>{px(r.level_price)}</b> (suggested {r.issued_at.slice(0, 10)}, cost {px(r.reference_price)}).
                    {" "}Now {px(m?.last_price)}{dist != null ? `, ${dist.toFixed(1)}% above the stop` : ""}.
                    {" "}{m?.level_touched ? `Stop level touched on ${m.level_touched_on}; frozen level-only result ${pct(m.pnl_if_level_pct)} (not a confirmed fill).` : "No stop touch verified in this mark."}
                    {" "}You: {m ? (STATUS[m.status]?.label ?? m.status) : "—"}. Current position P/L {pct(m?.pnl_pct)} {plTag(m)}.
                  </div>
                );
              })}
            </div>
          )}

          {data.revision && (
            <div style={{ marginTop: 18 }}>
              <div style={{ color: T.text, fontWeight: 700, fontSize: 13 }}>Generic buy-idea stop-rule experiment <span style={{ color: T.sub, fontWeight: 400, fontSize: 11 }}>({data.revision.revised_on}, shadow only—not actual Guardian suggestions)</span></div>
              <div style={{ color: T.sub, fontSize: 11, marginTop: 6 }}>Hypothetical proposal-price entries, separate from the exact frozen advice above. This experiment does not establish that a Guardian stop helped, and never revises an active stop.</div>
              <div style={{ color: T.sub, fontSize: 12, marginTop: 6, lineHeight: 1.55 }}>{data.revision.note}</div>
              {data.revision.sample > 0 && (
                <div style={{ overflowX: "auto", marginTop: 8 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, color: T.sub }}>
                    <thead><tr style={{ color: T.muted, textAlign: "left" }}>{["Stop rule", "n", "Avg return", "Stopped", "Saved (pts)", "Premature cost (pts)"].map((h) => <th key={h} style={{ padding: "4px 8px 4px 0", fontWeight: 400 }}>{h}</th>)}</tr></thead>
                    <tbody>{data.revision.arms.map((a) => (
                      <tr key={a.id} style={{ borderTop: `1px solid ${T.border}` }}>
                        <td style={{ padding: "4px 8px 4px 0" }}>{a.label}</td><td>{a.n}</td><td style={{ color: tone(a.meanRetPct) }}>{pct(a.meanRetPct)}</td>
                        <td>{a.stoppedShare == null ? "—" : `${Math.round(a.stoppedShare * 100)}%`}</td><td>{a.savedPts}</td><td>{a.costPts}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          <div style={{ marginTop: 16, color: T.muted, fontSize: 11, lineHeight: 1.6 }}>
            Legacy “taken”/reduction states can be inferred from daily snapshots and cannot see intraday round trips. “If bought” is hypothetical and ignores execution costs. Holdings-based P/L is an unrealized estimate from average cost, not realized profit. Exact Guardian results and linked fill evidence are reported separately above.
          </div>
        </>
      )}
    </section>
  );
}
