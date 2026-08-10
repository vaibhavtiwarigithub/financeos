"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer,
} from "recharts";

// ── Palette ─────────────────────────────────────────────────────────────────

const T = {
  bg: "#0D0F1A", card: "#12141F", border: "#1E2030",
  text: "#E2E8F0", muted: "#64748B", accent: "#6366F1",
  green: "#22C55E", red: "#EF4444", yellow: "#EAB308",
};

const LINE_COLORS = [
  "#6366F1","#22C55E","#EAB308","#EF4444","#3B82F6",
  "#A855F7","#F97316","#06B6D4","#EC4899","#84CC16",
];

// ── Indicator metadata ───────────────────────────────────────────────────────

type IndicatorGroup = "scores" | "fundamental" | "price";

const INDICATOR_DEFS: { key: string; label: string; group: IndicatorGroup; pct?: boolean }[] = [
  // Scores
  { key: "analyst_score",     label: "Analyst Score",   group: "scores" },
  { key: "fundamental_score", label: "F-Score",         group: "scores" },
  { key: "technical_score",   label: "T-Score",         group: "scores" },
  { key: "sentiment_score",   label: "S-Score",         group: "scores" },
  { key: "macro_score",       label: "M-Score",         group: "scores" },
  // Price
  { key: "price",             label: "Price",           group: "price"  },
  // Fundamentals
  { key: "PERatio",           label: "P/E",             group: "fundamental" },
  { key: "PEGRatio",          label: "PEG",             group: "fundamental" },
  { key: "ReturnOnEquityTTM", label: "ROE",             group: "fundamental", pct: true },
  { key: "GrossMarginTTM",    label: "Gross Margin",    group: "fundamental", pct: true },
  { key: "FCFYield",          label: "FCF Yield",       group: "fundamental", pct: true },
  { key: "DebtToEquity",      label: "D/E",             group: "fundamental" },
  { key: "QuarterlyRevenueGrowthYOY", label: "Rev Growth", group: "fundamental", pct: true },
  { key: "ProfitMargin",      label: "Profit Margin",   group: "fundamental", pct: true },
  { key: "EPS",               label: "EPS",             group: "fundamental" },
];

const INDICATOR_BY_KEY = Object.fromEntries(INDICATOR_DEFS.map(d => [d.key, d]));

// ── Table column defs ────────────────────────────────────────────────────────

const TABLE_COLS: { key: string; label: string; width: number; pct?: boolean; score?: boolean }[] = [
  { key: "symbol",              label: "Symbol",       width: 90 },
  { key: "market",              label: "Mkt",          width: 42 },
  { key: "direction",           label: "Dir",          width: 58 },
  { key: "analyst_score",       label: "Score",        width: 54, score: true },
  { key: "fundamental_score",   label: "F",            width: 42, score: true },
  { key: "technical_score",     label: "T",            width: 42, score: true },
  { key: "sentiment_score",     label: "S",            width: 42, score: true },
  { key: "macro_score",         label: "M",            width: 42, score: true },
  { key: "PERatio",             label: "P/E",          width: 56 },
  { key: "PEGRatio",            label: "PEG",          width: 50 },
  { key: "ReturnOnEquityTTM",   label: "ROE",          width: 60, pct: true },
  { key: "GrossMarginTTM",      label: "G.Margin",     width: 68, pct: true },
  { key: "FCFYield",            label: "FCF Yld",      width: 64, pct: true },
  { key: "DebtToEquity",        label: "D/E",          width: 50 },
  { key: "QuarterlyRevenueGrowthYOY", label: "Rev↑",  width: 56, pct: true },
  { key: "ProfitMargin",        label: "Net Marg",     width: 68, pct: true },
  { key: "EPS",                 label: "EPS",          width: 58 },
  { key: "last_researched_at",  label: "Last Run",     width: 72 },
];

// ── Types ────────────────────────────────────────────────────────────────────

