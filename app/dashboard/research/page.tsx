"use client";

import React, { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, ReferenceLine,
} from "recharts";

// ── Palette ──────────────────────────────────────────────────────────────────

const T = {
  bg: "#0D0F1A", card: "#12141F", border: "#1E2030",
  text: "#E2E8F0", muted: "#64748B", accent: "#6366F1",
  green: "#22C55E", red: "#EF4444", yellow: "#EAB308",
};

const LINE_COLORS = [
  "#6366F1","#22C55E","#EAB308","#EF4444","#3B82F6",
  "#A855F7","#F97316","#06B6D4","#EC4899","#84CC16",
];

// ── Chart grouping: same-scale indicators share one panel ─────────────────────

const CHART_GROUPS = [
  {
    id: "scores", label: "Scores (0–100)",
    keys: ["analyst_score","fundamental_score","technical_score","sentiment_score","macro_score"],
    pct: false, yDomain: [0, 100] as [number,number],
  },
  {
    id: "price",  label: "Price",
    keys: ["price"],
    pct: false,
  },
  {
    id: "pct",    label: "Margins & Yields (%)",
    keys: ["ReturnOnEquityTTM","GrossMarginTTM","FCFYield","QuarterlyRevenueGrowthYOY","ProfitMargin"],
    pct: true,
  },
  {
    id: "ratio",  label: "Valuation Ratios",
    keys: ["PERatio","PEGRatio","DebtToEquity"],
    pct: false,
  },
  {
    id: "eps",    label: "EPS",
    keys: ["EPS"],
    pct: false,
  },
];

// ── Indicator defs ────────────────────────────────────────────────────────────

const INDICATOR_DEFS = [
  { key: "analyst_score",     label: "Analyst Score",  group: "scores" },
  { key: "fundamental_score", label: "F-Score",        group: "scores" },
  { key: "technical_score",   label: "T-Score",        group: "scores" },
  { key: "sentiment_score",   label: "S-Score",        group: "scores" },
  { key: "macro_score",       label: "M-Score",        group: "scores" },
  { key: "price",             label: "Price",          group: "price"  },
  { key: "PERatio",           label: "P/E",            group: "ratio"  },
  { key: "PEGRatio",          label: "PEG",            group: "ratio"  },
  { key: "ReturnOnEquityTTM", label: "ROE",            group: "pct", pct: true },
  { key: "GrossMarginTTM",    label: "Gross Margin",   group: "pct", pct: true },
  { key: "FCFYield",          label: "FCF Yield",      group: "pct", pct: true },
  { key: "DebtToEquity",      label: "D/E",            group: "ratio"  },
  { key: "QuarterlyRevenueGrowthYOY", label: "Rev Growth", group: "pct", pct: true },
  { key: "ProfitMargin",      label: "Profit Margin",  group: "pct", pct: true },
  { key: "EPS",               label: "EPS",            group: "eps"    },
];
const IND_BY_KEY = Object.fromEntries(INDICATOR_DEFS.map(d => [d.key, d]));

// ── Table column defs ─────────────────────────────────────────────────────────

interface ColDef {
  key: string; label: string; width: number;
  pct?: boolean; score?: boolean; tooltip: string; defaultHidden?: boolean;
}

