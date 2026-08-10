"use client";

import React, { useState, useEffect, useRef } from "react";
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

// ── Table column definitions ─────────────────────────────────────────────────

interface ColDef {
  key: string; label: string; width: number;
  pct?: boolean; score?: boolean; tooltip: string;
  defaultHidden?: boolean;
}

const ALL_COLS: ColDef[] = [
  { key: "symbol",   label: "Symbol",   width: 90, tooltip: "Ticker — click to open deep dive" },
  { key: "Name",     label: "Name",     width: 160, defaultHidden: true, tooltip: "Company full name" },
  { key: "Sector",   label: "Sector",   width: 110, defaultHidden: true, tooltip: "Sector from provider taxonomy" },
  { key: "market",   label: "Mkt",      width: 42,  tooltip: "Market: 🇺🇸 US or 🇮🇳 India (NSE)" },
  { key: "direction",label: "Dir",      width: 58,  tooltip: "Signal direction: LONG / NEUTRAL / SHORT from last research run" },
  { key: "analyst_score",     label: "Score", width: 54, score: true, tooltip: "Composite analyst score (0–100): weighted F + T + S + M" },
  { key: "fundamental_score", label: "F",     width: 42, score: true, tooltip: "Fundamental score (0–100): P/E, PEG, ROE, FCF Yield, D/E, Gross Margin, Rev Growth, EPS trend" },
  { key: "technical_score",   label: "T",     width: 42, score: true, tooltip: "Technical score (0–100): RSI, EMA 20/50/200, MACD, ADX trend strength, RS vs benchmark, 52W proximity" },
  { key: "sentiment_score",   label: "S",     width: 42, score: true, tooltip: "Sentiment score (0–100): news sentiment, analyst upgrades/downgrades, insider activity" },
  { key: "macro_score",       label: "M",     width: 42, score: true, tooltip: "Macro score (0–100): market regime, VIX, sector breadth, yield curve context" },
  { key: "PERatio",           label: "P/E",   width: 56, tooltip: "Price-to-Earnings TTM. Lower = cheaper vs earnings. Scored vs sector median." },
  { key: "PEGRatio",          label: "PEG",   width: 50, tooltip: "PEG = P/E ÷ earnings growth rate. <1 = potentially undervalued for growth; >3 = expensive" },
  { key: "ReturnOnEquityTTM", label: "ROE",   width: 60, pct: true, tooltip: "Return on Equity TTM: net income ÷ equity. How efficiently management uses capital." },
  { key: "GrossMarginTTM",    label: "G.Mgn", width: 64, pct: true, tooltip: "Gross Margin TTM: (revenue − COGS) ÷ revenue. Higher = stronger pricing power." },
  { key: "FCFYield",          label: "FCF%",  width: 56, pct: true, tooltip: "Free Cash Flow Yield: FCF ÷ market cap. >5% = high cash generation; <0% = burning cash." },
  { key: "DebtToEquity",      label: "D/E",   width: 50, tooltip: "Debt-to-Equity: total debt ÷ equity. <0.5 = conservative; >2.0 = high leverage risk." },
  { key: "QuarterlyRevenueGrowthYOY", label: "Rev↑", width: 56, pct: true, tooltip: "Quarterly Revenue Growth YoY. Positive = accelerating top-line." },
  { key: "ProfitMargin",      label: "N.Mgn", width: 60, pct: true, tooltip: "Net Profit Margin: net income ÷ revenue. % of sales that becomes profit after all costs." },
  { key: "EPS",               label: "EPS",   width: 58, tooltip: "Earnings Per Share TTM: total earnings ÷ shares outstanding." },
  { key: "last_researched_at",label: "Last",  width: 60, tooltip: "Days since last research pipeline run for this symbol." },
];

const COL_BY_KEY = Object.fromEntries(ALL_COLS.map(c => [c.key, c]));

// ── Indicator definitions for chart builder ──────────────────────────────────