interface SymbolRow {
  symbol: string; market: string; analyst_score: number;
  fundamental_score: number; technical_score: number;
  sentiment_score: number; macro_score: number;
  direction: string; last_researched_at: string;
  fundamentals: Record<string, string> | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtVal(v: string | number | undefined, pct = false) {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(v as string);
  if (!isFinite(n)) return "—";
  if (pct) return `${(n * 100).toFixed(1)}%`;
  return n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 })
       : n >= 10   ? n.toFixed(1)
       :             n.toFixed(2);
}

function scoreColor(v: number) {
  return v >= 70 ? T.green : v >= 50 ? T.yellow : T.red;
}

function dirColor(d: string) {
  return d === "long" ? T.green : d === "short" ? T.red : T.muted;
}

function daysAgo(iso: string) {
  const d = Math.round((Date.now() - new Date(iso).getTime()) / 86400000);
  return d === 0 ? "today" : `${d}d`;
}

function getCell(row: SymbolRow, key: string) {
  if (key in row) return (row as any)[key];
  return row.fundamentals?.[key] ?? null;
}

// ── Merge chart series into unified date-keyed array ────────────────────────

function mergeSeries(
  series: Record<string, Record<string, { date: string; value: number }[]>>,
  symbols: string[],
  indicators: string[],
) {
  const dateMap = new Map<string, Record<string, number>>();
  for (const sym of symbols) {
    for (const ind of indicators) {
      const pts = series[sym]?.[ind] ?? [];
      for (const { date, value } of pts) {
        if (!dateMap.has(date)) dateMap.set(date, { date: date as any });
        dateMap.get(date)![`${sym}:${ind}`] = value;
      }
    }
  }
  return [...dateMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v);
}

// ── Component ────────────────────────────────────────────────────────────────

