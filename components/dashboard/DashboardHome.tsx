"use client";
import { useState, useEffect } from "react";
import WatchlistPanel from "@/components/dashboard/WatchlistPanel";
import BriefingSection from "@/components/dashboard/BriefingSection";
import GoalCard from "@/components/dashboard/GoalCard";
import AgentCalendar from "@/components/dashboard/AgentCalendar";
import SystemHealthCard from "@/components/dashboard/SystemHealthCard";
import { useRevealToggle, maskText, EyeToggle } from "@/components/dashboard/PrivacyMask";
import { fmtMoneyAbbrev } from "@/lib/format-money";

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

function ExpandableStatRow({ label, value, color, sub, children }: {
  label: string; value: string | number; color?: string; sub?: string; children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!children;
  return (
    <div>
      <div
        onClick={() => hasDetail && setOpen(o => !o)}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "7px 0", borderBottom: `1px solid ${T.border}44`, cursor: hasDetail ? "pointer" : "default", userSelect: "none" }}
      >
        <span style={{ fontSize: "13px", color: T.textSub, display: "flex", alignItems: "center", gap: "5px" }}>
          {hasDetail && <span style={{ fontSize: "9px", color: T.muted, transition: "transform 0.15s", display: "inline-block", transform: open ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>}
          {label}
        </span>
        <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "1px" }}>
          <span style={{ fontSize: "13px", fontWeight: 600, color: color ?? T.text }}>{value}</span>
          {sub && <span style={{ fontSize: "10px", color: T.muted }}>{sub}</span>}
        </span>
      </div>
      {open && hasDetail && (
        <div style={{ background: T.dim, borderRadius: "8px", margin: "4px 0 6px", padding: "8px 10px", maxHeight: "240px", overflowY: "auto" }}>
          {children}
        </div>
      )}
    </div>
  );
}

function DetailItem({ left, right, color, sub }: { left: string; right: string; color?: string; sub?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: `1px solid ${T.border}33`, fontSize: "11px" }}>
      <span style={{ color: T.textSub }}>{left}</span>
      <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
        <span style={{ color: color ?? T.text, fontWeight: 600 }}>{right}</span>
        {sub && <span style={{ color: T.muted, fontSize: "10px" }}>{sub}</span>}
      </span>
    </div>
  );
}

function safeDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
function fmtDate(v: string | null | undefined, opts?: Intl.DateTimeFormatOptions): string {
  const d = safeDate(v);
  if (!d) return "—";
  return d.toLocaleString("en-US", opts ?? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function nextWeekdayLabel(): string {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const daysUntilMon = day === 0 ? 1 : day === 6 ? 2 : 1;
  const next = new Date(now);
  next.setDate(now.getDate() + daysUntilMon);
  return next.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) + " 9:00 AM ET";
}

// LearnerAgent runs Friday 5:00 PM ET (Windows Task Scheduler: FridayTrigger 5PM;
// the route gates on getDay()===5). Keep this in sync with scripts/register-tasks.ps1.
function nextFridayLabel(): string {
  const now = new Date();
  const day = now.getDay(); // 0=Sun … 5=Fri
  let addDays = (5 - day + 7) % 7; // days until next Friday
  // If today is Friday but past 5 PM local, roll to next Friday.
  if (addDays === 0 && now.getHours() >= 17) addDays = 7;
  const next = new Date(now);
  next.setDate(now.getDate() + addDays);
  return next.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) + " 5:00 PM ET";
}