const INDICATOR_DEFS = [
  { key: "analyst_score",     label: "Analyst Score",  group: "scores" as const },
  { key: "fundamental_score", label: "F-Score",        group: "scores" as const },
  { key: "technical_score",   label: "T-Score",        group: "scores" as const },
  { key: "sentiment_score",   label: "S-Score",        group: "scores" as const },
  { key: "macro_score",       label: "M-Score",        group: "scores" as const },
  { key: "price",             label: "Price",          group: "price"  as const },
  { key: "PERatio",           label: "P/E",            group: "fundamental" as const },
  { key: "PEGRatio",          label: "PEG",            group: "fundamental" as const },
  { key: "ReturnOnEquityTTM", label: "ROE",            group: "fundamental" as const, pct: true },
  { key: "GrossMarginTTM",    label: "Gross Margin",   group: "fundamental" as const, pct: true },
  { key: "FCFYield",          label: "FCF Yield",      group: "fundamental" as const, pct: true },
  { key: "DebtToEquity",      label: "D/E",            group: "fundamental" as const },
  { key: "QuarterlyRevenueGrowthYOY", label: "Rev Growth", group: "fundamental" as const, pct: true },
  { key: "ProfitMargin",      label: "Profit Margin",  group: "fundamental" as const, pct: true },
  { key: "EPS",               label: "EPS",            group: "fundamental" as const },
];
const IND_BY_KEY = Object.fromEntries(INDICATOR_DEFS.map(d => [d.key, d]));

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
       : n >= 10   ? n.toFixed(1) : n.toFixed(2);
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

// ── Component ────────────────────────────────────────────────────────────────

