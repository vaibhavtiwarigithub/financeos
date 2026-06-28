"use client";

import { useEffect, useState, lazy, Suspense } from "react";
const SectorTreemap = lazy(() => import("@/components/charts/SectorTreemap"));
const PriceChart = lazy(() => import("@/components/charts/PriceChart"));

const T = {
  bg: "#0D0F14",
  surface: "#13151C",
  card: "#1A1D27",
  border: "#252836",
  text: "#ECEDEF",
  textSub: "#9B9EA8",
  muted: "#6B7280",
  accent: "#6366F1",
  green: "#34D399",
  greenBg: "#052E16",
  red: "#F87171",
  redBg: "#3B0000",
  amber: "#FBBF24",
};

interface IndexQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
}

interface SectorQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
}

interface MarketOverview {
  indices: IndexQuote[];
  sectors: SectorQuote[];
  fetchedAt: string;
}

function fmt(n: number, decimals = 2) {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function pctColor(pct: number) {
  if (pct > 0) return T.green;
  if (pct < 0) return T.red;
  return T.muted;
}

function pctBg(pct: number): string {
  // Intensity proportional to magnitude, capped at ±3%
  const abs = Math.min(Math.abs(pct), 3);
  const alpha = Math.round((abs / 3) * 200).toString(16).padStart(2, "0");
  return pct >= 0 ? `#34D399${alpha}` : `#F87171${alpha}`;
}

function PctPill({ value }: { value: number }) {
  const color = pctColor(value);
  return (
    <span
      style={{
        fontSize: "12px",
        fontWeight: 700,
        fontFamily: "'JetBrains Mono', monospace",
        padding: "2px 7px",
        borderRadius: "5px",
        background: value >= 0 ? T.greenBg : T.redBg,
        color,
      }}
    >
      {value >= 0 ? "+" : ""}{fmt(value, 2)}%
    </span>
  );
}

function IndexCard({ q }: { q: IndexQuote }) {
  const isVIX = q.symbol === "VIX";
  const color = isVIX
    ? q.changePct >= 0 ? T.red : T.green   // VIX up = bad
    : pctColor(q.changePct);

  return (
    <div
      style={{
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: "12px",
        padding: "18px 20px",
        flex: "1 1 180px",
        minWidth: 0,
        borderTop: `3px solid ${color}`,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
        <div>
          <div style={{ fontSize: "11px", color: T.muted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "2px" }}>{q.name}</div>
          <div style={{ fontSize: "11px", fontWeight: 600, color: T.accent }}>{q.symbol}</div>
        </div>
        <PctPill value={q.changePct} />
      </div>
      <div style={{ fontSize: "26px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "-0.02em", color: T.text }}>
        {q.price > 0 ? fmt(q.price) : "—"}
      </div>
      <div style={{ fontSize: "12px", color: pctColor(q.change), fontFamily: "'JetBrains Mono', monospace", marginTop: "4px" }}>
        {q.change >= 0 ? "+" : ""}{fmt(q.change)} today
      </div>
    </div>
  );
}

function SectorHeatmap({ sectors }: { sectors: SectorQuote[] }) {
  const sorted = [...sectors].sort((a, b) => b.changePct - a.changePct);

  return (
    <div
      style={{
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: "12px",
        padding: "20px",
      }}
    >
      <div style={{ fontSize: "11px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "16px" }}>
        Sector Performance
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "8px" }}>
        {sorted.map(s => (
          <div
            key={s.symbol}
            style={{
              background: pctBg(s.changePct),
              border: `1px solid ${s.changePct >= 0 ? T.green : T.red}30`,
              borderRadius: "8px",
              padding: "12px 14px",
              cursor: "default",
            }}
          >
            <div style={{ fontSize: "11px", color: T.textSub, marginBottom: "4px" }}>{s.name}</div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "12px", fontWeight: 700, color: T.accent }}>{s.symbol}</span>
              <span
                style={{
                  fontSize: "13px",
                  fontWeight: 700,
                  fontFamily: "'JetBrains Mono', monospace",
                  color: pctColor(s.changePct),
                }}
              >
                {s.changePct >= 0 ? "+" : ""}{fmt(s.changePct, 2)}%
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div style={{ animation: "pulse 1.5s ease-in-out infinite" }}>
      <div style={{ display: "flex", gap: "12px", marginBottom: "24px", flexWrap: "wrap" }}>
        {[...Array(4)].map((_, i) => (
          <div key={i} style={{ flex: "1 1 180px", minWidth: 0, height: "110px", background: T.card, borderRadius: "12px", border: `1px solid ${T.border}` }} />
        ))}
      </div>
      <div style={{ height: "300px", background: T.card, borderRadius: "12px", border: `1px solid ${T.border}` }} />
    </div>
  );
}

export default function MarketsPage() {
  const [data, setData] = useState<MarketOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<string | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);

  async function fetchMarkets() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/markets/overview");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const json: MarketOverview = await res.json();
      setData(json);
      setLastFetch(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchMarkets();
    // Auto-refresh every 5 minutes
    const interval = setInterval(fetchMarkets, 5 * 60 * 1000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ padding: "28px", color: T.text, fontFamily: "'Inter', sans-serif" }}>
      {/* Header */}
      <div style={{ marginBottom: "24px" }}>
        <div style={{ fontSize: "11px", color: T.accent, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "6px" }}>
          Market Overview
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px" }}>
          <h1 style={{ fontSize: "24px", fontWeight: 700, letterSpacing: "-0.02em", margin: 0 }}>Markets</h1>
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            {lastFetch && (
              <span style={{ fontSize: "12px", color: T.muted }}>Updated {lastFetch}</span>
            )}
            <button
              onClick={fetchMarkets}
              disabled={loading}
              style={{
                padding: "7px 16px",
                background: T.surface,
                border: `1px solid ${T.border}`,
                borderRadius: "8px",
                color: loading ? T.muted : T.text,
                fontSize: "13px",
                fontWeight: 500,
                cursor: loading ? "not-allowed" : "pointer",
              }}
            >
              {loading ? "Loading…" : "Refresh"}
            </button>
          </div>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div
          style={{
            background: "#3B0000",
            border: `1px solid ${T.red}40`,
            borderRadius: "10px",
            padding: "16px 20px",
            marginBottom: "24px",
            color: T.red,
            fontSize: "13px",
          }}
        >
          <span style={{ fontWeight: 600 }}>Error fetching market data: </span>{error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !data && <LoadingSkeleton />}

      {/* Data loaded */}
      {data && (
        <>
          {/* Index bar */}
          <div style={{ display: "flex", gap: "12px", marginBottom: "16px", flexWrap: "wrap" }}>
            {data.indices.map(q => (
              <div
                key={q.symbol}
                onClick={() => setSelectedSymbol(selectedSymbol === q.symbol ? null : q.symbol)}
                style={{ cursor: "pointer" }}
              >
                <IndexCard q={q} />
              </div>
            ))}
          </div>

          {/* Inline price chart for selected index */}
          {selectedSymbol && (
            <div style={{ background: "#1A1D27", border: "1px solid #252836", borderRadius: "12px", padding: "20px", marginBottom: "16px" }}>
              <Suspense fallback={<div style={{ color: "#6B7280", fontSize: "13px" }}>Loading chart…</div>}>
                <PriceChart symbol={selectedSymbol} height={260} />
              </Suspense>
            </div>
          )}

          {/* Sector treemap */}
          <Suspense fallback={<div style={{ background: "#1A1D27", border: "1px solid #252836", borderRadius: "12px", padding: "20px", height: "320px", display: "flex", alignItems: "center", justifyContent: "center", color: "#6B7280", fontSize: "13px" }}>Loading heatmap…</div>}>
            <SectorTreemap sectors={data.sectors} />
          </Suspense>

          {/* Footer note */}
          <div style={{ marginTop: "16px", fontSize: "11px", color: T.muted, textAlign: "right" }}>
            Data via FinancialDatasets · 15-min delay · Cached 5 min
          </div>
        </>
      )}
    </div>
  );
}