export default function FundamentalsPage() {
  const router = useRouter();

  // Universe data
  const [rows, setRows]       = useState<SymbolRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Table controls
  const [query, setQuery]         = useState("");
  const [mktFilter, setMktFilter] = useState<"all" | "us" | "india">("all");
  const [sortKey, setSortKey]     = useState("analyst_score");
  const [sortDir, setSortDir]     = useState<"asc" | "desc">("desc");

  // Chart controls
  const [chartSymbols, setChartSymbols]       = useState<string[]>([]);
  const [chartIndicators, setChartIndicators] = useState<string[]>(["analyst_score"]);
  const [chartDays, setChartDays]             = useState(365);
  const [chartData, setChartData]             = useState<Record<string, any>[]>([]);
  const [chartLoading, setChartLoading]       = useState(false);
  const [rawSeries, setRawSeries]             = useState<Record<string, Record<string, { date: string; value: number }[]>>>({});

  // Load universe
  useEffect(() => {
    fetch("/api/research/universe")
      .then(r => r.json())
      .then(d => { setRows(d.symbols ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  // Fetch chart data when selections change
  useEffect(() => {
    if (!chartSymbols.length || !chartIndicators.length) { setChartData([]); return; }
    setChartLoading(true);
    const params = new URLSearchParams({
      symbols: chartSymbols.join(","),
      indicators: chartIndicators.join(","),
      days: String(chartDays),
    });
    fetch(`/api/research/chart-data?${params}`)
      .then(r => r.json())
      .then(d => {
        setRawSeries(d.series ?? {});
        setChartData(mergeSeries(d.series ?? {}, chartSymbols, chartIndicators));
        setChartLoading(false);
      })
      .catch(() => setChartLoading(false));
  }, [chartSymbols, chartIndicators, chartDays]);

  // Table sort
  function handleSort(key: string) {
    if (sortKey === key) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  const filtered = rows
    .filter(r => {
      if (mktFilter !== "all" && r.market !== mktFilter) return false;
      if (query) {
        const q = query.toLowerCase();
        return r.symbol.toLowerCase().includes(q) ||
          (r.fundamentals?.Sector ?? "").toLowerCase().includes(q);
      }
      return true;
    })
    .sort((a, b) => {
      const av = getCell(a, sortKey);
      const bv = getCell(b, sortKey);
      const an = parseFloat(av) ?? 0;
      const bn = parseFloat(bv) ?? 0;
      if (!isNaN(an) && !isNaN(bn)) return sortDir === "desc" ? bn - an : an - bn;
      const as = String(av ?? "");
      const bs = String(bv ?? "");
      return sortDir === "desc" ? bs.localeCompare(as) : as.localeCompare(bs);
    });

  // Chart symbol toggle
  function toggleChartSymbol(sym: string) {
    setChartSymbols(prev =>
      prev.includes(sym) ? prev.filter(s => s !== sym) : [...prev, sym].slice(0, 10)
    );
  }

  // Chart indicator toggle
  function toggleChartIndicator(ind: string) {
    setChartIndicators(prev =>
      prev.includes(ind) ? prev.filter(s => s !== ind) : [...prev, ind].slice(0, 12)
    );
  }

  // Line keys + colors
  const lineKeys = chartSymbols.flatMap(sym =>
    chartIndicators.map(ind => ({ key: `${sym}:${ind}`, sym, ind }))
  );

  const SortArrow = ({ col }: { col: string }) => (
    <span style={{ fontSize: 8, marginLeft: 3, opacity: sortKey === col ? 1 : 0.3 }}>
      {sortKey === col ? (sortDir === "desc" ? "▼" : "▲") : "▼"}
    </span>
  );

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text }}>

      {/* ── Header ── */}
      <div style={{ padding: "18px 20px 0" }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Fundamentals</h1>
        <p style={{ color: T.muted, fontSize: 12, marginTop: 3 }}>
          All researched symbols — sort any column · select rows to chart historical trends
        </p>
      </div>

      {/* ── Table filter bar ── */}
      <div style={{ padding: "12px 20px 8px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Filter symbol / sector…"
          style={{
            flex: "1 1 160px", minWidth: 120, background: T.card,
            border: `1px solid ${T.border}`, borderRadius: 6,
            padding: "6px 10px", color: T.text, fontSize: 13, outline: "none",
          }}
        />
        {(["all", "us", "india"] as const).map(m => (
          <button key={m} onClick={() => setMktFilter(m)}
            style={{
              padding: "5px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer",
              border: `1px solid ${mktFilter === m ? T.accent : T.border}`,
              background: mktFilter === m ? `${T.accent}22` : T.card,
              color: mktFilter === m ? T.accent : T.muted,
            }}>
            {m === "all" ? "All" : m === "us" ? "🇺🇸 US" : "🇮🇳 India"}
          </button>
        ))}
        <span style={{ fontSize: 11, color: T.muted }}>
          {loading ? "Loading…" : `${filtered.length} symbols`}
        </span>
        {chartSymbols.length > 0 && (
          <span style={{ fontSize: 11, color: T.accent }}>
            {chartSymbols.length} selected for chart ↓
          </span>
        )}
      </div>

      {/* ── Sortable table ── */}
      <div style={{ overflowX: "auto", margin: "0 20px", borderRadius: 8, border: `1px solid ${T.border}` }}>
        <table style={{ borderCollapse: "collapse", width: "max-content", minWidth: "100%", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "#0A0C16", position: "sticky", top: 0, zIndex: 2 }}>
              {TABLE_COLS.map(col => (
                <th key={col.key}
                  onClick={() => handleSort(col.key)}
                  style={{
                    padding: "8px 10px", textAlign: col.key === "symbol" ? "left" : "right",
                    color: sortKey === col.key ? T.accent : T.muted,
                    fontWeight: 600, fontSize: 10, letterSpacing: "0.06em",
                    textTransform: "uppercase", cursor: "pointer", whiteSpace: "nowrap",
                    borderBottom: `1px solid ${T.border}`, minWidth: col.width,
                    userSelect: "none",
                  }}>
                  {col.label}<SortArrow col={col.key} />
                </th>
              ))}
              <th style={{ padding: "8px 10px", color: T.muted, fontSize: 10, borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap" }}>
                ADD TO CHART
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && Array.from({ length: 8 }).map((_, i) => (
              <tr key={i}>
                {TABLE_COLS.map(c => (
                  <td key={c.key} style={{ padding: "8px 10px", borderBottom: `1px solid ${T.border}` }}>
                    <div style={{ height: 12, background: T.border, borderRadius: 3, opacity: 0.5 }} />
                  </td>
                ))}
                <td style={{ borderBottom: `1px solid ${T.border}` }} />
              </tr>
            ))}

            {!loading && filtered.map(row => {
              const inChart = chartSymbols.includes(row.symbol);
              const f = row.fundamentals ?? {};
              return (
                <tr key={`${row.symbol}:${row.market}`}
                  style={{ borderBottom: `1px solid ${T.border}`, background: inChart ? `${T.accent}0D` : "transparent" }}
                  onMouseEnter={e => { if (!inChart) (e.currentTarget as HTMLElement).style.background = "#ffffff08"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = inChart ? `${T.accent}0D` : "transparent"; }}
                >
                  {TABLE_COLS.map(col => {
                    let content: React.ReactNode;

                    if (col.key === "symbol") {
                      content = (
                        <span onClick={() => router.push(`/dashboard/research/${row.symbol}`)}
                          style={{ fontWeight: 700, cursor: "pointer", color: T.accent }}>
                          {row.symbol}
                        </span>
                      );
                    } else if (col.key === "market") {
                      content = <span style={{ color: T.muted }}>{row.market === "india" ? "🇮🇳" : "🇺🇸"}</span>;
                    } else if (col.key === "direction") {
                      content = (
                        <span style={{ color: dirColor(row.direction), fontWeight: 700, fontSize: 10 }}>
                          {row.direction?.toUpperCase() ?? "—"}
                        </span>
                      );
                    } else if (col.key === "last_researched_at") {
                      content = <span style={{ color: T.muted }}>{daysAgo(row.last_researched_at)}</span>;
                    } else if (col.score) {
                      const v = Number((row as any)[col.key]);
                      content = (
                        <span style={{ fontWeight: 700, color: scoreColor(v) }}>{isNaN(v) ? "—" : v}</span>
                      );
                    } else {
                      const raw = f[col.key];
                      content = <span style={{ color: raw ? T.text : T.muted }}>{fmtVal(raw, col.pct)}</span>;
                    }

                    return (
                      <td key={col.key} style={{
                        padding: "7px 10px",
                        textAlign: col.key === "symbol" ? "left" : "right",
                        whiteSpace: "nowrap",
                      }}>
                        {content}
                      </td>
                    );
                  })}
                  {/* Chart toggle */}
                  <td style={{ padding: "7px 10px", textAlign: "center" }}>
                    <button
                      onClick={() => toggleChartSymbol(row.symbol)}
                      style={{
                        background: inChart ? T.accent : T.card,
                        border: `1px solid ${inChart ? T.accent : T.border}`,
                        color: inChart ? "#fff" : T.muted,
                        borderRadius: 4, padding: "2px 8px", fontSize: 10,
                        fontWeight: 600, cursor: "pointer",
                      }}>
                      {inChart ? "✓ Added" : "+ Chart"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Chart builder ── */}
      <div style={{ padding: "24px 20px 40px" }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>
          Historical Chart Builder
          <span style={{ fontWeight: 400, fontSize: 11, color: T.muted, marginLeft: 8 }}>
            select symbols above · choose indicators below
          </span>
        </div>

        {/* Indicator multiselect */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
            Indicators
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {INDICATOR_DEFS.map(ind => {
              const active = chartIndicators.includes(ind.key);
              return (
                <button key={ind.key} onClick={() => toggleChartIndicator(ind.key)}
                  style={{
                    padding: "4px 10px", borderRadius: 12, fontSize: 11, cursor: "pointer",
                    fontWeight: active ? 700 : 400,
                    border: `1px solid ${active ? T.accent : T.border}`,
                    background: active ? `${T.accent}22` : T.card,
                    color: active ? T.accent : T.muted,
                  }}>
                  {ind.label}
                  <span style={{ fontSize: 9, marginLeft: 3, opacity: 0.6 }}>
                    {ind.group === "scores" ? "S" : ind.group === "price" ? "P" : "F"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Time window */}
        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          {([90, 180, 365, 730, 2000] as const).map(d => (
            <button key={d} onClick={() => setChartDays(d)}
              style={{
                padding: "4px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer",
                border: `1px solid ${chartDays === d ? T.accent : T.border}`,
                background: chartDays === d ? `${T.accent}22` : T.card,
                color: chartDays === d ? T.accent : T.muted,
              }}>
              {d === 90 ? "3M" : d === 180 ? "6M" : d === 365 ? "1Y" : d === 730 ? "2Y" : "All"}
            </button>
          ))}
        </div>

        {/* Empty state */}
        {!chartSymbols.length && (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "32px", textAlign: "center", color: T.muted, fontSize: 13 }}>
            Click "+ Chart" on any row above to add symbols, then pick indicators.
          </div>
        )}

        {/* Selected symbols chips */}
        {chartSymbols.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            {chartSymbols.map((sym, i) => (
              <span key={sym} style={{
                background: `${LINE_COLORS[i % LINE_COLORS.length]}22`,
                border: `1px solid ${LINE_COLORS[i % LINE_COLORS.length]}`,
                borderRadius: 12, padding: "3px 10px", fontSize: 11, fontWeight: 700,
                color: LINE_COLORS[i % LINE_COLORS.length], cursor: "pointer",
              }} onClick={() => toggleChartSymbol(sym)}>
                {sym} ×
              </span>
            ))}
          </div>
        )}

        {/* Charts — one per indicator (separate y-axes make sense) */}
        {chartSymbols.length > 0 && chartIndicators.map((ind, chartIdx) => {
          const def = INDICATOR_BY_KEY[ind];
          const seriesKeys = chartSymbols.map(sym => ({
            key: `${sym}:${ind}`,
            sym,
            color: LINE_COLORS[chartSymbols.indexOf(sym) % LINE_COLORS.length],
          }));

          // Build data for this indicator only
          const dateMap = new Map<string, Record<string, number>>();
          for (const sym of chartSymbols) {
            const pts = rawSeries[sym]?.[ind] ?? [];
            for (const { date, value } of pts) {
              if (!dateMap.has(date)) dateMap.set(date, { date: date as any });
              dateMap.get(date)![`${sym}:${ind}`] = value;
            }
          }
          const data = [...dateMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v);

          if (!data.length && !chartLoading) return null;

          return (
            <div key={ind} style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: T.text, marginBottom: 8 }}>
                {def?.label ?? ind}
                <span style={{ fontSize: 10, color: T.muted, marginLeft: 6 }}>
                  {def?.group === "scores" ? "Score (0–100)" : def?.group === "price" ? "Price" : def?.pct ? "%" : "ratio"}
                </span>
              </div>
              <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "12px 4px 4px" }}>
                {chartLoading ? (
                  <div style={{ height: 180, display: "flex", alignItems: "center", justifyContent: "center", color: T.muted, fontSize: 12 }}>
                    Loading…
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={180}>
                    <LineChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
                      <XAxis dataKey="date" tick={{ fontSize: 9, fill: T.muted }} tickFormatter={d => d.slice(5)} minTickGap={40} />
                      <YAxis tick={{ fontSize: 9, fill: T.muted }} width={38}
                        tickFormatter={v => def?.pct ? `${(v * 100).toFixed(0)}%` : String(Number(v).toFixed(0))} />
                      <Tooltip
                        contentStyle={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, fontSize: 11 }}
                        formatter={(v: any, name: string) => {
                          const sym = name.split(":")[0];
                          const fmted = def?.pct ? `${(Number(v) * 100).toFixed(1)}%` : Number(v).toFixed(2);
                          return [fmted, sym];
                        }}
                      />
                      <Legend formatter={(name: string) => name.split(":")[0]} wrapperStyle={{ fontSize: 10 }} />
                      {seriesKeys.map(({ key, color }) => (
                        <Line key={key} dataKey={key} stroke={color} dot={false} strokeWidth={1.5}
                          connectNulls activeDot={{ r: 3 }} />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
