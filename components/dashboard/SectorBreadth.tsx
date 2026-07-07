"use client";

import { useEffect, useState } from "react";
import {
  Treemap,
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  Tooltip,
} from "recharts";

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

const PERIOD_OPTIONS = [
  { label: "1W", days: 7 },
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
  { label: "1Y", days: 365 },
];

const SECTORS = [
  { etf: "XLK", name: "Technology" },
  { etf: "XLF", name: "Financials" },
  { etf: "XLE", name: "Energy" },
  { etf: "XLI", name: "Industrials" },
  { etf: "XLV", name: "Health Care" },
  { etf: "XLU", name: "Utilities" },
  { etf: "XLRE", name: "Real Estate" },
  { etf: "XLC", name: "Comm Services" },
  { etf: "XLY", name: "Consumer Discr" },
  { etf: "XLP", name: "Consumer Staples" },
  { etf: "XLB", name: "Materials" },
];

interface Holding {
  symbol: string;
  weightPct: number;
  changePct: number;
  contribution: number;
}

interface BreadthData {
  sector: string;
  holdings: Holding[];
  topContributors: Holding[];
  topDetractors: Holding[];
  advanceCount: number;
  declineCount: number;
  unchangedCount: number;
  total: number;
  breadthPct: number;
  narrowTag: "NARROW" | "BROAD" | "MIXED";
  breadthHistory: { date: string; breadth_pct: number }[];
  topExplainPct: number;
  error?: string;
}

function fmt(n: number, decimals = 2) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function cellColor(changePct: number): string {
  if (changePct > 2) return "#065F46";
  if (changePct > 0) return "#064E3B";
  if (changePct < -2) return "#7F1D1D";
  if (changePct < 0) return "#450A0A";
  return "#1F2937";
}

function cellTextColor(changePct: number): string {
  if (changePct > 2) return "#34D399";
  if (changePct > 0) return "#6EE7B7";
  if (changePct < -2) return "#F87171";
  if (changePct < 0) return "#FCA5A5";
  return "#9B9EA8";
}

interface TreemapEntry {
  name: string;
  size: number;
  changePct: number;
  contribution: number;
}

interface CustomTreemapContentProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  name?: string;
  changePct?: number;
}

function CustomTreemapContent(props: CustomTreemapContentProps) {
  const { x = 0, y = 0, width = 0, height = 0, name = "", changePct = 0 } = props;
  if (width < 30 || height < 24) return null;
  const bg = cellColor(changePct);
  const fg = cellTextColor(changePct);
  const sign = changePct >= 0 ? "+" : "";
  const showPct = height > 36;

  return (
    <g>
      <rect
        x={x + 1}
        y={y + 1}
        width={width - 2}
        height={height - 2}
        style={{ fill: bg, stroke: T.border, strokeWidth: 1 }}
        rx={3}
      />
      <text
        x={x + width / 2}
        y={y + (showPct ? height / 2 - 6 : height / 2 + 4)}
        textAnchor="middle"
        dominantBaseline="middle"
        style={{ fill: fg, fontSize: Math.min(12, width / 4), fontWeight: 700 }}
      >
        {name}
      </text>
      {showPct && (
        <text
          x={x + width / 2}
          y={y + height / 2 + 9}
          textAnchor="middle"
          dominantBaseline="middle"
          style={{ fill: fg, fontSize: Math.min(10, width / 5) }}
        >
          {sign}{fmt(changePct, 1)}%
        </text>
      )}
    </g>
  );
}

function NarrowBadge({ tag }: { tag: "NARROW" | "BROAD" | "MIXED" }) {
  const config = {
    NARROW: { bg: T.redBg, color: T.red, border: "#5B0000" },
    MIXED: { bg: "#3B2500", color: T.amber, border: "#5B3A00" },
    BROAD: { bg: T.greenBg, color: T.green, border: "#065F46" },
  }[tag];

  return (
    <span
      style={{
        fontSize: "11px",
        fontWeight: 700,
        letterSpacing: "0.08em",
        padding: "3px 8px",
        borderRadius: "5px",
        background: config.bg,
        color: config.color,
        border: `1px solid ${config.border}`,
      }}
    >
      {tag}
    </span>
  );
}

function ADBar({
  advance,
  decline,
  total,
}: {
  advance: number;
  decline: number;
  total: number;
}) {
  if (total === 0) return null;
  const advPct = (advance / total) * 100;
  const decPct = (decline / total) * 100;
  const unchPct = 100 - advPct - decPct;

  return (
    <div style={{ marginTop: "10px" }}>
      <div
        style={{
          display: "flex",
          height: "10px",
          borderRadius: "5px",
          overflow: "hidden",
          gap: "2px",
        }}
      >
        <div
          style={{
            width: `${advPct}%`,
            background: T.green,
            borderRadius: "5px 0 0 5px",
          }}
        />
        <div
          style={{
            width: `${unchPct}%`,
            background: T.border,
          }}
        />
        <div
          style={{
            width: `${decPct}%`,
            background: T.red,
            borderRadius: "0 5px 5px 0",
          }}
        />
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: "5px",
          fontSize: "11px",
          color: T.textSub,
        }}
      >
        <span style={{ color: T.green }}>▲ {advance} advancing</span>
        <span>{fmt(advPct, 0)}% breadth</span>
        <span style={{ color: T.red }}>{decline} declining ▼</span>
      </div>
    </div>
  );
}

