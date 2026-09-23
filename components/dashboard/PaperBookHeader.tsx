"use client";
// Shared rich header (win-rate gauge + cash-allocation donut + NAV/P&L numbers
// + NAV sparkline) for every paper-trading book page (equities Paper Portfolio,
// Crypto). Extracted 2026-09-23 from components/dashboard/PortfolioPage.tsx so
// the two pages render the SAME visual language instead of crypto's page
// re-implementing its own flat card grid — see
// features/leveraged-etf-and-intraday-execution/FEATURE_ARCHITECTURE.md's
// sibling UI-parity note for why.
import { fmtMoney } from "@/lib/format-money";

export const PAPER_BOOK_T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24",
  greenBg: "#052E16", redBg: "#3B0000", amberBg: "#2D1B00",
};
const T = PAPER_BOOK_T;

export function pnlColor(n: number) { return n >= 0 ? T.green : T.red; }
export function fmtSignedMoney(n: number, market: "us" | "india" = "us") {
  return (n >= 0 ? "+" : "-") + fmtMoney(Math.abs(n), market);
}
export function fmtSignedPct(n: number) { return (n >= 0 ? "+" : "") + n.toFixed(2) + "%"; }

const SEMI_R = 56, SEMI_CX = 72, SEMI_CY = 72;
const SEMI_CIRC = Math.PI * SEMI_R;
function semiArcPath(cx: number, cy: number, r: number) {
  return `M ${cx - r},${cy} A ${r},${r} 0 0,1 ${cx + r},${cy}`;
}

