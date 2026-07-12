"use client";
import { useState, useEffect } from "react";
import PageHeader from "@/components/dashboard/PageHeader";
import ResearchFunnel from "@/components/dashboard/ResearchFunnel";
import { useMarket } from "@/lib/market-context";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", accentBg: "#1E1F3A",
  green: "#34D399", red: "#F87171", amber: "#FBBF24", blue: "#60A5FA",
};

function todayStr() { return new Date().toISOString().slice(0, 10); }

function terminalBadge(terminal: string) {
  if (terminal === "filled") return { label: "FILLED", color: T.green };
  if (terminal.startsWith("rejected_research")) return { label: "REJECTED · Research", color: T.red };
  if (terminal.startsWith("rejected_portfolio_constructor")) return { label: "REJECTED · Portfolio Constructor", color: T.red };
  if (terminal.startsWith("rejected_execution")) return { label: "REJECTED · Execution", color: T.red };
  if (terminal.startsWith("pending_")) return { label: `PENDING · ${terminal.replace("pending_", "")}`, color: T.amber };
  if (terminal === "passed_research_no_downstream_data") return { label: "PASSED research (no downstream data yet)", color: T.blue };
  return { label: terminal, color: T.muted };
}

function FunnelTab() {
  const [date, setDate] = useState(todayStr());
  const { market } = useMarket();
  const [data, setData] = useState<any>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch(`/api/agents/research-journal?date=${date}&market=${market}`).then(r => r.json()).then(setData).catch(() => {});
  }, [date, market]);

  function toggle(symbol: string) {
    const next = new Set(expanded);
    if (next.has(symbol)) next.delete(symbol); else next.add(symbol);
    setExpanded(next);
  }

  return (
    <div>
      <div style={{ display: "flex", gap: "10px", marginBottom: "16px", alignItems: "center" }}>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "6px", color: T.text, padding: "8px 10px", fontSize: "13px" }} />
        {data && <span style={{ fontSize: "12px", color: T.muted }}>{data.count} symbol{data.count === 1 ? "" : "s"} scored</span>}
      </div>

      {!data ? (
        <div style={{ fontSize: "13px", color: T.muted }}>Loading…</div>
      ) : data.count === 0 ? (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "24px", fontSize: "13px", color: T.muted, textAlign: "center" as const }}>
          No candidates scored yet — research runs at 9 AM ET.
        </div>
      ) : (
        <div style={{ display: "grid", gap: "8px" }}>
          {data.symbols.map((s: any) => {
            const badge = terminalBadge(s.terminal);
            const isOpen = expanded.has(s.symbol);
            return (
              <div key={s.symbol} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px", overflow: "hidden" }}>
                <div onClick={() => toggle(s.symbol)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", cursor: "pointer" }}>
                  <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                    <span style={{ fontSize: "14px", fontWeight: 700, color: T.text }}>{s.symbol}</span>
                    {s.run_count > 1 && <span title="Research ran more than once today (manual re-trigger or scheduled + test) — showing the latest scoring" style={{ fontSize: "11px", color: T.muted, cursor: "help" }}>×{s.run_count} runs</span>}
                    <span style={{ fontSize: "12px", color: T.textSub }}>score {s.analyst_score} (thresh {s.score_threshold})</span>
                    {s.screener && <span style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "4px", background: T.accentBg, color: T.accent }}>{s.screener.bucket}</span>}
                  </div>
                  <span style={{ fontSize: "11px", fontWeight: 700, padding: "3px 10px", borderRadius: "5px", background: `${badge.color}22`, color: badge.color, border: `1px solid ${badge.color}44` }}>{badge.label}</span>
                </div>
                {isOpen && (
                  <div style={{ padding: "0 16px 16px", borderTop: `1px solid ${T.border}` }}>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "8px", margin: "12px 0", fontSize: "11px" }}>
                      {Object.entries(s.scores).map(([dim, val]: [string, any]) => {
                        const w = s.weighting?.applied_weights?.[dim];
                        const excluded = s.weighting?.renormalized && !s.weighting.included_dims.includes(dim);
                        return (
                          <div key={dim} style={{ opacity: excluded ? 0.4 : 1 }}>
                            <div style={{ color: T.muted, textTransform: "uppercase" as const }}>{dim}{w != null ? ` (${Math.round(w * 100)}%)` : ""}</div>
                            <div style={{ color: T.text, fontWeight: 700 }}>{val ?? "—"}</div>
                            {s.notes[dim] && <div style={{ color: T.muted, marginTop: "2px" }}>{s.notes[dim]}{excluded ? " — excluded from score" : ""}</div>}
                          </div>
                        );
                      })}
                    </div>
                    {s.weighting?.renormalized && (
                      <div style={{ fontSize: "11px", color: T.blue, marginBottom: "10px" }}>
                        Reweighted: {s.weighting.included_dims.join(", ")} only ({5 - s.weighting.included_dims.length} dimension{5 - s.weighting.included_dims.length === 1 ? "" : "s"} excluded as inapplicable/unavailable, not counted as neutral).
                      </div>
                    )}
                    {s.screener && (
                      <div style={{ fontSize: "12px", color: T.textSub, marginBottom: "10px" }}>
                        Screener: <b>{s.screener.bucket}</b> — {s.screener.criteria_matched?.join(", ")}
                      </div>
                    )}
                    <div style={{ fontSize: "11px", color: T.muted, marginBottom: "6px", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>Pipeline stages</div>
                    {s.stages.length === 0 ? (
                      <div style={{ fontSize: "12px", color: T.muted }}>No downstream stage data (pre-instrumentation or not yet processed).</div>
                    ) : (
                      <div style={{ display: "grid", gap: "4px" }}>
                        {s.stages.map((st: any, i: number) => (
                          <div key={i} style={{ fontSize: "12px", color: st.outcome === "rejected" ? T.red : st.outcome === "filled" ? T.green : T.textSub }}>
                            <b>{st.stage}</b> → {st.outcome}{st.reason ? `: ${st.reason}` : ""}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EvolutionTab() {
  const { market } = useMarket();
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    fetch(`/api/agents/research-journal/evolution?market=${market}&days=90`).then(r => r.json()).then(setData).catch(() => {});
  }, [market]);

  if (!data) return <div style={{ fontSize: "13px", color: T.muted }}>Loading…</div>;

  const Card = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px 18px", marginBottom: "12px" }}>
      <div style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "0.08em", color: T.muted, textTransform: "uppercase" as const, marginBottom: "10px" }}>{title}</div>
      {children}
    </div>
  );

  return (
    <div>
      <Card title="LearnerAgent weight changes">
        {!data.learner.enoughHistory ? (
          <div style={{ fontSize: "12px", color: T.muted }}>Only {data.learner.runsCount} learner run(s) in the last 90 days — not enough history to show a trend yet.</div>
        ) : (
          <div style={{ display: "grid", gap: "4px" }}>
            {data.learner.weightSeries.map((w: any, i: number) => (
              <div key={i} style={{ fontSize: "12px", color: T.textSub }}>{w.date}: win rate {w.win_rate != null ? `${w.win_rate}%` : "—"}, mutations: {JSON.stringify(w.mutations)}</div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Feature registry timeline">
        {!data.featureRegistry.enoughHistory ? (
          <div style={{ fontSize: "12px", color: T.muted }}>Only {data.featureRegistry.events.length} status change(s) in the last 90 days — not enough history yet.</div>
        ) : (
          <div style={{ display: "grid", gap: "4px" }}>
            {data.featureRegistry.events.map((f: any, i: number) => (
              <div key={i} style={{ fontSize: "12px", color: T.textSub }}>{new Date(f.date).toLocaleDateString()}: feature #{f.feature_id} {f.from ?? "new"} → <b>{f.to}</b>{f.reason ? ` (${f.reason})` : ""}</div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Calibration drift">
        {!data.calibration.enoughHistory ? (
          <div style={{ fontSize: "12px", color: T.muted }}>Only {data.calibration.series.length} calibration fit(s) in the last 90 days — not enough history yet.</div>
        ) : (
          <div style={{ display: "grid", gap: "4px" }}>
            {data.calibration.series.map((c: any, i: number) => (
              <div key={i} style={{ fontSize: "12px", color: T.textSub }}>{new Date(c.date).toLocaleDateString()}: n={c.n_observations}, brier={c.brier ?? "—"}</div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Shadow decisions (challenger vs champion)">
        {!data.shadow.enoughHistory ? (
          <div style={{ fontSize: "12px", color: T.muted }}>Only {data.shadow.decisionsCount} shadow decision(s) in the last 90 days — not enough history yet.</div>
        ) : (
          <div style={{ fontSize: "12px", color: T.textSub }}>{data.shadow.decisionsCount} shadow decisions, {data.shadow.wouldEnterPct}% would-enter rate (not champion agreement — no such comparison is computed yet).</div>
        )}
      </Card>
    </div>
  );
}

export default function ResearchJournalPage() {
  const [tab, setTab] = useState<"funnel" | "evolution">("funnel");

  return (
    <div style={{ color: T.text, fontFamily: "'Inter', sans-serif" }}>
      <PageHeader
        title="Research Journal"
        subtitle="Why the agent did (or didn't) act, and how the learning loop is evolving"
        whatItDoes="Daily Funnel shows every symbol scored today with its full score breakdown, screener bucket, and pass/reject reason at each pipeline stage (research → portfolio constructor → execution). Evolution shows longer-horizon trends: learner weight changes, feature-registry promotions, calibration drift, shadow-decision agreement."
        whatToLookFor={[
          "A rejected symbol always has a reason — score breakdown, threshold, or a Portfolio Constructor limit.",
          "Evolution tab is honest about thin history — it won't draw a trend from 1-2 data points.",
        ]}
      />
      <div style={{ padding: "0 28px 32px" }}>
        <div style={{ display: "flex", gap: "8px", marginBottom: "20px" }}>
          {(["funnel", "evolution"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: "8px 18px", borderRadius: "8px", cursor: "pointer", fontSize: "13px", fontWeight: 600,
              background: tab === t ? T.accentBg : T.surface, border: `1px solid ${tab === t ? T.accent : T.border}`,
              color: tab === t ? T.accent : T.textSub,
            }}>
              {t === "funnel" ? "Daily Funnel" : "Evolution"}
            </button>
          ))}
        </div>
        {tab === "funnel" ? <ResearchFunnel /> : <EvolutionTab />}
      </div>
    </div>
  );
}
