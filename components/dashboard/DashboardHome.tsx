"use client";
import type { Profile, Holding, Prediction } from "@/types";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280", dim: "#1C1F26",
  accent: "#6366F1", accentBg: "#1E1F3A", green: "#34D399", greenBg: "#052E16",
  red: "#F87171", blue: "#60A5FA", yellow: "#FBBF24",
};

function fmtUSD(n: number) {
  if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (Math.abs(n) >= 1000) return "$" + (n / 1000).toFixed(1) + "k";
  return "$" + n.toFixed(0);
}
function fmtPct(n: number) { return (n >= 0 ? "+" : "") + n.toFixed(1) + "%"; }

function calcPortfolio(holdings: Holding[]) {
  return holdings.map(h => {
    const mktVal = h.qty * h.current_price;
    const cost = h.qty * h.avg_cost;
    const pnl = mktVal - cost;
    return { ...h, mktVal, cost, pnl, pnlPct: (pnl / cost) * 100 };
  });
}

export default function DashboardHome({ profile, holdings, predictions, signals, paperPortfolio }: {
  profile: Profile; holdings: Holding[]; predictions: Prediction[];
  signals?: any[]; paperPortfolio?: any;
}) {
  const portfolio = calcPortfolio(holdings);
  const totalValue = portfolio.reduce((s, p) => s + p.mktVal, 0);
  const totalPnl = portfolio.reduce((s, p) => s + p.pnl, 0);
  const totalCost = totalValue - totalPnl;

  const dateStr = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const dnaVals = [profile.dna_macro, profile.dna_equities, profile.dna_technical, profile.dna_risk_mgmt].filter(v => v != null) as number[];
  const dnaAvg = dnaVals.length ? Math.round(dnaVals.reduce((s, v) => s + v, 0) / dnaVals.length) : 0;

  return (
    <div style={{ padding: "28px", animation: "slideUp 0.3s ease" }}>

      {/* Hero */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "16px", padding: "28px", marginBottom: "24px", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: 0, right: 0, width: "300px", height: "100%", background: `linear-gradient(135deg, ${T.accent}06 0%, #A78BFA08 100%)`, pointerEvents: "none" }} />
        <div style={{ fontSize: "12px", color: T.muted, marginBottom: "6px" }}>{dateStr}</div>
        <div style={{ fontSize: "28px", fontWeight: 600, letterSpacing: "-0.02em", marginBottom: "4px" }}>
          Good morning, {profile.full_name?.split(" ")[0] || "Investor"}
        </div>
        <div style={{ fontSize: "14px", color: T.textSub }}>
          Portfolio: {fmtUSD(totalValue)} &middot; P&L:&nbsp;
          <span style={{ color: totalPnl >= 0 ? T.green : T.red }}>{fmtUSD(totalPnl)} ({fmtPct(totalCost > 0 ? totalPnl / totalCost * 100 : 0)})</span>
        </div>

        {/* Stats row */}
        <div style={{ display: "flex", gap: "28px", marginTop: "20px", flexWrap: "wrap" }}>
          {[
            { label: "XP", value: profile.xp, color: T.accent },
            { label: "Streak", value: profile.streak_days + "d", color: T.green },
            { label: "Analyses", value: profile.analysis_count, color: T.blue },
            { label: "Knowledge", value: dnaAvg + "%", color: T.yellow },
          ].map(s => (
            <div key={s.label} style={{ textAlign: "center" }}>
              <div style={{ fontSize: "11px", color: T.muted, marginBottom: "2px" }}>{s.label}</div>
              <div style={{ fontSize: "22px", fontWeight: 700, color: s.color, fontFamily: "'JetBrains Mono', monospace" }}>{s.value}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px" }}>

        {/* Portfolio summary */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
          <div style={{ fontSize: "12px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "14px" }}>Portfolio</div>
          {portfolio.slice(0, 5).map(p => (
            <div key={p.id} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: `1px solid ${T.border}44` }}>
              <span style={{ fontWeight: 500, fontFamily: "'JetBrains Mono', monospace", fontSize: "13px" }}>{p.symbol}</span>
              <span style={{ color: p.pnl >= 0 ? T.green : T.red, fontSize: "13px", fontFamily: "'JetBrains Mono', monospace" }}>
                {fmtPct(p.pnlPct ?? 0)}
              </span>
            </div>
          ))}
          {holdings.length === 0 && (
            <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "20px 0" }}>No holdings yet</div>
          )}
        </div>

        {/* Open predictions */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
          <div style={{ fontSize: "12px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "14px" }}>Active Predictions</div>
          {predictions.map(p => (
            <div key={p.id} style={{ padding: "8px 0", borderBottom: `1px solid ${T.border}44` }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "3px" }}>
                <span style={{ fontWeight: 500, color: T.blue, fontSize: "13px" }}>{p.asset}</span>
                <span style={{ fontSize: "11px", padding: "2px 6px", borderRadius: "4px", background: p.direction === "UP" ? T.green + "22" : T.red + "22", color: p.direction === "UP" ? T.green : T.red }}>{p.direction}</span>
              </div>
              <div style={{ fontSize: "12px", color: T.muted }}>{p.timeframe} &middot; {p.confidence}% conf</div>
            </div>
          ))}
          {predictions.length === 0 && (
            <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "20px 0" }}>No open predictions</div>
          )}
        </div>

        {/* Quick actions */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
          <div style={{ fontSize: "12px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "14px" }}>Quick Actions</div>
          {[
            { label: "Run AI Analysis", href: "/dashboard/intelligence?tab=analysis", color: T.accent },
            { label: "Morning Brief", href: "/dashboard/intelligence?tab=brief", color: T.blue },
            { label: "Add Holding", href: "/dashboard/portfolio?tab=holdings", color: T.green },
            { label: "New Prediction", href: "/dashboard/you?tab=predictions", color: T.yellow },
          ].map(a => (
            <a key={a.label} href={a.href} style={{ display: "block", padding: "9px 12px", borderRadius: "8px", background: T.dim, marginBottom: "6px", fontSize: "13px", color: a.color, fontWeight: 500, borderLeft: `3px solid ${a.color}` }}>
              {a.label} →
            </a>
          ))}
        </div>
      </div>

      {/* Agent signals widget */}
      {signals && signals.length > 0 && (
        <div style={{ marginTop: "16px", background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
            <div style={{ fontSize: "12px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Latest Agent Signals
            </div>
            {paperPortfolio && (
              <div style={{ fontSize: "12px", color: T.muted }}>
                Paper NAV: <span style={{ color: T.green, fontWeight: 700 }}>${(paperPortfolio.nav ?? 10000).toFixed(0)}</span>
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            {signals.map((s: any) => (
              <div key={s.id} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "10px 14px", minWidth: "120px" }}>
                <div style={{ fontWeight: 800, fontSize: "14px", marginBottom: "3px" }}>{s.symbol}</div>
                <div style={{ fontSize: "11px", marginBottom: "2px" }}>
                  <span style={{ color: s.direction === "long" ? T.green : T.yellow, fontWeight: 600 }}>{s.direction?.toUpperCase()}</span>
                  <span style={{ color: T.muted }}> · {s.analyst_score}</span>
                </div>
                <div style={{ fontSize: "10px", color: s.status === "paper_traded" ? T.green : T.muted }}>{s.status}</div>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}
