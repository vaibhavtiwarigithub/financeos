"use client";

import { useEffect, useState } from "react";
import { useMarket } from "@/lib/market-context";

const T = {
  surface: "#13151C", card: "#1A1D27", border: "#252836", text: "#ECEDEF",
  textSub: "#A7AAB4", muted: "#737987", accent: "#818CF8", green: "#34D399",
  red: "#F87171", amber: "#FBBF24", blue: "#60A5FA", ink: "#0C1017",
};

function today() { return new Date().toISOString().slice(0, 10); }
function titleCase(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, c => c.toUpperCase()); }
function percent(value: number) { return `${Math.round((value ?? 0) * 100)}%`; }
function pretty(value: unknown): string {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value ?? "—");
}
function terminalBadge(terminal: string) {
  if (terminal === "filled") return { label: "FILLED", color: T.green };
  if (terminal === "staged_awaiting_session") return { label: "STAGED · AWAITING MARKET SESSION", color: T.blue };
  if (terminal === "revalidated_superseded") return { label: "REVALIDATED · SUPERSEDED", color: T.muted };
  if (terminal === "expired_not_traded") return { label: "EXPIRED · NOT TRADED", color: T.muted };
  if (terminal === "passed_research_awaiting_paper_gates") return { label: "PASSED RESEARCH · AWAITING PAPER GATES", color: T.blue };
  if (terminal === "passed_portfolio_awaiting_execution") return { label: "PASSED PORTFOLIO GATES · AWAITING EXECUTION", color: T.blue };
  if (terminal === "paper_traded_audit_gap") return { label: "PAPER TRADED · AUDIT EVENT MISSING", color: T.amber };
  if (terminal.startsWith("rejected_")) return { label: terminal.replace("rejected_", "REJECTED · ").replaceAll("_", " ").toUpperCase(), color: T.red };
  if (terminal.startsWith("passed_") && terminal.endsWith("_awaiting_downstream")) return { label: terminal.replace("passed_", "PASSED · ").replace("_awaiting_downstream", " · AWAITING NEXT GATE").replaceAll("_", " ").toUpperCase(), color: T.blue };
  if (terminal.startsWith("pending_")) return { label: terminal.replace("pending_", "PENDING · ").replaceAll("_", " ").toUpperCase(), color: T.amber };
  if (terminal === "passed_research_no_downstream_data") return { label: "PASSED RESEARCH", color: T.blue };
  return { label: terminal.replaceAll("_", " ").toUpperCase(), color: T.muted };
}
function actionColor(action: string) {
  if (action.includes("EXIT") || action.includes("AVOID") || action.includes("BLOCKED")) return T.red;
  if (action.includes("HOLD") || action.includes("PAPER")) return T.green;
  return T.amber;
}
function formatDate(iso?: string | null) {
  if (!iso) return "Not recorded";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function formatMoney(value: number | null | undefined, currency: "USD" | "INR") {
  if (value == null || !Number.isFinite(Number(value))) return "Not recorded";
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency", currency, maximumFractionDigits: Number(value) < 1 ? 4 : 2,
  }).format(Number(value));
}

function MiniMetric({ label, value, color }: { label: string; value: string; color?: string }) {
  return <div style={{ minWidth: "112px", padding: "9px 11px", background: T.ink, border: `1px solid ${T.border}`, borderRadius: "8px" }}>
    <div style={{ color: T.muted, fontSize: "9px", letterSpacing: ".09em", textTransform: "uppercase", marginBottom: "3px" }}>{label}</div>
    <div style={{ color: color ?? T.text, fontSize: "13px", fontWeight: 750 }}>{value}</div>
  </div>;
}

/**
 * `focusSymbol` is the deep-link target (`/dashboard/research-journal?symbol=…`),
 * used by the Risk Analytics research annotation to jump straight to the entry
 * behind a score. It auto-expands that symbol once its data arrives.
 *
 * The market half of the deep link is applied by the page, not here — this
 * component reads the market from context and must keep doing so, or the URL and
 * the header's market switcher would disagree about which book is on screen.
 */
