"use client";

import { useEffect, useState, useRef, useCallback, lazy, Suspense } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/dashboard/PageHeader";
import { useMarket, CURRENCY } from "@/lib/market-context";
// India market data is fetched from the server route /api/markets/india — the
// browser NEVER calls Yahoo/NSE directly. `import type` is erased at build, so no
// provider hostname or adapter code lands in the client bundle.
import type { IndiaMarketsSnapshot } from "@/lib/india-markets/snapshot";
import SectorTradingViewOverview from "@/components/charts/SectorTradingViewOverview";
import SectorTreemap from "@/components/charts/SectorTreemap";
const PriceChart = lazy(() => import("@/components/charts/PriceChart"));
const SectorPerformanceChart = lazy(() => import("@/components/charts/SectorPerformanceChart"));
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

// Mirrors the contract in app/api/markets/overview/route.ts. `price`/`change`/
// `changePct` are nullable BY DESIGN: an unresolved symbol must be impossible to
// render as a real number, so there is no 0 for it to masquerade as.
interface IndexQuote {
  symbol: string;
  name: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
  status?: "ok" | "unavailable";
  reason?: string;
}

interface SectorQuote {
  symbol: string;
  name: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
  status?: "ok" | "unavailable";
  reason?: string;
}

interface MarketOverview {
  indices: IndexQuote[];
  sectors: SectorQuote[];
  /** ET date of the session these closes belong to. */
  sessionDate: string | null;
  /** ET date of the session the change is measured against. */
  priorCloseDate: string | null;
  /** When the server fetched upstream — the real age of the data. */
  fetchedAt: string;
  stale: boolean;
  unavailableCount: number;
  degraded?: string;
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

// A null value renders as a neutral "n/a" chip — never a green +0.00%, which is
// indistinguishable from a genuinely flat sector.
function PctPill({ value }: { value: number | null }) {
  if (value == null) {
    return (
      <span
        style={{
          fontSize: "12px",
          fontWeight: 700,
          fontFamily: "'JetBrains Mono', monospace",
          padding: "2px 7px",
          borderRadius: "5px",
          background: T.surface,
          border: `1px dashed ${T.border}`,
          color: T.muted,
        }}
      >
        n/a
      </span>
    );
  }
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

function IndexCard({ q, currency = "" }: { q: IndexQuote; currency?: string }) {
  const isVIX = q.symbol === "VIX" || q.symbol === "^INDIAVIX" || /vix/i.test(q.name);
  const unavailable = q.status === "unavailable" || q.changePct == null;
  const color = unavailable
    ? T.border
    : isVIX
      ? q.changePct! >= 0 ? T.red : T.green   // VIX up = bad
      : pctColor(q.changePct!);

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
      <div style={{ fontSize: "26px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "-0.02em", color: unavailable ? T.muted : T.text }}>
        {q.price != null && q.price > 0 ? `${isVIX ? "" : currency}${fmt(q.price)}` : "—"}
      </div>
      {q.change == null ? (
        <div style={{ fontSize: "11px", color: T.muted, marginTop: "4px" }}>
          {q.reason ?? "unavailable"}
        </div>
      ) : (
        <div style={{ fontSize: "12px", color: pctColor(q.change), fontFamily: "'JetBrains Mono', monospace", marginTop: "4px" }}>
          {q.change >= 0 ? "+" : ""}{fmt(q.change)} vs prior close
        </div>
      )}
    </div>
  );
}

// `onSymbol` is OPTIONAL and the "click to view chart" affordance appears only
// when it is supplied. India passes nothing: /api/charts/price-history resolves
// through fetchUsCandles, which cannot price NSE index symbols (^CNXIT, ^NSEBANK
// …), so a wired click there would open a permanently empty chart — trading one
// silent lie for another. See docs/arch/07-coding-conventions.md.
function SectorHeatmap({ sectors, onSymbol }: { sectors: SectorQuote[]; onSymbol?: (sym: string) => void }) {
  // Unresolved sectors sort last rather than being treated as 0% (flat).
  const sorted = [...sectors].sort((a, b) => {
    if (a.changePct == null) return 1;
    if (b.changePct == null) return -1;
    return b.changePct - a.changePct;
  });

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
        Sector Performance{onSymbol ? " · click to view chart" : ""}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "8px" }}>
        {sorted.map(s => {
          const unavailable = s.status === "unavailable" || s.changePct == null;
          return (
          <div
            key={s.symbol}
            onClick={onSymbol && !unavailable ? () => onSymbol(s.symbol) : undefined}
            style={{
              background: unavailable ? T.surface : pctBg(s.changePct!),
              border: unavailable
                ? `1px dashed ${T.border}`
                : `1px solid ${s.changePct! >= 0 ? T.green : T.red}30`,
              borderRadius: "8px",
              padding: "12px 14px",
              cursor: onSymbol && !unavailable ? "pointer" : "default",
              transition: "opacity 0.15s",
            }}
            onMouseEnter={e => { if (onSymbol && !unavailable) e.currentTarget.style.opacity = "0.8"; }}
            onMouseLeave={e => (e.currentTarget.style.opacity = "1")}
          >
            <div style={{ fontSize: "11px", color: T.textSub, marginBottom: "4px" }}>{s.name}</div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "12px", fontWeight: 700, color: unavailable ? T.muted : T.accent }}>
                {s.symbol}{onSymbol && !unavailable ? " ↗" : ""}
              </span>
              {unavailable ? (
                <span style={{ fontSize: "11px", fontWeight: 600, color: T.muted }}>n/a</span>
              ) : (
                <span
                  style={{
                    fontSize: "13px",
                    fontWeight: 700,
                    fontFamily: "'JetBrains Mono', monospace",
                    color: pctColor(s.changePct!),
                  }}
                >
                  {s.changePct! >= 0 ? "+" : ""}{fmt(s.changePct!, 2)}%
                </span>
              )}
            </div>
          </div>
          );
        })}
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
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "10px" }}>
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

