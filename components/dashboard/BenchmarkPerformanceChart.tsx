"use client";
import { useState, useEffect, useMemo, useRef } from "react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ReferenceLine,
} from "recharts";

// Shared dark palette — matches PortfolioPage / BenchmarkChart T tokens.
const T = {
  card: "#1A1D27", border: "#252836", text: "#ECEDEF", textSub: "#9B9EA8",
  muted: "#6B7280", accent: "#6366F1", green: "#34D399", red: "#F87171",
  greenBg: "#052E16", redBg: "#3B0000", surface: "#13151C",
};
const COLORS = { portfolio: "#6366F1", bench: "#9B9EA8" };

type Market = "us" | "india";
type Timeframe = "1W" | "1M" | "YTD" | "1Y" | "All";
const TIMEFRAMES: Timeframe[] = ["1W", "1M", "YTD", "1Y", "All"];

interface SeriesRow { date: string; nav: number | null; bench_nav: number | null }
interface BenchmarkOption {
  id: string;
  label: string;
  symbol: string | null;
  provider_symbol: string | null;
  is_primary: boolean;
}

const DAY = 86_400_000;

// Earliest date (inclusive) to keep for a timeframe, or null = keep everything.
function cutoffFor(tf: Timeframe): number | null {
  const now = Date.now();
  switch (tf) {
    case "1W":  return now - 7 * DAY;
    case "1M":  return now - 30 * DAY;
    case "1Y":  return now - 365 * DAY;
    case "YTD": return new Date(new Date().getFullYear(), 0, 1).getTime();
    case "All": return null;
  }
}

// Rebase to % return from the FIRST point in the window: pct = (v/base - 1)*100.
function pct(v: number, base: number): number {
  if (!base) return 0;
  return parseFloat((((v - base) / base) * 100).toFixed(3));
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "10px 14px", fontSize: "12px" }}>
      <div style={{ color: T.muted, marginBottom: "6px" }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ color: p.color, fontWeight: 600, marginBottom: "2px" }}>
          {p.name}: {p.value >= 0 ? "+" : ""}{p.value?.toFixed(2)}%
        </div>
      ))}
    </div>
  );
}

const CARD: React.CSSProperties = {
  background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px",
};