function ContributorRow({
  holding,
  isPuller,
}: {
  holding: Holding;
  isPuller: boolean;
}) {
  const sign = holding.changePct >= 0 ? "+" : "";
  const contribSign = holding.contribution >= 0 ? "+" : "";
  const color = isPuller ? T.green : T.red;

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "6px 0",
        borderBottom: `1px solid ${T.border}`,
        fontSize: "12px",
      }}
    >
      <span
        style={{
          fontWeight: 700,
          fontFamily: "'JetBrains Mono', monospace",
          color: T.text,
          minWidth: "48px",
        }}
      >
        {holding.symbol}
      </span>
      <span style={{ color, fontFamily: "'JetBrains Mono', monospace" }}>
        {contribSign}{fmt(holding.contribution, 3)}%
      </span>
      <span style={{ color: T.textSub, fontFamily: "'JetBrains Mono', monospace" }}>
        ({sign}{fmt(holding.changePct, 1)}%)
      </span>
    </div>
  );
}

function shortDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function SectorBreadth() {
  const [activeSector, setActiveSector] = useState("XLK");
  const [period, setPeriod] = useState(PERIOD_OPTIONS[1]); // default 1M
  const [data, setData] = useState<BreadthData | null>(null);
  const [loading, setLoading] = useState(false);
  const [periodReturn, setPeriodReturn] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);

    fetch(`/api/markets/breadth?sector=${activeSector}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeSector]);

  // Period-scoped ETF return (from the sector-returns price cache). The A/D
  // holdings breakdown below is always the latest daily session; this figure
  // gives period context matching the selected window.
  useEffect(() => {
    let cancelled = false;
    setPeriodReturn(null);
    fetch(`/api/charts/sector-returns?days=${period.days}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const row = (d.sectors ?? []).find(
          (s: { symbol: string; returnPct: number | null }) => s.symbol === activeSector
        );
        setPeriodReturn(row?.returnPct ?? null);
      })
      .catch(() => {
        if (!cancelled) setPeriodReturn(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSector, period.days]);

  const sectorName =
    SECTORS.find((s) => s.etf === activeSector)?.name ?? activeSector;

  const treeData: TreemapEntry[] = (data?.holdings ?? []).map((h) => ({
    name: h.symbol,
    size: h.weightPct,
    changePct: h.changePct,
    contribution: h.contribution,
  }));

  const historyData = (data?.breadthHistory ?? []).map((r) => ({
    date: shortDate(r.date),
    breadth_pct: r.breadth_pct,
  }));

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
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: "10px",
          marginBottom: "16px",
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
              marginBottom: "4px",
            }}
          >
            Sector Breadth Analysis
          </div>
          <div style={{ fontSize: "12px", color: T.textSub }}>
            Holdings advancing vs declining within {sectorName} · {period.label}{" "}
            {activeSector} return{" "}
            {periodReturn !== null ? (
              <span
                style={{
                  color: periodReturn >= 0 ? T.green : T.red,
                  fontWeight: 700,
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {periodReturn >= 0 ? "+" : ""}
                {fmt(periodReturn, 2)}%
              </span>
            ) : (
              <span style={{ color: T.muted }}>—</span>
            )}
          </div>
        </div>
        {/* Period selector — mirrors Sector Performance chart */}
        <div style={{ display: "flex", gap: "4px", flexShrink: 0 }}>
          {PERIOD_OPTIONS.map((p) => (
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
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Sector tabs */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "6px",
          marginBottom: "20px",
        }}
      >
        {SECTORS.map((s) => (
          <button
            key={s.etf}
            onClick={() => setActiveSector(s.etf)}
            style={{
              fontSize: "11px",
              fontWeight: 600,
              padding: "4px 10px",
              borderRadius: "6px",
              border: `1px solid ${activeSector === s.etf ? T.accent : T.border}`,
              background: activeSector === s.etf ? `${T.accent}22` : T.surface,
              color: activeSector === s.etf ? T.accent : T.textSub,
              cursor: "pointer",
              fontFamily: "'JetBrains Mono', monospace",
              transition: "all 0.15s",
            }}
          >
            {s.etf}
          </button>
        ))}
      </div>

      {/* Loading state */}
      {loading && (
        <div
          style={{
            height: "80px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: T.muted,
            fontSize: "13px",
          }}
        >
          Loading breadth data for {sectorName}…
        </div>
      )}

      {/* Error state */}
      {!loading && data?.error && (
        <div
          style={{
            padding: "12px",
            background: T.redBg,
            border: `1px solid #5B0000`,
            borderRadius: "8px",
            color: T.red,
            fontSize: "12px",
            marginBottom: "16px",
          }}
        >
          {data.error}
        </div>
      )}

      {/* Today's breadth summary */}
      {!loading && data && !data.error && (
        <>
          <div
            style={{
              background: T.surface,
              border: `1px solid ${T.border}`,
              borderRadius: "10px",
              padding: "16px",
              marginBottom: "16px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: "8px",
                marginBottom: "4px",
              }}
            >
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: 600,
                  color: T.textSub,
                  textTransform: "uppercase",
                  letterSpacing: "0.07em",
                }}
              >
                Today's Breadth
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <NarrowBadge tag={data.narrowTag} />
                {data.topExplainPct > 0 && (
                  <span style={{ fontSize: "11px", color: T.textSub }}>
                    Top 3 ={" "}
                    <span style={{ color: T.amber, fontWeight: 700 }}>
                      {fmt(data.topExplainPct, 0)}%
                    </span>{" "}
                    of move
                  </span>
                )}
              </div>
            </div>

            <ADBar
              advance={data.advanceCount}
              decline={data.declineCount}
              total={data.total}
            />
          </div>

          {/* Treemap — holdings sized by weight, colored by change */}
          {treeData.length > 0 && (
            <div style={{ marginBottom: "16px" }}>
              <div
                style={{
                  fontSize: "11px",
                  color: T.muted,
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  marginBottom: "10px",
                }}
              >
                Who's Driving the Move · sized by weight
              </div>
              <div style={{ width: "100%", height: "220px" }}>
                <ResponsiveContainer width="100%" height="100%">
                  <Treemap
                    data={treeData}
                    dataKey="size"
                    aspectRatio={4 / 3}
                    content={<CustomTreemapContent />}
                  />
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Top contributors & detractors */}
          {(data.topContributors.length > 0 || data.topDetractors.length > 0) && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                gap: "16px",
                marginBottom: "16px",
              }}
            >
              {/* Pullers */}
              <div
                style={{
                  background: T.surface,
                  border: `1px solid ${T.border}`,
                  borderRadius: "10px",
                  padding: "14px",
                }}
              >
                <div
                  style={{
                    fontSize: "11px",
                    color: T.green,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    marginBottom: "10px",
                  }}
                >
                  ▲ Pullers
                </div>
                {data.topContributors.map((h) => (
                  <ContributorRow key={h.symbol} holding={h} isPuller={true} />
                ))}
              </div>

              {/* Draggers */}
              <div
                style={{
                  background: T.surface,
                  border: `1px solid ${T.border}`,
                  borderRadius: "10px",
                  padding: "14px",
                }}
              >
                <div
                  style={{
                    fontSize: "11px",
                    color: T.red,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    marginBottom: "10px",
                  }}
                >
                  ▼ Draggers
                </div>
                {data.topDetractors.map((h) => (
                  <ContributorRow key={h.symbol} holding={h} isPuller={false} />
                ))}
              </div>
            </div>
          )}

          {/* 30-day breadth history */}
          <div
            style={{
              background: T.surface,
              border: `1px solid ${T.border}`,
              borderRadius: "10px",
              padding: "16px",
            }}
          >
            <div
              style={{
                fontSize: "11px",
                color: T.muted,
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                marginBottom: "4px",
              }}
            >
              30-Day Breadth History
            </div>
            <div style={{ fontSize: "11px", color: T.textSub, marginBottom: "12px" }}>
              Above 50% = more advancing than declining
            </div>

            {historyData.length < 3 ? (
              <div
                style={{
                  height: "120px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: T.muted,
                  fontSize: "12px",
                  fontStyle: "italic",
                }}
              >
                Building history… data accumulates daily
              </div>
            ) : (
              <div style={{ width: "100%", height: "160px" }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={historyData}
                    margin={{ top: 4, right: 8, left: -20, bottom: 0 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke={T.border}
                      vertical={false}
                    />
                    <XAxis
                      dataKey="date"
                      tick={{ fill: T.muted, fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      domain={[0, 100]}
                      tick={{ fill: T.muted, fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v) => `${v}%`}
                    />
                    <Tooltip
                      contentStyle={{
                        background: T.card,
                        border: `1px solid ${T.border}`,
                        borderRadius: "8px",
                        fontSize: "11px",
                        color: T.text,
                      }}
                      formatter={(value: number) => [`${fmt(value, 1)}%`, "Breadth"]}
                      labelStyle={{ color: T.textSub }}
                    />
                    <ReferenceLine
                      y={50}
                      stroke={T.muted}
                      strokeDasharray="4 3"
                      label={{
                        value: "50%",
                        fill: T.muted,
                        fontSize: 10,
                        position: "insideTopRight",
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="breadth_pct"
                      stroke={T.green}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, fill: T.green }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
