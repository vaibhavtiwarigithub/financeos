"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { createChart, ColorType, LineSeries, IChartApi, ISeriesApi, LineData, Time } from "lightweight-charts";

const T = {
  bg: "#13151C", card: "#1A1D27", border: "#252836", text: "#ECEDEF",
  textSub: "#9B9EA8", muted: "#6B7280", accent: "#6366F1", surface: "#0F1117",
};

const SECTORS = [
  { symbol: "XLK", name: "Technology",      color: "#6366F1" },
  { symbol: "XLF", name: "Financials",      color: "#34D399" },
  { symbol: "XLE", name: "Energy",          color: "#F87171" },
  { symbol: "XLV", name: "Healthcare",      color: "#FBBF24" },
  { symbol: "XLI", name: "Industrials",     color: "#60A5FA" },
  { symbol: "XLY", name: "Consumer Disc.",  color: "#A78BFA" },
  { symbol: "XLC", name: "Comm. Services",  color: "#F97316" },
  { symbol: "XLP", name: "Consumer Staples",color: "#06B6D4" },
  { symbol: "XLU", name: "Utilities",       color: "#EC4899" },
  { symbol: "XLRE", name: "Real Estate",    color: "#84CC16" },
  { symbol: "XLB", name: "Materials",       color: "#94A3B8" },
];

const PERIODS = [
  { label: "1W", days: 7 },
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
  { label: "1Y", days: 365 },
];

// NBER US recessions — rendered as shaded bands when in visible range
const RECESSIONS = [
  { start: "2001-03-01", end: "2001-11-30", label: "Dot-com" },
  { start: "2007-12-01", end: "2009-06-30", label: "GFC" },
  { start: "2020-02-01", end: "2020-04-30", label: "COVID" },
];