export default function ResearchFunnel({ focusSymbol }: { focusSymbol?: string | null } = {}) {
  const [date, setDate] = useState(today());
  const [scope, setScope] = useState<"date" | "all">("date");
  const [symbolDraft, setSymbolDraft] = useState("");
  const [symbolFilter, setSymbolFilter] = useState("");
  const { market } = useMarket();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [contexts, setContexts] = useState<Record<string, any>>({});
  const [contextLoading, setContextLoading] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    setData(null); setError(""); setExpanded(new Set()); setContexts({});
    const params = new URLSearchParams({ date, market, scope });
    if (symbolFilter) params.set("symbol", symbolFilter);
    fetch(`/api/agents/research-journal?${params.toString()}`)
      .then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); })
      .then(j => {
        if (!live) return;
        if (scope === "date" && j.count === 0 && j.latest_available_date && j.latest_available_date !== date) { setDate(j.latest_available_date); return; }
        setData(j);
      })
      .catch(e => { if (live) setError(e?.message ?? String(e)); });
    return () => { live = false; };
  }, [date, market, scope, symbolFilter]);

  // Deep-link focus: expand the requested symbol once its row exists. The fetch
  // effect above clears `expanded` on every date/market change, so this must run
  // after the data lands rather than at mount. Only expands a symbol the payload
  // actually contains — a deep link to a symbol with no entry for this market
  // silently expands nothing rather than inventing a row.
  useEffect(() => {
    if (!focusSymbol || !data?.symbols) return;
    const match = data.symbols.find((s: any) => s?.symbol === focusSymbol);
    if (!match) return;
    const key = String(match.observation_id ?? match.symbol);
    setExpanded(current => current.has(key) ? current : new Set(current).add(key));
  }, [focusSymbol, data]);

  function toggle(key: string) {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function applySymbolFilter() {
    setSymbolFilter(symbolDraft.trim().toUpperCase());
  }

  async function loadCurrentContext(symbol: string) {
    setContextLoading(current => new Set(current).add(symbol));
    try {
      const response = await fetch(`/api/agents/research-journal/context?symbol=${encodeURIComponent(symbol)}&market=${market}`);
      const json = await response.json();
      setContexts(current => ({ ...current, [symbol]: response.ok ? json : { available: false, message: json.error ?? "Context request failed." } }));
    } catch {
      setContexts(current => ({ ...current, [symbol]: { available: false, message: "Current context could not be fetched." } }));
    } finally {
      setContextLoading(current => { const next = new Set(current); next.delete(symbol); return next; });
    }
  }

  return <div>
    <div style={{ display: "flex", gap: "10px", marginBottom: "10px", alignItems: "center", flexWrap: "wrap" }}>
      <div style={{ display: "flex", gap: "4px", padding: "3px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px" }}>
        {(["date", "all"] as const).map(option => <button key={option} type="button" onClick={() => setScope(option)}
          style={{ background: scope === option ? T.accent : "transparent", border: 0, borderRadius: "6px", color: scope === option ? "#fff" : T.muted, padding: "5px 10px", fontSize: "11px", fontWeight: 700, cursor: "pointer" }}>
          {option === "date" ? "One date" : "All dates"}
        </button>)}
      </div>
      {scope === "date" && <input aria-label="Journal date" type="date" value={date} onChange={e => setDate(e.target.value)}
        style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "7px", color: T.text, padding: "8px 10px", fontSize: "13px", colorScheme: "dark" }} />}
      <input aria-label="Filter funnel by symbol" value={symbolDraft} onChange={e => setSymbolDraft(e.target.value.toUpperCase())}
        onKeyDown={e => { if (e.key === "Enter") applySymbolFilter(); }} placeholder="Filter symbol"
        style={{ width: "145px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "7px", color: T.text, padding: "8px 10px", fontSize: "12px" }} />
      <button type="button" onClick={applySymbolFilter} style={{ background: T.accent, border: 0, borderRadius: "7px", color: "#fff", padding: "8px 11px", fontSize: "11px", fontWeight: 700, cursor: "pointer" }}>Apply</button>
      {symbolFilter && <button type="button" onClick={() => { setSymbolDraft(""); setSymbolFilter(""); }}
        style={{ background: "transparent", border: `1px solid ${T.border}`, borderRadius: "7px", color: T.textSub, padding: "7px 10px", fontSize: "11px", fontWeight: 700, cursor: "pointer" }}>Clear symbol</button>}
      {data && <span style={{ fontSize: "12px", color: T.muted }}>
        {data.count} {scope === "all" ? "observations" : "symbols · latest decision per symbol"}
        {symbolFilter ? ` · ${symbolFilter}` : ""}
        {data.capped ? ` · newest ${data.limit} shown` : ""}
      </span>}
    </div>
    <div style={{ color: T.muted, fontSize: "11px", marginBottom: "16px" }}>
      Score measures the available evidence. Coverage shows how much applicable evidence was present. Confidence tells you how cautiously to read the conclusion.
    </div>

    {error ? <div style={{ color: T.red, fontSize: "13px" }}>Research journal unavailable: {error.slice(0, 180)}</div>
      : !data ? <div style={{ color: T.muted, fontSize: "13px" }}>Loading research decisions…</div>
      : data.count === 0 ? <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "24px", color: T.muted, textAlign: "center" }}>No research observations exist for this market yet.</div>
      : <div style={{ display: "grid", gap: "12px" }}>
        {data.symbols.map((s: any) => {
          const rowKey = String(s.observation_id ?? s.symbol);
          const open = expanded.has(rowKey);
          const terminal = terminalBadge(s.terminal);
          const ac = actionColor(s.novice.action);
          return <article key={rowKey} style={{ background: T.card, border: `1px solid ${open ? T.accent + "77" : T.border}`, borderRadius: "12px", overflow: "hidden", boxShadow: open ? "0 18px 44px rgba(0,0,0,.22)" : "none" }}>
            <button type="button" aria-expanded={open} onClick={() => toggle(rowKey)} style={{ width: "100%", background: "transparent", border: 0, color: T.text, padding: "16px", cursor: "pointer", textAlign: "left" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "14px", alignItems: "flex-start", flexWrap: "wrap" }}>
                <div>
                  <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontFamily: "Georgia, serif", fontSize: "20px", fontWeight: 700 }}>{open ? "▾" : "▸"} {s.symbol}</span>
                    {scope === "all" && <span style={{ color: T.textSub, fontSize: "10px", border: `1px solid ${T.border}`, padding: "3px 7px", borderRadius: "999px" }}>{s.observed_date}</span>}
                    <span style={{ color: T.muted, fontSize: "10px", border: `1px solid ${T.border}`, padding: "3px 7px", borderRadius: "999px" }}>{s.identity.asset_label}</span>
                    <span style={{ color: s.history.state === "new" ? T.blue : s.history.state === "holding" ? T.green : T.muted, fontSize: "10px", border: `1px solid currentColor`, padding: "3px 7px", borderRadius: "999px" }}>{titleCase(s.history.state)}</span>
                  </div>
                  <div style={{ marginTop: "7px", color: ac, fontWeight: 800, fontSize: "13px", letterSpacing: ".04em" }}>{s.novice.action}</div>
                  <div style={{ marginTop: "4px", color: T.muted, fontSize: "11px" }}>{s.identity.description}</div>
                </div>
                <div style={{ display: "flex", gap: "7px", flexWrap: "wrap" }}>
                  <MiniMetric label="Evidence score" value={`${s.analyst_score}/100`} />
                  <MiniMetric label="Coverage" value={`${percent(s.novice.evidence_coverage)} · ${s.novice.usable_dimensions}/${s.novice.applicable_dimensions}`} color={s.novice.evidence_coverage >= .8 ? T.green : T.amber} />
                  <MiniMetric label="Confidence" value={s.novice.confidence_label} color={s.novice.confidence_label === "High" ? T.green : T.amber} />
                </div>
              </div>
              <div style={{ marginTop: "12px", paddingTop: "11px", borderTop: `1px solid ${T.border}`, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px" }}>
                <div style={{ fontSize: "12px", color: T.textSub, lineHeight: 1.5 }}><span style={{ color: T.muted }}>WHY IT APPEARED</span><br />{s.selection.reason}</div>
                <div style={{ fontSize: "12px", color: T.textSub, lineHeight: 1.5 }}><span style={{ color: T.green }}>STRONGEST EVIDENCE</span><br />{s.novice.strongest_evidence}</div>
                <div style={{ fontSize: "12px", color: T.textSub, lineHeight: 1.5 }}><span style={{ color: T.red }}>MAIN GAP / RISK</span><br />{s.novice.main_risk}</div>
              </div>
              <div style={{ marginTop: "10px", color: T.textSub, fontSize: "12px" }}><b style={{ color: T.text }}>Next:</b> {s.novice.next_step}</div>
            </button>

            {open && <div style={{ borderTop: `1px solid ${T.border}`, padding: "16px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "12px", marginBottom: "12px" }}>
                <section style={{ background: T.surface, padding: "14px", borderRadius: "9px" }}>
                  <div style={{ color: T.muted, fontSize: "10px", letterSpacing: ".1em", textTransform: "uppercase", marginBottom: "7px" }}>Plain-English research view</div>
                  <div style={{ color: T.textSub, fontSize: "13px", lineHeight: 1.65 }}>{s.thesis.summary || "No narrative thesis was recorded. Use the deterministic evidence below."}</div>
                  {s.novice.technical_read.length > 0 && <div style={{ marginTop: "12px", paddingTop: "10px", borderTop: `1px solid ${T.border}` }}>
                    <div style={{ color: T.blue, fontSize: "10px", textTransform: "uppercase", marginBottom: "5px" }}>What the chart says</div>
                    {s.novice.technical_read.map((x: string, i: number) => <div key={i} style={{ color: T.textSub, fontSize: "12px", marginTop: "4px" }}>• {x}</div>)}
                  </div>}
                  <div style={{ marginTop: "10px", padding: "9px 10px", background: T.ink, borderRadius: "7px", color: T.textSub, fontSize: "11px", lineHeight: 1.5 }}><b style={{ color: T.amber }}>Hype check:</b> {s.novice.hype_read}</div>
                </section>
                <section style={{ background: T.surface, padding: "14px", borderRadius: "9px" }}>
                  <div style={{ color: T.muted, fontSize: "10px", letterSpacing: ".1em", textTransform: "uppercase", marginBottom: "7px" }}>History & status</div>
                  <div style={{ fontSize: "12px", color: T.textSub, lineHeight: 1.7 }}>First seen: <b style={{ color: T.text }}>{formatDate(s.history.first_seen)}</b></div>
                  <div style={{ fontSize: "12px", color: T.textSub, lineHeight: 1.7 }}>Recorded observations: <b style={{ color: T.text }}>{s.history.observations_in_window}{s.history.capped ? "+" : ""}</b></div>
                  <div style={{ fontSize: "12px", color: T.textSub, lineHeight: 1.7 }}>Previous score: <b style={{ color: T.text }}>{s.history.previous_score ?? "First observation"}</b></div>
                  {s.history.score_change != null && <div style={{ fontSize: "12px", color: s.history.score_change >= 0 ? T.green : T.red, lineHeight: 1.7 }}>Score change: <b>{s.history.score_change >= 0 ? "+" : ""}{s.history.score_change}</b></div>}
                  <div style={{ marginTop: "8px", fontSize: "10px", fontWeight: 700, color: terminal.color }}>{terminal.label}</div>
                </section>
              </div>

              <section style={{ borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, padding: "12px 0", marginBottom: "14px" }}>
                <div style={{ color: T.muted, fontSize: "10px", letterSpacing: ".1em", textTransform: "uppercase", marginBottom: "8px" }}>Indicative plan at research time</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))", gap: "8px" }}>
                  <MiniMetric label="Reference" value={formatMoney(s.trade_plan.reference_price, s.trade_plan.currency)} />
                  {s.trade_plan.status === "candidate" && <>
                    <MiniMetric label={`Initial risk floor · -${s.trade_plan.stop_loss_pct}%`} value={formatMoney(s.trade_plan.initial_risk_floor, s.trade_plan.currency)} color={T.red} />
                    <MiniMetric label={`Profit objective · +${s.trade_plan.target_pct}%`} value={formatMoney(s.trade_plan.profit_objective, s.trade_plan.currency)} color={T.green} />
                    <MiniMetric label="Horizon" value={`${s.trade_plan.horizon_sessions} sessions`} />
                  </>}
                </div>
                <div style={{ color: T.textSub, fontSize: "11px", lineHeight: 1.5, marginTop: "8px" }}>
                  {s.trade_plan.status === "candidate" ? "Eligible research scenario. PaperTrader re-prices every level from a fresh actual fill."
                    : s.trade_plan.status === "holding_context" ? "Reference only. PositionMonitor owns this holding's executable stop, target, trailing, and time exits."
                    : s.trade_plan.status === "no_entry" ? "No entry plan because this research decision was not eligible for a new long position."
                    : "No reliable point-in-time price was recorded, so no levels are shown."}
                </div>
                <div style={{ color: T.amber, fontSize: "10px", marginTop: "5px" }}>Not an order or guaranteed execution · {s.trade_plan.reference_source} · as of {formatDate(s.trade_plan.reference_as_of)}</div>
                <div style={{ color: s.learning_readiness.ready ? T.green : T.muted, fontSize: "10px", marginTop: "5px" }}>
                  {s.learning_readiness.available
                    ? <>Exit-policy learning: {s.learning_readiness.n}/{s.learning_readiness.required} eligible {market.toUpperCase()} outcomes at this horizon · {s.learning_readiness.ready ? "validated percentile policy available" : "mandate levels remain authoritative"}</>
                    : <>Exit-policy learning readiness unavailable · mandate levels remain authoritative</>}
                </div>
              </section>

              <section style={{ borderBottom: `1px solid ${T.border}`, paddingBottom: "14px", marginBottom: "14px" }}>
                <div style={{ color: T.muted, fontSize: "10px", letterSpacing: ".1em", textTransform: "uppercase", marginBottom: "8px" }}>Current position and realized outcome</div>
                {!s.current_position.paper && !s.current_position.live && !s.realized_outcome
                  ? <div style={{ color: T.muted, fontSize: "11px" }}>No current paper/live position or exact-signal paper outcome is linked to this decision.</div>
                  : <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: "12px" }}>
                    {s.current_position.paper && <div>
                      <div style={{ color: T.blue, fontSize: "10px", textTransform: "uppercase", marginBottom: "6px" }}>Paper position · PositionMonitor owned</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "7px" }}>
                        <MiniMetric label="Actual average cost" value={formatMoney(s.current_position.paper.avg_cost, s.trade_plan.currency)} />
                        <MiniMetric label="Current price" value={formatMoney(s.current_position.paper.current_price, s.trade_plan.currency)} />
                        <MiniMetric label="Current stop" value={formatMoney(s.current_position.paper.current_stop_loss, s.trade_plan.currency)} color={T.red} />
                        <MiniMetric label="Current target" value={formatMoney(s.current_position.paper.price_target, s.trade_plan.currency)} color={T.green} />
                      </div>
                      <div style={{ color: T.muted, fontSize: "10px", marginTop: "6px" }}>Qty {pretty(s.current_position.paper.qty)} · updated {formatDate(s.current_position.paper.updated_at)}</div>
                    </div>}
                    {s.current_position.live && <div>
                      <div style={{ color: s.current_position.live.status === "managed" ? T.green : T.amber, fontSize: "10px", textTransform: "uppercase", marginBottom: "6px" }}>Live holding · {titleCase(s.current_position.live.status)}</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "7px" }}>
                        <MiniMetric label="Broker average cost" value={formatMoney(s.current_position.live.avg_cost, s.trade_plan.currency)} />
                        <MiniMetric label="Snapshot price" value={formatMoney(s.current_position.live.current_price, s.trade_plan.currency)} />
                        {s.current_position.live.status === "managed" && <>
                          <MiniMetric label="Recorded stop" value={formatMoney(s.current_position.live.stop_loss, s.trade_plan.currency)} color={T.red} />
                          <MiniMetric label="Recorded target" value={formatMoney(s.current_position.live.price_target, s.trade_plan.currency)} color={T.green} />
                          <MiniMetric label="Time-stop horizon" value={`${s.current_position.live.horizon_days} market days`} />
                        </>}
                      </div>
                      <div style={{ color: T.muted, fontSize: "10px", marginTop: "6px" }}>Qty {pretty(s.current_position.live.qty)} · snapshot {formatDate(s.current_position.live.snapshot?.captured_at)}</div>
                      {s.current_position.live.status !== "managed" && <div style={{ color: T.amber, fontSize: "10px", lineHeight: 1.45, marginTop: "5px" }}>No exact active-account Kairos fill policy matches this broker holding. The Journal will not invent live protection.</div>}
                    </div>}
                    {s.realized_outcome && <div>
                      <div style={{ color: T.muted, fontSize: "10px", textTransform: "uppercase", marginBottom: "6px" }}>Exact-signal paper outcome</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "7px" }}>
                        <MiniMetric label="Fill" value={formatMoney(s.realized_outcome.fill_price, s.trade_plan.currency)} />
                        <MiniMetric label="Exit" value={formatMoney(s.realized_outcome.exit_price, s.trade_plan.currency)} />
                        <MiniMetric label="P&L" value={s.realized_outcome.pnl_pct == null ? "Open / not recorded" : `${s.realized_outcome.pnl_pct >= 0 ? "+" : ""}${s.realized_outcome.pnl_pct.toFixed(2)}%`} color={s.realized_outcome.pnl_pct == null ? T.muted : s.realized_outcome.pnl_pct >= 0 ? T.green : T.red} />
                      </div>
                      <div style={{ color: T.muted, fontSize: "10px", marginTop: "6px" }}>{s.realized_outcome.exit_reason ? `Exit: ${titleCase(s.realized_outcome.exit_reason)}` : "No exit recorded"} · {formatDate(s.realized_outcome.closed_at ?? s.realized_outcome.executed_at)}</div>
                    </div>}
                  </div>}
              </section>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "10px", marginBottom: "14px" }}>
                <section><div style={{ color: T.green, fontSize: "10px", textTransform: "uppercase", marginBottom: "6px" }}>Recorded catalysts / hypotheses</div>
                  {s.thesis.catalysts.length ? s.thesis.catalysts.map((x: string, i: number) => <div key={i} style={{ color: T.textSub, fontSize: "12px", marginBottom: "4px" }}>+ {x}</div>) : <div style={{ color: T.muted, fontSize: "12px" }}>No catalyst list was recorded.</div>}
                </section>
                <section><div style={{ color: T.red, fontSize: "10px", textTransform: "uppercase", marginBottom: "6px" }}>Risks / counter-evidence</div>
                  {s.counter_evidence.length ? s.counter_evidence.map((x: string, i: number) => <div key={i} style={{ color: T.textSub, fontSize: "12px", marginBottom: "4px" }}>− {x}</div>) : <div style={{ color: T.muted, fontSize: "12px" }}>No specific counter-evidence was recorded.</div>}
                </section>
              </div>

              <section style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "9px", padding: "12px", marginBottom: "14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                  <div>
                    <div style={{ color: T.muted, fontSize: "10px", letterSpacing: ".1em", textTransform: "uppercase" }}>Current news context · separate from this decision</div>
                    <div style={{ color: T.textSub, fontSize: "11px", marginTop: "3px" }}>Loaded only when requested to protect free-provider limits.</div>
                  </div>
                  <button type="button" onClick={() => loadCurrentContext(s.symbol)} disabled={contextLoading.has(s.symbol)} style={{ background: T.ink, border: `1px solid ${T.blue}55`, color: contextLoading.has(s.symbol) ? T.muted : T.blue, borderRadius: "7px", padding: "6px 10px", cursor: contextLoading.has(s.symbol) ? "default" : "pointer", fontSize: "11px" }}>
                    {contextLoading.has(s.symbol) ? "Loading…" : contexts[s.symbol] ? "Refresh current news" : "Load current news"}
                  </button>
                </div>
                {contexts[s.symbol] && <div style={{ marginTop: "10px", borderTop: `1px solid ${T.border}`, paddingTop: "9px" }}>
                  <div style={{ color: T.amber, fontSize: "10px", marginBottom: "7px" }}>{contexts[s.symbol].disclaimer}</div>
                  {contexts[s.symbol].available ? contexts[s.symbol].items.map((item: any, i: number) => <div key={item.url} style={{ padding: "8px 0", borderTop: i ? `1px solid ${T.border}` : "none" }}>
                    <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ color: T.text, fontSize: "12px", fontWeight: 700, textDecoration: "none", lineHeight: 1.45 }}>{item.title} ↗</a>
                    <div style={{ color: T.muted, fontSize: "10px", marginTop: "3px" }}>{item.published_at ? formatDate(item.published_at) : "Publication time unavailable"}{item.sentiment ? ` · provider sentiment: ${item.sentiment}` : ""}</div>
                    {item.summary && <div style={{ color: T.textSub, fontSize: "11px", lineHeight: 1.45, marginTop: "3px" }}>{item.summary}</div>}
                  </div>) : <div style={{ color: T.muted, fontSize: "11px", lineHeight: 1.5 }}>{contexts[s.symbol].message}</div>}
                  {contexts[s.symbol].provider && <div style={{ color: T.muted, fontSize: "9px", marginTop: "7px" }}>Provider: {contexts[s.symbol].provider} · fetched {formatDate(contexts[s.symbol].fetched_at)}</div>}
                </div>}
              </section>

              <div style={{ color: T.muted, fontSize: "10px", letterSpacing: ".1em", textTransform: "uppercase", marginBottom: "7px" }}>Quant audit · how the available-evidence score was built</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "8px", marginBottom: "14px" }}>
                {Object.entries(s.dimensions).map(([dim, d]: [string, any]) => <div key={dim} style={{ background: T.surface, border: `1px solid ${d.state === "ok" ? T.border : T.amber + "44"}`, borderRadius: "8px", padding: "10px", opacity: d.state === "inapplicable" ? .68 : 1 }}>
                  <div style={{ color: T.muted, fontSize: "10px", textTransform: "uppercase" }}>{dim} · {d.state}</div>
                  <div style={{ color: T.text, fontSize: "17px", fontWeight: 800, margin: "3px 0" }}>{d.state === "inapplicable" || d.state === "missing" ? "Not used" : d.score ?? "—"}</div>
                  <div style={{ color: T.textSub, fontSize: "10px" }}>weight {Math.round((d.weight ?? 0) * 100)}% · contributes {d.contribution ?? 0} pts</div>
                  {d.note && <div style={{ color: T.muted, fontSize: "10px", marginTop: "5px", lineHeight: 1.4 }}>{d.note}</div>}
                  {d.state !== "inapplicable" && Object.keys(d.evidence ?? {}).length > 0 && <div style={{ color: T.muted, fontSize: "10px", marginTop: "5px", lineHeight: 1.45 }}>{Object.entries(d.evidence).map(([k, v]) => `${k.replaceAll("_", " ")}: ${pretty(v)}`).join(" · ")}</div>}
                </div>)}
              </div>

              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", padding: "10px 0", borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, marginBottom: "12px" }}>
                <span style={{ color: T.muted, fontSize: "11px", alignSelf: "center" }}>Verify externally:</span>
                {s.external_links.map((link: any) => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer" style={{ color: T.blue, fontSize: "11px", textDecoration: "none", border: `1px solid ${T.blue}44`, padding: "4px 8px", borderRadius: "6px" }}>{link.label} ↗</a>)}
              </div>

              <div style={{ color: T.muted, fontSize: "10px", textTransform: "uppercase", marginBottom: "6px" }}>Pipeline audit trail</div>
              {s.stages.length ? s.stages.map((st: any, i: number) => <div key={i} style={{ fontSize: "12px", color: st.outcome === "rejected" ? T.red : st.outcome === "filled" ? T.green : T.textSub, marginBottom: "3px" }}><b>{st.stage}</b> → {st.outcome}{st.reason ? `: ${st.reason}` : ""}</div>)
                : <div style={{ color: T.muted, fontSize: "12px" }}>No downstream event was recorded for this historical signal.</div>}
            </div>}
          </article>;
        })}
      </div>}
  </div>;
}