// Portfolio cumulative %-return vs an owner-selected market-local display
// benchmark, with a timeframe toggle. Both lines are rebased to % return from
// the first point inside the selected window, so every timeframe reads "how am I
// doing vs the comparator over THIS period". Display selection is persisted by
// the server but never changes the governed primary benchmark used by learning.
export default function BenchmarkPerformanceChart({ market = "us" }: { market?: Market }) {
  const [series, setSeries] = useState<SeriesRow[]>([]);
  const [benchmarks, setBenchmarks] = useState<BenchmarkOption[]>([]);
  const [selectedBenchmark, setSelectedBenchmark] = useState<BenchmarkOption | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingDefault, setSavingDefault] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tf, setTf] = useState<Timeframe>("1M");
  const requestSeq = useRef(0);
  const benchLabel = selectedBenchmark?.label ?? (market === "india" ? "NIFTY 50" : "VOO");

  async function load(benchmarkId?: string) {
    const seq = ++requestSeq.current;
    setLoading(true);
    setErr(null);
    try {
      const suffix = benchmarkId ? `&benchmarkId=${encodeURIComponent(benchmarkId)}` : "";
      const response = await fetch(`/api/portfolio/performance-series?market=${market}${suffix}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || data?.error) throw new Error(data?.error ?? "performance_series_failed");
      if (seq !== requestSeq.current) return;
      setSeries(Array.isArray(data?.series) ? data.series : []);
      setBenchmarks(Array.isArray(data?.benchmarks) ? data.benchmarks : []);
      setSelectedBenchmark(data?.selected_benchmark ?? null);
    } catch (e: any) {
      if (seq !== requestSeq.current) return;
      setErr(e?.message ?? "Failed to load performance history.");
      setSeries([]);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    return () => { requestSeq.current += 1; };
  }, [market]);

  async function chooseBenchmark(option: BenchmarkOption) {
    if (option.id === selectedBenchmark?.id || savingDefault) return;
    const previous = selectedBenchmark;
    setSelectedBenchmark(option);
    setSavingDefault(true);
    setErr(null);
    try {
      const response = await fetch("/api/portfolio/performance-series", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market, benchmarkId: option.id }),
      });
      const data = await response.json();
      if (!response.ok || !data?.ok) throw new Error(data?.error ?? "benchmark_preference_failed");
      await load(option.id);
    } catch (e: any) {
      setSelectedBenchmark(previous);
      setErr(`Could not save benchmark default: ${e?.message ?? "unknown error"}`);
    } finally {
      setSavingDefault(false);
    }
  }

  const { chartData, portfolioLast, benchLast, delta } = useMemo(() => {
    const cut = cutoffFor(tf);
    // Use a common starting observation. Rebasing portfolio from Monday while
    // rebasing the benchmark from Wednesday produces a fake relative return.
    const windowed = series.filter(r =>
      r.nav != null && r.bench_nav != null &&
      (cut == null || new Date(r.date).getTime() >= cut));

    if (windowed.length < 2) {
      return { chartData: [] as any[], portfolioLast: null, benchLast: null, delta: null };
    }

    const navBase = Number(windowed[0].nav);
    const benchBase = Number(windowed[0].bench_nav);

    const data = windowed.map(r => ({
      date: r.date,
      portfolio: pct(Number(r.nav), navBase),
      bench: pct(Number(r.bench_nav), benchBase),
    }));

    const pLast = data[data.length - 1].portfolio;
    const bLast = [...data].reverse().find(d => d.bench != null)?.bench ?? null;
    return {
      chartData: data,
      portfolioLast: pLast,
      benchLast: bLast,
      delta: bLast != null ? parseFloat((pLast - bLast).toFixed(2)) : null,
    };
  }, [series, tf]);

  const hasBench = chartData.some(d => d.bench != null);

  const toggle = (
    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
      {TIMEFRAMES.map(t => {
        const active = t === tf;
        return (
          <button
            key={t}
            onClick={() => setTf(t)}
            style={{
              fontSize: "11px", fontWeight: 600, padding: "4px 10px", borderRadius: "6px",
              cursor: "pointer", transition: "background 120ms, color 120ms",
              background: active ? T.accent : T.surface,
              color: active ? "#fff" : T.textSub,
              border: `1px solid ${active ? T.accent : T.border}`,
            }}
          >
            {t}
          </button>
        );
      })}
    </div>
  );

  const header = (
    <div style={{ marginBottom: "14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "10px" }}>
        <div>
          <div style={{ fontSize: "13px", fontWeight: 600, color: T.text }}>Portfolio vs {benchLabel}</div>
          <div style={{ fontSize: "11px", color: T.muted, marginTop: "2px" }}>Cumulative % return, rebased to each window · selection is your saved default</div>
        </div>
        {toggle}
      </div>
      {benchmarks.length > 0 && (
        <div role="radiogroup" aria-label={`${market.toUpperCase()} comparison benchmark`} style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "12px" }}>
          {benchmarks.map((option) => {
            const active = option.id === selectedBenchmark?.id;
            return (
              <button
                key={option.id}
                role="radio"
                aria-checked={active}
                disabled={savingDefault}
                onClick={() => void chooseBenchmark(option)}
                title={option.is_primary ? "Governed primary benchmark" : "Display comparison only"}
                style={{
                  fontSize: "11px", fontWeight: 600, padding: "5px 9px", borderRadius: "999px",
                  cursor: savingDefault ? "wait" : "pointer", opacity: savingDefault ? 0.7 : 1,
                  background: active ? T.accent : T.surface,
                  color: active ? "#fff" : T.textSub,
                  border: `1px solid ${active ? T.accent : T.border}`,
                }}
              >
                {option.label}{option.is_primary ? " · primary" : ""}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  // ── Empty / short / error states ────────────────────────────────────────────
  if (loading) {
    return (
      <div style={CARD}>
        {header}
        <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "48px 0" }}>Loading…</div>
      </div>
    );
  }
  if (err) {
    return (
      <div style={CARD}>
        {header}
        <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "48px 0" }}>{err}</div>
      </div>
    );
  }
  if (chartData.length < 2) {
    return (
      <div style={CARD}>
        {header}
        <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "48px 0" }}>
          No matched daily Portfolio/{benchLabel} history yet. Run the benchmark scorecard once or check back after its next daily run.
        </div>
      </div>
    );
  }

  return (
    <div style={CARD}>
      {header}

      {/* Headline: window delta vs benchmark (Portfolio % − Benchmark %) */}
      <div style={{ display: "flex", alignItems: "baseline", gap: "12px", flexWrap: "wrap", marginBottom: "12px" }}>
        {delta != null ? (
          <div style={{
            fontSize: "20px", fontWeight: 800, letterSpacing: "-0.01em",
            color: delta >= 0 ? T.green : T.red,
            background: delta >= 0 ? T.greenBg : T.redBg,
            padding: "3px 10px", borderRadius: "7px",
          }}>
            {delta >= 0 ? "+" : ""}{delta.toFixed(2)}% vs {benchLabel}
          </div>
        ) : (
          <div style={{ fontSize: "12px", color: T.muted }}>{benchLabel} benchmark not recorded for this window yet.</div>
        )}
        <div style={{ fontSize: "12px", color: T.textSub }}>
          Portfolio <span style={{ color: (portfolioLast ?? 0) >= 0 ? T.green : T.red, fontWeight: 600 }}>
            {(portfolioLast ?? 0) >= 0 ? "+" : ""}{(portfolioLast ?? 0).toFixed(2)}%
          </span>
          {benchLast != null && (
            <>
              {"  ·  "}{benchLabel} <span style={{ color: benchLast >= 0 ? T.green : T.red, fontWeight: 600 }}>
                {benchLast >= 0 ? "+" : ""}{benchLast.toFixed(2)}%
              </span>
            </>
          )}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={T.border} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false}
            interval="preserveStartEnd" tickFormatter={(v: string) => (v?.length >= 10 ? v.slice(5) : v)} />
          <YAxis tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false}
            tickFormatter={(v: number) => v.toFixed(1) + "%"} width={50} />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine y={0} stroke={T.muted} strokeDasharray="2 2" />
          <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }} />
          <Line type="monotone" dataKey="portfolio" name="Portfolio" stroke={COLORS.portfolio} strokeWidth={2.5} dot={false} />
          {hasBench && (
            <Line type="monotone" dataKey="bench" name={benchLabel} stroke={COLORS.bench} strokeWidth={1.5}
              dot={false} strokeDasharray="4 2" connectNulls />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