// ─── Market Synthesis + Regime Indicators ────────────────────────────────────

interface SynthIndicator {
  label: string;
  symbol: string;
  price: number | null;
  changePct: number | null;
  note: string;
}

interface SynthData {
  regime: "risk-on" | "neutral" | "risk-off" | "unknown";
  indicators: SynthIndicator[];
  synthesis: string;
  generatedAt: string | null;
}

const REGIME_CHIP: Record<string, { bg: string; color: string; border: string; label: string }> = {
  "risk-on":  { bg: T.greenBg, color: T.green, border: "#065F46", label: "RISK-ON" },
  "neutral":  { bg: "#2D2000", color: T.amber, border: "#5B3A00", label: "NEUTRAL" },
  "risk-off": { bg: T.redBg,  color: T.red,   border: "#5B0000", label: "RISK-OFF" },
  "unknown":  { bg: T.surface, color: T.muted, border: T.border, label: "INSUFFICIENT DATA" },
};

function MarketSynthesis() {
  const [data, setData] = useState<SynthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function load(force = false) {
    if (force) setRefreshing(true); else setLoading(true);
    try {
      const url = force ? "/api/markets/synthesis?force=true" : "/api/markets/synthesis";
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        setData({
          regime: json.signalsAvailable > 0 ? (json.regime ?? "neutral") : "unknown",
          indicators: json.indicators ?? [],
          synthesis: json.synthesis ?? "",
          generatedAt: json.generatedAt ?? null,
        });
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
    if (diff < 60) return `${diff} min ago`;
    const hrs = Math.floor(diff / 60);
    return hrs === 1 ? "1 hr ago" : `${hrs} hrs ago`;
  }

  const chip = data ? REGIME_CHIP[data.regime] ?? REGIME_CHIP.unknown : REGIME_CHIP.unknown;

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
        <div>
          <div style={{ fontSize: "11px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "2px" }}>
            Market Synthesis · regime read across asset classes
          </div>
          <div style={{ fontSize: "11px", color: T.muted }}>
            Equities, credit, rates, dollar, gold & volatility → one risk-regime call
            {data?.generatedAt && !loading ? ` · generated ${minutesAgo(data.generatedAt)}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          {data && !loading && (
            <span style={{
              padding: "5px 12px",
              borderRadius: "8px",
              background: chip.bg,
              border: `1px solid ${chip.border}`,
              color: chip.color,
              fontSize: "12px",
              fontWeight: 700,
              letterSpacing: "0.06em",
              whiteSpace: "nowrap",
            }}>
              {chip.label}
            </span>
          )}
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
      </div>

      {loading && (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "10px" }}>
            {[...Array(8)].map((_, i) => (
              <div key={i} style={{ height: "78px", background: T.surface, borderRadius: "10px", animation: "pulse 1.5s ease-in-out infinite" }} />
            ))}
          </div>
          <div style={{ height: "60px", background: T.surface, borderRadius: "8px", animation: "pulse 1.5s ease-in-out infinite" }} />
        </div>
      )}

      {!loading && data && (
        <>
          {/* Indicator tiles */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "10px", marginBottom: "16px" }}>
            {data.indicators.map((ind) => {
              const pct = ind.changePct;
              const color = pct === null ? T.muted : pct > 0 ? T.green : pct < 0 ? T.red : T.muted;
              // For safe-haven / risk-off proxies, up move is not "good" — but we keep
              // signed color literal (green=up, red=down) and let the note explain meaning.
              return (
                <div
                  key={ind.symbol + ind.label}
                  style={{
                    background: T.surface,
                    border: `1px solid ${T.border}`,
                    borderRadius: "10px",
                    padding: "12px 14px",
                    borderTop: `3px solid ${color}`,
                    minWidth: 0,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "6px", marginBottom: "6px" }}>
                    <span style={{ fontSize: "11px", color: T.textSub, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {ind.label}
                    </span>
                    <span style={{ fontSize: "11px", fontWeight: 700, color: T.accent, fontFamily: "'JetBrains Mono', monospace", flexShrink: 0 }}>
                      {ind.symbol}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "8px" }}>
                    <span style={{ fontSize: "16px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: T.text }}>
                      {ind.price !== null ? `$${fmt(ind.price)}` : "—"}
                    </span>
                    <span style={{ fontSize: "13px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color }}>
                      {pct !== null ? `${pct >= 0 ? "+" : ""}${fmt(pct, 2)}%` : "—"}
                    </span>
                  </div>
                  <div style={{ fontSize: "10px", color: T.muted, lineHeight: "1.4" }}>
                    {ind.note}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Synthesis paragraph */}
          {data.synthesis && (
            <div style={{
              background: T.surface,
              border: `1px solid ${T.border}`,
              borderRadius: "10px",
              padding: "14px 16px",
              fontSize: "13px",
              lineHeight: "1.7",
              color: T.textSub,
              whiteSpace: "pre-wrap",
            }}>
              {renderThesisText(data.synthesis)}
            </div>
          )}
        </>
      )}

      {!loading && !data && (
        <div style={{ fontSize: "13px", color: T.muted }}>
          Synthesis unavailable — regime indicator data could not be fetched.
        </div>
      )}
    </div>
  );
}

// ─── End Market Synthesis ────────────────────────────────────────────────────

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

// Per-tab load outcome. `ok` still covers "loaded fine and there genuinely are no
// rows" — which is NOT the same thing as a source that could not be read at all.
// Keeping them apart is the whole point: an empty box means "nobody traded", a
// note means "we could not see whether anybody traded".
type FeedState =
  | { kind: "ok" }
  | { kind: "failed"; detail: string }
  | { kind: "discontinued"; reason: string; detail: string };

function SmartMoneyTrades() {
  const [trades, setTrades] = useState<InsiderTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"insider" | "congress">("insider");
  const [showAll, setShowAll] = useState(false);
  const [insiderState, setInsiderState] = useState<FeedState>({ kind: "ok" });
  const [congressState, setCongressState] = useState<FeedState>({ kind: "ok" });

  useEffect(() => {
    // allSettled, not all: the two feeds are independent sources. A failure of one
    // must not blank the other, and must not collapse into a shared silent catch.
    Promise.allSettled([
      fetch("/api/markets/edgar-insiders").then((r) => r.json()),
      fetch("/api/markets/insider-trades").then((r) => r.json()),
    ])
      .then(([edgarRes, congressRes]) => {
        let rows: InsiderTrade[] = [];

        if (edgarRes.status === "fulfilled") {
          rows = rows.concat(
            (edgarRes.value?.transactions ?? [])
              .filter((t: any) => t.transactionType === "buy" || t.transactionType === "sell")
              .map((t: any) => ({
                symbol: t.symbol,
                name: t.name,
                type: t.transactionType,
                value: Number(t.value) || 0,
                shares: Number(t.shares) || 0,
                date: t.date,
                filer: t.name,
                role: "insider" as const,
                title: t.role,
              })),
          );
          setInsiderState({ kind: "ok" });
        } else {
          setInsiderState({
            kind: "failed",
            detail: `the SEC Form 4 feed could not be read (${String(edgarRes.reason).slice(0, 120)})`,
          });
        }

        if (congressRes.status === "fulfilled") {
          const c = congressRes.value ?? {};
          // The route reports a permanent `discontinued` state rather than an
          // empty list, so the panel can say WHY instead of rendering a bare box.
          if (c.status === "discontinued") {
            setCongressState({
              kind: "discontinued",
              reason: c.reason ?? "upstream discontinued",
              detail: c.detail ?? "the congressional data source is no longer available",
            });
          } else {
            rows = rows.concat(c.trades ?? []);
            setCongressState({ kind: "ok" });
          }
        } else {
          setCongressState({
            kind: "failed",
            detail: `the congressional feed could not be read (${String(congressRes.reason).slice(0, 120)})`,
          });
        }

        setTrades(rows);
      })
      .finally(() => setLoading(false));
  }, []);

  const tabState = tab === "insider" ? insiderState : congressState;

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

      {/* Source is gone for good — say so, and do NOT offer a retry. */}
      {!loading && tabState.kind === "discontinued" && (
        <DiscontinuedNote label="Congressional trade disclosures" reason={tabState.reason} detail={tabState.detail} />
      )}

      {/* Source exists but this fetch failed — transient, retry is honest here. */}
      {!loading && tabState.kind === "failed" && (
        <TempUnavailableNote
          label={tab === "insider" ? "Insider trades" : "Congressional trades"}
          detail={tabState.detail}
          onRetry={() => window.location.reload()}
        />
      )}

      {/* Genuinely empty: the feed was read and reported nothing. */}
      {!loading && tabState.kind === "ok" && visible.length === 0 && (
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
                  wordBreak: "break-word",
                }}
                title={t.filer || t.name || ""}
              >
                {t.filer || t.name || "—"}
              </span>

              {/* Title/role */}
              {t.title && (
                <span
                  style={{
                    fontSize: "11px",
                    color: T.muted,
                    flex: "0 1 120px",
                    wordBreak: "break-word",
                  }}
                  title={t.title}
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
  regime: "green" | "yellow" | "orange" | "red" | "unknown";
  signals_triggered: number;
  summary: string | null;
}

const REGIME_STYLES: Record<string, { bg: string; color: string; border: string }> = {
  green:   { bg: "#0d2218", color: "#34D399", border: "#1a3a24" },
  yellow:  { bg: "#1a1500", color: "#FBBF24", border: "#3a2e00" },
  orange:  { bg: "#2a1000", color: "#FB923C", border: "#3a2000" },
  red:     { bg: "#2a0000", color: "#F87171", border: "#3a0000" },
  unknown: { bg: "#1a1a1a", color: "#9B9EA8", border: "#2a2a2a" },
};

const SIGNAL_COLORS: Record<string, string> = {
  green:  "#34D399",
  yellow: "#FBBF24",
  orange: "#FB923C",
  red:    "#F87171",
};

// Agent Mind Phase 3 — plain-English read of what the current macro backdrop
// means for the current book. Advisory only; generated at most once/day.
function MacroReadCard({ market }: { market: "us" | "india" }) {
  const [read, setRead] = useState<{ content: string; created_at: string } | null>(null);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  // Guards the one-shot self-heal so a persistently-stale read (e.g. no macro
  // regime data yet) doesn't POST on every re-render. Reset when the market flips.
  const autoTried = useRef(false);

  async function load() {
    setLoading(true);
    let isStale = false;
    try {
      const res = await fetch(`/api/agent-mind/macro-read?market=${market}`);
      if (res.ok) { const d = await res.json(); setRead(d.interpretation ?? null); isStale = !!d.stale; setStale(isStale); }
    } catch {}
    setLoading(false);
    // Self-heal: if today's read hasn't been generated yet, regenerate it once so
    // the card is never frozen showing a previous day's text. Advisory-only and
    // cached per day, so at most one cheap LLM call per viewer per day.
    if (isStale && !autoTried.current) {
      autoTried.current = true;
      await generate();
    }
  }
  async function generate() {
    setRunning(true);
    try {
      const res = await fetch(`/api/agent-mind/macro-read?market=${market}&force=1`, { method: "POST" });
      if (res.ok) await load();
    } catch {}
    setRunning(false);
  }
  useEffect(() => { autoTried.current = false; load(); }, [market]);

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", flexWrap: "wrap", gap: "10px" }}>
        <div>
          <div style={{ fontSize: "14px", fontWeight: 700, color: T.text }}>What this means for your book</div>
          <div style={{ fontSize: "12px", color: T.muted }}>Macro regime + your holdings + the system's macro beliefs → plain-English read (advisory only)</div>
        </div>
        <button onClick={generate} disabled={running} style={{ background: running ? T.border : "transparent", border: `1px solid ${T.accent}`, borderRadius: "8px", color: T.accent, padding: "7px 14px", fontSize: "12px", fontWeight: 600, cursor: running ? "not-allowed" : "pointer" }}>{running ? "Generating…" : read ? "Regenerate" : "Generate"}</button>
      </div>
      {loading ? (
        <div style={{ color: T.muted, fontSize: "13px" }}>Loading…</div>
      ) : read ? (
        <>
          <div style={{ fontSize: "13px", color: T.textSub, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{read.content}</div>
          <div style={{ fontSize: "11px", color: T.muted, marginTop: "10px" }}>{stale ? "From a previous day — click Regenerate for today. " : ""}Generated {new Date(read.created_at).toLocaleString()}</div>
        </>
      ) : (
        <div style={{ color: T.muted, fontSize: "13px" }}>No read yet — click Generate. Needs macro data + at least the current regime.</div>
      )}
    </div>
  );
}

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
  const isUnknown = regime === "unknown";
  const regStyle = REGIME_STYLES[regime] ?? REGIME_STYLES.green;
  const dangerScore = latest?.danger_score ?? 0;
  const dangerColor = isUnknown
    ? T.muted
    : dangerScore < 20 ? "#34D399" : dangerScore < 40 ? "#FBBF24" : dangerScore < 60 ? "#FB923C" : "#F87171";

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
                  {isUnknown ? "—/100" : `${dangerScore}/100`}
                </span>
              </div>
              <div style={{ height: 8, borderRadius: 4, background: "#1E2130", width: "100%", overflow: "hidden" }}>
                <div style={{ height: "100%", width: isUnknown ? "100%" : `${dangerScore}%`, background: isUnknown ? "repeating-linear-gradient(45deg, #2a2a2a, #2a2a2a 6px, #1E2130 6px, #1E2130 12px)" : dangerColor, borderRadius: 4, transition: "width 0.5s" }} />
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
              {isUnknown ? "❓" : regime === "green" ? "🟢" : regime === "yellow" ? "🟡" : regime === "orange" ? "🟠" : "🔴"} {isUnknown ? "UNKNOWN" : regime.toUpperCase()}
              <span style={{ fontWeight: 400, fontSize: "11px", marginLeft: "8px", opacity: 0.8 }}>
                {isUnknown ? "(insufficient data)" : `(${latest?.signals_triggered ?? 0} signal${latest?.signals_triggered !== 1 ? "s" : ""})`}
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

// ─── India Markets (server-snapshot driven) ─────────────────────────────────
//
// All India tiles read ONE frozen snapshot from /api/markets/india (server-side,
// allowlisted, paced, cached). Product states are explicit and honest:
//   loading → bounded skeleton (always exits on timeout/error)
//   complete/partial → available rows + explicit coverage (never a fake total)
//   temporarily_unavailable → capability exists but failed/staled
//   not_supported → no India equivalent (structural gap; never synthesized)
//   discontinued → capability retired: the upstream is permanently gone and no
//                  licence-clean replacement exists. Never offers a retry.

// A capability that exists for India but currently failed or staled out. Distinct
// from `NotSupportedNote` (a structural absence) — different meaning, different UI.
function TempUnavailableNote({ label, detail, onRetry }: { label: string; detail?: string; onRetry?: () => void }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.amber}30`, borderRadius: "12px", padding: "18px 20px", fontSize: "12px", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
      <span style={{ fontSize: "10px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "2px 8px", borderRadius: "5px", background: "#2D2000", border: `1px solid ${T.amber}40`, color: T.amber }}>Temporarily unavailable</span>
      <span style={{ color: T.textSub }}>{label}{detail ? ` — ${detail}` : ""}</span>
      {onRetry && (
        <button onClick={onRetry} style={{ marginLeft: "auto", padding: "5px 12px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "7px", color: T.text, fontSize: "12px", fontWeight: 500, cursor: "pointer" }}>Retry</button>
      )}
    </div>
  );
}

// A structural gap — there is no approved free India equivalent for this US-only
// surface. NOT a transient failure; never synthesized.
function NotSupportedNote({ label }: { label: string }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "18px 20px", color: T.muted, fontSize: "12px", display: "flex", alignItems: "center", gap: "8px" }}>
      <span style={{ fontSize: "10px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "2px 8px", borderRadius: "5px", background: T.surface, border: `1px solid ${T.border}`, color: T.textSub }}>Not supported</span>
      {label} has no approved India equivalent — US only.
    </div>
  );
}

// A capability that has been RETIRED: its upstream is permanently gone and no
// licence-clean replacement qualified. Distinct from `TempUnavailableNote` (which
// implies "try again") and from `NotSupportedNote` (which is about a market that
// never had the data). Deliberately has no retry button — a retry against a dead
// source would be a lie. Carries what/why/next so the panel is never a bare box.
function DiscontinuedNote({ label, reason, detail }: { label: string; reason: string; detail: string }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "18px 20px", fontSize: "12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "8px" }}>
        <span style={{ fontSize: "10px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "2px 8px", borderRadius: "5px", background: T.surface, border: `1px solid ${T.border}`, color: T.textSub }}>Discontinued</span>
        <span style={{ color: T.text, fontWeight: 500 }}>{label} — {reason}</span>
      </div>
      <div style={{ color: T.muted, lineHeight: 1.6 }}>{detail}</div>
    </div>
  );
}

function snapRowToQuote(r: IndiaMarketsSnapshot["indices"][number]): IndexQuote {
  return { symbol: r.symbol, name: r.label, price: r.price, change: (r.price * r.changePct) / 100, changePct: r.changePct };
}

// NIFTY-50 breadth from the snapshot. Honest: shows advanced/declined over the
// RESOLVED names and always discloses resolvedN/eligibleN coverage. Labeled
// "partial coverage" below the coverage floor — never presented as a full total.
function IndiaBreadthBlock({ breadth }: { breadth: NonNullable<IndiaMarketsSnapshot["breadth"]> }) {
  const decided = breadth.advanced + breadth.declined;
  const upPct = decided > 0 ? (breadth.advanced / decided) * 100 : 50;
  const partial = breadth.quality === "partial";
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: "6px", marginBottom: "16px" }}>
        <span style={{ fontSize: "11px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em" }}>
          NIFTY-50 breadth · advancers vs decliners
        </span>
        <span style={{ fontSize: "10px", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", padding: "2px 8px", borderRadius: "5px", background: partial ? "#2D2000" : T.surface, border: `1px solid ${partial ? T.amber + "40" : T.border}`, color: partial ? T.amber : T.textSub }}>
          {partial ? "Below coverage floor" : "Coverage floor met"}
        </span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <span style={{ fontSize: "13px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: T.green }}>{breadth.advanced} up</span>
        <span style={{ fontSize: "13px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: T.red }}>{breadth.declined} down</span>
      </div>
      <div style={{ display: "flex", height: "10px", borderRadius: "5px", overflow: "hidden", background: T.surface }}>
        <div style={{ width: `${upPct}%`, background: T.green }} />
        <div style={{ width: `${100 - upPct}%`, background: T.red }} />
      </div>
      <div style={{ fontSize: "11px", color: T.muted, marginTop: "10px" }}>
        {breadth.resolvedN}/{breadth.eligibleN} constituents resolved ({breadth.coveragePct}% coverage)
        {breadth.unchanged > 0 ? ` · ${breadth.unchanged} unchanged` : ""}
        {breadth.unavailable > 0 ? ` · ${breadth.unavailable} unavailable` : ""}
        {" · membership as of "}{breadth.universeAsOf}
      </div>
    </div>
  );
}

export default function MarketsPage() {
  const router = useRouter();
  const { market } = useMarket();
  const isIndia = market === "india";
  const [data, setData] = useState<MarketOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [slowFetch, setSlowFetch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<string | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [showRecessions, setShowRecessions] = useState(false);
  // India markets snapshot — fetched from the server route (never Yahoo directly).
  // `indiaState` drives the explicit product states; loading ALWAYS exits (bounded
  // by a client-side abort timeout as well as the server's own bounded fetch).
  const [indiaSnap, setIndiaSnap] = useState<IndiaMarketsSnapshot | null>(null);
  const indiaSnapRef = useRef<IndiaMarketsSnapshot | null>(null);
  const [indiaState, setIndiaState] = useState<"loading" | "ready" | "unavailable">("loading");

  const loadIndia = useCallback(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000); // hard bound — loading must exit
    setIndiaState("loading");
    fetch("/api/markets/india", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: IndiaMarketsSnapshot) => {
        indiaSnapRef.current = j;
        setIndiaSnap(j);
        setIndiaState(j.status === "unavailable" ? "unavailable" : "ready");
      })
      .catch(() => setIndiaState(indiaSnapRef.current ? "ready" : "unavailable"))
      .finally(() => clearTimeout(timer));
    return () => { ctrl.abort(); clearTimeout(timer); };
  }, []);

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
      // The server's own fetch time, NOT the browser clock — a 5-min cached
      // payload previously always read "fresh" because this stamped the moment
      // the response arrived rather than the age of the data inside it.
      setLastFetch(json.fetchedAt ? new Date(json.fetchedAt).toLocaleTimeString() : null);
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

  // When India is selected, load the server snapshot and refresh every 5 min.
  // The server route handles all provider access, pacing, caching, and provenance.
  useEffect(() => {
    if (!isIndia) return;
    const cleanup = loadIndia();
    const iv = setInterval(loadIndia, 5 * 60 * 1000);
    return () => { cleanup(); clearInterval(iv); };
  }, [isIndia, loadIndia]);

  return (
    <div style={{ color: T.text, fontFamily: "'Inter', sans-serif" }}>
      <PageHeader
        title={isIndia ? "Markets · India" : "Markets"}
        subtitle={isIndia
          ? "NIFTY 50, SENSEX, BANK NIFTY, India VIX, NSE sector indices & breadth (₹)"
          : "End-of-day indices, sector rotation, and VIX proxy"}
        cadence="daily"
        whatItDoes={isIndia
          ? "Shows NIFTY 50, SENSEX, BANK NIFTY and India VIX plus 10 NSE sector indices and NIFTY-50 market breadth. India data comes from a server-side snapshot (Yahoo .NS, unofficial) refreshed on a schedule — advisory display only."
          : "Shows S&P 500, Nasdaq, Dow, and VIX proxy (VIXY) plus all 11 S&P sector ETF performances. Each move is the latest completed session's close against the prior session's close — an end-of-day figure from Massive, not an intraday quote, so it does not move during the trading day."}
        whatToLookFor={isIndia ? [
          "Red sectors = risk-off rotation. Green sectors = risk-on. Note which NSE sectors lead.",
          "India VIX rising = elevated volatility / fear — consider sizing down new entries.",
          "NIFTY vs BANK NIFTY divergence tells you whether financials are leading or lagging.",
          "Breadth shows how many of the NIFTY-50 are advancing — check coverage before reading it.",
        ] : [
          "Red sectors = risk-off rotation. Green sectors = risk-on. Note which sectors lead.",
          "VIXY > $20 = elevated volatility / fear — consider sizing down new entries.",
          "If S&P and Nasdaq diverge, tech is driving or lagging — check XLK.",
          "Sector strength tells you which bucket (momentum vs value) is working this week.",
        ]}
      />
      <div style={{ padding: "clamp(12px, 4vw, 28px)" }}>
      {/* Header (legacy — kept for refresh button) */}
      <div style={{ marginBottom: "24px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px" }}>
          <div />
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            {!isIndia && lastFetch && (
              <span style={{ fontSize: "12px", color: T.muted }}>Data fetched {lastFetch}</span>
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

      {/* Loading skeleton — show slow-fetch note after 10s (US only) */}
      {!isIndia && loading && !data && (
        <>
          <LoadingSkeleton />
          {/* Must describe the fetch that is ACTUALLY running. This previously
              named the broker and an AI subprocess as the source and called the
              result intraday: all three were false. The route calls Massive's
              grouped-daily endpoint, no broker and no subprocess are involved,
              and the closes are end-of-day — so this must never say "live".
              Pinned by tests/markets-overview.test.ts. */}
          {slowFetch && (
            <div style={{ textAlign: "center", marginTop: "16px", fontSize: "12px", color: T.muted }}>
              Fetching end-of-day closes from Massive — resolving the latest published session…
            </div>
          )}
        </>
      )}

      {/* Market Synthesis — US regime read across asset classes (fetches independently) */}
      {!isIndia && (
        <div style={{ marginBottom: "16px" }}>
          <MarketSynthesis />
        </div>
      )}

      {/* India — server-snapshot driven. Explicit product states; loading is
          bounded and always exits (client abort + server-side bounded fetch). */}
      {isIndia && (
        <>
          {/* loading */}
          {indiaState === "loading" && !indiaSnap && (
            <div style={{ display: "flex", gap: "12px", marginBottom: "16px", flexWrap: "wrap" }}>
              {[...Array(4)].map((_, i) => (
                <div key={i} style={{ flex: "1 1 180px", minWidth: 0, height: "110px", background: T.card, borderRadius: "12px", border: `1px solid ${T.border}`, animation: "pulse 1.5s ease-in-out infinite" }} />
              ))}
            </div>
          )}

          {/* temporarily_unavailable — capability exists but the fetch failed/staled */}
          {indiaState === "unavailable" && (
            <div style={{ marginBottom: "16px" }}>
              <TempUnavailableNote
                label="India market data"
                detail="the snapshot could not be fetched or has no rows yet"
                onRetry={loadIndia}
              />
            </div>
          )}

          {/* complete / partial */}
          {indiaState === "ready" && indiaSnap && (
            <>
              {indiaSnap.status === "partial" && (
                <div style={{ marginBottom: "12px", fontSize: "11px", color: T.amber, background: "#2D2000", border: `1px solid ${T.amber}30`, borderRadius: "8px", padding: "8px 12px" }}>
                  Partial data — some India components did not resolve this fetch. Available rows are shown with explicit coverage below; no healthy-looking total is implied.
                </div>
              )}

              {/* Index bar (non-clickable — no per-symbol India page) */}
              {indiaSnap.indices.length > 0 ? (
                <div style={{ display: "flex", gap: "12px", marginBottom: "16px", flexWrap: "wrap" }}>
                  {indiaSnap.indices.map((r) => (
                    <div key={r.symbol}>
                      <IndexCard q={snapRowToQuote(r)} currency={CURRENCY.india} />
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ marginBottom: "16px" }}>
                  <TempUnavailableNote label="India index quotes" detail="no index rows resolved this fetch" onRetry={loadIndia} />
                </div>
              )}

              {/* Sector heatmap */}
              <div style={{ marginBottom: "16px" }}>
                {indiaSnap.sectors.length > 0 ? (
                  <SectorHeatmap
                    sectors={indiaSnap.sectors.map((r) => ({ symbol: r.symbol, name: r.label, price: r.price, change: (r.price * r.changePct) / 100, changePct: r.changePct, status: "ok" as const }))}
                  />
                ) : (
                  <TempUnavailableNote label="India sector rotation" detail="no NSE sector rows resolved this fetch" onRetry={loadIndia} />
                )}
              </div>

              {/* NIFTY-50 breadth */}
              <div style={{ marginBottom: "16px" }}>
                {indiaSnap.breadth ? (
                  <IndiaBreadthBlock breadth={indiaSnap.breadth} />
                ) : (
                  <TempUnavailableNote label="NIFTY-50 breadth" detail="awaiting the scheduled full-constituent fill" />
                )}
              </div>

              {/* Structural gaps — no approved India equivalent (never synthesized) */}
              <div style={{ marginBottom: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
                <NotSupportedNote label="TradingView sector overview, macro sentinel & leveraged-pair sentiment" />
                {/* Congressional disclosures are US-only by STRUCTURE, not by
                    outage: India has no politician-trade disclosure regime (see
                    lib/nse-data.ts), so there is nothing to fetch and a retry
                    would be a lie. Rendered as an explicit note rather than by
                    omitting the panel, so the India view never silently drops a
                    US surface.
                    Scoped deliberately to CONGRESSIONAL data only: India *does*
                    have an insider-disclosure analog (SEBI PIT via
                    `fetchNseInsider`) and an institutional-flow analog (FII/DII
                    via /api/india/smart-money). Those are unwired, not absent —
                    calling them "not supported" here would be the same dishonesty
                    this note exists to prevent. */}
                <NotSupportedNote label="Congressional (US House) trade disclosures" />
              </div>

              {/* Provenance / freshness footer */}
              <div style={{ fontSize: "11px", color: T.muted, textAlign: "right" }}>
                India indices &amp; NSE sectors via Yahoo Finance (unofficial · not an authoritative NSE feed) · as of {indiaSnap.asOf} · status {indiaSnap.status}
              </div>
            </>
          )}
        </>
      )}

      {/* Data loaded (US) */}
      {!isIndia && data && (
        <>
          {/* Degradation banner — a provider/credential outage previously rendered
              as every index and sector exactly flat with no indication at all. */}
          {data.degraded && (
            <div style={{ marginBottom: "16px", background: "#2D2000", border: `1px solid ${T.amber}40`, borderRadius: "12px", padding: "14px 18px", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <span style={{ fontSize: "10px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "2px 8px", borderRadius: "5px", background: T.surface, border: `1px solid ${T.amber}40`, color: T.amber }}>
                Data unavailable
              </span>
              <span style={{ fontSize: "12px", color: T.text }}>{data.degraded}</span>
              <button onClick={fetchMarkets} style={{ marginLeft: "auto", padding: "5px 12px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "7px", color: T.text, fontSize: "12px", fontWeight: 500, cursor: "pointer" }}>Retry</button>
            </div>
          )}
          {!data.degraded && data.stale && data.unavailableCount > 0 && (
            <div style={{ marginBottom: "16px", background: "#2D2000", border: `1px solid ${T.amber}40`, borderRadius: "12px", padding: "12px 18px", fontSize: "12px", color: T.text }}>
              <span style={{ color: T.amber, fontWeight: 700 }}>Partial data</span>
              {" — "}{data.unavailableCount} of {data.indices.length + data.sectors.length} symbols could not be resolved this fetch. Unresolved tiles show “n/a”, never 0.00%.
            </div>
          )}

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

          {/* Sector treemap — clicking a sector opens the chart above. This is
              the ONLY writer of selectedSymbol on US; the sector ETFs are US
              symbols that /api/charts/price-history can genuinely resolve. */}
          <SectorTreemap sectors={data.sectors} onSymbol={setSelectedSymbol} />

          {/* Provenance / freshness footer — states the real provider, the real
              endpoint semantics, and the real age of the data. */}
          <div style={{ marginTop: "16px", fontSize: "11px", color: T.muted, textAlign: "right", lineHeight: 1.6 }}>
            Daily close via Massive (previous-day aggregate, end-of-day — not intraday)
            {data.sessionDate && <> · session {data.sessionDate}</>}
            {data.priorCloseDate && <> vs prior close {data.priorCloseDate}</>}
            <br />
            Fetched {new Date(data.fetchedAt).toLocaleString()} · server-cached 5 min
            {data.unavailableCount > 0 && (
              <> · <span style={{ color: T.amber }}>{data.unavailableCount} symbol{data.unavailableCount === 1 ? "" : "s"} unavailable</span></>
            )}
          </div>
        </>
      )}

      {/* US-only analytics — sector rotation, breadth, sentiment, thesis, macro,
          smart money. No free India equivalent, so hidden when India is selected
          (the India gap note above stands in for these). */}
      {!isIndia && (
        <>
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
            Loading sector charts…
          </div>
        }>
          <SectorTradingViewOverview />
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

      {/* What the macro backdrop means for your book (Agent Mind, Phase 3) */}
      <div style={{ marginBottom: "16px" }}>
        <MacroReadCard market={market} />
      </div>

      {/* Smart Money Trades */}
      <div style={{ marginTop: "16px", marginBottom: "32px" }}>
        <SmartMoneyTrades />
      </div>
        </>
      )}
      </div>
    </div>
  );
}
