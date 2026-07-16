"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from "recharts";
import PageHeader from "@/components/dashboard/PageHeader";
import SymbolAutocomplete from "@/components/dashboard/SymbolAutocomplete";
import { useMarket } from "@/lib/market-context";
import { fmtMoney, type Mkt } from "@/lib/format-money";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280", dim: "#1C1F26",
  accent: "#6366F1", accentBg: "#1E1F3A",
  green: "#34D399", greenBg: "#052E16",
  red: "#F87171", redBg: "#3B0000",
  amber: "#FBBF24", amberBg: "#2D1B00",
  blue: "#60A5FA", blueBg: "#0F1A2E",
  purple: "#A78BFA",
};

const PERIODS = ["1W", "1M", "3M", "YTD", "1Y", "ALL"] as const;
type Period = typeof PERIODS[number];

const LINE_COLORS = [
  "#6366F1", "#34D399", "#60A5FA", "#FBBF24", "#F87171",
  "#A78BFA", "#F59E0B", "#10B981", "#EC4899", "#14B8A6",
];

const STORAGE_KEY = "kairos-score-tracker-symbols";
const FILTERS_KEY = "kairos-score-tracker-filters";

// ── Score Tracker filters (additive, read-only — no scoring/money impact) ─────
// Each field maps 1:1 to a real signal_score_history column that the
// score-history API now understands. "all"/"" means "don't constrain".
//
// `market` is deliberately NOT a local filter. The chart's market is owned by the
// global US/India switcher (useMarket) — a local dropdown defaulting to "all"
// meant flipping to India still plotted US points alongside India's. One
// authority, no silent override.
type Filters = {
  scoreBand: "all" | "high" | "mid" | "low";
  direction: "all" | "long" | "short" | "neutral";
  source: "all" | "holding" | "watchlist" | "screener";
  from: string; // ISO date (yyyy-mm-dd) or ""
  to: string;   // ISO date (yyyy-mm-dd) or ""
};
const DEFAULT_FILTERS: Filters = {
  scoreBand: "all", direction: "all", source: "all", from: "", to: "",
};
const FILTER_KEYS = Object.keys(DEFAULT_FILTERS) as (keyof Filters)[];

// Drop unknown/stale keys from persisted filters — older builds stored a
// `market` filter here; carrying it forward would re-introduce the override and
// permanently mark the filter bar "active".
function sanitizeFilters(raw: unknown): Filters {
  const out = { ...DEFAULT_FILTERS };
  if (!raw || typeof raw !== "object") return out;
  for (const k of FILTER_KEYS) {
    const v = (raw as any)[k];
    if (typeof v === "string") (out as any)[k] = v;
  }
  return out;
}

// Human-readable option labels (detail-over-cryptic: say what each value means).
const FILTER_OPTIONS = {
  scoreBand: [
    { v: "all", label: "Any score" },
    { v: "high", label: "≥ 80 (high conviction)" },
    { v: "mid", label: "50–79 (moderate)" },
    { v: "low", label: "< 50 (low / bearish)" },
  ],
  direction: [
    { v: "all", label: "Any direction" },
    { v: "long", label: "Long" },
    { v: "short", label: "Short" },
    { v: "neutral", label: "Neutral" },
  ],
  source: [
    { v: "all", label: "Any source" },
    { v: "holding", label: "Holding (owned position)" },
    { v: "watchlist", label: "Watchlist" },
    { v: "screener", label: "Screener candidate" },
  ],
} as const;

const DIMENSIONS: { key: keyof ScoreRow; label: string }[] = [
  { key: "fundamental_score", label: "Fundamental" },
  { key: "technical_score", label: "Technical" },
  { key: "sentiment_score", label: "Sentiment" },
  { key: "macro_score", label: "Macro" },
  { key: "insider_score", label: "Insider" },
];

type ScoreRow = {
  symbol: string;
  analyst_score: number;
  fundamental_score: number;
  technical_score: number;
  sentiment_score: number;
  macro_score: number;
  insider_score: number;
  direction: string;
  source: string;
  rationale: string;
  used_champion_weights: boolean;
  research_packet_id: string | null;
  created_at: string;
};

type StrategyVersion = {
  id: number;
  name: string;
  version: string;
  is_champion: boolean;
  promoted_at: string | null;
  weights_snapshot: any;
};

type Selected = { symbol: string; row: ScoreRow; index: number } | null;

// ── Point-detail API shapes (GET /api/scores/point-detail) ──────────────────
type PacketDetail = {
  packet_id: string | null;
  analyst_score: number | null;
  summary: string | null;
  key_risks: string[];
  catalysts: string[];
  weights: Record<string, number> | null;
  used_champion_weights: boolean | null;
  scores: Record<string, number | null>;
  evidence: Record<string, any>;
  data_quality: Record<string, any> | null;
  created_at: string | null;
};
type PointDetailResp = { detail: PacketDetail | null; prior: PacketDetail | null; available: boolean };

// Evidence dimensions map to the score keys the API returns.
const EVIDENCE_DIMS: { key: string; label: string }[] = [
  { key: "fundamental", label: "Fundamental" },
  { key: "technical", label: "Technical" },
  { key: "sentiment", label: "Sentiment" },
  { key: "macro", label: "Macro" },
  { key: "insider", label: "Insider" },
];

