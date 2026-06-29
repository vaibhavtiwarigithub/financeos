"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import {
  createChart, ColorType,
  CandlestickSeries, LineSeries, HistogramSeries,
  IChartApi, ISeriesApi,
} from "lightweight-charts";

const T = {
  bg: "#0D0F14", card: "#1A1D27", border: "#252836", text: "#ECEDEF",
  textSub: "#9B9EA8", muted: "#6B7280", accent: "#6366F1",
  green: "#34D399", red: "#F87171", amber: "#FBBF24",
};

// NBER recession periods
const RECESSIONS = [
  { start: "2001-03-01", end: "2001-11-30", label: "Dot-com" },
  { start: "2007-12-01", end: "2009-06-30", label: "GFC" },
  { start: "2020-02-01", end: "2020-04-30", label: "COVID" },
];

const PERIODS = [
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
  { label: "1Y", days: 365 },
  { label: "2Y", days: 730 },
  { label: "5Y", days: 1825 },
  { label: "10Y", days: 3650 },
  { label: "All", days: 9999 },
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

interface Candle { date: string; open: number; high: number; low: number; close: number; volume: number; }

interface Props { symbol: string; }

export default function SymbolChart({ symbol }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const ema20Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const ema50Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const ema200Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const sma200Ref = useRef<ISeriesApi<"Line"> | null>(null);

  const [period, setPeriod] = useState(PERIODS[3]); // 1Y default
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showVol, setShowVol] = useState(true);
  const [showEMA20, setShowEMA20] = useState(false);
  const [showEMA50, setShowEMA50] = useState(true);
  const [showEMA200, setShowEMA200] = useState(false);
  const [showSMA200, setShowSMA200] = useState(false);
  const [showRecessions, setShowRecessions] = useState(true);
  const [crosshair, setCrosshair] = useState<{ date: string; o: number; h: number; l: number; c: number; v: number } | null>(null);

  // Fetch candles
  useEffect(() => {
    setLoading(true);
    setError(null);
    const from = period.days >= 9999
      ? "2000-01-01"
      : new Date(Date.now() - period.days * 86400000).toISOString().split("T")[0];

    fetch(`/api/charts/symbol-history?symbol=${symbol}&from=${from}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error);
        setCandles(d.candles ?? []);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [symbol, period]);

  // Build / rebuild chart when candles or toggles change
  useEffect(() => {
    if (!containerRef.current || candles.length === 0) return;

    // Destroy old chart
    if (chartRef.current) { chartRef.current.remove(); chartRef.current = null; }

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: T.card },
        textColor: T.textSub,
        fontSize: 11,
      },
      grid: {
        vertLines: { color: T.border },
        horzLines: { color: T.border },
      },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: T.border },
      timeScale: { borderColor: T.border, timeVisible: true },
      width: containerRef.current.clientWidth,
      height: 480,
    });
    chartRef.current = chart;

    // Candlestick
    const cSeries = chart.addSeries(CandlestickSeries, {
      upColor: T.green, downColor: T.red,
      borderUpColor: T.green, borderDownColor: T.red,
      wickUpColor: T.green, wickDownColor: T.red,
    });
    cSeries.setData(candles.map(c => ({ time: c.date as any, open: c.open, high: c.high, low: c.low, close: c.close })));
    candleRef.current = cSeries;

    // Volume (secondary scale) — series must be added before applyOptions on its scale
    if (showVol) {
      const vSeries = chart.addSeries(HistogramSeries, {
        color: "#6366F140", priceScaleId: "volume",
      });
      chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
      vSeries.setData(candles.map(c => ({
        time: c.date as any,
        value: c.volume,
        color: c.close >= c.open ? "#34D39930" : "#F8717130",
      })));
      volRef.current = vSeries;
    }

    const closes = candles.map(c => c.close);

    // EMA 20
    if (showEMA20) {
      const s = chart.addSeries(LineSeries, { color: T.amber, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      const vals = calcEMA(closes, 20);
      s.setData(candles.map((c, i) => vals[i] !== null ? { time: c.date as any, value: vals[i]! } : null).filter(Boolean) as any);
      ema20Ref.current = s;
    }

    // EMA 50
    if (showEMA50) {
      const s = chart.addSeries(LineSeries, { color: "#60A5FA", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      const vals = calcEMA(closes, 50);
      s.setData(candles.map((c, i) => vals[i] !== null ? { time: c.date as any, value: vals[i]! } : null).filter(Boolean) as any);
      ema50Ref.current = s;
    }

    // EMA 200
    if (showEMA200) {
      const s = chart.addSeries(LineSeries, { color: "#A78BFA", lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
      const vals = calcEMA(closes, 200);
      s.setData(candles.map((c, i) => vals[i] !== null ? { time: c.date as any, value: vals[i]! } : null).filter(Boolean) as any);
      ema200Ref.current = s;
    }

    // SMA 200
    if (showSMA200) {
      const s = chart.addSeries(LineSeries, { color: "#F97316", lineWidth: 2, lineStyle: 1, priceLineVisible: false, lastValueVisible: false });
      const vals = calcSMA(closes, 200);
      s.setData(candles.map((c, i) => vals[i] !== null ? { time: c.date as any, value: vals[i]! } : null).filter(Boolean) as any);
      sma200Ref.current = s;
    }

    // Crosshair subscriber
    chart.subscribeCrosshairMove(p => {
      if (!p.time || !p.seriesData) return;
      const raw = p.seriesData.get(cSeries) as any;
      if (!raw) return;
      setCrosshair({ date: String(p.time), o: raw.open, h: raw.high, l: raw.low, c: raw.close, v: 0 });
    });

    // Fit visible range to period
    chart.timeScale().fitContent();

    // Resize observer
    const ro = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, showVol, showEMA20, showEMA50, showEMA200, showSMA200]);

  const btnStyle = (active: boolean, color = T.accent): React.CSSProperties => ({
    fontSize: "11px", fontWeight: 600, padding: "4px 10px", borderRadius: "6px",
    cursor: "pointer", border: `1px solid ${active ? color : T.border}`,
    background: active ? color + "20" : "transparent",
    color: active ? color : T.muted,
  });

  return (
    <div style={{ background: T.card, borderRadius: "14px", border: `1px solid ${T.border}`, overflow: "hidden" }}>
      {/* Controls */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "14px 18px", borderBottom: `1px solid ${T.border}`, flexWrap: "wrap" }}>
        {/* Period buttons */}
        <div style={{ display: "flex", gap: "4px" }}>
          {PERIODS.map(p => (
            <button key={p.label} onClick={() => setPeriod(p)} style={btnStyle(period.label === p.label)}>
              {p.label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        {/* Overlay toggles */}
        <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
          <button onClick={() => setShowVol(v => !v)} style={btnStyle(showVol, T.muted)}>Vol</button>
          <button onClick={() => setShowEMA20(v => !v)} style={btnStyle(showEMA20, T.amber)}>EMA20</button>
          <button onClick={() => setShowEMA50(v => !v)} style={btnStyle(showEMA50, "#60A5FA")}>EMA50</button>
          <button onClick={() => setShowEMA200(v => !v)} style={btnStyle(showEMA200, "#A78BFA")}>EMA200</button>
          <button onClick={() => setShowSMA200(v => !v)} style={btnStyle(showSMA200, "#F97316")}>SMA200</button>
          <button onClick={() => setShowRecessions(v => !v)} style={btnStyle(showRecessions, "#6B7280")}>Recessions</button>
        </div>
      </div>

      {/* Crosshair OHLC strip */}
      {crosshair && (
        <div style={{ display: "flex", gap: "16px", padding: "8px 18px", borderBottom: `1px solid ${T.border}`, fontSize: "11px", fontFamily: "monospace" }}>
          <span style={{ color: T.muted }}>{crosshair.date}</span>
          <span>O <span style={{ color: T.text }}>{crosshair.o.toFixed(2)}</span></span>
          <span>H <span style={{ color: T.green }}>{crosshair.h.toFixed(2)}</span></span>
          <span>L <span style={{ color: T.red }}>{crosshair.l.toFixed(2)}</span></span>
          <span>C <span style={{ color: crosshair.c >= crosshair.o ? T.green : T.red }}>{crosshair.c.toFixed(2)}</span></span>
        </div>
      )}

      {/* Chart area */}
      <div style={{ position: "relative" }}>
        {loading && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: T.card + "cc", zIndex: 10, fontSize: "13px", color: T.muted }}>
            Loading {symbol} history…
          </div>
        )}
        {error && (
          <div style={{ padding: "40px", textAlign: "center", color: T.red, fontSize: "13px" }}>
            Error: {error}
          </div>
        )}
        <div ref={containerRef} style={{ width: "100%" }} />

        {/* Recession bands overlay */}
        {showRecessions && !loading && candles.length > 0 && (
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, pointerEvents: "none", height: "480px", overflow: "hidden" }}>
            {RECESSIONS.map(r => (
              <div key={r.label} style={{
                position: "absolute", top: 0, bottom: 0,
                background: "#F8717108",
                borderLeft: "1px solid #F8717130",
                borderRight: "1px solid #F8717130",
                display: "flex", alignItems: "flex-start", paddingTop: "8px",
                // We can't easily compute pixel positions without chart internals,
                // so show a legend strip instead
              }} />
            ))}
            <div style={{ position: "absolute", bottom: "8px", right: "12px", display: "flex", gap: "8px" }}>
              {RECESSIONS.map(r => (
                <span key={r.label} style={{ fontSize: "10px", color: "#F87171", background: "#F8717115", padding: "2px 6px", borderRadius: "4px" }}>
                  {r.label}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Legend */}
      <div style={{ display: "flex", gap: "14px", padding: "10px 18px", borderTop: `1px solid ${T.border}`, fontSize: "10px", flexWrap: "wrap" }}>
        {showEMA20 && <span style={{ color: T.amber }}>── EMA 20</span>}
        {showEMA50 && <span style={{ color: "#60A5FA" }}>── EMA 50</span>}
        {showEMA200 && <span style={{ color: "#A78BFA" }}>── EMA 200</span>}
        {showSMA200 && <span style={{ color: "#F97316", letterSpacing: "2px" }}>╌ SMA 200</span>}
        <span style={{ color: T.muted, marginLeft: "auto" }}>{candles.length} bars · {candles[0]?.date ?? ""} → {candles[candles.length - 1]?.date ?? ""}</span>
      </div>
    </div>
  );
}