const ALL_COLS: ColDef[] = [
  { key: "run_date",   label: "Date",      width: 86,  tooltip: "Exact date and time this research run was executed" },
  { key: "symbol",     label: "Symbol",    width: 90,  tooltip: "Ticker — click to open deep dive" },
  { key: "Name",       label: "Name",      width: 160, defaultHidden: true, tooltip: "Company full name" },
  { key: "Sector",     label: "Sector",    width: 110, defaultHidden: true, tooltip: "Sector from provider taxonomy" },
  { key: "market",     label: "Mkt",       width: 42,  tooltip: "Market: 🇺🇸 US (NYSE/Nasdaq) or 🇮🇳 India (NSE)" },
  { key: "direction",  label: "Dir",       width: 58,  tooltip: "Signal direction: LONG / NEUTRAL / SHORT from this research run" },
  { key: "analyst_score",     label: "Score", width: 54, score: true,
    tooltip: "Composite analyst score (0–100)\nFormula: weighted sum of F + T + S + M using champion genome weights.\nWeights are learned from closed-trade outcomes by LearnerAgent." },
  { key: "fundamental_score", label: "F",     width: 42, score: true,
    tooltip: "Fundamental score (0–100)\nKey drivers:\n• P/E vs sector median: ±15 pts\n• PEG: <1→+12, <2→+6, >3→-10\n• ROE: >15%→+10, >8%→+5, <0→-10\n• EPS growth: >20%→+10, >5%→+5\n• Revenue growth: >20%→+15, >10%→+8, <-10→-12\n• FCF Yield: >5%→+12, <0→-10\n• D/E: <0.5→+8, >3→-15\n• Gross Margin: >50%→+10, >30%→+5\n• 52W proximity: within 5%→+15, within 10%→+10" },
  { key: "technical_score",   label: "T",     width: 42, score: true,
    tooltip: "Technical score (0–100)\nKey drivers:\n• RSI: 40–60→+10, >70→-5, <30→-20\n• EMA20>EMA50→+8, below→-8\n• EMA50>EMA200→+10, below→-10\n• MACD histogram: pos→+5, neg→-5\n• RS vs benchmark: >5%→+8, >0→+4, <-5%→-8\n• ADX≥25→×1.15 (trending), ADX<20→×0.75 (ranging)\n• Breakdown veto: ATR crash caps score at 20" },
  { key: "sentiment_score",   label: "S",     width: 42, score: true,
    tooltip: "Sentiment score (0–100)\nSources: news sentiment (GDELT/Finnhub), analyst upgrades/downgrades, insider buying/selling activity" },
  { key: "macro_score",       label: "M",     width: 42, score: true,
    tooltip: "Macro score (0–100)\nSources: market regime (bull/bear/neutral), VIX level, sector breadth, yield curve context from macro_regime table" },
  { key: "last_trade_side",   label: "Trade", width: 60, defaultHidden: false,
    tooltip: "Last paper trade executed for this symbol: BUY (entry) or SELL (exit). Shows score at time of trade in parentheses." },
  { key: "PERatio",           label: "P/E",   width: 56, tooltip: "Price-to-Earnings TTM. Scored vs sector median. Lower relative to sector = better." },
  { key: "PEGRatio",          label: "PEG",   width: 50, tooltip: "PEG = P/E ÷ earnings growth rate. <1 = undervalued for growth; >3 = expensive." },
  { key: "ReturnOnEquityTTM", label: "ROE",   width: 60, pct: true, tooltip: "Return on Equity TTM: net income ÷ equity. Measures management capital efficiency." },
  { key: "GrossMarginTTM",    label: "G.Mgn", width: 64, pct: true, tooltip: "Gross Margin TTM: (revenue − COGS) ÷ revenue. Pricing power proxy." },
  { key: "FCFYield",          label: "FCF%",  width: 56, pct: true, tooltip: "Free Cash Flow Yield: FCF ÷ market cap. >5% = strong cash gen; <0% = burning cash." },
  { key: "DebtToEquity",      label: "D/E",   width: 50, tooltip: "Debt-to-Equity: total debt ÷ equity. <0.5 = conservative; >2.0 = high leverage risk." },
  { key: "QuarterlyRevenueGrowthYOY", label: "Rev↑", width: 56, pct: true, tooltip: "Quarterly Revenue Growth YoY — top-line acceleration signal." },
  { key: "ProfitMargin",      label: "N.Mgn", width: 60, pct: true, tooltip: "Net Profit Margin: net income ÷ revenue." },
  { key: "EPS",               label: "EPS",   width: 58, tooltip: "Earnings Per Share TTM." },
];

const COL_BY_KEY = Object.fromEntries(ALL_COLS.map(c => [c.key, c]));

