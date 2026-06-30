"use client";

import { useEffect, useState, lazy, Suspense } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/dashboard/PageHeader";
const SectorTreemap = lazy(() => import("@/components/charts/SectorTreemap"));
const PriceChart = lazy(() => import("@/components/charts/PriceChart"));
const SectorPerformanceChart = lazy(() => import("@/components/charts/SectorPerformanceChart"));
const SectorLineChart = lazy(() => import("@/components/charts/SectorLineChart"));
const SectorBreadth = lazy(() => import("@/components/dashboard/SectorBreadth"));

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

function SectorHeatmap({ sectors, onSymbol }: { sectors: SectorQuote[]; onSymbol: (sym: string) => void }) {
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
        Sector Performance · click to view chart
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "8px" }}>
        {sorted.map(s => (
          <div
            key={s.symbol}
            onClick={() => onSymbol(s.symbol)}
            style={{
              background: pctBg(s.changePct),
              border: `1px solid ${s.changePct >= 0 ? T.green : T.red}30`,
              borderRadius: "8px",
              padding: "12px 14px",
              cursor: "pointer",
              transition: "opacity 0.15s",
            }}
            onMouseEnter={e => (e.currentTarget.style.opacity = "0.8")}
            onMouseLeave={e => (e.currentTarget.style.opacity = "1")}
          >
            <div style={{ fontSize: "11px", color: T.textSub, marginBottom: "4px" }}>{s.name}</div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "12px", fontWeight: 700, color: T.accent }}>{s.symbol} ↗</span>
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

const SENTIMENT_PAIRS = [
  { bull: "TQQQ", bear: "SQQQ", label: "Nasdaq" },
  { bull: "SOXL", bear: "SOXS", label: "Semis" },
  { bull: "SPXL", bear: "SPXS", label: "S&P 500" },
  { bull: "FAS",  bear: "FAZ",  label: "Financials" },
  { bull: "UGL",  bear: "GLL",  label: "Gold" },
];

interface PairQuote {
  symbol: string;
  changePct: number | null;
}

interface PairData {
  label: string;
  bull: PairQuote;
  bear: PairQuote;
  direction: "BULL" | "BEAR" | "MIXED";
}

function SentimentPairs() {
  const [pairs, setPairs] = useState<PairData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const symbols = SENTIMENT_PAIRS.flatMap(p => [p.bull, p.bear]).join(",");
    fetch(`/api/markets/quotes?symbols=${symbols}`)
      .then(r => r.json())
      .then(json => {
        const q = json.quotes ?? {};
        const built: PairData[] = SENTIMENT_PAIRS.map(p => {
          const bullPct: number | null = q[p.bull]?.changePct ?? null;
          const bearPct: number | null = q[p.bear]?.changePct ?? null;
          let direction: "BULL" | "BEAR" | "MIXED" = "MIXED";
          if (bullPct !== null && bearPct !== null) {
            if (bullPct > 0 && bullPct > bearPct) direction = "BULL";
            else if (bearPct > 0 && bearPct > bullPct) direction = "BEAR";
          }
          return { label: p.label, bull: { symbol: p.bull, changePct: bullPct }, bear: { symbol: p.bear, changePct: bearPct }, direction };
        });
        setPairs(built);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
      <div style={{ fontSize: "11px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "4px" }}>
        Leveraged Sentiment Pairs · bull vs bear flow
      </div>
      <div style={{ fontSize: "11px", color: T.muted, marginBottom: "16px" }}>
        3x leveraged — for direction signal only, not trading targets
      </div>
      {loading ? (
        <div style={{ display: "flex", gap: "10px" }}>
          {[...Array(5)].map((_, i) => (
            <div key={i} style={{ flex: "1 1 0", height: "88px", background: T.surface, borderRadius: "8px", animation: "pulse 1.5s ease-in-out infinite" }} />
          ))}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "10px" }}>
          {pairs.map(p => {
            const dirColor = p.direction === "BULL" ? T.green : p.direction === "BEAR" ? T.red : T.amber;
            const dirBg   = p.direction === "BULL" ? T.greenBg : p.direction === "BEAR" ? T.redBg : "#2D2000";
            return (
              <div
                key={p.label}
                style={{
                  background: T.surface,
                  border: `1px solid ${T.border}`,
                  borderRadius: "10px",
                  padding: "12px 14px",
                  borderTop: `3px solid ${dirColor}`,
                }}
              >
                <div style={{ fontSize: "11px", color: T.textSub, fontWeight: 600, marginBottom: "8px" }}>{p.label}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginBottom: "8px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px" }}>
                    <span style={{ color: T.muted }}>{p.bull.symbol}</span>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", color: p.bull.changePct !== null && p.bull.changePct >= 0 ? T.green : T.red, fontWeight: 700 }}>
                      {p.bull.changePct !== null ? `${p.bull.changePct >= 0 ? "+" : ""}${p.bull.changePct.toFixed(2)}%` : "—"}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px" }}>
                    <span style={{ color: T.muted }}>{p.bear.symbol}</span>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", color: p.bear.changePct !== null && p.bear.changePct >= 0 ? T.red : T.green, fontWeight: 700 }}>
                      {p.bear.changePct !== null ? `${p.bear.changePct >= 0 ? "+" : ""}${p.bear.changePct.toFixed(2)}%` : "—"}
                    </span>
                  </div>
                </div>
                <div style={{ display: "inline-block", padding: "2px 8px", borderRadius: "5px", background: dirBg, color: dirColor, fontSize: "10px", fontWeight: 700, letterSpacing: "0.06em" }}>
                  {p.direction}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function renderThesisText(text: string) {
  // Convert **bold** markers to <strong> spans
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} style={{ color: T.text, fontWeight: 700 }}>{part.slice(2, -2)}</strong>;
    }
    return <span key={i}>{part}</span>;
  });
}

function MarketThesis() {
  const [thesis, setThesis] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function load(force = false) {
    if (force) setRefreshing(true); else setLoading(true);
    try {
      const url = force ? "/api/markets/thesis?force=true" : "/api/markets/thesis";
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        setThesis(json.thesis ?? null);
        setGeneratedAt(json.generatedAt ?? null);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { load(); }, []);

  function minutesAgo(iso: string) {
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (diff < 1) return "just now";
    if (diff === 1) return "1 min ago";
    return `${diff} min ago`;
  }

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <div>
          <div style={{ fontSize: "11px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "2px" }}>
            AI Market Thesis · 1-day + 1-week + next session
          </div>
          {generatedAt && !loading && (
            <div style={{ fontSize: "11px", color: T.muted }}>Generated {minutesAgo(generatedAt)}</div>
          )}
        </div>
        <button
          onClick={() => load(true)}
          disabled={loading || refreshing}
          style={{
            padding: "6px 14px",
            background: T.surface,
            border: `1px solid ${T.border}`,
            borderRadius: "8px",
            color: loading || refreshing ? T.muted : T.text,
            fontSize: "12px",
            fontWeight: 500,
            cursor: loading || refreshing ? "not-allowed" : "pointer",
          }}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {loading && (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              style={{
                height: "18px",
                background: T.surface,
                borderRadius: "4px",
                width: i === 2 ? "60%" : "100%",
                animation: "pulse 1.5s ease-in-out infinite",
              }}
            />
          ))}
        </div>
      )}

      {!loading && thesis && (
        <div
          style={{
            fontSize: "13px",
            lineHeight: "1.7",
            color: T.textSub,
            whiteSpace: "pre-wrap",
          }}
        >
          {renderThesisText(thesis)}
        </div>
      )}

      {!loading && !thesis && (
        <div style={{ fontSize: "13px", color: T.muted }}>
          Thesis unavailable — market data could not be fetched.
        </div>
      )}
    </div>
  );
}

interface InsiderTrade {
  symbol: string;
  name: string;
  type: "buy" | "sell";
  value: number;
  shares: number;
  date: string;
  filer: string;
  role: "insider" | "congress";
  title?: string;
}

function fmtValue(v: number) {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  if (v > 0) return `$${v.toLocaleString()}`;
  return "—";
}

function SmartMoneyTrades() {
  const [trades, setTrades] = useState<InsiderTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"insider" | "congress">("insider");
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    fetch("/api/markets/insider-trades")
      .then((r) => r.json())
      .then((json) => setTrades(json.trades ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const filtered = trades.filter((t) => t.role === tab);
  const visible = showAll ? filtered : filtered.slice(0, 10);

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
          gap: "10px",
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
            Smart Money Trades · Insiders & Congress
          </div>
          <div style={{ fontSize: "11px", color: T.muted }}>
            Recent buys and sells by corporate insiders and House members
          </div>
        </div>
        {/* Tab switcher */}
        <div
          style={{
            display: "flex",
            gap: "6px",
            background: T.surface,
            borderRadius: "8px",
            padding: "4px",
          }}
        >
          {(["insider", "congress"] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setShowAll(false); }}
              style={{
                padding: "5px 14px",
                borderRadius: "6px",
                fontSize: "12px",
                fontWeight: 600,
                border: "none",
                cursor: "pointer",
                background: tab === t ? T.accent : "transparent",
                color: tab === t ? "#fff" : T.muted,
                transition: "background 0.15s",
              }}
            >
              {t === "insider" ? "Insiders" : "Congress"}
            </button>
          ))}
        </div>
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              style={{
                height: "44px",
                background: T.surface,
                borderRadius: "8px",
                animation: "pulse 1.5s ease-in-out infinite",
              }}
            />
          ))}
        </div>
      )}

      {/* Trade rows */}
      {!loading && visible.length === 0 && (
        <div style={{ fontSize: "13px", color: T.muted, textAlign: "center", padding: "24px 0" }}>
          No recent {tab === "insider" ? "insider" : "congressional"} trades found.
        </div>
      )}

      {!loading && visible.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {visible.map((t, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                padding: "10px 12px",
                background: T.surface,
                borderRadius: "8px",
                border: `1px solid ${T.border}`,
                flexWrap: "wrap",
              }}
            >
              {/* Symbol */}
              <span
                style={{
                  fontSize: "12px",
                  fontWeight: 700,
                  color: T.accent,
                  fontFamily: "'JetBrains Mono', monospace",
                  minWidth: "52px",
                }}
              >
                {t.symbol}
              </span>

              {/* Buy/Sell badge */}
              <span
                style={{
                  fontSize: "10px",
                  fontWeight: 700,
                  padding: "2px 8px",
                  borderRadius: "5px",
                  background: t.type === "buy" ? T.greenBg : T.redBg,
                  color: t.type === "buy" ? T.green : T.red,
                  letterSpacing: "0.06em",
                  minWidth: "36px",
                  textAlign: "center",
                }}
              >
                {t.type === "buy" ? "BUY" : "SELL"}
              </span>

              {/* Filer name */}
              <span
                style={{
                  fontSize: "12px",
                  color: T.text,
                  fontWeight: 500,
                  flex: "1 1 140px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {t.filer || t.name || "—"}
              </span>

              {/* Title/role */}
              {t.title && (
                <span
                  style={{
                    fontSize: "11px",
                    color: T.muted,
                    flex: "0 1 100px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {t.title}
                </span>
              )}

              {/* Value */}
              <span
                style={{
                  fontSize: "12px",
                  fontWeight: 700,
                  fontFamily: "'JetBrains Mono', monospace",
                  color: t.type === "buy" ? T.green : T.red,
                  minWidth: "60px",
                  textAlign: "right",
                }}
              >
                {fmtValue(t.value)}
              </span>

              {/* Date */}
              <span
                style={{
                  fontSize: "11px",
                  color: T.muted,
                  fontFamily: "'JetBrains Mono', monospace",
                  minWidth: "80px",
                  textAlign: "right",
                }}
              >
                {t.date ? new Date(t.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" }) : "—"}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Show more toggle */}
      {!loading && filtered.length > 10 && (
        <button
          onClick={() => setShowAll((s) => !s)}
          style={{
            marginTop: "12px",
            width: "100%",
            padding: "8px",
            background: "transparent",
            border: `1px solid ${T.border}`,
            borderRadius: "8px",
            color: T.muted,
            fontSize: "12px",
            cursor: "pointer",
            fontWeight: 500,
          }}
        >
          {showAll ? "Show less" : `Show ${filtered.length - 10} more`}
        </button>
      )}
    </div>
  );
}

// ─── Macro Sentinel Card ────────────────────────────────────────────────────

interface MacroSignal {
  indicator: string;
  value: number | null;
  signal: "green" | "yellow" | "orange" | "red";
  description: string;
}

interface MacroRegime {
  week_of: string;
  danger_score: number;
  regime: "green" | "yellow" | "orange" | "red";
  signals_triggered: number;
  summary: string | null;
}

const REGIME_STYLES: Record<string, { bg: string; color: string; border: string }> = {
  green:  { bg: "#0d2218", color: "#34D399", border: "#1a3a24" },
  yellow: { bg: "#1a1500", color: "#FBBF24", border: "#3a2e00" },
  orange: { bg: "#2a1000", color: "#FB923C", border: "#3a2000" },
  red:    { bg: "#2a0000", color: "#F87171", border: "#3a0000" },
};

const SIGNAL_COLORS: Record<string, string> = {
  green:  "#34D399",
  yellow: "#FBBF24",
  orange: "#FB923C",
  red:    "#F87171",
};

function MacroSentinelCard() {
  const [macroData, setMacroData] = useState<{ regimes: MacroRegime[]; latest_signals: MacroSignal[] } | null>(null);
  const [macroLoading, setMacroLoading] = useState(true);
  const [macroRunning, setMacroRunning] = useState(false);
  const [macroShowExplain, setMacroShowExplain] = useState(false);

  async function loadHistory() {
    setMacroLoading(true);
    try {
      const res = await fetch("/api/agents/macro-sentinel/history");
      if (res.ok) setMacroData(await res.json());
    } catch {}
    setMacroLoading(false);
  }

  async function runNow() {
    setMacroRunning(true);
    try {
      const res = await fetch("/api/agents/macro-sentinel", { method: "POST" });
      if (res.ok) await loadHistory();
    } catch {}
    setMacroRunning(false);
  }

  useEffect(() => { loadHistory(); }, []);

  const latest = macroData?.regimes?.[0] ?? null;
  const signals = macroData?.latest_signals ?? [];
  const hasData = !!latest;
  const regime = latest?.regime ?? "green";
  const regStyle = REGIME_STYLES[regime] ?? REGIME_STYLES.green;
  const dangerScore = latest?.danger_score ?? 0;
  const dangerColor = dangerScore < 20 ? "#34D399" : dangerScore < 40 ? "#FBBF24" : dangerScore < 60 ? "#FB923C" : "#F87171";

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <div>
          <div style={{ fontSize: "11px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "2px" }}>
            Macro Recession Sentinel
          </div>
          <div style={{ fontSize: "11px", color: T.muted }}>
            8 economic indicators · weekly assessment · advisory only
          </div>
        </div>
        <button
          onClick={runNow}
          disabled={macroRunning || macroLoading}
          style={{
            padding: "6px 14px",
            background: T.surface,
            border: `1px solid ${T.border}`,
            borderRadius: "8px",
            color: macroRunning ? T.muted : T.text,
            fontSize: "12px",
            fontWeight: 500,
            cursor: macroRunning || macroLoading ? "not-allowed" : "pointer",
            display: "flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          {macroRunning ? "Running…" : "Run Now ▷"}
        </button>
      </div>

      {macroLoading && (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {[...Array(3)].map((_, i) => (
            <div key={i} style={{ height: "18px", background: T.surface, borderRadius: "4px", width: i === 2 ? "60%" : "100%", animation: "pulse 1.5s ease-in-out infinite" }} />
          ))}
        </div>
      )}

      {!macroLoading && !hasData && (
        <div style={{ textAlign: "center", padding: "24px 0" }}>
          <div style={{ fontSize: "14px", color: T.muted, marginBottom: "12px" }}>
            No readings yet — run MacroSentinel for first assessment
          </div>
          <button
            onClick={runNow}
            disabled={macroRunning}
            style={{
              padding: "8px 20px",
              background: T.accent,
              border: "none",
              borderRadius: "8px",
              color: "#fff",
              fontSize: "13px",
              fontWeight: 600,
              cursor: macroRunning ? "not-allowed" : "pointer",
            }}
          >
            {macroRunning ? "Running…" : "Run Now"}
          </button>
        </div>
      )}

      {!macroLoading && hasData && (
        <>
          {/* Regime summary row */}
          <div style={{ display: "flex", alignItems: "center", gap: "16px", marginBottom: "12px", flexWrap: "wrap" }}>
            {/* Danger score gauge */}
            <div style={{ flex: "1 1 200px", minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                <span style={{ fontSize: "12px", color: T.muted }}>Danger Score</span>
                <span style={{ fontSize: "13px", fontWeight: 700, color: dangerColor, fontFamily: "'JetBrains Mono', monospace" }}>
                  {dangerScore}/100
                </span>
              </div>
              <div style={{ height: 8, borderRadius: 4, background: "#1E2130", width: "100%", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${dangerScore}%`, background: dangerColor, borderRadius: 4, transition: "width 0.5s" }} />
              </div>
            </div>

            {/* Regime badge */}
            <div style={{
              padding: "6px 14px",
              borderRadius: "8px",
              background: regStyle.bg,
              border: `1px solid ${regStyle.border}`,
              color: regStyle.color,
              fontSize: "13px",
              fontWeight: 700,
              letterSpacing: "0.04em",
              whiteSpace: "nowrap",
            }}>
              {regime === "green" ? "🟢" : regime === "yellow" ? "🟡" : regime === "orange" ? "🟠" : "🔴"} {regime.toUpperCase()}
              <span style={{ fontWeight: 400, fontSize: "11px", marginLeft: "8px", opacity: 0.8 }}>
                ({latest?.signals_triggered ?? 0} signal{latest?.signals_triggered !== 1 ? "s" : ""})
              </span>
            </div>

            {/* Week of */}
            <span style={{ fontSize: "11px", color: T.muted, whiteSpace: "nowrap" }}>
              Week of {latest?.week_of}
            </span>
          </div>

          {/* Summary text */}
          {latest?.summary && (
            <div style={{
              fontSize: "12px",
              color: T.textSub,
              background: T.surface,
              borderRadius: "8px",
              padding: "10px 12px",
              marginBottom: "14px",
              lineHeight: "1.5",
              fontStyle: "italic",
            }}>
              "{latest.summary}"
            </div>
          )}

          {/* Signal breakdown table */}
          {signals.length > 0 && (
            <div style={{ marginBottom: "12px" }}>
              <div style={{ fontSize: "11px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "8px" }}>
                Signal Breakdown
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                {signals.map((sig) => {
                  const sigColor = SIGNAL_COLORS[sig.signal] ?? T.muted;
                  return (
                    <div
                      key={sig.indicator}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                        padding: "8px 10px",
                        background: T.surface,
                        borderRadius: "7px",
                        border: `1px solid ${T.border}`,
                      }}
                    >
                      <span style={{ color: sigColor, fontSize: "10px", flexShrink: 0 }}>■</span>
                      <span style={{ flex: "1 1 0", fontSize: "12px", color: T.text, fontWeight: 500 }}>{sig.indicator}</span>
                      <span style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: "11px",
                        color: T.muted,
                        minWidth: "64px",
                        textAlign: "right",
                      }}>
                        {sig.value !== null ? sig.value : "—"}
                      </span>
                      <span style={{
                        fontSize: "10px",
                        fontWeight: 700,
                        padding: "2px 8px",
                        borderRadius: "4px",
                        background: REGIME_STYLES[sig.signal]?.bg ?? T.surface,
                        color: sigColor,
                        border: `1px solid ${REGIME_STYLES[sig.signal]?.border ?? T.border}`,
                        minWidth: "60px",
                        textAlign: "center",
                        whiteSpace: "nowrap",
                      }}>
                        {sig.signal === "green" ? "🟢" : sig.signal === "yellow" ? "🟡" : sig.signal === "orange" ? "🟠" : "🔴"} {sig.signal.toUpperCase()}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* How to interpret (collapsible) */}
          <button
            onClick={() => setMacroShowExplain((s) => !s)}
            style={{
              background: "transparent",
              border: "none",
              color: T.muted,
              fontSize: "11px",
              cursor: "pointer",
              padding: "0",
              display: "flex",
              alignItems: "center",
              gap: "4px",
            }}
          >
            {macroShowExplain ? "▾" : "▸"} How to interpret
          </button>
          {macroShowExplain && (
            <div style={{ marginTop: "10px", background: T.surface, borderRadius: "8px", padding: "12px 14px", fontSize: "12px", color: T.textSub, lineHeight: "1.7" }}>
              <div style={{ marginBottom: "6px", fontWeight: 600, color: T.text }}>Scoring Methodology</div>
              <div>Danger Score = weighted average of 8 indicators. Each indicator is scored GREEN/YELLOW/ORANGE/RED and weighted by predictive reliability (HIGH=3, MEDIUM=2, LOW=1).</div>
              <div style={{ marginTop: "8px" }}>
                <span style={{ color: "#34D399", fontWeight: 600 }}>0–20 GREEN:</span> Expansion. Economy healthy. No action needed.<br />
                <span style={{ color: "#FBBF24", fontWeight: 600 }}>20–40 YELLOW:</span> Caution. 1–2 weak signals. Monitor closely.<br />
                <span style={{ color: "#FB923C", fontWeight: 600 }}>40–60 ORANGE:</span> Warning. Multiple signals. Consider reducing exposure.<br />
                <span style={{ color: "#F87171", fontWeight: 600 }}>60+ RED:</span> Danger. Recession likely or in progress. Defensive positioning.
              </div>
              <div style={{ marginTop: "8px", color: T.muted, fontStyle: "italic" }}>
                Advisory only — this does not auto-adjust agent behavior. You decide whether to act.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── End Macro Sentinel Card ─────────────────────────────────────────────────

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
  const router = useRouter();
  const [data, setData] = useState<MarketOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [slowFetch, setSlowFetch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<string | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [showRecessions, setShowRecessions] = useState(false);

  async function fetchMarkets() {
    setLoading(true);
    setSlowFetch(false);
    setError(null);
    // After 10s without data, surface a "fetching live data…" note instead of blank spinner
    const slowTimer = setTimeout(() => setSlowFetch(true), 10_000);
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
      clearTimeout(slowTimer);
      setLoading(false);
      setSlowFetch(false);
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
    <div style={{ color: T.text, fontFamily: "'Inter', sans-serif" }}>
      <PageHeader
        title="Markets"
        subtitle="Live indices, sector rotation, and VIX proxy"
        cadence="daily"
        whatItDoes="Shows S&P 500, Nasdaq, Dow, and VIX proxy (VIXY) plus all 11 S&P sector ETF performances. Data refreshes every 5 minutes during market hours."
        whatToLookFor={[
          "Red sectors = risk-off rotation. Green sectors = risk-on. Note which sectors lead.",
          "VIXY > $20 = elevated volatility / fear — consider sizing down new entries.",
          "If S&P and Nasdaq diverge, tech is driving or lagging — check XLK.",
          "Sector strength tells you which bucket (momentum vs value) is working this week.",
        ]}
      />
      <div style={{ padding: "0 28px 28px" }}>
      {/* Header (legacy — kept for refresh button) */}
      <div style={{ marginBottom: "24px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px" }}>
          <div />
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

      {/* Loading skeleton — show slow-fetch note after 10s */}
      {loading && !data && (
        <>
          <LoadingSkeleton />
          {slowFetch && (
            <div style={{ textAlign: "center", marginTop: "16px", fontSize: "12px", color: T.muted }}>
              Fetching live quotes from Robinhood via AI subprocess — may take up to 90s on first load…
            </div>
          )}
        </>
      )}

      {/* Data loaded */}
      {data && (
        <>
          {/* Index bar */}
          <div style={{ display: "flex", gap: "12px", marginBottom: "16px", flexWrap: "wrap" }}>
            {data.indices.map(q => (
              <div
                key={q.symbol}
                onClick={() => router.push(`/dashboard/symbol/${q.symbol}`)}
                style={{ cursor: "pointer" }}
              >
                <IndexCard q={q} />
              </div>
            ))}
          </div>

          {/* Inline price chart for selected index */}
          {selectedSymbol && (
            <div style={{ background: "#1A1D27", border: "1px solid #252836", borderRadius: "12px", padding: "20px", marginBottom: "16px" }}>
              {/* Recession overlay toggle */}
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "8px" }}>
                <button
                  onClick={() => setShowRecessions(r => !r)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    padding: "5px 12px",
                    borderRadius: "6px",
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: "pointer",
                    border: `1px solid ${showRecessions ? "#F87171" : "#252836"}`,
                    background: showRecessions ? "#3B000080" : "#13151C",
                    color: showRecessions ? "#F87171" : "#6B7280",
                    transition: "all 0.15s",
                  }}
                >
                  <span style={{ fontSize: "9px" }}>■</span>
                  Show Recessions
                </button>
              </div>
              <Suspense fallback={<div style={{ color: "#6B7280", fontSize: "13px" }}>Loading chart…</div>}>
                <PriceChart symbol={selectedSymbol} height={260} showRecessions={showRecessions} />
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

      {/* Sector charts — render immediately from Supabase cache, no dependency on live quotes */}
      <div style={{ marginTop: "16px" }}>
        <Suspense fallback={
          <div style={{ background: "#1A1D27", border: "1px solid #252836", borderRadius: "12px", padding: "20px", height: "420px", display: "flex", alignItems: "center", justifyContent: "center", color: "#6B7280", fontSize: "13px" }}>
            Loading sector performance…
          </div>
        }>
          <SectorPerformanceChart />
        </Suspense>
      </div>

      <div style={{ marginTop: "16px" }}>
        <Suspense fallback={
          <div style={{ height: "460px", background: T.surface, borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", color: "#6B7280", fontSize: "13px" }}>
            Loading sector line chart…
          </div>
        }>
          <SectorLineChart />
        </Suspense>
      </div>

      {/* Sector breadth */}
      <div style={{ marginTop: "16px" }}>
        <Suspense fallback={
          <div style={{ height: "300px", background: T.surface, borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", color: "#6B7280", fontSize: "13px" }}>
            Loading sector breadth…
          </div>
        }>
          <SectorBreadth />
        </Suspense>
      </div>

      {/* Sentiment pairs */}
      <div style={{ marginTop: "16px" }}>
        <SentimentPairs />
      </div>

      {/* Market thesis */}
      <div style={{ marginTop: "16px", marginBottom: "32px" }}>
        <MarketThesis />
      </div>

      {/* Macro Recession Sentinel */}
      <div style={{ marginTop: "16px", marginBottom: "16px" }}>
        <MacroSentinelCard />
      </div>

      {/* Smart Money Trades */}
      <div style={{ marginTop: "16px", marginBottom: "32px" }}>
        <SmartMoneyTrades />
      </div>
      </div>
    </div>
  );
}
