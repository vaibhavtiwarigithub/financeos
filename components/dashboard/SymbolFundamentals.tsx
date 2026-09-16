"use client";
import { useEffect, useState } from "react";
import { CURRENCY, type Market } from "@/lib/market-context";
import { fmtMoneyAbbrev } from "@/lib/format-money";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24",
};

interface FundamentalsData {
  name?: string;
  exchange?: string;
  sector?: string;
  industry?: string;
  marketCap?: number | null;
  peRatio?: number | null;
  eps?: number | null;
  revenueGrowth?: number | null;
  grossMargin?: number | null;
  dividendYield?: number | null;
  beta?: number | null;
  week52High?: number | null;
  week52Low?: number | null;
  analystTarget?: number | null;
  forwardPE?: number | null;
  psRatio?: number | null;
  pbRatio?: number | null;
  description?: string;
  error?: string;
}

// India market caps read in the lakh/crore convention via the shared helper
// (₹2.30Cr), US keeps the familiar T/B/M scale. Either way the currency follows
// the symbol's own market — a .NS name's numbers are ₹, never "$".
function fmtMarketCap(v: number | null | undefined, market: Market): string {
  if (v == null) return "—";
  if (market === "india") return fmtMoneyAbbrev(v, market);
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v.toLocaleString()}`;
}

function fmtNum(v: number | null | undefined, decimals = 1, suffix = ""): string {
  if (v == null || isNaN(v)) return "—";
  return `${v.toFixed(decimals)}${suffix}`;
}

function StatBox({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{
      background: T.surface,
      border: `1px solid ${T.border}`,
      borderRadius: "10px",
      padding: "12px 16px",
      minWidth: "110px",
      flex: "1 1 110px",
    }}>
      <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "6px", whiteSpace: "nowrap" }}>
        {label}
      </div>
      <div style={{ fontSize: "18px", fontWeight: 700, color: color ?? T.text, lineHeight: 1.1 }}>
        {value}
      </div>
    </div>
  );
}

function SkeletonBox() {
  return (
    <div style={{
      background: T.surface,
      border: `1px solid ${T.border}`,
      borderRadius: "10px",
      padding: "12px 16px",
      minWidth: "110px",
      flex: "1 1 110px",
      height: "62px",
    }}>
      <div style={{ width: "60%", height: "9px", background: T.border, borderRadius: "4px", marginBottom: "10px" }} />
      <div style={{ width: "80%", height: "18px", background: T.border, borderRadius: "4px" }} />
    </div>
  );
}

function RangeBar({ low, high, current, target, cur }: { low: number; high: number; current?: number; target?: number | null; cur: string }) {
  const range = high - low;
  if (range <= 0) return null;

  const currentPct = current != null ? Math.max(0, Math.min(100, ((current - low) / range) * 100)) : null;
  const targetPct = target != null ? Math.max(0, Math.min(100, ((target - low) / range) * 100)) : null;

  return (
    <div style={{
      background: T.surface,
      border: `1px solid ${T.border}`,
      borderRadius: "10px",
      padding: "14px 18px",
      flex: "1 1 280px",
    }}>
      <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "10px" }}>
        52-Week Range
      </div>

      {/* Target marker row */}
      {targetPct != null && (
        <div style={{ position: "relative", marginBottom: "4px", height: "18px" }}>
          <div style={{ position: "absolute", left: `${targetPct}%`, transform: "translateX(-50%)", display: "flex", flexDirection: "column", alignItems: "center" }}>
            <span style={{ fontSize: "9px", color: T.amber, whiteSpace: "nowrap", fontWeight: 700, maxWidth: "80px", overflow: "hidden", textOverflow: "ellipsis" }}>
              Target {cur}{target?.toFixed(2)}
            </span>
            <span style={{ color: T.amber, fontSize: "10px", lineHeight: 1 }}>▼</span>
          </div>
        </div>
      )}

      {/* Bar */}
      <div style={{ position: "relative", height: "6px", background: T.border, borderRadius: "3px", margin: "4px 0" }}>
        {/* Fill from left to current */}
        {currentPct != null && (
          <div style={{
            position: "absolute", left: 0, width: `${currentPct}%`,
            height: "100%", background: T.accent, borderRadius: "3px",
          }} />
        )}
        {/* Current price dot */}
        {currentPct != null && (
          <div style={{
            position: "absolute", top: "50%", left: `${currentPct}%`,
            transform: "translate(-50%, -50%)",
            width: "12px", height: "12px", borderRadius: "50%",
            background: T.accent, border: `2px solid ${T.bg}`,
          }} />
        )}
        {/* Target marker */}
        {targetPct != null && (
          <div style={{
            position: "absolute", top: "50%", left: `${targetPct}%`,
            transform: "translate(-50%, -50%)",
            width: "3px", height: "14px",
            background: T.amber, borderRadius: "2px",
          }} />
        )}
      </div>

      {/* Labels */}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "6px" }}>
        <span style={{ fontSize: "11px", color: T.red, fontWeight: 600 }}>{cur}{low.toFixed(2)}</span>
        {current != null && (
          <span style={{ fontSize: "11px", color: T.text, fontWeight: 700 }}>{cur}{current.toFixed(2)}</span>
        )}
        <span style={{ fontSize: "11px", color: T.green, fontWeight: 600 }}>{cur}{high.toFixed(2)}</span>
      </div>
    </div>
  );
}

interface CryptoOverviewData {
  sessionCount: number;
  latestEvidenceAt: string | null;
  technicalScore: number | null;
  realYieldChange20obsPp: number | null;
  dollarChange20obsIndexPoints: number | null;
  analystScore: number | null;
  direction: string | null;
  rationale: string | null;
  signalStatus: string | null;
}

// Crypto has no P/E, margin, ROE, or analyst coverage — this renders the same
// technical+macro(+sentiment) composite the Trading page's Crypto Watch panel
// shows, but as a per-coin breakdown (mirrors the equity fundamentals card's
// role: "why was this scored the way it was"). See FEATURE_ARCHITECTURE.md §2.3.
function CryptoOverview({ symbol }: { symbol: string }) {
  const [data, setData] = useState<CryptoOverviewData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/charts/crypto-overview?symbol=${symbol}`)
      .then(r => r.json())
      .then(d => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [symbol]);

  if (loading) {
    return (
      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
        {Array.from({ length: 4 }).map((_, i) => <SkeletonBox key={i} />)}
      </div>
    );
  }
  if (!data) return <div style={{ color: T.muted, fontSize: "13px", padding: "12px 0" }}>Crypto evidence unavailable for {symbol}.</div>;

  const scoreColor = data.analystScore != null
    ? (data.analystScore >= 70 ? T.green : data.analystScore >= 50 ? T.amber : T.red)
    : T.muted;
  const techColor = data.technicalScore != null
    ? (data.technicalScore >= 60 ? T.green : data.technicalScore >= 40 ? T.amber : T.red)
    : T.muted;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ fontSize: "11px", color: T.textSub }}>
        Crypto composite: technical + macro (+ sentiment when available) — no fundamentals dimension exists for this asset class.
      </div>
      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
        <StatBox label="Analyst Score" value={data.analystScore != null ? String(data.analystScore) : "—"} color={scoreColor} />
        <StatBox label="Direction" value={data.direction ? data.direction.toUpperCase() : "—"} color={data.direction === "long" ? T.green : T.muted} />
        <StatBox label="Technical Score" value={data.technicalScore != null ? data.technicalScore.toFixed(1) : "—"} color={techColor} />
        <StatBox label="Real Yield Δ20obs (pp)" value={data.realYieldChange20obsPp != null ? `${data.realYieldChange20obsPp >= 0 ? "+" : ""}${data.realYieldChange20obsPp.toFixed(2)}` : "—"} />
        <StatBox label="DXY Δ20obs" value={data.dollarChange20obsIndexPoints != null ? `${data.dollarChange20obsIndexPoints >= 0 ? "+" : ""}${data.dollarChange20obsIndexPoints.toFixed(2)}` : "—"} />
        <StatBox label="Evidence Sessions" value={String(data.sessionCount)} />
      </div>
      {data.rationale && (
        <div style={{ fontSize: "12px", color: T.textSub, background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "12px 14px" }}>
          {data.rationale}
        </div>
      )}
    </div>
  );
}