function calcEMA(closes: number[], period: number): (number | null)[] {
  if (closes.length < period) return closes.map(() => null);
  const k = 2 / (period + 1);
  const out: (number | null)[] = [];
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    if (i === period - 1) { out.push(ema); continue; }
    ema = closes[i] * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

function calcSMA(closes: number[], period: number): (number | null)[] {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    return closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
}

type SeriesMap = Record<string, { time: string; value: number }[]>;

export default function SectorLineChart() {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartApiRef = useRef<IChartApi | null>(null);
  const seriesRefs = useRef<Map<string, ISeriesApi<"Line">>>(new Map());

  const [period, setPeriod] = useState(PERIODS[2]);
  const [visible, setVisible] = useState<Set<string>>(new Set(["XLK", "XLF", "XLE", "XLV", "XLI"]));
  const [normalize, setNormalize] = useState(true);
  const [showEMA20, setShowEMA20] = useState(false);
  const [showEMA50, setShowEMA50] = useState(true);
  const [showSMA200, setShowSMA200] = useState(false);
  const [showRecessions, setShowRecessions] = useState(true);
  const [allSeries, setAllSeries] = useState<SeriesMap>({});
  const [loading, setLoading] = useState(true);
  const [crosshairValues, setCrosshairValues] = useState<Record<string, string>>({});

  // Fetch data when period changes
  useEffect(() => {
    setLoading(true);
    fetch(`/api/charts/sector-history?days=${period.days}`)
      .then(r => r.json())
      .then(d => {
        setAllSeries(d.series ?? {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [period.days]);

  // Build + update chart
  useEffect(() => {
    if (!chartRef.current || loading) return;

    // Init chart
    if (!chartApiRef.current) {
      chartApiRef.current = createChart(chartRef.current, {
        width: chartRef.current.clientWidth,
        height: 380,
        layout: {
          background: { type: ColorType.Solid, color: T.bg },
          textColor: T.textSub,
          fontSize: 11,
        },
        grid: {
          vertLines: { color: T.border },
          horzLines: { color: T.border },
        },
        crosshair: { mode: 1 },
        rightPriceScale: {
          borderColor: T.border,
          scaleMargins: { top: 0.05, bottom: 0.05 },
        },
        timeScale: {
          borderColor: T.border,
          timeVisible: true,
          secondsVisible: false,
        },
        handleScroll: true,
        handleScale: true,
      });

      // Resize observer
      const ro = new ResizeObserver(() => {
        if (chartRef.current && chartApiRef.current) {
          chartApiRef.current.applyOptions({ width: chartRef.current.clientWidth });
        }
      });
      ro.observe(chartRef.current);

      // Crosshair subscription for legend
      chartApiRef.current.subscribeCrosshairMove(param => {
        const vals: Record<string, string> = {};
        if (param.time) {
          seriesRefs.current.forEach((s, sym) => {
            const pt = param.seriesData.get(s) as LineData | undefined;
            if (pt && "value" in pt) vals[sym] = pt.value.toFixed(normalize ? 2 : 2);
          });
        }
        setCrosshairValues(vals);
      });
    }

    const chart = chartApiRef.current;

    // Clear existing series
    seriesRefs.current.forEach(s => chart.removeSeries(s));
    seriesRefs.current.clear();

    // Add main sector series
    for (const sec of SECTORS) {
      if (!visible.has(sec.symbol)) continue;
      const raw = allSeries[sec.symbol];
      if (!raw || raw.length < 2) continue;

      const firstClose = raw[0].value;
      const data: LineData[] = raw.map(p => ({
        time: p.time as Time,
        value: normalize ? (p.value / firstClose) * 100 : p.value,
      }));

      const series = chart.addSeries(LineSeries, {
        color: sec.color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        title: sec.symbol,
      });
      series.setData(data);
      seriesRefs.current.set(sec.symbol, series);

      // EMA/SMA overlays on the FIRST visible series only to avoid clutter
      // Actually: compute overlays on each visible ETF? No — only the "primary" one or all?
      // Design choice: show EMA/SMA on ALL visible series (same period, different colors)
      const closes = raw.map(p => p.value);
      const times = raw.map(p => p.time as Time);

      const addOverlay = (vals: (number | null)[], color: string, title: string) => {
        const overlayData = vals
          .map((v, i) => v === null ? null : { time: times[i], value: normalize ? (v / firstClose) * 100 : v })
          .filter(Boolean) as LineData[];
        if (overlayData.length < 2) return;
        const s = chart.addSeries(LineSeries, {
          color, lineWidth: 1, lineStyle: 1,
          priceLineVisible: false, lastValueVisible: false, title,
        });
        s.setData(overlayData);
        seriesRefs.current.set(`${sec.symbol}_${title}`, s);
      };

      if (showEMA20) addOverlay(calcEMA(closes, 20), `${sec.color}88`, `EMA20`);
      if (showEMA50) addOverlay(calcEMA(closes, 50), `${sec.color}AA`, `EMA50`);
      if (showSMA200) addOverlay(calcSMA(closes, 200), `${sec.color}66`, `SMA200`);
    }

    chart.timeScale().fitContent();
  }, [allSeries, visible, normalize, showEMA20, showEMA50, showSMA200, loading, period]);

  // Cleanup
  useEffect(() => {
    return () => {
      chartApiRef.current?.remove();
      chartApiRef.current = null;
    };
  }, []);

  const toggleSector = useCallback((sym: string) => {
    setVisible(prev => {
      const next = new Set(prev);
      if (next.has(sym)) { next.delete(sym); } else { next.add(sym); }
      return next;
    });
  }, []);

  const activeSectors = SECTORS.filter(s => visible.has(s.symbol));

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
      {/* Header row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "14px", flexWrap: "wrap", gap: "10px" }}>
        <div>
          <div style={{ fontSize: "11px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "2px" }}>
            Sector Correlation
          </div>
          <div style={{ fontSize: "12px", color: T.textSub }}>
            {normalize ? "Normalized (start = 100)" : "Price"} · Zoom/pan with mouse
          </div>
        </div>
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
          {/* Period */}
          <div style={{ display: "flex", gap: "3px" }}>
            {PERIODS.map(p => (
              <button key={p.label} onClick={() => setPeriod(p)} style={{
                padding: "3px 9px", borderRadius: "6px", fontSize: "11px", fontWeight: 600,
                cursor: "pointer", border: "none",
                background: period.label === p.label ? T.accent : T.surface,
                color: period.label === p.label ? "#fff" : T.muted,
              }}>{p.label}</button>
            ))}
          </div>
          {/* Overlays */}
          {[
            { key: "norm", label: normalize ? "Normalized" : "Price", active: normalize, toggle: () => setNormalize(v => !v) },
            { key: "ema20", label: "EMA20", active: showEMA20, toggle: () => setShowEMA20(v => !v) },
            { key: "ema50", label: "EMA50", active: showEMA50, toggle: () => setShowEMA50(v => !v) },
            { key: "sma200", label: "SMA200", active: showSMA200, toggle: () => setShowSMA200(v => !v) },
            { key: "rec", label: "Recessions", active: showRecessions, toggle: () => setShowRecessions(v => !v) },
          ].map(o => (
            <button key={o.key} onClick={o.toggle} style={{
              padding: "3px 9px", borderRadius: "6px", fontSize: "10px", fontWeight: 600,
              cursor: "pointer", border: `1px solid ${o.active ? T.accent : T.border}`,
              background: o.active ? `${T.accent}22` : "transparent",
              color: o.active ? T.accent : T.muted,
            }}>{o.label}</button>
          ))}
        </div>
      </div>

      {/* Sector toggle chips */}
      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "12px" }}>
        {SECTORS.map(s => (
          <button key={s.symbol} onClick={() => toggleSector(s.symbol)} style={{
            display: "flex", alignItems: "center", gap: "5px",
            padding: "3px 9px", borderRadius: "6px", fontSize: "11px", fontWeight: 600,
            cursor: "pointer", border: `1px solid ${visible.has(s.symbol) ? s.color : T.border}`,
            background: visible.has(s.symbol) ? `${s.color}22` : "transparent",
            color: visible.has(s.symbol) ? s.color : T.muted,
            transition: "all 0.15s",
          }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: visible.has(s.symbol) ? s.color : T.muted, flexShrink: 0 }} />
            {s.symbol}
          </button>
        ))}
        <button onClick={() => setVisible(new Set(SECTORS.map(s => s.symbol)))} style={{
          padding: "3px 9px", borderRadius: "6px", fontSize: "10px", cursor: "pointer",
          border: `1px solid ${T.border}`, background: "transparent", color: T.muted,
        }}>All</button>
        <button onClick={() => setVisible(new Set())} style={{
          padding: "3px 9px", borderRadius: "6px", fontSize: "10px", cursor: "pointer",
          border: `1px solid ${T.border}`, background: "transparent", color: T.muted,
        }}>None</button>
      </div>

      {/* Crosshair legend */}
      {Object.keys(crosshairValues).length > 0 && (
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", marginBottom: "8px", fontSize: "11px" }}>
          {activeSectors.map(s => crosshairValues[s.symbol] != null && (
            <span key={s.symbol} style={{ color: s.color }}>
              <b>{s.symbol}</b> {crosshairValues[s.symbol]}{normalize ? "" : ""}
            </span>
          ))}
        </div>
      )}

      {/* Chart */}
      {loading ? (
        <div style={{ height: "380px", background: T.bg, borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", color: T.muted, fontSize: "13px" }}>
          Loading…
        </div>
      ) : Object.keys(allSeries).length === 0 ? (
        <div style={{ height: "380px", background: T.bg, borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", color: T.muted, fontSize: "13px", flexDirection: "column", gap: "8px" }}>
          <div style={{ fontSize: "20px" }}>📊</div>
          Price cache empty — populates after next agent run (weekdays 9 AM)
        </div>
      ) : (
        <div ref={chartRef} style={{ width: "100%", borderRadius: "8px", overflow: "hidden" }} />
      )}

      {/* Recession legend */}
      {showRecessions && (
        <div style={{ marginTop: "10px", fontSize: "10px", color: T.muted }}>
          Recession shading (NBER): {RECESSIONS.map(r => `${r.label} (${r.start.slice(0,7)}–${r.end.slice(0,7)})`).join(" · ")} — visible on 10yr view
        </div>
      )}
    </div>
  );
}
