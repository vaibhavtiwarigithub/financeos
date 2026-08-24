"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback, useMemo } from "react";
import {
  LineChart, Line, BarChart, Bar, ComposedChart, Area, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine,
  ReferenceArea, Scatter, ScatterChart
} from "recharts";

// ── Types ──────────────────────────────────────────────────────────────────

interface Candle {
  date: string;
  open: number; high: number; low: number; close: number; volume: number;
}

interface DecisionTradeEvent {
  id: string;
  venue: "paper" | "live";
  stage: "proposal" | "order" | "fill";
  side: "buy" | "sell";
  status: string;
  occurred_at: string;
  qty: number | null;
  price: number | null;
  is_execution: boolean;
  realized_pnl_pct: number | null;
  analyst_score: number | null;
  scores: { fundamental: number | null; technical: number | null; sentiment: number | null; macro: number | null } | null;
  reason: string | null;
}

interface Overview {
  PERatio?: string; ProfitMargin?: string; ReturnOnEquityTTM?: string;
  EPS?: string; QuarterlyRevenueGrowthYOY?: string; Sector?: string;
  GrossMarginTTM?: string; DebtToEquity?: string; FCFYield?: string;
  PEGRatio?: string; "52WeekHigh"?: string; "52WeekLow"?: string;
  AnalystTargetPrice?: string;
}

// ── Indicator Computation ──────────────────────────────────────────────────

function computeEMA(closes: number[], period: number): number[] {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const emas = [ema];
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    emas.push(ema);
  }
  return emas;
}

function computeRSI(closes: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = Array(period).fill(null);
  if (closes.length < period + 1) return result;
  const gains: number[] = [], losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(d > 0 ? d : 0);
    losses.push(d < 0 ? -d : 0);
  }
  let ag = gains.slice(0, period).reduce((a, b) => a + b) / period;
  let al = losses.slice(0, period).reduce((a, b) => a + b) / period;
  const rsis: (number | null)[] = Array(period + 1).fill(null);
  rsis.push(al === 0 ? 100 : parseFloat((100 - 100 / (1 + ag / al)).toFixed(2)));
  for (let i = period; i < gains.length; i++) {
    ag = (ag * (period - 1) + gains[i]) / period;
    al = (al * (period - 1) + losses[i]) / period;
    rsis.push(al === 0 ? 100 : parseFloat((100 - 100 / (1 + ag / al)).toFixed(2)));
  }
  return rsis;
}

function computeMACD(closes: number[]) {
  if (closes.length < 26) return { macdLine: [], macdSignal: [], macdHistogram: [] };
  const ema12 = computeEMA(closes, 12);
  const ema26 = computeEMA(closes, 26);
  const offset = ema12.length - ema26.length; // ema12 is longer
  const macdLine = ema26.map((v, i) => ema12[i + offset] - v);
  const macdSignal = computeEMA(macdLine, 9);
  const sigOffset = macdLine.length - macdSignal.length;
  const macdHistogram = macdSignal.map((v, i) => macdLine[i + sigOffset] - v);
  return { macdLine, macdSignal, macdHistogram };
}

// ── Window helpers ─────────────────────────────────────────────────────────

type Window = "6M" | "1Y" | "5Y" | "All";
const WINDOW_DAYS: Record<Window, number> = { "6M": 180, "1Y": 365, "5Y": 1825, "All": 9999 };

function filterByWindow(candles: Candle[], window: Window): Candle[] {
  const days = WINDOW_DAYS[window];
  if (days >= 9999) return candles;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];
  return candles.filter(c => c.date >= cutoff);
}

function toDateLabel(date: string, window: Window): string {
  const d = new Date(date);
  if (window === "6M") return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (window === "1Y") return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  return d.getFullYear().toString();
}

function downsample<T extends { date: string }>(arr: T[], max = 300): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const result: T[] = [];
  for (let i = 0; i < max - 1; i++) result.push(arr[Math.round(i * step)]);
  result.push(arr[arr.length - 1]); // always include latest
  return result;
}

// ── Score Breakdown ────────────────────────────────────────────────────────