export default function FundamentalsPage() {
  const router = useRouter();

  // Universe
  const [rows, setRows]       = useState<SymbolRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Table controls
  const [query, setQuery]           = useState("");
  const [mktFilter, setMktFilter]   = useState<"all" | "us" | "india">("all");
  const [sortKey, setSortKey]       = useState("analyst_score");
  const [sortDir, setSortDir]       = useState<"asc" | "desc">("desc");

  // Column visibility + order
  const [colOrder,  setColOrder]  = useState<string[]>(ALL_COLS.map(c => c.key));
  const [hiddenSet, setHiddenSet] = useState<Set<string>>(
    new Set(ALL_COLS.filter(c => c.defaultHidden).map(c => c.key))
  );
  const [showColPicker, setShowColPicker] = useState(false);

  // Drag-to-reorder columns
  const dragFrom = useRef<number | null>(null);

  // Chart controls
  const [chartSymbols,    setChartSymbols]    = useState<string[]>([]);
  const [chartIndicators, setChartIndicators] = useState<string[]>(["analyst_score"]);
  const [chartDays,       setChartDays]       = useState(365);
  const [chartData,       setChartData]       = useState<Record<string, any>[]>([]);
  const [chartLoading,    setChartLoading]    = useState(false);
  const [rawSeries, setRawSeries] = useState<Record<string, Record<string, { date: string; value: number }[]>>>({});

  // Load universe
  useEffect(() => {
    fetch("/api/research/universe")
      .then(r => r.json())
      .then(d => { setRows(d.symbols ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  // Chart fetch
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
        setChartLoading(false);
      })
      .catch(() => setChartLoading(false));
  }, [chartSymbols, chartIndicators, chartDays]);

  // Visible cols in order
  const visibleCols = colOrder
    .filter(k => !hiddenSet.has(k))
    .map(k => COL_BY_KEY[k])
    .filter(Boolean);

  // Sort
  function handleSort(key: string) {
    if (sortKey === key) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  // Column drag handlers
  function onDragStart(i: number) { dragFrom.current = i; }
  function onDragOver(e: React.DragEvent) { e.preventDefault(); }
  function onDrop(toIdx: number) {
    const from = dragFrom.current;
    if (from == null || from === toIdx) return;
    setColOrder(prev => {
      // Work on visible order only then splice back
      const visKeys = prev.filter(k => !hiddenSet.has(k));
      const fromKey = visKeys[from];
      visKeys.splice(from, 1);
      visKeys.splice(toIdx, 0, fromKey);
      // Rebuild full order: hidden cols preserve their original relative positions
      const hiddenKeys = prev.filter(k => hiddenSet.has(k));
      return [...visKeys, ...hiddenKeys];
    });
    dragFrom.current = null;
  }

  // Column toggle
  function toggleCol(key: string) {
    setHiddenSet(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  // Chart toggles
  function toggleChartSymbol(sym: string) {
    setChartSymbols(prev =>
      prev.includes(sym) ? prev.filter(s => s !== sym) : [...prev, sym].slice(0, 10)
    );
  }
  function toggleChartIndicator(ind: string) {
    setChartIndicators(prev =>
      prev.includes(ind) ? prev.filter(s => s !== ind) : [...prev, ind].slice(0, 12)
    );
  }

  // Filter + sort rows
  const filtered = rows
    .filter(r => {
      if (mktFilter !== "all" && r.market !== mktFilter) return false;
      if (query) {
        const q = query.toLowerCase();
        return r.symbol.toLowerCase().includes(q) ||
          (r.fundamentals?.Sector ?? "").toLowerCase().includes(q) ||
          (r.fundamentals?.Name ?? "").toLowerCase().includes(q);
      }
      return true;
    })
    .sort((a, b) => {
      const av = getCell(a, sortKey), bv = getCell(b, sortKey);
      const an = parseFloat(av), bn = parseFloat(bv);
      if (!isNaN(an) && !isNaN(bn)) return sortDir === "desc" ? bn - an : an - bn;
      return sortDir === "desc"
        ? String(bv ?? "").localeCompare(String(av ?? ""))
        : String(av ?? "").localeCompare(String(bv ?? ""));
    });

  const SortArrow = ({ col }: { col: string }) => (
    <span style={{ fontSize: 8, marginLeft: 2, opacity: sortKey === col ? 1 : 0.25 }}>
      {sortKey === col && sortDir === "asc" ? "▲" : "▼"}
    </span>
  );

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text }}>

      {/* ── Header ── */}
      <div style={{ padding: "18px 20px 0" }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Fundamentals</h1>
        <p style={{ color: T.muted, fontSize: 12, marginTop: 3 }}>
          All researched symbols — chart history · sortable table · customisable columns
        </p>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          CHART BUILDER — above table
      ══════════════════════════════════════════════════════════════════════ */}
      <div style={{ padding: "16px 20px 0" }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>
          Historical Chart Builder
          <span style={{ fontWeight: 400, fontSize: 11, color: T.muted, marginLeft: 8 }}>
            click "+ Chart" in table · pick indicators · compare symbols
          </span>
        </div>

        {/* Indicator pills */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 9, color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 5 }}>
            Indicators — S=Score · P=Price · F=Fundamental
          </div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {INDICATOR_DEFS.map(ind => {
              const active = chartIndicators.includes(ind.key);
              return (
                <button key={ind.key} onClick={() => toggleChartIndicator(ind.key)}
                  style={{
                    padding: "3px 9px", borderRadius: 10, fontSize: 11, cursor: "pointer",
                    fontWeight: active ? 700 : 400,
                    border: `1px solid ${active ? T.accent : T.border}`,
                    background: active ? `${T.accent}22` : T.card,
                    color: active ? T.accent : T.muted,
                  }}>
                  {ind.label}
                  <span style={{ fontSize: 9, marginLeft: 3, opacity: 0.5 }}>
                    {ind.group === "scores" ? "S" : ind.group === "price" ? "P" : "F"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Time window */}
        <div style={{ display: "flex", gap: 5, marginBottom: 12 }}>
          {([90, 180, 365, 730, 2000] as const).map(d => (
            <button key={d} onClick={() => setChartDays(d)}
              style={{
                padding: "3px 9px", borderRadius: 5, fontSize: 11, cursor: "pointer",
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
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8,
            padding: "20px", textAlign: "center", color: T.muted, fontSize: 12, marginBottom: 12 }}>
            Click "+ Chart" on any row in the table below to add symbols here.
          </div>
        )}

        {/* Symbol chips */}
        {chartSymbols.length > 0 && (
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
            {chartSymbols.map((sym, i) => (
              <span key={sym}
                onClick={() => toggleChartSymbol(sym)}
                style={{
                  background: `${LINE_COLORS[i % LINE_COLORS.length]}22`,
                  border: `1px solid ${LINE_COLORS[i % LINE_COLORS.length]}`,
                  borderRadius: 10, padding: "2px 9px", fontSize: 11, fontWeight: 700,
                  color: LINE_COLORS[i % LINE_COLORS.length], cursor: "pointer",
                }}>
                {sym} ×
              </span>
            ))}
          </div>
        )}

        {/* One chart per indicator */}
        {chartSymbols.length > 0 && chartIndicators.map(ind => {
          const def = IND_BY_KEY[ind];
          const dateMap = new Map<string, Record<string, number>>();
          for (const sym of chartSymbols) {
            for (const { date, value } of rawSeries[sym]?.[ind] ?? []) {
              if (!dateMap.has(date)) dateMap.set(date, { date: date as any });
              dateMap.get(date)![`${sym}`] = value;
            }
          }
          const data = [...dateMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([,v]) => v);
          if (!data.length && !chartLoading) return null;
          return (
            <div key={ind} style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 5 }}>
                {def?.label ?? ind}
                <span style={{ fontSize: 9, marginLeft: 6 }}>
                  {def?.group === "scores" ? "0–100" : def?.pct ? "%" : def?.group === "price" ? "$" : "ratio"}
                </span>
              </div>
              <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 4px 4px" }}>
                {chartLoading ? (
                  <div style={{ height: 160, display: "flex", alignItems: "center", justifyContent: "center", color: T.muted, fontSize: 11 }}>
                    Loading…
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={160}>
                    <LineChart data={data} margin={{ top: 4, right: 12, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
                      <XAxis dataKey="date" tick={{ fontSize: 9, fill: T.muted }}
                        tickFormatter={d => d.slice(5)} minTickGap={40} />
                      <YAxis tick={{ fontSize: 9, fill: T.muted }} width={36}
                        tickFormatter={v => def?.pct ? `${(v*100).toFixed(0)}%` : Number(v).toFixed(0)} />
                      <Tooltip
                        contentStyle={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, fontSize: 11 }}
                        formatter={(v: any, name: string) => [
                          def?.pct ? `${(Number(v)*100).toFixed(1)}%` : Number(v).toFixed(2),
                          name,
                        ]}
                      />
                      <Legend wrapperStyle={{ fontSize: 10 }} />
                      {chartSymbols.map((sym, i) => (
                        <Line key={sym} dataKey={sym} stroke={LINE_COLORS[i % LINE_COLORS.length]}
                          dot={false} strokeWidth={1.5} connectNulls activeDot={{ r: 3 }} />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          TABLE — filter bar + sortable table
      ══════════════════════════════════════════════════════════════════════ */}
      <div style={{ padding: "16px 20px 8px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Filter by symbol, sector, name…"
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

        {/* Column picker */}
        <div style={{ position: "relative" }}>
          <button onClick={() => setShowColPicker(p => !p)}
            style={{
              padding: "5px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer",
              border: `1px solid ${showColPicker ? T.accent : T.border}`,
              background: showColPicker ? `${T.accent}22` : T.card,
              color: showColPicker ? T.accent : T.muted,
            }}>
            ⚙ Columns
          </button>
          {showColPicker && (
            <div style={{
              position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 50,
              background: T.card, border: `1px solid ${T.border}`, borderRadius: 8,
              padding: "10px 12px", minWidth: 200, boxShadow: "0 8px 24px #00000066",
            }}>
              <div style={{ fontSize: 10, color: T.muted, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Show / hide columns
              </div>
              {ALL_COLS.map(col => (
                <label key={col.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", cursor: "pointer" }}>
                  <input type="checkbox" checked={!hiddenSet.has(col.key)} onChange={() => toggleCol(col.key)} />
                  <span style={{ fontSize: 12, color: T.text }}>{col.label}</span>
                  <span style={{ fontSize: 10, color: T.muted, flex: 1, textAlign: "right" }}>
                    {col.key === "symbol" ? "required" : ""}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>

        <span style={{ fontSize: 11, color: T.muted }}>
          {loading ? "Loading…" : `${filtered.length} symbols`}
        </span>
        {chartSymbols.length > 0 && (
          <span style={{ fontSize: 11, color: T.accent }}>
            {chartSymbols.length} in chart ↑
          </span>
        )}
      </div>

      {/* Table */}
      <div style={{ overflowX: "auto", margin: "0 20px 32px", borderRadius: 8, border: `1px solid ${T.border}` }}
        onClick={() => setShowColPicker(false)}>
        <table style={{ borderCollapse: "collapse", width: "max-content", minWidth: "100%", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "#0A0C16" }}>
              {visibleCols.map((col, i) => (
                <th key={col.key}
                  draggable
                  onDragStart={() => onDragStart(i)}
                  onDragOver={onDragOver}
                  onDrop={() => onDrop(i)}
                  onClick={() => handleSort(col.key)}
                  title={col.tooltip}
                  style={{
                    padding: "8px 10px",
                    textAlign: col.key === "symbol" || col.key === "Name" || col.key === "Sector" ? "left" : "right",
                    color: sortKey === col.key ? T.accent : T.muted,
                    fontWeight: 600, fontSize: 10, letterSpacing: "0.06em",
                    textTransform: "uppercase", cursor: "grab", whiteSpace: "nowrap",
                    borderBottom: `1px solid ${T.border}`, minWidth: col.width,
                    userSelect: "none",
                  }}>
                  {col.label}<SortArrow col={col.key} />
                </th>
              ))}
              <th style={{ padding: "8px 10px", color: T.muted, fontSize: 10, borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap" }}>
                CHART
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && Array.from({ length: 8 }).map((_, i) => (
              <tr key={i}>
                {visibleCols.map(c => (
                  <td key={c.key} style={{ padding: "8px 10px", borderBottom: `1px solid ${T.border}` }}>
                    <div style={{ height: 12, background: T.border, borderRadius: 3, opacity: 0.4 }} />
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
                  onMouseEnter={e => { if (!inChart) (e.currentTarget as HTMLElement).style.background = "#ffffff07"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = inChart ? `${T.accent}0D` : "transparent"; }}
                >
                  {visibleCols.map(col => {
                    let content: React.ReactNode;
                    const isLeft = col.key === "symbol" || col.key === "Name" || col.key === "Sector";

                    if (col.key === "symbol") {
                      content = (
                        <span onClick={() => router.push(`/dashboard/research/${row.symbol}`)}
                          style={{ fontWeight: 700, cursor: "pointer", color: T.accent }}>
                          {row.symbol}
                        </span>
                      );
                    } else if (col.key === "Name" || col.key === "Sector") {
                      const v = f[col.key] ?? "—";
                      content = <span style={{ color: v === "—" ? T.muted : T.text, maxWidth: col.width, overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>{v}</span>;
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
                      <td key={col.key} style={{ padding: "7px 10px", textAlign: isLeft ? "left" : "right", whiteSpace: "nowrap" }}>
                        {content}
                      </td>
                    );
                  })}
                  <td style={{ padding: "7px 10px", textAlign: "center" }}>
                    <button onClick={() => toggleChartSymbol(row.symbol)}
                      style={{
                        background: inChart ? T.accent : T.card,
                        border: `1px solid ${inChart ? T.accent : T.border}`,
                        color: inChart ? "#fff" : T.muted,
                        borderRadius: 4, padding: "2px 7px", fontSize: 10,
                        fontWeight: 600, cursor: "pointer",
                      }}>
                      {inChart ? "✓" : "+"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
