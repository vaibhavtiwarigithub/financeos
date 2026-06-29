"use client";

import { useState, useEffect } from "react";

const T = {
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
  surface: "#13151C",
};

const SECTORS: { symbol: string; name: string }[] = [
  { symbol: "XLK", name: "Technology" },
  { symbol: "XLF", name: "Financials" },
  { symbol: "XLE", name: "Energy" },
  { symbol: "XLV", name: "Healthcare" },
  { symbol: "XLI", name: "Industrials" },
  { symbol: "XLY", name: "Consumer Disc." },
  { symbol: "XLC", name: "Comm. Services" },
  { symbol: "XLP", name: "Consumer Staples" },
  { symbol: "XLU", name: "Utilities" },
  { symbol: "XLRE", name: "Real Estate" },
  { symbol: "XLB", name: "Materials" },
];

interface SectorReturn {
  symbol: string;
  name: string;
  returnPct: number | null;
  loading: boolean;
  error: boolean;
}

const PERIOD_OPTIONS = [
  { label: "1W", days: 7 },
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
  { label: "1Y", days: 365 },
];

export default function SectorPerformanceChart() {
  const [period, setPeriod] = useState(PERIOD_OPTIONS[2]); // default 3M
  const [sectors, setSectors] = useState<SectorReturn[]>(
    SECTORS.map(s => ({ ...s, returnPct: null, loading: true, error: false }))
  );

  useEffect(() => {
    setSectors(SECTORS.map(s => ({ ...s, returnPct: null, loading: true, error: false })));

    // Fetch all 11 ETFs in parallel
    Promise.all(
      SECTORS.map(async s => {
        try {
          const res = await fetch(
            `/api/charts/price-history?symbol=${s.symbol}&days=${period.days}`
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          const candles: { close: number }[] = data.candles ?? [];
          if (candles.length < 2) return { ...s, returnPct: null, loading: false, error: false };
          const first = candles[0].close;
          const last = candles[candles.length - 1].close;
          const returnPct = ((last - first) / first) * 100;
          return { ...s, returnPct, loading: false, error: false };
        } catch {
          return { ...s, returnPct: null, loading: false, error: true };
        }
      })
    ).then(results => setSectors(results));
  }, [period.days]);

  const loaded = sectors.filter(s => !s.loading && s.returnPct !== null) as (SectorReturn & { returnPct: number })[];
  const sorted = [...loaded].sort((a, b) => b.returnPct - a.returnPct);

  const maxAbs = Math.max(...sorted.map(s => Math.abs(s.returnPct)), 1);
  const anyLoading = sectors.some(s => s.loading);

  return (
    <div
      style={{
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: "12px",
        padding: "20px",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "16px",
          flexWrap: "wrap",
          gap: "8px",
        }}
      >
        <div>
          <div
            style={{
              fontSize: "11px",
              color: T.muted,
              fontWeight: 500,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              marginBottom: "2px",
            }}
          >
            Sector Performance
          </div>
          <div style={{ fontSize: "13px", color: T.textSub }}>
            SPDR Sector ETFs · {period.label} return
          </div>
        </div>
        {/* Period selector */}
        <div style={{ display: "flex", gap: "4px" }}>
          {PERIOD_OPTIONS.map(p => (
            <button
              key={p.label}
              onClick={() => setPeriod(p)}
              style={{
                padding: "4px 10px",
                borderRadius: "6px",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
                border: "none",
                background: period.label === p.label ? T.accent : T.surface,
                color: period.label === p.label ? "#fff" : T.muted,
                transition: "background 0.15s",
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Loading state */}
      {anyLoading && sorted.length === 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          {SECTORS.map(s => (
            <div
              key={s.symbol}
              style={{
                height: "36px",
                background: T.surface,
                borderRadius: "6px",
                opacity: 0.5,
                animation: "pulse 1.5s ease-in-out infinite",
              }}
            />
          ))}
        </div>
      )}

      {/* Bar chart */}
      {sorted.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {sorted.map(s => {
            const positive = s.returnPct >= 0;
            const barWidth = (Math.abs(s.returnPct) / maxAbs) * 100;
            const barColor = positive ? T.green : T.red;
            const bgColor = positive ? `${T.green}18` : `${T.red}18`;

            return (
              <div
                key={s.symbol}
                style={{
                  display: "grid",
                  gridTemplateColumns: "140px 1fr 80px",
                  alignItems: "center",
                  gap: "10px",
                  padding: "6px 0",
                }}
              >
                {/* Label */}
                <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: 700,
                      color: T.accent,
                      fontFamily: "'JetBrains Mono', monospace",
                      minWidth: "36px",
                    }}
                  >
                    {s.symbol}
                  </span>
                  <span
                    style={{
                      fontSize: "11px",
                      color: T.textSub,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {s.name}
                  </span>
                </div>

                {/* Bar track */}
                <div
                  style={{
                    height: "22px",
                    background: T.surface,
                    borderRadius: "4px",
                    overflow: "hidden",
                    position: "relative",
                  }}
                >
                  {/* Center line */}
                  <div
                    style={{
                      position: "absolute",
                      left: "50%",
                      top: 0,
                      bottom: 0,
                      width: "1px",
                      background: T.border,
                      zIndex: 1,
                    }}
                  />
                  {/* Filled bar — grows from center */}
                  <div
                    style={{
                      position: "absolute",
                      top: 0,
                      bottom: 0,
                      width: `${barWidth / 2}%`,
                      background: bgColor,
                      ...(positive
                        ? { left: "50%" }
                        : { right: "50%" }),
                      borderRadius: positive ? "0 3px 3px 0" : "3px 0 0 3px",
                      transition: "width 0.4s ease",
                    }}
                  />
                  {/* Colored border/highlight */}
                  <div
                    style={{
                      position: "absolute",
                      top: 0,
                      bottom: 0,
                      width: `${barWidth / 2}%`,
                      borderRight: positive ? `2px solid ${barColor}` : undefined,
                      borderLeft: !positive ? `2px solid ${barColor}` : undefined,
                      ...(positive ? { left: "50%" } : { right: "50%" }),
                      transition: "width 0.4s ease",
                    }}
                  />
                </div>

                {/* % return */}
                <div
                  style={{
                    fontSize: "12px",
                    fontWeight: 700,
                    fontFamily: "'JetBrains Mono', monospace",
                    color: barColor,
                    textAlign: "right",
                  }}
                >
                  {positive ? "+" : ""}{s.returnPct.toFixed(2)}%
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Errors */}
      {!anyLoading && sectors.some(s => s.error) && (
        <div style={{ marginTop: "8px", fontSize: "11px", color: T.muted }}>
          Some ETFs failed to load. They are omitted from the chart.
        </div>
      )}

      {/* Loading indicator when refreshing but already have data */}
      {anyLoading && sorted.length > 0 && (
        <div style={{ marginTop: "8px", fontSize: "11px", color: T.muted }}>
          Refreshing…
        </div>
      )}
    </div>
  );
}