/** Semicircle gauge — 0-100% */
export function SemiGauge({ value, label, sublabel, color }: { value: number | null; label: string; sublabel?: string; color: string }) {
  const clamp = Math.max(0, Math.min(100, value ?? 0));
  const filled = (clamp / 100) * SEMI_CIRC;
  const track = semiArcPath(SEMI_CX, SEMI_CY, SEMI_R);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "6px" }}>
      <svg viewBox="0 0 144 84" style={{ width: "144px", height: "84px", overflow: "visible" }}>
        <path d={track} fill="none" stroke={T.border} strokeWidth="10" strokeLinecap="round" />
        {value !== null && <path d={track} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${filled} ${SEMI_CIRC}`} />}
        <text x={SEMI_CX} y={SEMI_CY - 6} textAnchor="middle" fill={value !== null ? color : T.muted} fontSize="22" fontWeight="700" fontFamily="Inter, sans-serif">
          {value !== null ? Math.round(value) + "%" : "—"}
        </text>
      </svg>
      <div style={{ fontSize: "10px", fontWeight: 600, color: T.textSub, textTransform: "uppercase", letterSpacing: "0.09em" }}>{label}</div>
      {sublabel && <div style={{ fontSize: "10px", color: T.muted }}>{sublabel}</div>}
    </div>
  );
}

/** Cash vs deployed donut */
export function CashDonut({ cashPct }: { cashPct: number }) {
  const deployedPct = 100 - cashPct;
  const r = 40, cx = 52, cy = 52;
  const circ = 2 * Math.PI * r;
  const deployedArc = (deployedPct / 100) * circ;
  const cashArc = (cashPct / 100) * circ;
  const offset = circ * 0.25;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "6px" }}>
      <svg viewBox="0 0 104 72" style={{ width: "104px", height: "72px" }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={T.border} strokeWidth="11" strokeDasharray={`${cashArc} ${circ}`} strokeDashoffset={offset} strokeLinecap="butt" />
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={T.accent} strokeWidth="11" strokeDasharray={`${deployedArc} ${circ}`} strokeDashoffset={offset - cashArc} strokeLinecap="butt" />
        <text x={cx} y={cy - 4} textAnchor="middle" fill={T.accent} fontSize="16" fontWeight="700" fontFamily="Inter, sans-serif">{deployedPct.toFixed(0)}%</text>
        <text x={cx} y={cy + 10} textAnchor="middle" fill={T.muted} fontSize="8" fontFamily="Inter, sans-serif">deployed</text>
      </svg>
      <div style={{ fontSize: "10px", fontWeight: 600, color: T.textSub, textTransform: "uppercase", letterSpacing: "0.09em" }}>Cash Allocation</div>
      <div style={{ fontSize: "10px", color: T.muted }}>{cashPct.toFixed(0)}% cash · {deployedPct.toFixed(0)}% invested</div>
    </div>
  );
}

/** Thin full-width NAV sparkline with gradient fill */
export function NavSparkline({ perf, cur = "$", gradientId = "navGrad" }: { perf: any[]; cur?: string; gradientId?: string }) {
  if (perf.length < 2) return null;
  const navs = perf.map(p => p.nav);
  const min = Math.min(...navs);
  const max = Math.max(...navs);
  const range = max - min || 1;
  const W = 800, H = 52, PAD = 6;
  const pts = navs.map((v, i) => `${(i / (navs.length - 1)) * W},${H - PAD - ((v - min) / range) * (H - PAD * 2)}`).join(" ");
  const isUp = navs[navs.length - 1] >= navs[0];
  const color = isUp ? T.green : T.red;
  const area = `0,${H} ${pts} ${W},${H}`;
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "14px 20px 10px", marginBottom: "20px" }}>
      <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "8px" }}>
        NAV History · {perf.length} days
        <span style={{ marginLeft: "12px", color, fontWeight: 600 }}>{fmtMoney(navs[navs.length - 1], cur === "₹" ? "india" : "us", 0)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: `${H}px` }} preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.22" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={area} fill={`url(#${gradientId})`} />
        <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export interface PaperBookTradeRecord { wins: number; losses: number; breakeven: number; closed: number }

/** Rich gauge+stats header row — win-rate gauge, cash donut, NAV, P&L, positions summary, NAV sparkline. */
export function PaperBookHeader({
  nav, cash, totalPnl, totalPnlPct, posValue, positionCount, winRate, tradeRecord, perf, cur = "$", startingNAV = 10000, gradientId,
}: {
  nav: number; cash: number; totalPnl: number; totalPnlPct: number; posValue: number;
  positionCount: number; winRate: number | null; tradeRecord: PaperBookTradeRecord;
  perf: any[]; cur?: string; startingNAV?: number; gradientId?: string;
}) {
  const cashPct = nav > 0 ? (cash / nav) * 100 : 0;
  const wr = winRate ?? 0;
  const wrColor = winRate !== null ? (wr >= 60 ? T.green : wr >= 40 ? T.amber : T.red) : T.muted;
  const { wins, losses, breakeven } = tradeRecord;
  const wrSublabel = `${wins}W / ${losses}L${breakeven > 0 ? ` / ${breakeven}BE` : ""}`;

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px,1fr))", gap: "0", background: T.card, border: `1px solid ${T.border}`, borderRadius: "16px", overflow: "hidden", marginBottom: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-around", padding: "24px 28px", borderRight: `1px solid ${T.border}`, gap: "8px", flexWrap: "wrap" }}>
          <SemiGauge value={winRate} label="Win Rate" sublabel={winRate !== null ? wrSublabel : "no closed trades"} color={wrColor} />
          <div style={{ width: "1px", height: "80px", background: T.border }} />
          <CashDonut cashPct={Math.max(0, Math.min(100, cashPct))} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: "20px", padding: "24px 32px", minWidth: 0 }}>
          <div>
            <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.09em", marginBottom: "4px" }}>Paper NAV</div>
            <div style={{ fontSize: "clamp(22px,7vw,32px)", fontWeight: 800, letterSpacing: "-0.02em", color: T.text, lineHeight: 1 }}>{fmtMoney(nav, cur === "₹" ? "india" : "us", 0)}</div>
            <div style={{ fontSize: "11px", color: T.muted, marginTop: "3px" }}>started {fmtMoney(startingNAV, cur === "₹" ? "india" : "us", 0)}</div>
          </div>
          <div>
            <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.09em", marginBottom: "4px" }}>Total P&L</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
              <span style={{ fontSize: "22px", fontWeight: 700, color: pnlColor(totalPnl), letterSpacing: "-0.01em" }}>{fmtSignedMoney(totalPnl, cur === "₹" ? "india" : "us")}</span>
              <span style={{ fontSize: "12px", fontWeight: 600, color: pnlColor(totalPnl), background: totalPnl >= 0 ? T.greenBg : T.redBg, padding: "2px 7px", borderRadius: "5px" }}>{fmtSignedPct(totalPnlPct)}</span>
            </div>
          </div>
          <div>
            <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.09em", marginBottom: "4px" }}>Positions</div>
            <div style={{ fontSize: "14px", fontWeight: 600, color: T.text }}>
              {positionCount} open
              <span style={{ color: T.muted, fontWeight: 400, marginLeft: "6px" }}>·</span>
              <span style={{ color: T.textSub, fontWeight: 500, marginLeft: "6px" }}>{fmtMoney(posValue, cur === "₹" ? "india" : "us", 0)} deployed</span>
            </div>
          </div>
        </div>
      </div>
      <NavSparkline perf={perf} cur={cur} gradientId={gradientId} />
    </>
  );
}
