"use client";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280", dim: "#1C1F26",
  accent: "#6366F1", accentBg: "#1E1F3A",
  green: "#34D399", greenBg: "#052E16",
  red: "#F87171", redBg: "#3B0000",
  amber: "#FBBF24", amberBg: "#2D1B00",
  blue: "#60A5FA",
};

function fmt$(n: number) {
  const abs = Math.abs(n);
  const s = abs >= 1000 ? "$" + (abs / 1000).toFixed(1) + "k" : "$" + abs.toFixed(0);
  return n < 0 ? "-" + s : s;
}
function fmtPct(n: number) { return (n >= 0 ? "+" : "") + n.toFixed(1) + "%"; }

function Badge({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <span style={{ fontSize: "10px", fontWeight: 700, padding: "2px 7px", borderRadius: "4px", background: bg, color, letterSpacing: "0.04em" }}>
      {label}
    </span>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
      <div style={{ fontSize: "10px", fontWeight: 700, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "16px" }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function StatRow({ label, value, color, sub }: { label: string; value: string | number; color?: string; sub?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "7px 0", borderBottom: `1px solid ${T.border}44` }}>
      <span style={{ fontSize: "13px", color: T.textSub }}>{label}</span>
      <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "1px" }}>
        <span style={{ fontSize: "13px", fontWeight: 600, color: color ?? T.text }}>{value}</span>
        {sub && <span style={{ fontSize: "10px", color: T.muted }}>{sub}</span>}
      </span>
    </div>
  );
}

function nextWeekdayLabel(): string {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const daysUntilMon = day === 0 ? 1 : day === 6 ? 2 : 1;
  const next = new Date(now);
  next.setDate(now.getDate() + daysUntilMon);
  return next.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) + " 9:00 AM ET";
}

function nextSundayLabel(): string {
  const now = new Date();
  const day = now.getDay();
  const daysUntilSun = day === 0 ? 7 : 7 - day;
  const next = new Date(now);
  next.setDate(now.getDate() + daysUntilSun);
  return next.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) + " 8:00 PM ET";
}