// `market` comes from the symbol's own .NS/.BO suffix (resolved by the symbol
// page), not the global switcher — a .NS name's fundamentals are ₹ regardless of
// which market the user is currently browsing.
export default function SymbolFundamentals({ symbol, currentPrice, market = "us", isCrypto }: { symbol: string; currentPrice?: number; market?: Market; isCrypto?: boolean }) {
  const cur = CURRENCY[market] ?? "$";
  const [data, setData] = useState<FundamentalsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (isCrypto) { setLoading(false); return; }
    setLoading(true);
    fetch(`/api/charts/symbol-overview?symbol=${symbol}`)
      .then(r => r.json())
      .then(d => setData(d))
      .catch(() => setData({ error: "fetch failed" }))
      .finally(() => setLoading(false));
  }, [symbol, isCrypto]);

  if (isCrypto) return <CryptoOverview symbol={symbol} />;

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          {Array.from({ length: 8 }).map((_, i) => <SkeletonBox key={i} />)}
        </div>
        <div style={{ display: "flex", gap: "10px" }}>
          <SkeletonBox />
          <SkeletonBox />
          <SkeletonBox />
        </div>
      </div>
    );
  }

  if (!data || data.error || (data.marketCap == null && data.peRatio == null && data.eps == null)) {
    const isRateLimit = data?.error === "rate_limited";
    return (
      <div style={{ color: T.muted, fontSize: "13px", padding: "12px 0" }}>
        {isRateLimit
          ? "Alpha Vantage rate limit reached (25 calls/day). Fundamentals will load tomorrow."
          : `Fundamentals unavailable for ${symbol}.`}
      </div>
    );
  }

  const peColor = data.peRatio != null && data.peRatio > 30 ? T.amber : T.text;
  const epsColor = data.eps != null && data.eps < 0 ? T.red : T.text;
  const betaColor = data.beta != null && data.beta > 1.5 ? T.amber : T.text;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {/* Sector / Industry header */}
      {(data.sector || data.industry) && (
        <div style={{ fontSize: "11px", color: T.textSub }}>
          {[data.sector, data.industry].filter(Boolean).join(" · ")}
        </div>
      )}

      {/* Fundamentals row */}
      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
        <StatBox label="Market Cap" value={fmtMarketCap(data.marketCap, market)} />
        <StatBox label="P/E (TTM)" value={data.peRatio != null ? `${data.peRatio.toFixed(1)}x` : "—"} color={peColor} />
        <StatBox label="Fwd P/E" value={data.forwardPE != null ? `${data.forwardPE.toFixed(1)}x` : "—"} />
        <StatBox label="P/S" value={data.psRatio != null ? `${data.psRatio.toFixed(1)}x` : "—"} />
        <StatBox label="EPS" value={data.eps != null ? `${cur}${data.eps.toFixed(2)}` : "—"} color={epsColor} />
        <StatBox label="Gross Margin" value={data.grossMargin != null ? `${data.grossMargin.toFixed(1)}%` : "—"} />
        <StatBox label="Div Yield" value={data.dividendYield != null ? `${data.dividendYield.toFixed(2)}%` : "—"} />
        <StatBox label="Beta" value={data.beta != null ? data.beta.toFixed(2) : "—"} color={betaColor} />
      </div>

      {/* 52W range bar row */}
      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
        {data.week52Low != null && data.week52High != null && (
          <RangeBar
            low={data.week52Low}
            high={data.week52High}
            current={currentPrice}
            target={data.analystTarget}
            cur={cur}
          />
        )}
        {data.analystTarget != null && (
          <StatBox label="Analyst Target" value={`${cur}${data.analystTarget.toFixed(2)}`} color={T.amber} />
        )}
        {data.pbRatio != null && (
          <StatBox label="P/B" value={`${data.pbRatio.toFixed(1)}x`} />
        )}
      </div>
    </div>
  );
}
