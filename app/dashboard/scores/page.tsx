"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from "recharts";
import PageHeader from "@/components/dashboard/PageHeader";

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

export default function ScoreTrackerPage() {
  const [allSymbols, setAllSymbols] = useState<string[]>([]);
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [customTicker, setCustomTicker] = useState("");

  const [period, setPeriod] = useState<Period>("1M");
  const [bySymbol, setBySymbol] = useState<Record<string, ScoreRow[]>>({});
  const [loading, setLoading] = useState(false);
  const [versions, setVersions] = useState<StrategyVersion[]>([]);
  const [selected, setSelected] = useState<Selected>(null);

  // ── Hydrate selection from localStorage + fetch candidate symbols ──────────
  useEffect(() => {
    let saved: string[] = [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch { /* non-fatal */ }

    async function loadCandidates() {
      const collected = new Set<string>();
      try {
        const [wRes, pRes] = await Promise.all([
          fetch("/api/watchlist").then(r => r.json()).catch(() => ({})),
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

    // Weight-change context — fetch strategy versions once
    fetch("/api/strategies/versions")
      .then(r => r.json())
      .then(d => setVersions(d.versions ?? []))
      .catch(() => {});
  }, []);

  // ── Persist selection ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedSymbols)); } catch { /* non-fatal */ }
  }, [selectedSymbols, hydrated]);

  // ── Fetch score history when symbols or period change ───────────────────────
  const loadHistory = useCallback(async () => {
    if (selectedSymbols.length === 0) { setBySymbol({}); return; }
    setLoading(true);
    try {
      const r = await fetch(`/api/charts/score-history?symbols=${selectedSymbols.join(",")}&period=${period}`);
      const d = await r.json();
      setBySymbol(d.bySymbol ?? {});
    } catch {
      setBySymbol({});
    } finally {
      setLoading(false);
    }
  }, [selectedSymbols, period]);

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

  return (
    <div style={{ color: T.text, fontFamily: "'Inter', sans-serif", minHeight: "100vh", background: T.bg }}>
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

      <div style={{ padding: "20px 28px 40px", maxWidth: "1400px" }}>

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
            <input
              value={customTicker}
              onChange={e => setCustomTicker(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") addCustom(); }}
              placeholder="Add ticker…"
              style={{
                background: T.dim, border: `1px solid ${T.border}`, borderRadius: "7px",
                color: T.text, fontSize: "12px", padding: "6px 10px", width: "140px", outline: "none",
                fontFamily: "inherit", textTransform: "uppercase",
              }}
            />
            <button
              onClick={addCustom}
              style={{ background: T.accentBg, border: `1px solid ${T.accent}44`, color: T.accent, borderRadius: "7px", padding: "6px 14px", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
            >
              + Add
            </button>
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
            <div style={{ height: "260px", display: "flex", alignItems: "center", justifyContent: "center", color: T.muted, fontSize: "13px", textAlign: "center", padding: "0 20px" }}>
              No score history yet for these symbols — the research agent writes a point each run (Mon-Fri mornings).
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

              {/* Rationale */}
              {drill.row.rationale && (
                <div style={{ background: T.dim, borderRadius: "10px", padding: "12px 14px", marginBottom: "14px" }}>
                  <div style={{ fontSize: "9px", fontWeight: 700, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "6px" }}>Thesis</div>
                  <div style={{ fontSize: "13px", color: T.textSub, lineHeight: "1.7" }}>{drill.row.rationale}</div>
                </div>
              )}

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