// A qualitative verdict + the T color token that reads for it.
type Verdict = { text: string; tone: "green" | "amber" | "red" | "muted" };
function num(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function pct(v: any): string {
  const n = num(v);
  if (n === null) return "";
  // Values may arrive as 0–1 fractions or 0–100 already.
  const p = n <= 1 && n >= -1 ? n * 100 : n;
  return `${Math.round(p)}%`;
}
function toneColor(tone: Verdict["tone"]) {
  return tone === "green" ? T.green : tone === "amber" ? T.amber : tone === "red" ? T.red : T.muted;
}

// Turn one dimension's evidence object into a human sentence with inline
// strong/moderate/weak verdicts. Returns null if there's genuinely nothing.
function explainDimension(dim: string, evidence: any, score: number | null, market: Mkt): { parts: Verdict[]; note: string | null } | null {
  if (!evidence || typeof evidence !== "object") {
    return { parts: [], note: null };
  }
  const note: string | null = typeof evidence.note === "string" ? evidence.note : null;
  const parts: Verdict[] = [];

  if (dim === "fundamental") {
    const pe = num(evidence.pe_ratio);
    if (pe !== null) {
      const tone = pe < 18 ? "green" : pe < 30 ? "amber" : "red";
      const tag = pe < 18 ? "cheap" : pe < 30 ? "fair" : "rich vs a typical sub-20";
      parts.push({ text: `P/E ${pe.toFixed(1)} (${tag})`, tone });
    }
    const roe = num(evidence.roe);
    if (roe !== null) {
      const r = roe <= 1 ? roe * 100 : roe;
      const tone = r > 20 ? "green" : r > 12 ? "amber" : "red";
      const tag = r > 20 ? "strong" : r > 12 ? "ok" : "weak";
      parts.push({ text: `ROE ${Math.round(r)}% (${tag})`, tone });
    }
    const rg = num(evidence.revenue_growth_yoy);
    if (rg !== null) {
      const g = Math.abs(rg) <= 1 ? rg * 100 : rg;
      const tone = g > 20 ? "green" : g > 8 ? "amber" : "red";
      const tag = g > 20 ? "strong" : g > 8 ? "moderate" : g >= 0 ? "soft" : "contracting";
      parts.push({ text: `revenue growth ${g > 0 ? "+" : ""}${Math.round(g)}% YoY (${tag})`, tone });
    }
    const pm = num(evidence.profit_margin);
    if (pm !== null) {
      const m = Math.abs(pm) <= 1 ? pm * 100 : pm;
      const tone = m > 20 ? "green" : m > 8 ? "amber" : "red";
      parts.push({ text: `margin ${Math.round(m)}%`, tone });
    }
    const eps = num(evidence.eps);
    if (eps !== null) parts.push({ text: `EPS ${eps.toFixed(2)}`, tone: eps > 0 ? "green" : "red" });
    const tgt = num(evidence.analyst_target);
    if (tgt !== null) parts.push({ text: `analyst target ${fmtMoney(tgt, market, 0)}`, tone: "muted" });
    if (evidence.sector) parts.push({ text: `Sector: ${evidence.sector}`, tone: "muted" });
    return { parts, note };
  }

  if (dim === "technical") {
    const rsi = num(evidence.rsi);
    if (rsi !== null) {
      const tone = rsi > 70 ? "amber" : rsi > 55 ? "green" : rsi < 45 ? "red" : "muted";
      const tag = rsi > 70 ? "overbought" : rsi > 55 ? "bullish momentum, not yet overbought" : rsi < 45 ? "bearish momentum" : "neutral";
      parts.push({ text: `RSI ${Math.round(rsi)} (${tag})`, tone });
    }
    const price = num(evidence.price);
    const ema = num(evidence.ema50) ?? num(evidence.ema) ?? num(evidence.sma);
    if (price !== null && ema !== null) {
      const above = price >= ema;
      parts.push({ text: `price ${above ? "above" : "below"} 50-day ${evidence.ema50 || evidence.ema ? "EMA" : "MA"} (${above ? "uptrend" : "downtrend"})`, tone: above ? "green" : "red" });
    }
    const macd = num(evidence.macd);
    if (macd !== null) parts.push({ text: `MACD ${macd > 0 ? "positive" : "negative"}`, tone: macd > 0 ? "green" : "red" });
    return { parts, note };
  }

  if (dim === "sentiment") {
    const bull = num(evidence.bullish_pct);
    const bear = num(evidence.bearish_pct);
    if (bull !== null || bear !== null) {
      const b = bull ?? (bear !== null ? (bear <= 1 ? 1 - bear : 100 - bear) : null);
      const net = b !== null ? (b <= 1 ? b * 100 : b) : null;
      const tone: Verdict["tone"] = net === null ? "muted" : net > 55 ? "green" : net < 45 ? "red" : "muted";
      const tag = net === null ? "" : net > 55 ? "net positive social sentiment" : net < 45 ? "net negative social sentiment" : "mixed social sentiment";
      parts.push({ text: `Bullish ${pct(bull ?? "")} / bearish ${pct(bear ?? "")}${tag ? ` — ${tag}` : ""}`, tone });
    }
    if (evidence.source) parts.push({ text: `source: ${evidence.source}`, tone: "muted" });
    return { parts, note };
  }

  if (dim === "macro") {
    const regime = evidence.regime ? String(evidence.regime).toUpperCase() : null;
    const danger = num(evidence.danger_score);
    if (regime || danger !== null) {
      const tone: Verdict["tone"] = regime === "GREEN" ? "green" : regime === "RED" ? "red" : regime === "AMBER" || regime === "YELLOW" ? "amber" : danger !== null ? (danger < 30 ? "green" : danger < 60 ? "amber" : "red") : "muted";
      const backdrop = tone === "green" ? "supportive backdrop" : tone === "red" ? "risk-off backdrop" : "mixed backdrop";
      const bits = [regime ? `Regime ${regime}` : null, danger !== null ? `danger score ${Math.round(danger)}/100` : null].filter(Boolean).join(", ");
      parts.push({ text: `${bits} — ${backdrop}`, tone });
    }
    if (evidence.as_of) parts.push({ text: `as of ${evidence.as_of}`, tone: "muted" });
    return { parts, note };
  }

  if (dim === "insider") {
    const keys = Object.keys(evidence).filter(k => k !== "note");
    if (keys.length === 0) return { parts: [], note: note ?? "No insider signal data." };
    for (const k of keys) {
      const v = evidence[k];
      if (v === null || v === undefined || typeof v === "object") continue;
      parts.push({ text: `${k.replace(/_/g, " ")}: ${v}`, tone: "muted" });
    }
    if (parts.length === 0 && !note) return { parts: [], note: "No insider signal data." };
    return { parts, note };
  }

  return { parts, note };
}

// Compare this point's evidence vs prior for one dimension → the driving metric
// that moved, as a short clause. Returns null if no specific driver identified.
function evidenceDeltaClause(dim: string, cur: any, prv: any): string | null {
  if (!cur || !prv || typeof cur !== "object" || typeof prv !== "object") return null;
  const chg = (label: string, a: any, b: any, digits = 0) => {
    const na = num(a), nb = num(b);
    if (na === null || nb === null || Math.abs(na - nb) < (digits ? 0.01 : 0.5)) return null;
    return `${label} ${nb.toFixed(digits)} → ${na.toFixed(digits)}`;
  };
  const clauses: string[] = [];
  if (dim === "fundamental") {
    const c = chg("P/E", cur.pe_ratio, prv.pe_ratio, 1); if (c) clauses.push(c);
    const r = chg("ROE", cur.roe, prv.roe, 0); if (r) clauses.push(r);
    const g = chg("rev growth", cur.revenue_growth_yoy, prv.revenue_growth_yoy, 0); if (g) clauses.push(g);
  } else if (dim === "technical") {
    const rsi = chg("RSI", cur.rsi, prv.rsi, 0); if (rsi) clauses.push(rsi);
    const pc = num(cur.price), pp = num(prv.price);
    const ec = num(cur.ema50) ?? num(cur.ema), ep = num(prv.ema50) ?? num(prv.ema);
    if (pc !== null && ec !== null && pp !== null && ep !== null) {
      const wasAbove = pp >= ep, nowAbove = pc >= ec;
      if (wasAbove !== nowAbove) clauses.push(`price crossed ${nowAbove ? "above" : "below"} the 50-day EMA`);
    }
  } else if (dim === "sentiment") {
    const b = chg("bullish", cur.bullish_pct, prv.bullish_pct, 0); if (b) clauses.push(b);
  } else if (dim === "macro") {
    const d = chg("danger", cur.danger_score, prv.danger_score, 0); if (d) clauses.push(d);
    if (cur.regime && prv.regime && String(cur.regime).toUpperCase() !== String(prv.regime).toUpperCase()) {
      clauses.push(`regime ${String(prv.regime).toUpperCase()} → ${String(cur.regime).toUpperCase()}`);
    }
  }
  if (clauses.length === 0) return null;
  return clauses.join(" and ");
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtShort(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function colorFor(sym: string, symbols: string[]) {
  const i = symbols.indexOf(sym);
  return LINE_COLORS[(i < 0 ? 0 : i) % LINE_COLORS.length];
}

function DeltaText({ delta, size = 12 }: { delta: number; size?: number }) {
  if (delta === 0) return <span style={{ color: T.muted, fontSize: size }}>±0</span>;
  const color = delta > 0 ? T.green : T.red;
  return <span style={{ color, fontSize: size, fontWeight: 600 }}>{(delta > 0 ? "+" : "") + delta}</span>;
}

export default function ScoreTrackerPanel({ embedded }: { embedded?: boolean }) {
  const { market } = useMarket();
  const [allSymbols, setAllSymbols] = useState<string[]>([]);
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [customTicker, setCustomTicker] = useState("");

  const [period, setPeriod] = useState<Period>("1M");
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [bySymbol, setBySymbol] = useState<Record<string, ScoreRow[]>>({});
  const [loading, setLoading] = useState(false);
  const [versions, setVersions] = useState<StrategyVersion[]>([]);
  const [selected, setSelected] = useState<Selected>(null);

  // Rich "why" evidence for the currently-selected point (fetched on click).
  const [pointDetail, setPointDetail] = useState<PointDetailResp | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // ── Hydrate selection from localStorage + fetch candidate symbols ──────────
  useEffect(() => {
    let saved: string[] = [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch { /* non-fatal */ }

    try {
      const rawF = localStorage.getItem(FILTERS_KEY);
      if (rawF) setFilters(sanitizeFilters(JSON.parse(rawF)));
    } catch { /* non-fatal */ }

    async function loadCandidates() {
      const collected = new Set<string>();
      try {
        // live-portfolio stays unscoped (US-only Robinhood holdings, by design —
        // India's live holdings live on a separate page/broker). Watchlist now
        // follows the global US/India switcher so the candidate pool (and thus
        // the chart) matches whichever market's tab the switcher shows elsewhere.
        const [wRes, pRes] = await Promise.all([
          fetch(`/api/watchlist?market=${market}`).then(r => r.json()).catch(() => ({})),
          fetch("/api/live-portfolio").then(r => r.json()).catch(() => ({})),
        ]);
        for (const it of (wRes.items ?? [])) {
          if (it.symbol) collected.add(String(it.symbol).toUpperCase());
        }
        for (const h of (pRes.holdings ?? [])) {
          if (h.symbol) collected.add(String(h.symbol).toUpperCase());
        }
      } catch { /* non-fatal */ }

      // Include any saved symbols not in the candidate lists so custom tickers persist as chips
      for (const s of saved) collected.add(String(s).toUpperCase());
      const list = [...collected];
      setAllSymbols(list);

      const validSaved = saved.map(s => s.toUpperCase()).filter(s => list.includes(s));
      if (validSaved.length > 0) setSelectedSymbols(validSaved);
      else setSelectedSymbols(list.slice(0, 3));
      setHydrated(true);
    }
    loadCandidates();

    // Weight-change context — scoped to the selected market, since these versions
    // annotate this market's score history. Unscoped, an India promotion drew a
    // weight-change marker on a US chart. This effect already re-runs on `market`.
    fetch(`/api/strategies/versions?market=${market}`)
      .then(r => r.json())
      .then(d => setVersions(d.versions ?? []))
      .catch(() => {});
  }, [market]);

  // ── Persist selection ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedSymbols)); } catch { /* non-fatal */ }
  }, [selectedSymbols, hydrated]);

  // ── Persist filter selection ────────────────────────────────────────────────
  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(FILTERS_KEY, JSON.stringify(filters)); } catch { /* non-fatal */ }
  }, [filters, hydrated]);

  const filtersActive = useMemo(
    () => JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS),
    [filters],
  );

  // ── Fetch score history when symbols or period change ───────────────────────
  const loadHistory = useCallback(async () => {
    if (selectedSymbols.length === 0) { setBySymbol({}); return; }
    setLoading(true);
    try {
      // Market always comes from the global switcher — the chart is never allowed
      // to plot two books at once, so this is unconditional, not a filter.
      const qs = new URLSearchParams({ symbols: selectedSymbols.join(","), period, market });
      // Only append filters that constrain (keeps the URL — and the query — a
      // no-op when nothing is filtered, so default behavior is unchanged).
      if (filters.direction !== "all") qs.set("direction", filters.direction);
      if (filters.source !== "all") qs.set("source", filters.source);
      if (filters.scoreBand !== "all") qs.set("scoreBand", filters.scoreBand);
      if (filters.from) qs.set("from", filters.from);
      if (filters.to) qs.set("to", filters.to);
      const r = await fetch(`/api/charts/score-history?${qs.toString()}`);
      const d = await r.json();
      setBySymbol(d.bySymbol ?? {});
    } catch {
      setBySymbol({});
    } finally {
      setLoading(false);
    }
  }, [selectedSymbols, period, filters, market]);

  useEffect(() => {
    if (!hydrated) return;
    loadHistory();
    setSelected(null); // clear drill-down on data change
  }, [hydrated, loadHistory]);

  function toggleSymbol(sym: string) {
    setSelectedSymbols(prev => prev.includes(sym) ? prev.filter(s => s !== sym) : [...prev, sym]);
  }

  function addCustom() {
    const sym = customTicker.trim().toUpperCase();
    if (!sym) return;
    setAllSymbols(prev => prev.includes(sym) ? prev : [...prev, sym]);
    setSelectedSymbols(prev => prev.includes(sym) ? prev : [...prev, sym]);
    setCustomTicker("");
  }

  // ── Merge bySymbol into unified chart rows keyed by created_at ──────────────
  const chartData = useMemo(() => {
    const byTime: Record<string, any> = {};
    for (const sym of selectedSymbols) {
      for (const row of (bySymbol[sym] ?? [])) {
        const key = row.created_at;
        if (!byTime[key]) byTime[key] = { created_at: key, label: fmtShort(key) };
        byTime[key][sym] = row.analyst_score;
      }
    }
    return Object.values(byTime).sort(
      (a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
  }, [bySymbol, selectedSymbols]);

  const hasHistory = selectedSymbols.some(s => (bySymbol[s] ?? []).length > 0);

  // ── Drill-down computations ─────────────────────────────────────────────────
  const drill = useMemo(() => {
    if (!selected) return null;
    const rows = bySymbol[selected.symbol] ?? [];
    const idx = selected.index;
    const row = rows[idx];
    if (!row) return null;
    const prev = idx > 0 ? rows[idx - 1] : null;

    const analystDelta = prev ? row.analyst_score - prev.analyst_score : null;
    const dims = DIMENSIONS.map(d => {
      const val = Number(row[d.key]);
      const delta = prev ? val - Number(prev[d.key]) : null;
      return { label: d.label, value: val, delta };
    });
    let biggestDriver: string | null = null;
    if (prev) {
      let max = -1;
      for (const d of dims) {
        const abs = Math.abs(d.delta ?? 0);
        if (abs > max) { max = abs; biggestDriver = d.label; }
      }
      if (max === 0) biggestDriver = null;
    }

    // Champion change between prior point and this point
    let championChange: StrategyVersion | null = null;
    if (prev) {
      const lo = new Date(prev.created_at).getTime();
      const hi = new Date(row.created_at).getTime();
      for (const v of versions) {
        if (!v.promoted_at) continue;
        const t = new Date(v.promoted_at).getTime();
        if (t > lo && t <= hi) { championChange = v; break; }
      }
    }

    return { row, prev, analystDelta, dims, biggestDriver, championChange };
  }, [selected, bySymbol, versions]);

  // ── Fetch rich evidence for the selected point ──────────────────────────────
  useEffect(() => {
    if (!selected) { setPointDetail(null); setDetailLoading(false); return; }
    const rows = bySymbol[selected.symbol] ?? [];
    const row = rows[selected.index];
    const packetId = row?.research_packet_id ?? null;
    if (!packetId) {
      // Old point predating the evidence upgrade — nothing to fetch.
      setPointDetail({ detail: null, prior: null, available: false });
      setDetailLoading(false);
      return;
    }
    const priorPacketId = selected.index > 0 ? (rows[selected.index - 1]?.research_packet_id ?? null) : null;
    const params = new URLSearchParams({ packet_id: packetId });
    if (priorPacketId) params.set("prior_packet_id", priorPacketId);

    let cancelled = false;
    setDetailLoading(true);
    setPointDetail(null);
    fetch(`/api/scores/point-detail?${params.toString()}`)
      .then(r => r.json())
      .then((d: PointDetailResp) => { if (!cancelled) setPointDetail(d); })
      .catch(() => { if (!cancelled) setPointDetail({ detail: null, prior: null, available: false }); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selected, bySymbol]);

  // ── Per-dimension "why" + "what changed" narrative from the fetched evidence ─
  const evidenceView = useMemo(() => {
    const detail = pointDetail?.detail ?? null;
    const prior = pointDetail?.prior ?? null;
    if (!detail) return null;

    const rows = detail.evidence ?? {};
    const priorEv = prior?.evidence ?? {};
    const curScores = detail.scores ?? {};
    const priorScores = prior?.scores ?? {};

    const dims = EVIDENCE_DIMS.map(({ key, label }) => {
      const explained = explainDimension(key, rows[key], num(curScores[key]), market);
      const curScore = num(curScores[key]);
      const prvScore = prior ? num(priorScores[key]) : null;
      const scoreDelta = curScore !== null && prvScore !== null ? curScore - prvScore : null;
      const driverClause = prior ? evidenceDeltaClause(key, rows[key], priorEv[key]) : null;
      return { key, label, explained, curScore, prvScore, scoreDelta, driverClause };
    });

    // Biggest driver of the overall move = dimension with largest |scoreDelta|.
    let biggestDriver: { label: string; scoreDelta: number } | null = null;
    if (prior) {
      let max = 0;
      for (const d of dims) {
        if (d.scoreDelta !== null && Math.abs(d.scoreDelta) > max) {
          max = Math.abs(d.scoreDelta);
          biggestDriver = { label: d.label, scoreDelta: d.scoreDelta };
        }
      }
    }

    // Data-quality caveats.
    const dq = detail.data_quality ?? {};
    const caveats: string[] = [];
    if (dq && typeof dq === "object") {
      if (dq.fundamentalDataAvailable === false) caveats.push("fundamental data missing");
      if (dq.technicalDataPoints === 0 || dq.technicalDataPoints === "0") caveats.push("no technical data points");
      if (dq.sentimentDataAvailable === false) caveats.push("sentiment data missing");
      if (dq.macroDataAvailable === false) caveats.push("macro data missing");
      if (dq.insiderDataAvailable === false) caveats.push("insider data missing");
    }

    return { detail, prior, dims, biggestDriver, caveats };
  }, [pointDetail, market]);

  return (
    <div style={{ color: T.text, fontFamily: "'Inter', sans-serif", minHeight: "100vh", background: T.bg }}>
      {!embedded && (
        <PageHeader
          title="Score Tracker"
          subtitle="AI conviction score over time — per stock, with drill-down"
          cadence="daily"
          whatItDoes="Plots the ResearchAgent's analyst_score (0-100) for each tracked symbol over time. Each research run writes one point per symbol; click a point to see what moved the score."
          whatToLookFor={[
            "A score crossing 60 = signal-worthy conviction",
            "Click a point to see the per-dimension breakdown and biggest driver",
            "A ⚡ tag means the champion strategy changed just before that point",
            "Read the rationale to understand the thesis behind each score",
          ]}
        />
      )}

      <div style={{ padding: "16px clamp(12px,4vw,28px) 40px", maxWidth: "1400px" }}>

        {/* ── Symbol picker ── */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "14px", padding: "18px 20px", marginBottom: "16px" }}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "12px" }}>
            Symbols {selectedSymbols.length > 0 && <span style={{ color: T.textSub, fontWeight: 400 }}>({selectedSymbols.length} selected)</span>}
          </div>

          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "14px" }}>
            {allSymbols.length === 0 && !hydrated && <span style={{ fontSize: "12px", color: T.muted }}>Loading symbols…</span>}
            {allSymbols.length === 0 && hydrated && <span style={{ fontSize: "12px", color: T.muted }}>No candidate symbols found — add one below.</span>}
            {allSymbols.map(sym => {
              const active = selectedSymbols.includes(sym);
              const c = colorFor(sym, selectedSymbols);
              return (
                <button
                  key={sym}
                  onClick={() => toggleSymbol(sym)}
                  style={{
                    padding: "5px 12px", borderRadius: "7px", fontSize: "12px", fontWeight: 600,
                    border: `1px solid ${active ? c + "88" : T.border}`,
                    background: active ? c + "22" : "none",
                    color: active ? c : T.muted,
                    cursor: "pointer",
                    display: "flex", alignItems: "center", gap: "6px",
                  }}
                >
                  {active && <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: c, flexShrink: 0 }} />}
                  {sym}
                </button>
              );
            })}
          </div>

          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <div style={{ width: "180px" }}>
              <SymbolAutocomplete
                value={customTicker}
                onChange={setCustomTicker}
                onEnter={addCustom}
                placeholder="Add ticker…"
                inputStyle={{ fontSize: "12px", padding: "6px 10px" }}
              />
            </div>
            <button
              onClick={addCustom}
              style={{ background: T.accentBg, border: `1px solid ${T.accent}44`, color: T.accent, borderRadius: "7px", padding: "6px 14px", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
            >
              + Add
            </button>
          </div>
        </div>

        {/* ── Filter bar (additive, read-only — narrows which scored points show) ── */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "14px", padding: "16px 20px", marginBottom: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "12px", flexWrap: "wrap" }}>
            <div style={{ fontSize: "11px", fontWeight: 700, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              Filters {filtersActive && <span style={{ color: T.accent, fontWeight: 400 }}>· active</span>}
            </div>
            {filtersActive && (
              <button
                onClick={() => setFilters(DEFAULT_FILTERS)}
                style={{ background: "none", border: `1px solid ${T.border}`, color: T.textSub, borderRadius: "6px", padding: "4px 10px", fontSize: "11px", fontWeight: 600, cursor: "pointer" }}
              >
                Clear filters
              </button>
            )}
          </div>

          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            {/* Market is read-only here — owned by the global US/India switcher so
                the chart can never plot both books at once. */}
            <div
              title="The chart follows the global US/India switcher in the header. Change market there."
              style={{ display: "flex", flexDirection: "column", gap: "5px", minWidth: "150px", flex: "1 1 150px" }}
            >
              <span style={{ fontSize: "10px", fontWeight: 700, color: T.muted, letterSpacing: "0.06em", textTransform: "uppercase" }}>Market</span>
              <div style={{ background: T.dim, border: `1px solid ${T.border}`, color: T.textSub, borderRadius: "7px", padding: "7px 10px", fontSize: "12px", fontWeight: 500, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px" }}>
                <span style={{ color: T.text }}>{market === "india" ? "🇮🇳 India" : "🇺🇸 US"}</span>
                <span style={{ fontSize: "10px", color: T.muted }}>global switcher</span>
              </div>
            </div>

            {/* Dropdown filters — each maps to a real column on signal_score_history */}
            {([
              { key: "scoreBand", label: "Score band", hint: "Filter by analyst_score range" },
              { key: "direction", label: "Direction", hint: "Long / short / neutral call" },
              { key: "source", label: "Discovery source", hint: "How the symbol entered research" },
            ] as const).map(({ key, label, hint }) => (
              <label key={key} title={hint} style={{ display: "flex", flexDirection: "column", gap: "5px", minWidth: "150px", flex: "1 1 150px" }}>
                <span style={{ fontSize: "10px", fontWeight: 700, color: T.muted, letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</span>
                <select
                  value={filters[key]}
                  onChange={e => setFilters(f => ({ ...f, [key]: e.target.value as any }))}
                  style={{ background: T.dim, border: `1px solid ${T.border}`, color: T.text, borderRadius: "7px", padding: "7px 10px", fontSize: "12px", fontWeight: 500, cursor: "pointer", width: "100%" }}
                >
                  {FILTER_OPTIONS[key].map(o => (
                    <option key={o.v} value={o.v} style={{ background: T.card, color: T.text }}>{o.label}</option>
                  ))}
                </select>
              </label>
            ))}

            {/* Date range — created_at from/to */}
            <label title="Only show points scored on or after this date" style={{ display: "flex", flexDirection: "column", gap: "5px", minWidth: "140px", flex: "1 1 140px" }}>
              <span style={{ fontSize: "10px", fontWeight: 700, color: T.muted, letterSpacing: "0.06em", textTransform: "uppercase" }}>From date</span>
              <input
                type="date"
                value={filters.from}
                max={filters.to || undefined}
                onChange={e => setFilters(f => ({ ...f, from: e.target.value }))}
                style={{ background: T.dim, border: `1px solid ${T.border}`, color: T.text, borderRadius: "7px", padding: "6px 10px", fontSize: "12px", cursor: "pointer", width: "100%", colorScheme: "dark" }}
              />
            </label>
            <label title="Only show points scored on or before this date" style={{ display: "flex", flexDirection: "column", gap: "5px", minWidth: "140px", flex: "1 1 140px" }}>
              <span style={{ fontSize: "10px", fontWeight: 700, color: T.muted, letterSpacing: "0.06em", textTransform: "uppercase" }}>To date</span>
              <input
                type="date"
                value={filters.to}
                min={filters.from || undefined}
                onChange={e => setFilters(f => ({ ...f, to: e.target.value }))}
                style={{ background: T.dim, border: `1px solid ${T.border}`, color: T.text, borderRadius: "7px", padding: "6px 10px", fontSize: "12px", cursor: "pointer", width: "100%", colorScheme: "dark" }}
              />
            </label>
          </div>
        </div>

        {/* ── Chart card ── */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "14px", padding: "20px", marginBottom: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div style={{ fontSize: "11px", fontWeight: 700, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                Analyst Score
              </div>
              {loading && <span style={{ fontSize: "11px", color: T.muted }}>Loading…</span>}
            </div>
            <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
              {PERIODS.map(p => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  style={{
                    padding: "4px 10px", borderRadius: "6px", fontSize: "11px", fontWeight: 600,
                    background: period === p ? T.accent : "none",
                    color: period === p ? "#fff" : T.muted,
                    border: `1px solid ${period === p ? T.accent : T.border}`,
                    cursor: "pointer",
                  }}
                >{p}</button>
              ))}
            </div>
          </div>

          {selectedSymbols.length === 0 ? (
            <div style={{ height: "260px", display: "flex", alignItems: "center", justifyContent: "center", color: T.muted, fontSize: "13px" }}>
              Pick one or more symbols above to plot their score history.
            </div>
          ) : !hasHistory && !loading ? (
            <div style={{ height: "260px", display: "flex", flexDirection: "column", gap: "8px", alignItems: "center", justifyContent: "center", color: T.muted, fontSize: "13px", textAlign: "center", padding: "0 20px" }}>
              {filtersActive ? (
                <>
                  <span>
                    No <strong style={{ color: T.textSub }}>{market === "india" ? "India" : "US"}</strong> scored points match these filters.
                    {" "}The chart only shows the {market === "india" ? "India" : "US"} book — switch market in the header to see the other one.
                  </span>
                  <button
                    onClick={() => setFilters(DEFAULT_FILTERS)}
                    style={{ background: T.accentBg, border: `1px solid ${T.accent}44`, color: T.accent, borderRadius: "7px", padding: "5px 12px", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
                  >
                    Clear filters
                  </button>
                </>
              ) : (
                <span>
                  No <strong style={{ color: T.textSub }}>{market === "india" ? "India" : "US"}</strong> score history yet for these symbols.
                  {" "}The research agent writes a point each run (Mon-Fri mornings). If these tickers trade in the other market, switch market in the header.
                </span>
              )}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fontSize: 10, fill: T.muted }}
                  tickLine={false}
                  axisLine={false}
                />
                <ReferenceLine y={50} stroke={T.muted} strokeDasharray="4 3" strokeOpacity={0.5} />
                <ReferenceLine y={60} stroke={T.green} strokeDasharray="4 3" strokeOpacity={0.5} />
                <Tooltip
                  contentStyle={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", fontSize: "12px" }}
                  labelStyle={{ color: T.textSub }}
                  formatter={(v: any, name: any) => [v, name]}
                />
                <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }} />
                {selectedSymbols.map(sym => (
                  <Line
                    key={sym}
                    type="monotone"
                    dataKey={sym}
                    stroke={colorFor(sym, selectedSymbols)}
                    strokeWidth={2}
                    connectNulls
                    dot={{ r: 3, cursor: "pointer" }}
                    activeDot={{
                      r: 6,
                      cursor: "pointer",
                      onClick: (_e: any, payload: any) => {
                        const createdAt = payload?.payload?.created_at;
                        if (!createdAt) return;
                        const rows = bySymbol[sym] ?? [];
                        const index = rows.findIndex(r => r.created_at === createdAt);
                        if (index >= 0) setSelected({ symbol: sym, row: rows[index], index });
                      },
                    }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
          {hasHistory && (
            <div style={{ fontSize: "10px", color: T.muted, marginTop: "8px" }}>
              Click a point to inspect the score and what drove it. Dashed lines: 50 (neutral) · 60 (signal threshold).
            </div>
          )}
        </div>

        {/* ── Drill-down panel ── */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "14px", padding: "20px" }}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "14px" }}>
            Point Detail
          </div>

          {!drill ? (
            <div style={{ color: T.muted, fontSize: "13px", padding: "8px 0" }}>
              Click a point on the chart to see its score, per-dimension breakdown, and research thesis.
            </div>
          ) : (
            <div>
              {/* Header row */}
              <div style={{ display: "flex", alignItems: "baseline", gap: "12px", flexWrap: "wrap", marginBottom: "16px" }}>
                <span style={{ fontSize: "20px", fontWeight: 700, color: colorFor(selected!.symbol, selectedSymbols) }}>{drill.row.symbol}</span>
                <span style={{ fontSize: "26px", fontWeight: 800, color: T.text }}>{drill.row.analyst_score}</span>
                {drill.analystDelta !== null
                  ? <span style={{ fontSize: "15px" }}><DeltaText delta={drill.analystDelta} size={15} /> <span style={{ fontSize: "11px", color: T.muted }}>vs prior</span></span>
                  : <span style={{ fontSize: "11px", color: T.muted }}>First recorded score — no prior point to compare.</span>}
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: "12px", color: T.muted }}>{fmtDateTime(drill.row.created_at)}</span>
              </div>

              {/* Champion change banner */}
              {drill.championChange && (
                <div style={{ background: T.amberBg, border: `1px solid ${T.amber}44`, borderRadius: "10px", padding: "10px 14px", marginBottom: "16px", fontSize: "12px", color: T.amber, lineHeight: "1.5" }}>
                  ⚡ Champion strategy changed to <strong>{drill.championChange.name} {drill.championChange.version}</strong> just before this point — score shift may reflect the new weights.
                </div>
              )}

              {/* Per-dimension breakdown */}
              <div style={{ overflowX: "auto", marginBottom: "16px" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                      {["Dimension", "Value", "Δ vs prior"].map((h, i) => (
                        <th key={h} style={{ padding: "6px 10px", textAlign: i === 0 ? "left" : "right", fontSize: "10px", color: T.muted, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {drill.dims.map(d => {
                      const isDriver = d.label === drill.biggestDriver;
                      return (
                        <tr key={d.label} style={{ borderBottom: `1px solid ${T.border}33`, background: isDriver ? T.accentBg + "66" : "none" }}>
                          <td style={{ padding: "9px 10px", color: isDriver ? T.accent : T.textSub, fontWeight: isDriver ? 700 : 400 }}>
                            {d.label}
                            {isDriver && <span style={{ fontSize: "9px", fontWeight: 700, marginLeft: "8px", padding: "1px 6px", borderRadius: "4px", background: T.accent, color: "#fff", letterSpacing: "0.05em" }}>BIGGEST DRIVER</span>}
                          </td>
                          <td style={{ padding: "9px 10px", textAlign: "right", fontWeight: 600, color: isDriver ? T.text : T.textSub }}>{d.value}</td>
                          <td style={{ padding: "9px 10px", textAlign: "right" }}>
                            {d.delta === null ? <span style={{ color: T.muted }}>—</span> : <DeltaText delta={d.delta} />}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* ── Rich evidence: WHY each dimension is what it is ── */}
              {detailLoading ? (
                <div style={{ color: T.accent, fontSize: "12px", padding: "6px 0 14px", display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: T.accent, display: "inline-block", opacity: 0.7 }} />
                  Loading explanation — pulling the per-dimension evidence behind this score…
                </div>
              ) : pointDetail && !pointDetail.available ? (
                <div style={{ color: T.muted, fontSize: "12px", fontStyle: "italic", padding: "6px 0 14px", lineHeight: "1.6" }}>
                  Detailed evidence wasn&apos;t recorded for this point (it predates the evidence upgrade — new points written each research run will show full reasoning).
                </div>
              ) : evidenceView ? (
                <>
                  {/* Data-quality caveat */}
                  {evidenceView.caveats.length > 0 && (
                    <div style={{ background: T.amberBg, border: `1px solid ${T.amber}44`, borderRadius: "10px", padding: "10px 14px", marginBottom: "16px", fontSize: "12px", color: T.amber, lineHeight: "1.5" }}>
                      ⚠ Some inputs were unavailable this run ({evidenceView.caveats.join(", ")}) — those dimensions used a neutral 50 baseline, so treat them as low-confidence rather than a true neutral read.
                    </div>
                  )}

                  {/* Per-dimension "why" */}
                  <div style={{ marginBottom: "16px" }}>
                    <div style={{ fontSize: "9px", fontWeight: 700, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "10px" }}>Why each dimension scored this</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      {evidenceView.dims.map(d => {
                        const ex = d.explained;
                        const empty = !ex || (ex.parts.length === 0 && !ex.note);
                        return (
                          <div key={d.key} style={{ background: T.dim, borderRadius: "8px", padding: "8px 12px" }}>
                            <div style={{ display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "3px" }}>
                              <span style={{ fontSize: "11px", fontWeight: 700, color: T.textSub }}>{d.label}</span>
                              {d.curScore !== null && <span style={{ fontSize: "11px", color: T.muted }}>· {d.curScore}/100</span>}
                            </div>
                            <div style={{ fontSize: "12px", color: T.textSub, lineHeight: "1.6" }}>
                              {empty ? (
                                <span style={{ color: T.muted }}>No detailed evidence for this dimension.</span>
                              ) : ex!.parts.length > 0 ? (
                                ex!.parts.map((p, i) => (
                                  <span key={i}>
                                    <span style={{ color: toneColor(p.tone), fontWeight: p.tone === "muted" ? 400 : 600 }}>{p.text}</span>
                                    {i < ex!.parts.length - 1 && <span style={{ color: T.muted }}>, </span>}
                                  </span>
                                ))
                              ) : (
                                <span style={{ color: T.muted }}>{ex!.note}</span>
                              )}
                              {ex && ex.parts.length > 0 && ex.note && (
                                <span style={{ color: T.muted, fontStyle: "italic" }}> — {ex.note}</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* What changed vs prior */}
                  {evidenceView.prior && (
                    <div style={{ marginBottom: "16px" }}>
                      <div style={{ fontSize: "9px", fontWeight: 700, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "10px" }}>What changed vs the prior point</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                        {(() => {
                          const changed = evidenceView.dims.filter(d => d.scoreDelta !== null && d.scoreDelta !== 0);
                          if (changed.length === 0) {
                            return <div style={{ fontSize: "12px", color: T.muted }}>No dimension scores moved between these two points.</div>;
                          }
                          return changed.map(d => {
                            const delta = d.scoreDelta!;
                            const color = delta > 0 ? T.green : T.red;
                            return (
                              <div key={d.key} style={{ fontSize: "12px", color: T.textSub, lineHeight: "1.6" }}>
                                <span style={{ fontWeight: 700, color: T.textSub }}>{d.label}</span>{" "}
                                <span style={{ color: T.muted }}>{d.prvScore} → {d.curScore}</span>{" "}
                                <span style={{ color, fontWeight: 600 }}>({delta > 0 ? "+" : ""}{delta})</span>
                                <span style={{ color: T.muted }}>: {d.driverClause ? d.driverClause : "dimension inputs shifted"}.</span>
                              </div>
                            );
                          });
                        })()}
                        {evidenceView.biggestDriver && (
                          <div style={{ fontSize: "12px", color: T.accent, fontWeight: 600, marginTop: "4px" }}>
                            ➜ Biggest driver: {evidenceView.biggestDriver.label} ({evidenceView.biggestDriver.scoreDelta > 0 ? "+" : ""}{evidenceView.biggestDriver.scoreDelta})
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </>
              ) : null}

              {/* Thesis / risks / catalysts */}
              {(() => {
                const thesis = evidenceView?.detail.summary || drill.row.rationale;
                const risks = evidenceView?.detail.key_risks ?? [];
                const catalysts = evidenceView?.detail.catalysts ?? [];
                if (!thesis && risks.length === 0 && catalysts.length === 0) return null;
                return (
                  <div style={{ background: T.dim, borderRadius: "10px", padding: "12px 14px", marginBottom: "14px" }}>
                    {thesis && (
                      <>
                        <div style={{ fontSize: "9px", fontWeight: 700, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "6px" }}>Thesis</div>
                        <div style={{ fontSize: "13px", color: T.textSub, lineHeight: "1.7", marginBottom: (risks.length || catalysts.length) ? "12px" : 0 }}>{thesis}</div>
                      </>
                    )}
                    {risks.length > 0 && (
                      <div style={{ marginBottom: catalysts.length ? "12px" : 0 }}>
                        <div style={{ fontSize: "9px", fontWeight: 700, color: T.red, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "6px" }}>Key risks</div>
                        <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "12px", color: T.textSub, lineHeight: "1.7" }}>
                          {risks.map((r, i) => <li key={i}>{r}</li>)}
                        </ul>
                      </div>
                    )}
                    {catalysts.length > 0 && (
                      <div>
                        <div style={{ fontSize: "9px", fontWeight: 700, color: T.green, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "6px" }}>Catalysts</div>
                        <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "12px", color: T.textSub, lineHeight: "1.7" }}>
                          {catalysts.map((c, i) => <li key={i}>{c}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Meta row */}
              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", fontSize: "11px", color: T.muted }}>
                <span style={{ padding: "3px 9px", borderRadius: "5px", background: T.dim }}>
                  Direction: <span style={{ color: T.textSub, fontWeight: 600 }}>{drill.row.direction || "—"}</span>
                </span>
                <span style={{ padding: "3px 9px", borderRadius: "5px", background: T.dim }}>
                  Weights used: <span style={{ color: drill.row.used_champion_weights ? T.green : T.textSub, fontWeight: 600 }}>{drill.row.used_champion_weights ? "champion" : "profile default"}</span>
                </span>
                {drill.row.source && (
                  <span style={{ padding: "3px 9px", borderRadius: "5px", background: T.dim }}>
                    Source: <span style={{ color: T.textSub, fontWeight: 600 }}>{drill.row.source}</span>
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
