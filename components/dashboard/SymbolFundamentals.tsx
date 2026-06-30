"use client";
import { useEffect, useState } from "react";

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

function fmtMarketCap(v: number | null | undefined): string {
  if (v == null) return "—";
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

function RangeBar({ low, high, current, target }: { low: number; high: number; current?: number; target?: number | null }) {
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
            <span style={{ fontSize: "9px", color: T.amber, whiteSpace: "nowrap", fontWeight: 700 }}>
              Target ${target?.toFixed(2)}
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
        <span style={{ fontSize: "11px", color: T.red, fontWeight: 600 }}>${low.toFixed(2)}</span>
        {current != null && (
          <span style={{ fontSize: "11px", color: T.text, fontWeight: 700 }}>${current.toFixed(2)}</span>
        )}
        <span style={{ fontSize: "11px", color: T.green, fontWeight: 600 }}>${high.toFixed(2)}</span>
      </div>
    </div>
  );
}

export default function SymbolFundamentals({ symbol, currentPrice }: { symbol: string; currentPrice?: number }) {
  const [data, setData] = useState<FundamentalsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/charts/symbol-overview?symbol=${symbol}`)
      .then(r => r.json())
      .then(d => setData(d))
      .catch(() => setData({ error: "fetch failed" }))
      .finally(() => setLoading(false));
  }, [symbol]);

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
        <StatBox label="Market Cap" value={fmtMarketCap(data.marketCap)} />
        <StatBox label="P/E (TTM)" value={data.peRatio != null ? `${data.peRatio.toFixed(1)}x` : "—"} color={peColor} />
        <StatBox label="Fwd P/E" value={data.forwardPE != null ? `${data.forwardPE.toFixed(1)}x` : "—"} />
        <StatBox label="P/S" value={data.psRatio != null ? `${data.psRatio.toFixed(1)}x` : "—"} />
        <StatBox label="EPS" value={data.eps != null ? `$${data.eps.toFixed(2)}` : "—"} color={epsColor} />
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
          />
        )}
        {data.analystTarget != null && (
          <StatBox label="Analyst Target" value={`$${data.analystTarget.toFixed(2)}`} color={T.amber} />
        )}
        {data.pbRatio != null && (
          <StatBox label="P/B" value={`${data.pbRatio.toFixed(1)}x`} />
        )}
      </div>
    </div>
  );
}