// ── Types ─────────────────────────────────────────────────────────────────────

interface LastTrade { side: string; date: string; exit_at: string | null; analyst_score: number | null }

interface SymbolRow {
  symbol: string; market: string; analyst_score: number;
  fundamental_score: number; technical_score: number;
  sentiment_score: number; macro_score: number;
  direction: string; last_researched_at: string;
  fundamentals: Record<string, string> | null;
  last_trade: LastTrade | null;
}

interface TradeMarker { date: string; side: string; type: "entry" | "exit"; analyst_score: number | null }

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtVal(v: string | number | undefined, pct = false) {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(v as string);
  if (!isFinite(n)) return "—";
  if (pct) return `${(n * 100).toFixed(1)}%`;
  return n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 })
       : n >= 10 ? n.toFixed(1) : n.toFixed(2);
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toISOString().slice(0, 10);
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function scoreColor(v: number) { return v >= 70 ? T.green : v >= 50 ? T.yellow : T.red; }
function dirColor(d: string)   { return d === "long" ? T.green : d === "short" ? T.red : T.muted; }

function getCell(row: SymbolRow, key: string) {
  if (key in row) return (row as any)[key];
  return row.fundamentals?.[key] ?? null;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function FundamentalsPage() {
  const router = useRouter();

  const [rows, setRows]         = useState<SymbolRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [viewMode, setViewMode] = useState<"latest" | "all_runs">("latest");

  // Table controls
  const [query, setQuery]           = useState("");
  const [mktFilter, setMktFilter]   = useState<"all" | "us" | "india">("all");
  const [sortKey, setSortKey]       = useState("analyst_score");
  const [sortDir, setSortDir]       = useState<"asc" | "desc">("desc");

  // Column management
  const [colOrder,  setColOrder]  = useState<string[]>(ALL_COLS.map(c => c.key));
  const [hiddenSet, setHiddenSet] = useState<Set<string>>(
    new Set(ALL_COLS.filter(c => c.defaultHidden).map(c => c.key))
  );
  const [showColPicker, setShowColPicker] = useState(false);
  const dragFrom = useRef<number | null>(null);

  // Chart
  const [chartSymbols,     setChartSymbols]     = useState<string[]>([]);
  const [chartIndicators,  setChartIndicators]  = useState<string[]>(["analyst_score","fundamental_score","technical_score"]);
  const [chartDays,        setChartDays]        = useState(365);
  const [showTradeMarkers, setShowTradeMarkers] = useState(true);
  const [chartLoading,     setChartLoading]     = useState(false);
  const [rawSeries, setRawSeries]   = useState<Record<string, Record<string, { date: string; value: number }[]>>>({});
  const [tradeMarkers, setTradeMarkers] = useState<Record<string, TradeMarker[]>>({});

  // Load rows
  useEffect(() => {
    setLoading(true);
    fetch(`/api/research/universe?mode=${viewMode}`)
      .then(r => r.json())
      .then(d => { setRows(d.symbols ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [viewMode]);

  // Load chart data
  useEffect(() => {
    if (!chartSymbols.length || !chartIndicators.length) {
      setRawSeries({}); setTradeMarkers({}); return;
    }
    setChartLoading(true);
    const params = new URLSearchParams({
      symbols: chartSymbols.join(","),
      indicators: chartIndicators.join(","),
      days: String(chartDays),
      include_trades: String(showTradeMarkers),
    });
    fetch(`/api/research/chart-data?${params}`)
      .then(r => r.json())
      .then(d => {
        setRawSeries(d.series ?? {});
        setTradeMarkers(d.trade_markers ?? {});
        setChartLoading(false);
      })
      .catch(() => setChartLoading(false));
  }, [chartSymbols, chartIndicators, chartDays, showTradeMarkers]);

  // Visible + ordered cols (in latest mode show fundamentals; in all_runs hide them)
  const visibleCols = colOrder
    .filter(k => {
      if (hiddenSet.has(k)) return false;
      if (viewMode === "all_runs") {
        // Fundamentals only available in latest mode
        const fundKeys = new Set(["PERatio","PEGRatio","ReturnOnEquityTTM","GrossMarginTTM","FCFYield","DebtToEquity","QuarterlyRevenueGrowthYOY","ProfitMargin","EPS","Name","Sector","last_trade_side"]);
        if (fundKeys.has(k)) return false;
      }
      return true;
    })
    .map(k => COL_BY_KEY[k]).filter(Boolean);

  // Sort
  function handleSort(key: string) {
    if (sortKey === key) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  // Drag-to-reorder columns
  function onDragStart(i: number) { dragFrom.current = i; }
  function onDragOver(e: React.DragEvent) { e.preventDefault(); }
  function onDrop(toIdx: number) {
    const from = dragFrom.current;
    if (from == null || from === toIdx) return;
    setColOrder(prev => {
      const vis = prev.filter(k => !hiddenSet.has(k));
      const fromKey = vis[from];
      vis.splice(from, 1); vis.splice(toIdx, 0, fromKey);
      return [...vis, ...prev.filter(k => hiddenSet.has(k))];
    });
    dragFrom.current = null;
  }

  function toggleCol(key: string) {
    setHiddenSet(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }

  function toggleChartSymbol(sym: string) {
    setChartSymbols(prev => prev.includes(sym) ? prev.filter(s => s !== sym) : [...prev, sym].slice(0, 10));
  }
  function toggleChartIndicator(ind: string) {
    setChartIndicators(prev => prev.includes(ind) ? prev.filter(s => s !== ind) : [...prev, ind].slice(0, 12));
  }

  // CSV export of current filtered+sorted view
  function downloadCSV() {
    const cols = visibleCols.filter(c => c.key !== "last_trade_side"); // trade col is formatted
    const header = [...cols.map(c => c.label), "Trade", "Trade Date"].join(",");
    const csvRows = filtered.map(r => {
      const f = r.fundamentals ?? {};
      const cells = cols.map(c => {
        let v: string;
        if (c.key === "run_date")   v = fmtDate(r.last_researched_at);
        else if (c.key === "symbol") v = r.symbol;
        else if (c.key === "market") v = r.market;
        else if (c.key === "direction") v = r.direction ?? "";
        else if (c.score)            v = String((r as any)[c.key] ?? "");
        else if (c.key === "Name" || c.key === "Sector") v = f[c.key] ?? "";
        else                         v = f[c.key] ?? "";
        return `"${String(v).replace(/"/g,'""')}"`;
      });
      const lt = r.last_trade;
      cells.push(`"${lt ? lt.side.toUpperCase() : ""}"`, `"${lt ? fmtDate(lt.date) : ""}"`);
      return cells.join(",");
    });
    const blob = new Blob([header + "\n" + csvRows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url;
    a.download = `fundamentals-${viewMode}-${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  // Filter + sort rows
  const filtered = rows.filter(r => {
    if (mktFilter !== "all" && r.market !== mktFilter) return false;
    if (query) {
      const q = query.toLowerCase();
      return r.symbol.toLowerCase().includes(q) ||
        (r.fundamentals?.Sector ?? "").toLowerCase().includes(q) ||
        (r.fundamentals?.Name ?? "").toLowerCase().includes(q);
    }
    return true;
  }).sort((a, b) => {
    if (sortKey === "last_researched_at" || sortKey === "run_date") {
      const at = new Date(a.last_researched_at).getTime();
      const bt = new Date(b.last_researched_at).getTime();
      return sortDir === "desc" ? bt - at : at - bt;
    }
    const av = getCell(a, sortKey), bv = getCell(b, sortKey);
    const an = parseFloat(av), bn = parseFloat(bv);
    if (!isNaN(an) && !isNaN(bn)) return sortDir === "desc" ? bn - an : an - bn;
    return sortDir === "desc"
      ? String(bv ?? "").localeCompare(String(av ?? ""))
      : String(av ?? "").localeCompare(String(bv ?? ""));
  });

  // Chart group rendering
  const activeGroups = CHART_GROUPS.map(g => ({
    ...g,
    activeKeys: g.keys.filter(k => chartIndicators.includes(k)),
  })).filter(g => g.activeKeys.length > 0);

  const SortArrow = ({ col }: { col: string }) => (
    <span style={{ fontSize: 8, marginLeft: 2, opacity: sortKey === col ? 1 : 0.25 }}>
      {sortKey === col && sortDir === "asc" ? "▲" : "▼"}
    </span>
  );

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text }}>

      {/* Header */}
      <div style={{ padding: "18px 20px 0" }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Fundamentals</h1>
        <p style={{ color: T.muted, fontSize: 12, marginTop: 3 }}>
          Research audit log · score formulas · chart any indicator over time · trade markers
        </p>
      </div>

      {/* ══ CHART BUILDER ══════════════════════════════════════════════════════ */}
      <div style={{ padding: "16px 20px 0" }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>
          Historical Chart Builder
          <span style={{ fontWeight: 400, fontSize: 11, color: T.muted, marginLeft: 8 }}>
            select symbols from table · pick indicators · same-scale indicators share one panel
          </span>
        </div>

        {/* Indicator pills */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 9, color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 5 }}>
            Indicators — S=Score · P=Price · %=Pct · R=Ratio
          </div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {INDICATOR_DEFS.map(ind => {
              const active = chartIndicators.includes(ind.key);
              const groupColor: Record<string, string> = {
                scores: T.accent, price: "#3B82F6", pct: T.green, ratio: T.yellow, eps: T.muted,
              };
              return (
                <button key={ind.key} onClick={() => toggleChartIndicator(ind.key)}
                  style={{
                    padding: "3px 9px", borderRadius: 10, fontSize: 11, cursor: "pointer",
                    fontWeight: active ? 700 : 400,
                    border: `1px solid ${active ? (groupColor[(ind as any).group] ?? T.border) : T.border}`,
                    background: active ? `${groupColor[(ind as any).group] ?? T.accent}22` : T.card,
                    color: active ? (groupColor[(ind as any).group] ?? T.text) : T.muted,
                  }}>
                  {ind.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Options row */}
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
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
          <button onClick={() => setShowTradeMarkers(p => !p)}
            style={{
              padding: "3px 9px", borderRadius: 5, fontSize: 11, cursor: "pointer",
              border: `1px solid ${showTradeMarkers ? T.green : T.border}`,
              background: showTradeMarkers ? `${T.green}22` : T.card,
              color: showTradeMarkers ? T.green : T.muted,
            }}>
            📍 Trade markers {showTradeMarkers ? "on" : "off"}
          </button>
        </div>

        {/* Empty state */}
        {!chartSymbols.length && (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "20px", textAlign: "center", color: T.muted, fontSize: 12, marginBottom: 12 }}>
            Click "+ Chart" on any row in the table below.
          </div>
        )}

        {/* Symbol chips */}
        {chartSymbols.length > 0 && (
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
            {chartSymbols.map((sym, i) => (
              <span key={sym} onClick={() => toggleChartSymbol(sym)}
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

        {/* Charts: one panel per group, same-scale indicators share panel */}
        {chartSymbols.length > 0 && activeGroups.map(group => {
          // Build unified date map for all symbols × indicators in this group
          const dateMap = new Map<string, Record<string, number>>();
          for (const sym of chartSymbols) {
            for (const ind of group.activeKeys) {
              for (const { date, value } of rawSeries[sym]?.[ind] ?? []) {
                if (!dateMap.has(date)) dateMap.set(date, { date: date as any });
                dateMap.get(date)![`${sym}:${ind}`] = value;
              }
            }
          }
          const data = [...dateMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([,v]) => v);

          // All trade markers across all selected symbols (for ReferenceLine)
          const allMarkers: (TradeMarker & { sym: string })[] = chartSymbols.flatMap(sym =>
            (tradeMarkers[sym] ?? []).map(m => ({ ...m, sym }))
          );

          if (!data.length && !chartLoading) return null;

          // Line keys: one per symbol × indicator
          const lineKeys = chartSymbols.flatMap((sym, si) =>
            group.activeKeys.map((ind, ii) => ({
              key: `${sym}:${ind}`,
              label: group.activeKeys.length > 1 ? `${sym} ${IND_BY_KEY[ind]?.label ?? ind}` : sym,
              color: LINE_COLORS[(si * 3 + ii) % LINE_COLORS.length],
            }))
          );

          return (
            <div key={group.id} style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 5 }}>
                {group.label}
                <span style={{ fontSize: 9, marginLeft: 6, color: T.muted }}>
                  {group.activeKeys.map(k => IND_BY_KEY[k]?.label ?? k).join(" · ")}
                </span>
              </div>
              <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 4px 4px" }}>
                {chartLoading ? (
                  <div style={{ height: 180, display: "flex", alignItems: "center", justifyContent: "center", color: T.muted, fontSize: 11 }}>
                    Loading…
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={180}>
                    <LineChart data={data} margin={{ top: 4, right: 12, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
                      <XAxis dataKey="date" tick={{ fontSize: 9, fill: T.muted }}
                        tickFormatter={d => d.slice(5)} minTickGap={40} />
                      <YAxis tick={{ fontSize: 9, fill: T.muted }} width={36}
                        domain={group.yDomain}
                        tickFormatter={v => group.pct ? `${(v*100).toFixed(0)}%` : String(Number(v).toFixed(0))} />
                      <Tooltip
                        contentStyle={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, fontSize: 11 }}
                        formatter={(v: any, name: string) => {
                          const isPct = group.pct;
                          return [isPct ? `${(Number(v)*100).toFixed(1)}%` : Number(v).toFixed(2), name];
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: 10 }} />
                      {lineKeys.map(({ key, label, color }) => (
                        <Line key={key} dataKey={key} name={label} stroke={color}
                          dot={false} strokeWidth={1.5} connectNulls activeDot={{ r: 3 }} />
                      ))}
                      {/* Trade markers: vertical reference lines */}
                      {showTradeMarkers && allMarkers.map((m, i) => (
                        <ReferenceLine key={i} x={m.date}
                          stroke={m.type === "entry" && m.side === "buy" ? T.green
                               : m.type === "exit" ? T.red : T.yellow}
                          strokeDasharray="4 2" strokeWidth={1.5}
                          label={{ value: m.side === "buy" ? "B" : "S", position: "top", fontSize: 8,
                            fill: m.side === "buy" ? T.green : T.red }}
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ══ TABLE ════════════════════════════════════════════════════════════ */}

      {/* Table filter bar */}
      <div style={{ padding: "16px 20px 8px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Filter by symbol, sector, name…"
          style={{
            flex: "1 1 160px", minWidth: 120, background: T.card,
            border: `1px solid ${T.border}`, borderRadius: 6,
            padding: "6px 10px", color: T.text, fontSize: 13, outline: "none",
          }}
        />

        {/* Market filter */}
        {(["all","us","india"] as const).map(m => (
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

        {/* View mode toggle */}
        <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", border: `1px solid ${T.border}` }}>
          {(["latest","all_runs"] as const).map(v => (
            <button key={v} onClick={() => setViewMode(v)}
              style={{
                padding: "5px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer", border: "none",
                background: viewMode === v ? T.accent : T.card,
                color: viewMode === v ? "#fff" : T.muted,
              }}>
              {v === "latest" ? "Latest" : "All Runs"}
            </button>
          ))}
        </div>

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
                Show / hide · drag headers to reorder
              </div>
              {ALL_COLS.map(col => (
                <label key={col.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", cursor: "pointer" }}>
                  <input type="checkbox" checked={!hiddenSet.has(col.key)} onChange={() => toggleCol(col.key)} />
                  <span style={{ fontSize: 12, color: T.text }}>{col.label}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <button onClick={downloadCSV} disabled={loading || !filtered.length}
          title="Download visible table as CSV"
          style={{
            padding: "5px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer",
            border: `1px solid ${T.border}`, background: T.card, color: T.muted,
            opacity: (!filtered.length || loading) ? 0.4 : 1,
          }}>
          ⬇ CSV
        </button>

        <span style={{ fontSize: 11, color: T.muted }}>
          {loading ? "Loading…" : `${filtered.length} row${filtered.length !== 1 ? "s" : ""}`}
        </span>
        {chartSymbols.length > 0 && (
          <span style={{ fontSize: 11, color: T.accent }}>{chartSymbols.length} in chart ↑</span>
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
                  draggable onDragStart={() => onDragStart(i)} onDragOver={onDragOver} onDrop={() => onDrop(i)}
                  onClick={() => handleSort(col.key)}
                  title={col.tooltip}
                  style={{
                    padding: "8px 10px",
                    textAlign: (col.key === "symbol" || col.key === "Name" || col.key === "Sector" || col.key === "run_date") ? "left" : "right",
                    color: sortKey === col.key ? T.accent : T.muted,
                    fontWeight: 600, fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase",
                    cursor: "grab", whiteSpace: "nowrap",
                    borderBottom: `1px solid ${T.border}`, minWidth: col.width, userSelect: "none",
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

            {!loading && filtered.map((row, ri) => {
              const inChart = chartSymbols.includes(row.symbol);
              const f = row.fundamentals ?? {};
              return (
                <tr key={ri}
                  style={{ borderBottom: `1px solid ${T.border}`, background: inChart ? `${T.accent}0D` : "transparent" }}
                  onMouseEnter={e => { if (!inChart) (e.currentTarget as HTMLElement).style.background = "#ffffff07"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = inChart ? `${T.accent}0D` : "transparent"; }}
                >
                  {visibleCols.map(col => {
                    const isLeft = ["symbol","Name","Sector","run_date"].includes(col.key);
                    let content: React.ReactNode;

                    if (col.key === "run_date") {
                      content = (
                        <span title={row.last_researched_at} style={{ color: T.muted, fontSize: 11, fontFamily: "monospace" }}>
                          {fmtDate(row.last_researched_at)}
                        </span>
                      );
                    } else if (col.key === "symbol") {
                      content = (
                        <span onClick={() => router.push(`/dashboard/research/${row.symbol}`)}
                          style={{ fontWeight: 700, cursor: "pointer", color: T.accent }}>
                          {row.symbol}
                        </span>
                      );
                    } else if (col.key === "Name" || col.key === "Sector") {
                      const v = f[col.key] ?? "—";
                      content = <span style={{ color: v === "—" ? T.muted : T.text }}>{v}</span>;
                    } else if (col.key === "market") {
                      content = <span>{row.market === "india" ? "🇮🇳" : "🇺🇸"}</span>;
                    } else if (col.key === "direction") {
                      content = (
                        <span style={{ color: dirColor(row.direction), fontWeight: 700, fontSize: 10 }}>
                          {row.direction?.toUpperCase() ?? "—"}
                        </span>
                      );
                    } else if (col.key === "last_trade_side") {
                      const lt = row.last_trade;
                      if (!lt) { content = <span style={{ color: T.muted }}>—</span>; }
                      else {
                        const isBuy = lt.side === "buy";
                        content = (
                          <span title={`${lt.side.toUpperCase()} on ${fmtDate(lt.date)}${lt.analyst_score != null ? ` · score ${lt.analyst_score}` : ""}`}
                            style={{ fontWeight: 700, fontSize: 10, color: isBuy ? T.green : T.red }}>
                            {lt.side.toUpperCase()} {fmtDate(lt.date).slice(5)}
                          </span>
                        );
                      }
                    } else if (col.score) {
                      const v = Number((row as any)[col.key]);
                      content = <span style={{ fontWeight: 700, color: scoreColor(v) }}>{isNaN(v) ? "—" : v}</span>;
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