export default function DashboardHome({ profile, paperPortfolio, positions, recentTrades, recentRuns, recentSignals, pendingSignals, recentLog }: {
  profile: any;
  paperPortfolio: any;
  positions: any[];
  recentTrades: any[];
  recentRuns: any[];
  recentSignals: any[];
  pendingSignals: any[];
  recentLog: any[];
}) {
  const nav = paperPortfolio?.nav ?? 10000;
  const cash = paperPortfolio?.cash_balance ?? 10000;
  const totalPnl = nav - 10000;

  // Last-week stats
  const closedTrades = recentTrades.filter(t => t.closed_at);
  const wins = closedTrades.filter(t => t.outcome === "win").length;
  const losses = closedTrades.filter(t => t.outcome === "loss").length;
  const be = closedTrades.filter(t => t.outcome === "breakeven").length;
  const totalRealizedPnl = closedTrades.reduce((s, t) => s + (t.realized_pnl ?? 0), 0);
  const bestTrade = closedTrades.length
    ? closedTrades.reduce((best, t) => (t.pnl_pct ?? 0) > (best.pnl_pct ?? 0) ? t : best, closedTrades[0])
    : null;
  const researchRuns = recentRuns.filter(r => r.agent_type === "research").length;
  const paperFills = recentRuns.filter(r => r.agent_type === "paper_trader").length;
  const learnerRuns = recentRuns.filter(r => r.agent_type === "learner").length;
  const newSignals = recentSignals.filter(s => {
    const d = new Date(s.created_at);
    return Date.now() - d.getTime() < 7 * 24 * 60 * 60 * 1000;
  }).length;

  // This-week stats
  const positionsValue = positions.reduce((s, p) => s + p.qty * (p.current_price ?? p.avg_cost), 0);
  const highConviction = pendingSignals.filter(s => s.analyst_score >= 60);
  const watchList = pendingSignals.filter(s => s.analyst_score >= 55 && s.analyst_score < 60);

  const dateStr = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  return (
    <div style={{ padding: "28px", color: T.text, fontFamily: "'Inter', sans-serif" }}>

      {/* Hero */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "16px", padding: "24px 28px", marginBottom: "20px", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: 0, right: 0, width: "280px", height: "100%", background: `linear-gradient(135deg, ${T.accent}08 0%, #A78BFA0A 100%)`, pointerEvents: "none" }} />
        <div style={{ fontSize: "11px", color: T.muted, marginBottom: "4px" }}>{dateStr}</div>
        <div style={{ fontSize: "26px", fontWeight: 700, letterSpacing: "-0.02em", marginBottom: "6px" }}>
          Morning, {profile?.full_name?.split(" ")[0] || "Investor"}
        </div>
        <div style={{ display: "flex", gap: "28px", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: "11px", color: T.muted, marginBottom: "2px" }}>Paper NAV</div>
            <div style={{ fontSize: "22px", fontWeight: 700 }}>{fmt$(nav)}</div>
          </div>
          <div>
            <div style={{ fontSize: "11px", color: T.muted, marginBottom: "2px" }}>Total P&L</div>
            <div style={{ fontSize: "22px", fontWeight: 700, color: totalPnl >= 0 ? T.green : T.red }}>
              {fmt$(totalPnl)} <span style={{ fontSize: "13px" }}>({fmtPct((totalPnl / 10000) * 100)})</span>
            </div>
          </div>
          <div>
            <div style={{ fontSize: "11px", color: T.muted, marginBottom: "2px" }}>Cash</div>
            <div style={{ fontSize: "22px", fontWeight: 700 }}>{fmt$(cash)}</div>
          </div>
          <div>
            <div style={{ fontSize: "11px", color: T.muted, marginBottom: "2px" }}>Positions</div>
            <div style={{ fontSize: "22px", fontWeight: 700 }}>{positions.length} <span style={{ fontSize: "13px", color: T.muted }}>({fmt$(positionsValue)})</span></div>
          </div>
        </div>
      </div>

      {/* 3-col grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px", marginBottom: "16px" }}>

        {/* Last week */}
        <SectionCard title="Last 7 Days">
          {closedTrades.length === 0 && recentRuns.length === 0 ? (
            <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "16px 0" }}>
              No activity yet — first research run is {nextWeekdayLabel()}
            </div>
          ) : (
            <>
              <StatRow
                label="Closed trades"
                value={closedTrades.length > 0 ? `${wins}W / ${losses}L / ${be}BE` : "—"}
                color={wins > losses ? T.green : losses > wins ? T.red : T.muted}
              />
              {closedTrades.length > 0 && (
                <StatRow
                  label="Realized P&L"
                  value={fmt$(totalRealizedPnl)}
                  color={totalRealizedPnl >= 0 ? T.green : T.red}
                />
              )}
              {bestTrade && (
                <StatRow
                  label="Best trade"
                  value={bestTrade.symbol}
                  color={T.green}
                  sub={fmtPct(bestTrade.pnl_pct ?? 0)}
                />
              )}
              <StatRow label="Research runs" value={researchRuns} />
              <StatRow label="Paper fills" value={paperFills} />
              {learnerRuns > 0 && <StatRow label="Learner runs" value={learnerRuns} />}
              <StatRow label="New signals" value={newSignals} />
              {recentLog.length > 0 && (
                <div style={{ marginTop: "12px", padding: "10px 12px", background: T.dim, borderRadius: "8px", fontSize: "12px", color: T.textSub, fontStyle: "italic", lineHeight: "1.5" }}>
                  "{recentLog[0].note?.slice(0, 120)}{(recentLog[0].note?.length ?? 0) > 120 ? "…" : ""}"
                </div>
              )}
            </>
          )}
        </SectionCard>

        {/* This week / now */}
        <SectionCard title="Right Now">
          {positions.length === 0 && highConviction.length === 0 ? (
            <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "16px 0" }}>
              No open positions or pending signals.<br />Next research: {nextWeekdayLabel()}
            </div>
          ) : (
            <>
              <StatRow label="Open positions" value={positions.length} sub={positions.length > 0 ? fmt$(positionsValue) + " deployed" : undefined} />
              <StatRow label="Cash available" value={fmt$(cash)} sub={`${((cash / nav) * 100).toFixed(0)}% of NAV`} />
              {highConviction.length > 0 && (
                <>
                  <div style={{ fontSize: "11px", color: T.muted, marginTop: "12px", marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    Pending signals (score ≥60)
                  </div>
                  {highConviction.map((s: any) => (
                    <div key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0" }}>
                      <span style={{ fontSize: "13px", fontWeight: 600, color: T.accent }}>{s.symbol}</span>
                      <span style={{ fontSize: "12px", color: T.green }}>score {s.analyst_score}</span>
                    </div>
                  ))}
                </>
              )}
              {watchList.length > 0 && (
                <>
                  <div style={{ fontSize: "11px", color: T.muted, marginTop: "12px", marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    Watch (score 55–59)
                  </div>
                  {watchList.map((s: any) => (
                    <div key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0" }}>
                      <span style={{ fontSize: "13px", color: T.textSub }}>{s.symbol}</span>
                      <span style={{ fontSize: "12px", color: T.amber }}>score {s.analyst_score}</span>
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </SectionCard>

        {/* Upcoming */}
        <SectionCard title="Pipeline">
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <div style={{ padding: "12px", background: T.dim, borderRadius: "8px" }}>
              <div style={{ fontSize: "11px", color: T.muted, marginBottom: "4px" }}>Next research run</div>
              <div style={{ fontSize: "13px", fontWeight: 600, color: T.accent }}>◐ ResearchAgent</div>
              <div style={{ fontSize: "12px", color: T.muted, marginTop: "2px" }}>{nextWeekdayLabel()}</div>
              <div style={{ fontSize: "11px", color: T.muted, marginTop: "4px" }}>Holdings-first → screener → paper fills</div>
            </div>
            <div style={{ padding: "12px", background: T.dim, borderRadius: "8px" }}>
              <div style={{ fontSize: "11px", color: T.muted, marginBottom: "4px" }}>Next learning run</div>
              <div style={{ fontSize: "13px", fontWeight: 600, color: T.blue }}>◫ LearnerAgent</div>
              <div style={{ fontSize: "12px", color: T.muted, marginTop: "2px" }}>{nextSundayLabel()}</div>
              <div style={{ fontSize: "11px", color: T.muted, marginTop: "4px" }}>Closes trades older than 7d, writes outcomes</div>
            </div>
            <div style={{ padding: "12px", background: T.dim, borderRadius: "8px" }}>
              <div style={{ fontSize: "11px", color: T.muted, marginBottom: "4px" }}>Phase 0 status</div>
              <div style={{ fontSize: "13px", fontWeight: 600 }}>
                {closedTrades.length + (recentTrades.filter(t => t.closed_at).length)}/10 trades closed
              </div>
              <div style={{ fontSize: "11px", color: T.muted, marginTop: "4px" }}>
                {closedTrades.length >= 10
                  ? "Phase 1 unlocked — weight mutation available"
                  : `${10 - closedTrades.length} more to unlock weight adaptation (Phase 1)`}
              </div>
            </div>
          </div>
        </SectionCard>
      </div>

      {/* Latest signals strip */}
      {recentSignals.length > 0 && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
            <div style={{ fontSize: "10px", fontWeight: 700, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
              Latest Agent Signals
            </div>
            <a href="/dashboard/activity" style={{ fontSize: "12px", color: T.accent, textDecoration: "none" }}>
              Full log →
            </a>
          </div>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            {recentSignals.map((s: any) => {
              const scoreColor = s.analyst_score >= 70 ? T.green : s.analyst_score >= 60 ? T.amber : T.muted;
              const dirColor = s.direction === "long" ? T.green : s.direction === "short" ? T.red : T.amber;
              return (
                <div key={s.id} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "10px 14px", minWidth: "120px" }}>
                  <div style={{ fontWeight: 800, fontSize: "14px", marginBottom: "4px", color: T.text }}>{s.symbol}</div>
                  <div style={{ fontSize: "11px", marginBottom: "3px" }}>
                    <span style={{ color: dirColor, fontWeight: 600 }}>{s.direction?.toUpperCase()}</span>
                    <span style={{ color: scoreColor, fontWeight: 700 }}> · {s.analyst_score}</span>
                  </div>
                  <div>
                    {s.status === "paper_traded"
                      ? <Badge label="FILLED" color={T.green} bg={T.greenBg} />
                      : s.status === "pending"
                      ? <Badge label="PENDING" color={T.muted} bg={T.dim} />
                      : <Badge label={s.status?.toUpperCase()} color={T.muted} bg={T.dim} />}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {recentSignals.length === 0 && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "32px", textAlign: "center" }}>
          <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "8px" }}>No signals yet</div>
          <div style={{ fontSize: "13px", color: T.muted, marginBottom: "16px" }}>
            Run ResearchAgent to generate the first signals. Next auto-run: {nextWeekdayLabel()}.
          </div>
          <a href="/dashboard/agents" style={{ display: "inline-block", padding: "9px 20px", borderRadius: "8px", background: T.accent, color: "#fff", fontSize: "13px", fontWeight: 600, textDecoration: "none" }}>
            Go to Agents →
          </a>
        </div>
      )}

      {/* Activity feed */}
      {(recentRuns.length > 0 || recentTrades.length > 0 || recentLog.length > 0) && (() => {
        type AEvent = { ts: number; icon: string; label: string; sub: string; color: string };
        const events: AEvent[] = [
          ...recentRuns.map((r: any) => ({
            ts: new Date(r.completed_at ?? r.created_at).getTime(),
            icon: "◐",
            label: `${r.agent_type === "research" ? "ResearchAgent" : r.agent_type === "paper_trader" ? "PaperTrader" : "LearnerAgent"} run`,
            sub: r.status === "success" ? "completed" : r.status ?? "ran",
            color: r.status === "success" ? T.green : T.muted,
          })),
          ...recentTrades.map((t: any) => ({
            ts: new Date(t.executed_at).getTime(),
            icon: "◈",
            label: `${t.order_side?.toUpperCase() === "BUY" ? "Bought" : "Sold"} ${t.symbol}`,
            sub: `${t.qty}sh @ $${t.fill_price?.toFixed(2)}${t.outcome ? ` · ${t.outcome} ${t.pnl_pct != null ? (t.pnl_pct >= 0 ? "+" : "") + t.pnl_pct.toFixed(1) + "%" : ""}` : ""}`,
            color: t.outcome === "win" ? T.green : t.outcome === "loss" ? T.red : T.textSub,
          })),
          ...recentLog.map((l: any) => ({
            ts: new Date(l.created_at).getTime(),
            icon: "◫",
            label: "Learner note",
            sub: l.note?.slice(0, 100) + (l.note?.length > 100 ? "…" : ""),
            color: T.blue,
          })),
        ].sort((a, b) => b.ts - a.ts).slice(0, 8);

        return (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px", marginTop: "16px" }}>
            <div style={{ fontSize: "10px", fontWeight: 700, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "14px" }}>
              Recent Activity
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>
              {events.map((e, i) => (
                <div key={i} style={{ display: "flex", gap: "12px", paddingBottom: i < events.length - 1 ? "12px" : "0", marginBottom: i < events.length - 1 ? "12px" : "0", borderBottom: i < events.length - 1 ? `1px solid ${T.border}44` : "none" }}>
                  <div style={{ width: "20px", textAlign: "center", color: e.color, fontSize: "13px", paddingTop: "1px", flexShrink: 0 }}>{e.icon}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: "13px", fontWeight: 500, color: T.text }}>{e.label}</div>
                    <div style={{ fontSize: "12px", color: T.muted, marginTop: "2px" }}>{e.sub}</div>
                  </div>
                  <div style={{ fontSize: "11px", color: T.muted, flexShrink: 0, paddingTop: "2px" }}>
                    {new Date(e.ts).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

    </div>
  );
}