export default function DashboardHome({ profile, paperPortfolio, positions, recentTrades, recentRuns, recentSignals, pendingSignals, recentLog, liveSnap, latestBriefing, mkt = "us" }: {
  profile: any;
  paperPortfolio: any;
  positions: any[];
  recentTrades: any[];
  recentRuns: any[];
  recentSignals: any[];
  pendingSignals: any[];
  recentLog: any[];
  liveSnap: any | null;
  latestBriefing: any | null;
  mkt?: "us" | "india";
}) {
  // The whole hero follows the global US/India switch (page.tsx scopes every query
  // to `mkt` and passes it here). Currency symbol AND the P&L baseline are
  // per-market: the US paper pool seeds at $10k, the India pool at ₹10,00,000.
  // Previously the hero hardcoded "$" and a /10000 baseline, so when the switch was
  // on India it showed the ₹ pool as "$…" with a nonsense % (e.g. +8372%).
  const isIndia = mkt === "india";
  const SEED = isIndia ? 1_000_000 : 10_000;
  const nav = paperPortfolio?.nav ?? SEED;
  const cash = paperPortfolio?.cash_balance ?? SEED;
  const totalPnl = nav - SEED;
  const pnlPct = SEED > 0 ? (totalPnl / SEED) * 100 : 0;
  const { masked: liveNumbersMasked, setRevealed: setLiveRevealed } = useRevealToggle();

  // Market-aware money formatter for the PAPER hero (the live Robinhood panel
  // stays $ — it's a US account, fmt$ above). The hero shows compact values, so
  // route through the shared abbrev helper: India gives ₹8.47L / ₹2.30Cr with the
  // lakh/crore convention; US is unchanged ($9.9k / $1.2M).
  const fmtMoney = (n: number) => fmtMoneyAbbrev(n, mkt);

  // LLM burn rate banner
  const [llmAlert, setLlmAlert] = useState(false);
  const [burnRate, setBurnRate] = useState("0.0000");
  const [projected, setProjected] = useState("0.00");

  useEffect(() => {
    fetch("/api/admin/llm-costs")
      .then(r => r.json())
      .then(d => {
        if (d.projectedDaily > 2) {
          setLlmAlert(true);
          setBurnRate(String(d.burnRateHourly.toFixed(4)));
          setProjected(String(d.projectedDaily.toFixed(2)));
        }
      })
      .catch(() => {});
  }, []);

  // Macro regime banner
  const [macroRegime, setMacroRegime] = useState<string | null>(null);
  const [macroSummary, setMacroSummary] = useState<string>("");

  useEffect(() => {
    fetch("/api/agents/macro-sentinel/history")
      .then(r => r.json())
      .then(d => {
        const top = d?.regimes?.[0];
        if (top?.regime && top.regime !== "green") {
          setMacroRegime(top.regime);
          setMacroSummary(top.summary ?? "");
        }
      })
      .catch(() => {});
  }, []);

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
    <div style={{ padding: "clamp(12px, 4vw, 28px)", color: T.text, fontFamily: "'Inter', sans-serif" }}>

      {/* Daily Briefing — moved to the TOP: it's the "start your day" summary and
          was previously buried below the 30-day agent calendar, System Health, the
          NAV hero and the goal tracker, so it was easy to miss entirely. */}
      <div style={{ marginBottom: "16px" }}>
        <BriefingSection initialBriefing={latestBriefing} />
      </div>

      <AgentCalendar />

      <SystemHealthCard />

      {/* Hero — two-section: paper left, live right */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "12px", marginBottom: "20px" }}>

        {/* Paper portfolio */}
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "16px", padding: "20px clamp(14px,4vw,28px)", position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", top: 0, right: 0, width: "280px", height: "100%", background: `linear-gradient(135deg, ${T.accent}08 0%, #A78BFA0A 100%)`, pointerEvents: "none" }} />
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
            <div style={{ fontSize: "11px", color: T.muted }}>{dateStr}</div>
            <span style={{ fontSize: "10px", fontWeight: 800, padding: "2px 8px", borderRadius: "4px", background: T.amberBg, color: T.amber, letterSpacing: "0.08em" }}>PAPER</span>
          </div>
          <div style={{ fontSize: "22px", fontWeight: 700, letterSpacing: "-0.02em", marginBottom: "14px" }}>
            Morning, {profile?.full_name?.split(" ")[0] || "Investor"}
          </div>
          <div style={{ display: "flex", gap: "28px", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: "11px", color: T.muted, marginBottom: "2px" }}>NAV</div>
              <div style={{ fontSize: "22px", fontWeight: 700 }}>{fmtMoney(nav)}</div>
            </div>
            <div>
              <div style={{ fontSize: "11px", color: T.muted, marginBottom: "2px" }}>P&L</div>
              <div style={{ fontSize: "22px", fontWeight: 700, color: totalPnl >= 0 ? T.green : T.red }}>
                {fmtMoney(totalPnl)} <span style={{ fontSize: "13px" }}>({fmtPct(pnlPct)})</span>
              </div>
            </div>
            <div>
              <div style={{ fontSize: "11px", color: T.muted, marginBottom: "2px" }}>Cash</div>
              <div style={{ fontSize: "22px", fontWeight: 700 }}>{fmtMoney(cash)}</div>
            </div>
            <div>
              <div style={{ fontSize: "11px", color: T.muted, marginBottom: "2px" }}>Positions</div>
              <div style={{ fontSize: "22px", fontWeight: 700 }}>{positions.length} <span style={{ fontSize: "13px", color: T.muted }}>({fmtMoney(positionsValue)})</span></div>
            </div>
          </div>
        </div>

        {/* Live accounts panel */}
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "16px", padding: "20px 22px", minWidth: "220px", maxWidth: "100%", display: "flex", flexDirection: "column", gap: "10px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
            <div style={{ fontSize: "10px", fontWeight: 800, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>{isIndia ? "Live Zerodha Kite" : "Live Robinhood"}</div>
            <EyeToggle masked={liveNumbersMasked} onToggle={() => setLiveRevealed(r => !r)} />
          </div>

          {/* India view: the live broker is Zerodha Kite, not Robinhood (US-only).
             Kite holdings render fully on Live Portfolio (India) — link there rather
             than showing a US Robinhood account under the India switch. */}
          {isIndia && (
            <div style={{ padding: "10px 12px", background: T.dim, borderRadius: "10px", borderLeft: `3px solid ${T.green}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                <span style={{ fontSize: "11px", color: T.muted }}>🇮🇳 Zerodha Kite · REAL MONEY</span>
                <a href="/dashboard/live-portfolio" style={{ fontSize: "10px", fontWeight: 700, color: T.green, textDecoration: "none" }}>VIEW →</a>
              </div>
              <div style={{ fontSize: "12px", color: T.textSub }}>Live NSE/BSE holdings + P&L (₹) on Live Portfolio.</div>
              <div style={{ fontSize: "11px", color: T.muted, marginTop: "2px" }}>Re-login daily in Settings → Kite if the session expired.</div>
            </div>
          )}

          {!isIndia && (<>
          <div style={{ padding: "10px 12px", background: T.dim, borderRadius: "10px", borderLeft: `3px solid ${T.blue}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
              <span style={{ fontSize: "11px", color: T.muted }}>••••8641 · READ-ONLY</span>
              <a href="/dashboard/live-portfolio" style={{ fontSize: "10px", fontWeight: 700, color: T.blue, textDecoration: "none" }}>VIEW →</a>
            </div>
            {liveSnap ? (
              <>
                <div style={{ display: "flex", gap: "16px", marginBottom: "5px", flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontSize: "9px", color: T.muted, marginBottom: "1px" }}>Live Equity</div>
                    <div style={{ fontSize: "14px", fontWeight: 700 }}>{maskText(`$${Number(liveSnap.equity ?? liveSnap.portfolio_value ?? 0).toFixed(0)}`, liveNumbersMasked)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: "9px", color: T.muted, marginBottom: "1px" }}>Buying Power</div>
                    <div style={{ fontSize: "14px", fontWeight: 700, color: T.green }}>{maskText(`$${Number(liveSnap.buying_power ?? 0).toFixed(0)}`, liveNumbersMasked)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: "9px", color: T.muted, marginBottom: "1px" }}>Positions</div>
                    <div style={{ fontSize: "14px", fontWeight: 700 }}>{liveNumbersMasked ? "••" : (liveSnap.position_count ?? "—")}</div>
                  </div>
                </div>
                {Array.isArray(liveSnap.positions_json) && liveSnap.positions_json.length > 0 && (
                  <div style={{ fontSize: "10px", color: T.muted, marginBottom: "4px" }}>
                    {liveNumbersMasked ? "••••• · ••••• · •••••" : (
                      <>
                        {liveSnap.positions_json.slice(0, 4).map((p: any) => p.symbol).join(" · ")}
                        {liveSnap.positions_json.length > 4 ? ` +${liveSnap.positions_json.length - 4}` : ""}
                      </>
                    )}
                  </div>
                )}
                <div style={{ fontSize: "9px", color: T.muted, marginTop: "3px" }}>
                  Synced {fmtDate(liveSnap.captured_at, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  {" · "}
                  <span style={{ color: T.muted + "88" }}>updates each research run</span>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: "12px", color: T.textSub, marginBottom: "3px" }}>Not yet synced</div>
                <div style={{ fontSize: "11px", color: T.muted }}>Syncs automatically on next research run (daily 9 AM)</div>
              </>
            )}
          </div>

          <div style={{ padding: "10px 12px", background: T.dim, borderRadius: "10px", borderLeft: `3px solid ${T.red}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "3px" }}>
              <span style={{ fontSize: "11px", color: T.muted }}>••••0660 · AGENTIC</span>
              <span style={{ fontSize: "10px", fontWeight: 700, color: T.red }}>DISABLED</span>
            </div>
            <div style={{ fontSize: "12px", color: T.muted }}>TraderAgent real orders off</div>
            <div style={{ fontSize: "11px", color: T.muted }}>Enable trading_enabled in Settings → Strategy</div>
          </div>
          </>)}
        </div>
      </div>

      {/* (The separate always-on India block was removed: the hero above now IS the
          selected market — driven by the global US/India switch — so India showed
          twice and with a broken $/baseline. One switch-driven hero is the fix.) */}

      {/* Goal tracker — measured dashboard only, never an agent input (Decision 34) */}
      <GoalCard />

      {/* Macro regime banner — only shows when regime != green */}
      {macroRegime && macroRegime !== "green" && (
        <div style={{ padding: "8px 14px", borderRadius: 8,
          background: macroRegime === "red" ? "#2a0000" : macroRegime === "orange" ? "#2a1000" : "#1a1500",
          border: `1px solid ${macroRegime === "red" ? "#7f1d1d" : macroRegime === "orange" ? "#7c2d12" : "#78350f"}`,
          display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <span style={{ fontSize: 14 }}>📊</span>
          <span style={{ fontSize: 12, color: macroRegime === "red" ? "#F87171" : macroRegime === "orange" ? "#FB923C" : "#FBBF24" }}>
            Macro Sentinel: {macroRegime.toUpperCase()} — {macroSummary}
          </span>
        </div>
      )}

      {/* LLM burn rate banner — only shows when projected daily > $2 */}
      {llmAlert && (
        <div style={{ padding: "8px 14px", borderRadius: 8, background: "#2a1f00",
          border: "1px solid #92400e", display: "flex", alignItems: "center", gap: 10,
          marginBottom: 12 }}>
          <span style={{ fontSize: 14 }}>💸</span>
          <span style={{ fontSize: 12, color: "#FBBF24" }}>
            LLM burn rate: ${burnRate}/hr · projected today: ${projected}
          </span>
        </div>
      )}

      {/* 3-col grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "16px", marginBottom: "16px" }}>

        {/* Last week */}
        <SectionCard title="Last 7 Days">
          {closedTrades.length === 0 && recentRuns.length === 0 ? (
            <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "16px 0" }}>
              No activity yet — first research run is {nextWeekdayLabel()}
            </div>
          ) : (
            <>
              <ExpandableStatRow
                label="Closed trades"
                value={closedTrades.length > 0 ? `${wins}W / ${losses}L / ${be}BE` : "—"}
                color={wins > losses ? T.green : losses > wins ? T.red : T.muted}
              >
                {closedTrades.length > 0 ? closedTrades.map((t: any) => (
                  <DetailItem
                    key={t.id}
                    left={`${t.symbol} · ${new Date(t.closed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                    right={t.realized_pnl != null ? fmtMoney(t.realized_pnl) : "—"}
                    color={t.outcome === "win" ? T.green : t.outcome === "loss" ? T.red : T.muted}
                    sub={t.pnl_pct != null ? fmtPct(t.pnl_pct) : t.outcome}
                  />
                )) : <span style={{ color: T.muted, fontSize: "11px" }}>No closed trades yet</span>}
              </ExpandableStatRow>
              {closedTrades.length > 0 && (
                <StatRow
                  label="Realized P&L"
                  value={fmtMoney(totalRealizedPnl)}
                  color={totalRealizedPnl >= 0 ? T.green : T.red}
                />
              )}
              {bestTrade && (
                <StatRow label="Best trade" value={bestTrade.symbol} color={T.green} sub={fmtPct(bestTrade.pnl_pct ?? 0)} />
              )}
              <ExpandableStatRow label="Research runs" value={researchRuns}>
                {recentRuns.filter((r: any) => r.agent_type === "research").map((r: any) => {
                  const syms = Array.isArray(r.symbols) ? r.symbols : [];
                  return (
                    <DetailItem
                      key={r.id}
                      left={fmtDate(r.completed_at ?? r.created_at)}
                      right={r.signals_written != null ? `${r.signals_written} signal${r.signals_written !== 1 ? "s" : ""}` : r.status ?? "ran"}
                      color={r.status === "done" || r.status === "success" ? T.green : T.amber}
                      sub={syms.length > 0 ? `Researched: ${syms.slice(0, 5).join(", ")}${syms.length > 5 ? ` +${syms.length - 5} more` : ""}` : r.result_summary?.slice(0, 80) ?? ""}
                    />
                  );
                })}
              </ExpandableStatRow>
              <ExpandableStatRow label="Paper fills" value={paperFills}>
                {recentTrades.filter((t: any) => !t.closed_at).slice(0, 15).map((t: any) => (
                  <DetailItem
                    key={t.id}
                    left={`${t.symbol} · ${(t.order_side ?? t.direction ?? "BUY").toUpperCase()} · ${fmtDate(t.executed_at ?? t.created_at, { month: "short", day: "numeric" })}`}
                    right={t.fill_price != null ? `$${Number(t.fill_price).toFixed(2)}` : t.entry_price != null ? `$${Number(t.entry_price).toFixed(2)}` : "—"}
                    color={t.direction === "long" || t.order_side === "buy" ? T.green : T.red}
                    sub={`${t.qty ?? "?"} shares · analyst score ${t.analyst_score ?? t.conviction ?? "?"}`}
                  />
                ))}
              </ExpandableStatRow>
              {learnerRuns > 0 && <StatRow label="Learner runs" value={learnerRuns} />}
              <ExpandableStatRow label="New signals" value={newSignals}>
                {recentSignals.slice(0, 20).map((s: any) => (
                  <DetailItem
                    key={s.id}
                    left={`${s.symbol} · ${(s.direction ?? s.action ?? "neutral").toUpperCase()}`}
                    right={s.analyst_score != null ? `Score ${s.analyst_score}` : "—"}
                    color={s.direction === "long" ? T.green : s.direction === "short" ? T.red : T.muted}
                    sub={[fmtDate(s.created_at, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }), s.conviction ? `conviction: ${s.conviction}` : null, s.status].filter(Boolean).join(" · ")}
                  />
                ))}
              </ExpandableStatRow>
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
              <StatRow label="Open positions" value={positions.length} sub={positions.length > 0 ? fmtMoney(positionsValue) + " deployed" : undefined} />
              <StatRow label="Cash available" value={fmtMoney(cash)} sub={nav > 0 ? `${((cash / nav) * 100).toFixed(0)}% of NAV` : "NAV unavailable"} />
              {highConviction.length > 0 && (
                <>
                  <div style={{ fontSize: "11px", color: T.muted, marginTop: "12px", marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    Pending signals → <span style={{ color: T.amber }}>PAPER</span> (score ≥60)
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
              <div style={{ fontSize: "12px", color: T.muted, marginTop: "2px" }}>{nextFridayLabel()}</div>
              <div style={{ fontSize: "11px", color: T.muted, marginTop: "4px" }}>Closes trades older than 7d, writes outcomes · weekly</div>
            </div>
            <div style={{ padding: "12px", background: T.dim, borderRadius: "8px" }}>
              <div style={{ fontSize: "11px", color: T.muted, marginBottom: "4px" }}>ThemeScout</div>
              <div style={{ fontSize: "13px", fontWeight: 600, color: "#A78BFA" }}>🎯 ThemeScout</div>
              <div style={{ fontSize: "12px", color: T.muted, marginTop: "2px" }}>On-demand · run manually in Agents</div>
              <div style={{ fontSize: "11px", color: T.muted, marginTop: "4px" }}>Finds 3–5 thematic candidates → watchlist (AI Scout, 7-day expiry)</div>
            </div>
            <div style={{ padding: "12px", background: T.dim, borderRadius: "8px" }}>
              <div style={{ fontSize: "11px", color: T.muted, marginBottom: "4px" }}>DeepSeek Research</div>
              <div style={{ fontSize: "13px", fontWeight: 600, color: T.amber }}>🤖 DeepSeek</div>
              <div style={{ fontSize: "12px", color: T.muted, marginTop: "2px" }}>Parallel to Claude · same signals, different LLM</div>
              <div style={{ fontSize: "11px", color: T.muted, marginTop: "4px" }}>A/B vs Claude — determines which LLM scores better before scaling</div>
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

      {/* Watchlist */}
      <div style={{ marginBottom: "16px" }}>
        <WatchlistPanel />
      </div>

      {/* Activity feed */}
      {(recentRuns.length > 0 || recentTrades.length > 0 || recentLog.length > 0) && (() => {
        type AEvent = {
          ts: number; icon: string; label: string;
          detail: string;  // what happened
          why: string;     // why / context / what to do
          color: string;
          badge?: { label: string; color: string; bg: string };
        };

        const events: AEvent[] = [
          ...recentRuns.map((r: any) => {
            const syms: string[] = Array.isArray(r.symbols) ? r.symbols : [];
            const sigCount = r.signals_written ?? 0;
            const isResearch = r.agent_type === "research";
            const isPaper = r.agent_type === "paper_trader";
            const isThemeScout = r.agent_type === "theme_scout";
            const isDeepSeek = r.agent_type === "deepseek";
            const ts = safeDate(r.completed_at ?? r.created_at)?.getTime() ?? 0;
            const detail = isResearch
              ? `Researched ${syms.length > 0 ? syms.join(", ") : "watchlist"} → ${sigCount} signal${sigCount !== 1 ? "s" : ""} written`
              : isPaper
              ? `Checked pending signals → ${r.result_summary ?? "no fills this run"}`
              : isThemeScout
              ? `ThemeScout: ${r.result_summary ?? "scanned for thematic opportunities"}`
              : isDeepSeek
              ? `DeepSeek: ${r.result_summary ?? "parallel research run completed"}`
              : `LearnerAgent: ${r.result_summary ?? "evaluated recent trades"}`;
            const why = isResearch
              ? sigCount >= 3
                ? `Signals ≥60 score go to paper trade queue. Check Intelligence → Signals for details.`
                : sigCount > 0
                ? `Only ${sigCount} signal(s) hit threshold. Markets may be uncertain or watchlist thin.`
                : `No signals passed threshold (score ≥60). Research ran but found no high-conviction setups.`
              : isPaper
              ? `PaperTrader runs after ResearchAgent. It places paper orders for signals with analyst_score ≥60.`
              : isThemeScout
              ? `ThemeScout found thematic candidates and added them to watchlist with 7-day expiry. Review in Watchlist.`
              : isDeepSeek
              ? `DeepSeek ran the same research as Claude in parallel. Compare signal quality in Intelligence → A/B Comparison.`
              : `LearnerAgent closes trades older than 7 days and writes outcome notes. Phase 1 unlocks at 10 trades.`;
            return {
              ts,
              icon: isThemeScout ? "🎯" : isDeepSeek ? "🤖" : "◐",
              label: isResearch ? "ResearchAgent" : isPaper ? "PaperTrader" : isThemeScout ? "ThemeScout" : isDeepSeek ? "DeepSeek" : "LearnerAgent",
              detail,
              why,
              color: r.status === "done" || r.status === "success" ? T.green : T.amber,
            };
          }),
          ...recentTrades.map((t: any) => {
            const ts = safeDate(t.executed_at)?.getTime() ?? 0;
            const side = (t.order_side ?? "buy").toLowerCase();
            const isBuy = side === "buy";
            const price = t.fill_price != null ? `$${Number(t.fill_price).toFixed(2)}` : "—";
            const score = t.analyst_score ?? t.conviction;
            const detail = `Paper ${isBuy ? "BUY" : "SELL"} ${t.qty ?? "?"} share${t.qty !== 1 ? "s" : ""} ${t.symbol} @ ${price}${score != null ? ` · score ${score}` : ""}`;
            const why = isBuy
              ? `Agent bought because analyst_score ≥60. Position will be evaluated after 7 days or if SELL signal fires.`
              : t.outcome === "win"
              ? `Sold for profit${t.pnl_pct != null ? ` (${t.pnl_pct >= 0 ? "+" : ""}${Number(t.pnl_pct).toFixed(1)}%)` : ""}. Position closed on SELL signal or 7-day rule.`
              : `Closed position${t.realized_pnl != null ? ` — P&L: $${Number(t.realized_pnl).toFixed(2)}` : ""}.`;
            return {
              ts,
              icon: "◈",
              label: `${isBuy ? "Bought" : "Sold"} ${t.symbol}`,
              detail,
              why,
              color: t.outcome === "win" ? T.green : t.outcome === "loss" ? T.red : T.textSub,
              badge: { label: "PAPER", color: "#FBBF24", bg: "#2D1B00" },
            };
          }),
          ...recentLog.map((l: any) => ({
            ts: safeDate(l.created_at)?.getTime() ?? 0,
            icon: "◫",
            label: "Learning note",
            detail: l.note?.slice(0, 160) + ((l.note?.length ?? 0) > 160 ? "…" : ""),
            why: `LearnerAgent wrote this after evaluating ${l.trades_evaluated ?? "recent"} trades. These notes feed back into next week's scoring weights.`,
            color: T.blue,
          })),
        ].filter(e => e.ts > 0).sort((a, b) => b.ts - a.ts).slice(0, 10);

        return (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px", marginTop: "16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
              <div style={{ fontSize: "10px", fontWeight: 700, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
                Recent Activity
              </div>
              <a href="/dashboard/activity" style={{ fontSize: "11px", color: T.accent, textDecoration: "none" }}>Full log →</a>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>
              {events.map((e, i) => (
                <div key={i} style={{ display: "flex", gap: "12px", paddingBottom: i < events.length - 1 ? "14px" : "0", marginBottom: i < events.length - 1 ? "14px" : "0", borderBottom: i < events.length - 1 ? `1px solid ${T.border}44` : "none" }}>
                  <div style={{ width: "20px", textAlign: "center", color: e.color, fontSize: "14px", paddingTop: "1px", flexShrink: 0 }}>{e.icon}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: "13px", fontWeight: 600, color: T.text, display: "flex", alignItems: "center", gap: "8px", marginBottom: "3px" }}>
                      {e.label}
                      {e.badge && (
                        <span style={{ fontSize: "9px", fontWeight: 700, padding: "2px 6px", borderRadius: "4px", background: e.badge.bg, color: e.badge.color, letterSpacing: "0.04em", flexShrink: 0 }}>
                          {e.badge.label}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: "12px", color: T.textSub, marginBottom: "3px", lineHeight: "1.4" }}>{e.detail}</div>
                    <div style={{ fontSize: "11px", color: T.muted, lineHeight: "1.5", fontStyle: "italic" }}>{e.why}</div>
                  </div>
                  <div style={{ fontSize: "11px", color: T.muted, flexShrink: 0, paddingTop: "2px", textAlign: "right" }}>
                    {e.ts ? fmtDate(new Date(e.ts).toISOString(), { month: "short", day: "numeric" }) : "—"}
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