function ScoreBar({ label, value, max = 100, color }: { label: string; value: number | null; max?: number; color: string }) {
  if (value == null) return null;
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="mb-2">
      <div className="flex justify-between text-xs mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-semibold">{Math.round(value)}</span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function DeepDivePage() {
  const params = useParams();
  const router = useRouter();
  const symbol = (typeof params.symbol === "string" ? params.symbol : "").toUpperCase();
  const market = /\.(NS|BO)$/i.test(symbol) ? "india" : "us";
  const currency = market === "india" ? "₹" : "$";

  const [window, setWindow] = useState<Window>("1Y");
  const [compareSymbols, setCompareSymbols] = useState<string[]>([]);
  const [compareInput, setCompareInput] = useState("");
  const [compareData, setCompareData] = useState<Record<string, Candle[]>>({});
  const [activeTab, setActiveTab] = useState<"price" | "fundamentals" | "scores">("price");
  const [selectedTrade, setSelectedTrade] = useState<DecisionTradeEvent | null>(null);

  const [candles, setCandles] = useState<Candle[]>([]);
  const [tradeEvents, setTradeEvents] = useState<DecisionTradeEvent[]>([]);
  const [overview, setOverview] = useState<Overview>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch primary symbol data
  useEffect(() => {
    if (!symbol) return;
    setLoading(true);
    setError(null);
    const days = WINDOW_DAYS["All"]; // fetch max, filter client-side
    Promise.all([
      fetch(`/api/research/price?symbol=${symbol}&days=${days}`).then(r => r.json()),
      fetch(`/api/research/trades?symbol=${symbol}&market=${market}`).then(r => r.json()),
      fetch(`/api/research/fundamentals?symbol=${symbol}`).then(r => r.json()),
    ])
      .then(([priceData, tradeData, fundData]) => {
        if (priceData.error) throw new Error(priceData.error);
        setCandles(priceData.candles ?? []);
        if (tradeData.error) throw new Error(tradeData.error);
        setTradeEvents(tradeData.events ?? []);
        setOverview(fundData.overview ?? {});
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [symbol, market]);

  // Fetch compare symbol data
  useEffect(() => {
    const missing = compareSymbols.filter(s => !compareData[s]);
    missing.forEach(s => {
      fetch(`/api/research/price?symbol=${s}&days=${WINDOW_DAYS["All"]}`)
        .then(r => r.json())
        .then(d => {
          if (d.candles) setCompareData(prev => ({ ...prev, [s]: d.candles }));
        });
    });
  // ponytail: compareData excluded from deps intentionally — adding it creates infinite refetch loop
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareSymbols]);

  const windowed = useMemo(() => filterByWindow(candles, window), [candles, window]);

  // Compute indicators on windowed candles
  const chartData = useMemo(() => {
    if (windowed.length === 0) return [];
    const closes = windowed.map(c => c.close);

    // EMAs (indexed from start of windowed data)
    const ema20arr = computeEMA(closes, 20);
    const ema50arr = computeEMA(closes, 50);
    const ema200arr = computeEMA(closes, 200);
    const rsiArr = computeRSI(closes);
    const { macdLine, macdHistogram, macdSignal } = computeMACD(closes);

    return windowed.map((c, i) => {
      const ema20Offset = ema20arr.length - windowed.length;
      const ema50Offset = ema50arr.length - windowed.length;
      const ema200Offset = ema200arr.length - windowed.length;
      const macdOffset = macdHistogram.length - windowed.length;

      return {
        date: c.date,
        label: toDateLabel(c.date, window),
        close: c.close,
        volume: c.volume,
        ema20: i + ema20Offset >= 0 ? parseFloat(ema20arr[i + ema20Offset]?.toFixed(2)) : null,
        ema50: i + ema50Offset >= 0 ? parseFloat(ema50arr[i + ema50Offset]?.toFixed(2)) : null,
        ema200: i + ema200Offset >= 0 ? parseFloat(ema200arr[i + ema200Offset]?.toFixed(2)) : null,
        rsi: rsiArr[i] ?? null,
        macdLine: macdLine[i + macdOffset] != null ? parseFloat(macdLine[i + macdOffset].toFixed(4)) : null,
        macdSignal: macdSignal[i + (macdSignal.length - windowed.length)] != null ? parseFloat(macdSignal[i + (macdSignal.length - windowed.length)].toFixed(4)) : null,
        macdHist: macdHistogram[i + macdOffset] != null ? parseFloat(macdHistogram[i + macdOffset].toFixed(4)) : null,
      };
    });
  }, [windowed, window]);

  // Multi-symbol % return normalized to window start
  const normalizedData = useMemo(() => {
    if (compareSymbols.length === 0) return null;
    const allSymbols = [symbol, ...compareSymbols];
    const allData: Record<string, Candle[]> = { [symbol]: windowed, ...compareData };

    // Get common date set
    const dates = windowed.map(c => c.date);
    return dates.map(date => {
      const point: Record<string, unknown> = { date, label: toDateLabel(date, window) };
      allSymbols.forEach(sym => {
        const symCandles = filterByWindow(allData[sym] ?? [], window);
        if (symCandles.length === 0) return;
        const base = symCandles[0].close;
        const current = symCandles.find(c => c.date === date)?.close;
        if (current != null && base > 0) {
          point[sym] = parseFloat(((current / base - 1) * 100).toFixed(2));
        }
      });
      return point;
    });
  }, [symbol, windowed, compareSymbols, compareData, window]);

  // Trade markers on the price chart
  const tradeMarkers = useMemo(() => {
    return tradeEvents
      .filter(t => t.is_execution && t.stage === "fill")
      .filter(t => {
        const d = t.occurred_at?.split("T")[0];
        return d && windowed.some(c => c.date === d || c.date > d);
      })
      .map(t => ({
        date: t.occurred_at?.split("T")[0],
        side: t.side,
        price: t.price,
        scores: {
          fundamental: t.scores?.fundamental ?? null,
          technical: t.scores?.technical ?? null,
          sentiment: t.scores?.sentiment ?? null,
          macro: t.scores?.macro ?? null,
          analyst: t.analyst_score,
        },
        pnl: t.realized_pnl_pct,
        rationale: t.reason,
        exit_reason: t.side === "sell" ? t.reason : null,
        trade: t,
      }));
  }, [tradeEvents, windowed]);

  if (!symbol) return <div className="p-6 text-muted-foreground">No symbol specified.</div>;
  if (loading) return <div className="p-6 text-muted-foreground">Loading {symbol}…</div>;
  if (error) return <div className="p-6 text-destructive">Failed to load {symbol}: {error}</div>;

  const isCompare = compareSymbols.length > 0;
  const allSymbols = [symbol, ...compareSymbols];
  const COLORS = ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6"];

  return (
    <div className="flex flex-col gap-4 p-4 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => router.back()} className="text-muted-foreground hover:text-foreground text-sm">← Back</button>
        <h1 className="text-2xl font-bold">{symbol}</h1>
        {overview.Sector && <span className="text-sm text-muted-foreground bg-muted px-2 py-0.5 rounded">{overview.Sector}</span>}
        {candles.length > 0 && (
          <span className="text-lg font-mono">
            {currency}{candles[candles.length - 1].close.toFixed(2)}
            {candles.length > 1 && (
              <span className={`ml-2 text-sm ${candles[candles.length - 1].close >= candles[candles.length - 2].close ? "text-green-500" : "text-red-500"}`}>
                {((candles[candles.length - 1].close / candles[candles.length - 2].close - 1) * 100).toFixed(2)}%
              </span>
            )}
          </span>
        )}
      </div>

      {/* Compare input */}
      <div className="flex gap-2 flex-wrap">
        <div className="flex gap-1">
          {allSymbols.map((s, i) => (
            <span key={s} className="flex items-center gap-1 px-2 py-1 rounded-full text-xs font-mono" style={{ backgroundColor: COLORS[i] + "22", color: COLORS[i], border: `1px solid ${COLORS[i]}44` }}>
              {s}
              {s !== symbol && <button onClick={() => setCompareSymbols(prev => prev.filter(x => x !== s))} className="ml-1 opacity-60 hover:opacity-100">×</button>}
            </span>
          ))}
        </div>
        <input
          className="border rounded px-2 py-1 text-xs bg-background w-24"
          placeholder="+ Compare"
          value={compareInput}
          onChange={e => setCompareInput(e.target.value.toUpperCase())}
          onKeyDown={e => {
            if (e.key === "Enter" && compareInput.trim() && !compareSymbols.includes(compareInput.trim())) {
              setCompareSymbols(prev => [...prev, compareInput.trim()]);
              setCompareInput("");
            }
          }}
        />
        {/* Window selector */}
        <div className="flex gap-1 ml-auto">
          {(["6M", "1Y", "5Y", "All"] as Window[]).map(w => (
            <button key={w} onClick={() => setWindow(w)}
              className={`px-2 py-1 text-xs rounded ${window === w ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}>
              {w}
            </button>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {(["price", "fundamentals", "scores"] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm capitalize border-b-2 -mb-px ${activeTab === tab ? "border-primary text-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
            {tab === "price" ? "Price & Technicals" : tab === "fundamentals" ? "Fundamentals" : "Score History"}
          </button>
        ))}
      </div>

      {/* ── Price & Technicals Tab ── */}
      {activeTab === "price" && (
        <div className="flex flex-col gap-4">
          {/* Price chart */}
          <div className="rounded-lg border bg-card p-4">
            <h2 className="text-sm font-semibold mb-3 text-muted-foreground">
              {isCompare ? "% Return (normalized from window start)" : "Price"}
            </h2>
            <ResponsiveContainer width="100%" height={320}>
              {isCompare && normalizedData ? (
                <LineChart data={downsample(normalizedData as Array<{ date: string }>)}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" strokeOpacity={0.4} />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                  <YAxis tickFormatter={v => `${v}%`} tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(v: unknown) => [`${v}%`]} />
                  <Legend />
                  {allSymbols.map((sym, i) => (
                    <Line key={sym} type="monotone" dataKey={sym} stroke={COLORS[i]} dot={false} strokeWidth={1.5} />
                  ))}
                  {/* Buy markers */}
                  {tradeMarkers.filter(m => m.side === "buy").map(m => (
                    <ReferenceLine key={m.date} x={toDateLabel(m.date!, window)} stroke="#10b981" strokeDasharray="4 2" strokeOpacity={0.7} />
                  ))}
                  {/* Sell markers */}
                  {tradeMarkers.filter(m => m.side === "sell").map(m => (
                    <ReferenceLine key={m.date + "sell"} x={toDateLabel(m.date!, window)} stroke="#ef4444" strokeDasharray="4 2" strokeOpacity={0.7} />
                  ))}
                </LineChart>
              ) : (
                <ComposedChart data={downsample(chartData)}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" strokeOpacity={0.4} />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                  <YAxis domain={["auto", "auto"]} tick={{ fontSize: 10 }} />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0].payload;
                      const marker = tradeMarkers.find(m => m.date === d.date);
                      return (
                        <div className="bg-popover border rounded p-2 text-xs shadow-lg">
                          <div className="font-mono font-semibold">{d.date}</div>
                          <div>Close: <span className="font-mono">{currency}{d.close?.toFixed(2)}</span></div>
                          {d.ema20 && <div>EMA20: <span className="font-mono">{currency}{d.ema20}</span></div>}
                          {d.ema50 && <div>EMA50: <span className="font-mono">{currency}{d.ema50}</span></div>}
                          {d.ema200 && <div>EMA200: <span className="font-mono">{currency}{d.ema200}</span></div>}
                          {marker && (
                            <div className={`mt-1 pt-1 border-t font-semibold ${marker.side === "buy" ? "text-green-500" : "text-red-500"}`}>
                              {marker.side.toUpperCase()} @ {currency}{marker.price?.toFixed(2)}
                              {marker.pnl != null && <span className="ml-1">({marker.pnl > 0 ? "+" : ""}{marker.pnl?.toFixed(1)}%)</span>}
                            </div>
                          )}
                        </div>
                      );
                    }}
                  />
                  <Line type="monotone" dataKey="close" stroke={COLORS[0]} dot={false} strokeWidth={2} name={symbol} />
                  <Line type="monotone" dataKey="ema20" stroke="#f59e0b" dot={false} strokeWidth={1} strokeDasharray="4 2" name="EMA20" />
                  <Line type="monotone" dataKey="ema50" stroke="#10b981" dot={false} strokeWidth={1} strokeDasharray="4 2" name="EMA50" />
                  <Line type="monotone" dataKey="ema200" stroke="#8b5cf6" dot={false} strokeWidth={1} strokeDasharray="2 2" name="EMA200" />
                  <Legend iconType="line" wrapperStyle={{ fontSize: 11 }} />
                  {/* Buy/sell reference lines */}
                  {tradeMarkers.filter(m => m.side === "buy").map((m, i) => (
                    <ReferenceLine key={`buy-${i}`} x={toDateLabel(m.date!, window)} stroke="#10b981" strokeWidth={1.5} strokeDasharray="4 2"
                      label={{ value: "▲", fill: "#10b981", fontSize: 10 }} />
                  ))}
                  {tradeMarkers.filter(m => m.side === "sell").map((m, i) => (
                    <ReferenceLine key={`sell-${i}`} x={toDateLabel(m.date!, window)} stroke="#ef4444" strokeWidth={1.5} strokeDasharray="4 2"
                      label={{ value: "▼", fill: "#ef4444", fontSize: 10 }} />
                  ))}
                </ComposedChart>
              )}
            </ResponsiveContainer>
          </div>

          {/* Volume */}
          <div className="rounded-lg border bg-card p-4">
            <h2 className="text-sm font-semibold mb-2 text-muted-foreground">Volume</h2>
            <ResponsiveContainer width="100%" height={80}>
              <BarChart data={downsample(chartData, 200)}>
                <XAxis dataKey="label" hide />
                <YAxis hide />
                <Tooltip formatter={(v: unknown) => [Number(v).toLocaleString()]} />
                <Bar dataKey="volume" fill={COLORS[0]} opacity={0.5} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* RSI */}
          <div className="rounded-lg border bg-card p-4">
            <h2 className="text-sm font-semibold mb-2 text-muted-foreground">RSI (14)</h2>
            <ResponsiveContainer width="100%" height={100}>
              <LineChart data={downsample(chartData)}>
                <XAxis dataKey="label" hide />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} width={30} />
                <Tooltip formatter={(v: unknown) => [(v as number)?.toFixed(1)]} />
                <ReferenceLine y={70} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.5} />
                <ReferenceLine y={30} stroke="#10b981" strokeDasharray="3 3" strokeOpacity={0.5} />
                <Line type="monotone" dataKey="rsi" stroke="#f59e0b" dot={false} strokeWidth={1.5} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* MACD */}
          <div className="rounded-lg border bg-card p-4">
            <h2 className="text-sm font-semibold mb-2 text-muted-foreground">MACD (12/26/9)</h2>
            <ResponsiveContainer width="100%" height={100}>
              <ComposedChart data={downsample(chartData)}>
                <XAxis dataKey="label" hide />
                <YAxis tick={{ fontSize: 9 }} width={40} />
                <Tooltip formatter={(v: unknown) => [(v as number)?.toFixed(4)]} />
                <ReferenceLine y={0} stroke="var(--border)" />
                <Bar dataKey="macdHist" fill="#6366f1" opacity={0.7} name="Histogram" />
                <Line type="monotone" dataKey="macdLine" stroke="#f59e0b" dot={false} strokeWidth={1} name="MACD" />
                <Line type="monotone" dataKey="macdSignal" stroke="#ef4444" dot={false} strokeWidth={1} name="Signal" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Trade log */}
          {tradeEvents.length > 0 && (
            <div className="rounded-lg border bg-card p-4">
              <h2 className="text-sm font-semibold mb-1 text-muted-foreground">Decision &amp; Trade History</h2>
              <p className="text-xs text-muted-foreground mb-3">A proposal is an app recommendation, not a trade. Only rows marked FILLED changed the paper or live portfolio.</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground border-b">
                      <th className="text-left py-1 pr-3">Date</th>
                      <th className="text-left pr-3">Venue / stage</th>
                      <th className="text-left pr-3">Side</th>
                      <th className="text-left pr-3">Status</th>
                      <th className="text-right pr-3">Price</th>
                      <th className="text-right pr-3">P&L%</th>
                      <th className="text-right pr-3">Score</th>
                      <th className="text-left">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tradeEvents.map(t => (
                      <tr key={t.id} className="border-b border-border/30 hover:bg-muted/30 cursor-pointer" onClick={() => setSelectedTrade(t === selectedTrade ? null : t)}>
                        <td className="py-1 pr-3 font-mono">{t.occurred_at?.split("T")[0]}</td>
                        <td className="pr-3 uppercase text-muted-foreground">{t.venue} · {t.stage}</td>
                        <td className={`pr-3 font-semibold ${t.side === "buy" ? "text-green-500" : "text-red-500"}`}>{t.side.toUpperCase()}</td>
                        <td className="pr-3 uppercase text-muted-foreground">{t.status.replaceAll("_", " ")}</td>
                        <td className="text-right pr-3 font-mono">{t.price == null ? "—" : `${currency}${t.price.toFixed(2)}`}</td>
                        <td className={`text-right pr-3 font-mono ${(t.realized_pnl_pct ?? 0) >= 0 ? "text-green-500" : "text-red-500"}`}>
                          {t.realized_pnl_pct != null ? `${t.realized_pnl_pct > 0 ? "+" : ""}${t.realized_pnl_pct.toFixed(1)}%` : "—"}
                        </td>
                        <td className="text-right pr-3 font-mono">{t.analyst_score ?? "—"}</td>
                        <td className="text-muted-foreground truncate max-w-[200px]">{t.reason ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Trade detail expander */}
              {selectedTrade && (
                <div className="mt-3 p-3 bg-muted rounded text-xs">
                  <div className="font-semibold mb-2">{selectedTrade.stage === "proposal" ? "Proposal evidence" : "Recorded action detail"}</div>
                  <ScoreBar label="Fundamental" value={selectedTrade.scores?.fundamental ?? null} color="#6366f1" />
                  <ScoreBar label="Technical" value={selectedTrade.scores?.technical ?? null} color="#f59e0b" />
                  <ScoreBar label="Sentiment" value={selectedTrade.scores?.sentiment ?? null} color="#10b981" />
                  <ScoreBar label="Macro" value={selectedTrade.scores?.macro ?? null} color="#8b5cf6" />
                  <ScoreBar label="Analyst (weighted)" value={selectedTrade.analyst_score} color="#ef4444" />
                  {selectedTrade.reason && (
                    <div className="mt-2 text-muted-foreground border-t pt-2">{selectedTrade.reason}</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Fundamentals Tab ── */}
      {activeTab === "fundamentals" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[
            { label: "P/E Ratio (TTM)", key: "PERatio", format: (v: string) => parseFloat(v).toFixed(1) + "x" },
            { label: "PEG Ratio", key: "PEGRatio", format: (v: string) => parseFloat(v).toFixed(2) },
            { label: "EPS (TTM)", key: "EPS", format: (v: string) => "$" + parseFloat(v).toFixed(2) },
            { label: "Profit Margin", key: "ProfitMargin", format: (v: string) => (parseFloat(v) * 100).toFixed(1) + "%" },
            { label: "Gross Margin", key: "GrossMarginTTM", format: (v: string) => (parseFloat(v) * 100).toFixed(1) + "%" },
            { label: "ROE (TTM)", key: "ReturnOnEquityTTM", format: (v: string) => (parseFloat(v) * 100).toFixed(1) + "%" },
            { label: "Revenue Growth YOY", key: "QuarterlyRevenueGrowthYOY", format: (v: string) => (parseFloat(v) * 100).toFixed(1) + "%" },
            { label: "FCF Yield", key: "FCFYield", format: (v: string) => (parseFloat(v) * 100).toFixed(1) + "%" },
            { label: "Debt / Equity", key: "DebtToEquity", format: (v: string) => parseFloat(v).toFixed(2) + "x" },
            { label: "52W High", key: "52WeekHigh", format: (v: string) => "$" + parseFloat(v).toFixed(2) },
            { label: "52W Low", key: "52WeekLow", format: (v: string) => "$" + parseFloat(v).toFixed(2) },
            { label: "Analyst Target", key: "AnalystTargetPrice", format: (v: string) => "$" + parseFloat(v).toFixed(2) },
          ].map(({ label, key, format }) => {
            const raw = overview[key as keyof Overview];
            const val = raw && Number.isFinite(parseFloat(raw)) ? format(raw) : "—";
            return (
              <div key={key} className="rounded-lg border bg-card p-4">
                <div className="text-xs text-muted-foreground mb-1">{label}</div>
                <div className={`text-xl font-mono font-semibold ${val === "—" ? "text-muted-foreground" : ""}`}>{val}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Score History Tab ── */}
      {activeTab === "scores" && (
        <div className="flex flex-col gap-4">
          {tradeEvents.filter(t => t.scores && t.analyst_score != null).length === 0 ? (
            <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
              No scored paper trades found for {symbol}.<br />
              <span className="text-xs mt-1 block">Scores are recorded at each research run that triggers a trade signal.</span>
            </div>
          ) : (
            <>
              {/* Score history chart */}
              <div className="rounded-lg border bg-card p-4">
                <h2 className="text-sm font-semibold mb-3 text-muted-foreground">Score at Entry — History</h2>
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={tradeEvents.filter(t => t.scores && t.analyst_score != null).slice().reverse().map(t => ({
                    date: t.occurred_at?.split("T")[0],
                    "Analyst (weighted)": t.analyst_score,
                    Fundamental: t.scores?.fundamental,
                    Technical: t.scores?.technical,
                    Sentiment: t.scores?.sentiment,
                    Macro: t.scores?.macro,
                  }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" strokeOpacity={0.4} />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <ReferenceLine y={50} stroke="var(--border)" strokeDasharray="3 3" />
                    <Line type="monotone" dataKey="Analyst (weighted)" stroke="#ef4444" strokeWidth={2} dot={{ r: 3 }} />
                    <Line type="monotone" dataKey="Fundamental" stroke="#6366f1" strokeWidth={1} dot={{ r: 2 }} />
                    <Line type="monotone" dataKey="Technical" stroke="#f59e0b" strokeWidth={1} dot={{ r: 2 }} />
                    <Line type="monotone" dataKey="Sentiment" stroke="#10b981" strokeWidth={1} dot={{ r: 2 }} />
                    <Line type="monotone" dataKey="Macro" stroke="#8b5cf6" strokeWidth={1} dot={{ r: 2 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Current score breakdown (from most recent trade) */}
              {(() => {
                const latest = tradeEvents.find(t => t.scores && t.analyst_score != null);
                if (!latest) return null;
                return (
                  <div className="rounded-lg border bg-card p-4">
                    <h2 className="text-sm font-semibold mb-3 text-muted-foreground">
                      Most Recent Score Breakdown — {latest.occurred_at?.split("T")[0]}
                    </h2>
                    <ScoreBar label={`Analyst Score (weighted total)`} value={latest.analyst_score} color="#ef4444" />
                    <div className="mt-3 border-t pt-3 space-y-1">
                      <ScoreBar label="Fundamental" value={latest.scores?.fundamental ?? null} color="#6366f1" />
                      <ScoreBar label="Technical" value={latest.scores?.technical ?? null} color="#f59e0b" />
                      <ScoreBar label="Sentiment" value={latest.scores?.sentiment ?? null} color="#10b981" />
                      <ScoreBar label="Macro" value={latest.scores?.macro ?? null} color="#8b5cf6" />
                    </div>
                    <div className="text-xs text-muted-foreground mt-3">
                      Scores are recorded at paper trade entry. Per-indicator breakdown (P/E contribution, RSI contribution, etc.) requires research-agent re-run for live detail.
                    </div>
                  </div>
                );
              })()}
            </>
          )}
        </div>
      )}
    </div>
  );
}
