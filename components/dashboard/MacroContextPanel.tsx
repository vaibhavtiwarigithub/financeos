"use client";

import { useEffect, useMemo, useState } from "react";
import type { Mkt } from "@/lib/format-money";

const T = {
  card: "#1A1D27", border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280",
  green: "#34D399", red: "#F87171", amber: "#FBBF24", accent: "#818CF8",
};

type Exposure = {
  symbol: string;
  windowStart: string | null;
  windowEnd: string | null;
  observations: number;
  factorCoverage: number;
  status: string;
  r2: number | null;
  betas: Record<string, number>;
  tstats: Record<string, number>;
  significant: string[];
};

type Payload = {
  market: Mkt;
  asOf: string;
  historicalAnalog: { implemented: boolean; regimeRunCount: number; reason: string };
  usRegime: null | {
    weekOf: string; regime: string; dangerScore: number | null; indicatorsAvailable: number;
    indicatorsExpected: number; dataUsable: boolean; unavailableReason: string | null; summary: string | null;
  };
  indiaFactors: Array<{ series: string; asOf: string; value: number; source: string }>;
  indiaExposureCoverage: { ok: number; insufficient: number; latestWindowEnd: string | null } | null;
  indiaExposures: Exposure[];
};

type MacroEvidenceCell = {
  market: Mkt; instrumentFamily: string; series: string; formulaVersion: string; horizonSessions: number;
  matchedDates: number; horizonSpacedWindows: number; symbolRows: number;
  coveragePct: number; spearmanIc: number | null; state: "insufficient" | "descriptive";
};
type MacroPerformance = {
  market: Mkt; evaluatedAt: string; rowsRead: number; cells: MacroEvidenceCell[];
  interpretation: string; limitations: string[];
};

const FACTORS = [
  ["market", "NIFTY 50"],
  ["usdinr", "USD/INR"],
  ["brent", "Brent"],
  ["vix", "India VIX"],
] as const;

const FACTOR_LABELS: Record<string, string> = {
  nifty50_close: "NIFTY 50 close", india_vix: "India VIX", usdinr_spot: "USD/INR spot", brent_front: "Brent front month",
};

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18, minWidth: 0 }}>
    <div style={{ color: T.muted, fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 12 }}>{title}</div>
    {children}
  </section>;
}

function fmt(value: number | null | undefined, digits = 2) {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

export default function MacroContextPanel({ market }: { market: Mkt }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [performance, setPerformance] = useState<MacroPerformance | null>(null);
  const [performanceError, setPerformanceError] = useState<string | null>(null);
  const [horizon, setHorizon] = useState(5);

  useEffect(() => {
    let active = true;
    setPayload(null);
    setError(null);
    fetch(`/api/learning/macro-context?market=${market}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
        return body as Payload;
      })
      .then((data) => { if (active) setPayload(data); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Macro context could not be loaded."); });
    return () => { active = false; };
  }, [market]);

  useEffect(() => {
    let active = true;
    setPerformance(null);
    setPerformanceError(null);
    fetch(`/api/learning/macro-performance?market=${market}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
        return body as MacroPerformance;
      })
      .then((data) => { if (active) setPerformance(data); })
      .catch((cause) => { if (active) setPerformanceError(cause instanceof Error ? cause.message : "Macro outcome evidence could not be loaded."); });
    return () => { active = false; };
  }, [market]);

  const filtered = useMemo(() => {
    const needle = query.trim().toUpperCase();
    const rows = (payload?.indiaExposures ?? []).filter((row) => !needle || row.symbol.includes(needle));
    return showAll ? rows : rows.slice(0, 18);
  }, [payload, query, showAll]);
  const performanceCells = useMemo(() => (performance?.cells ?? []).filter((cell) => cell.horizonSessions === horizon), [performance, horizon]);

  return (
    <div style={{ marginBottom: 24, border: `1px solid ${T.border}`, borderRadius: 14, padding: 18, background: "linear-gradient(130deg, rgba(129,140,248,.07), rgba(26,29,39,.96) 38%)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
        <div>
          <div style={{ color: T.text, fontSize: 17, fontWeight: 650 }}>Macro context &amp; symbol sensitivity</div>
          <div style={{ color: T.sub, fontSize: 12, marginTop: 5 }}>What the app has measured about the current backdrop—and what it has not proven.</div>
        </div>
        <span style={{ color: T.accent, border: `1px solid ${T.border}`, borderRadius: 999, padding: "5px 10px", fontSize: 11, whiteSpace: "nowrap" }}>SHADOW / READ-ONLY</span>
      </div>

      <div style={{ color: T.amber, background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.22)", borderRadius: 9, padding: "10px 12px", fontSize: 12, lineHeight: 1.55, margin: "12px 0 16px" }}>
        Historical episode matching is not active yet. A symbol’s beta below is its past co-movement with a factor—not a causal effect or a forecast of what it will do next.
      </div>

      {error && <div role="status" style={{ color: T.red, fontSize: 13, padding: 12 }}>Could not load stored macro evidence: {error}</div>}
      {!error && !payload && <div style={{ color: T.muted, fontSize: 13, padding: 14 }}>Loading stored macro evidence…</div>}

      {payload && <>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 12 }}>
          {market === "us" && <Card title="United States · MacroSentinel">
            {payload.usRegime ? <>
              <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ color: T.text, fontSize: 20, fontWeight: 700, textTransform: "capitalize" }}>{payload.usRegime.regime}</span>
                <span style={{ color: T.sub, fontSize: 12 }}>danger {fmt(payload.usRegime.dangerScore, 0)} · {payload.usRegime.indicatorsAvailable}/{payload.usRegime.indicatorsExpected} indicators</span>
              </div>
              <div style={{ color: T.muted, fontSize: 11, marginTop: 6 }}>Weekly snapshot: {payload.usRegime.weekOf}{payload.usRegime.dataUsable ? " · inputs pass integrity checks" : ` · unavailable: ${payload.usRegime.unavailableReason ?? "input integrity check failed"}`}</div>
              <p style={{ color: T.sub, fontSize: 12, lineHeight: 1.5, margin: "10px 0 0" }}>This is one US-wide state. It can describe the backdrop, but by itself cannot tell Kairos which stock is more exposed.</p>
            </> : <div style={{ color: T.muted, fontSize: 12 }}>No US MacroSentinel snapshot is stored.</div>}
          </Card>}

          {market === "india" && <Card title="India · dated market factors">
            {payload.indiaFactors.length ? <div style={{ display: "grid", gap: 8 }}>
              {payload.indiaFactors.map((factor) => <div key={factor.series} style={{ display: "flex", justifyContent: "space-between", gap: 12, borderBottom: `1px solid ${T.border}`, paddingBottom: 7 }}>
                <span style={{ color: T.sub, fontSize: 12 }}>{FACTOR_LABELS[factor.series] ?? factor.series}</span>
                <span style={{ textAlign: "right", color: T.text, fontSize: 12 }}>{fmt(factor.value, 2)} <span style={{ color: T.muted }}>· {factor.asOf}</span></span>
              </div>)}
            </div> : <div style={{ color: T.muted, fontSize: 12 }}>No dated India factor observations are stored.</div>}
            <p style={{ color: T.muted, fontSize: 11, lineHeight: 1.45, margin: "10px 0 0" }}>These are context levels only; they are not combined into an India score.</p>
          </Card>}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, margin: "18px 0 10px" }}>
          <div>
            <div style={{ color: T.text, fontSize: 13, fontWeight: 600 }}>{market === "india" ? "India company exposure shadow" : "Symbol-level macro sensitivity"}</div>
            <div style={{ color: T.muted, fontSize: 11, marginTop: 4 }}>
              {market === "india" && payload.indiaExposureCoverage ? `${payload.indiaExposureCoverage.ok} latest stored estimates meet the estimator’s data floor; ${payload.indiaExposureCoverage.insufficient} are insufficient. Latest window ends ${payload.indiaExposureCoverage.latestWindowEnd ?? "—"}.` : "No per-symbol macro-exposure producer is available for this market yet."}
            </div>
          </div>
          {market === "india" && <input aria-label="Filter India symbol exposures" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter symbol…" style={{ width: 170, background: "#11131A", color: T.text, border: `1px solid ${T.border}`, borderRadius: 7, padding: "8px 10px", fontSize: 12 }} />}
        </div>

        {market === "india" && payload.indiaExposures.length > 0 ? <>
          <div style={{ overflowX: "auto", border: `1px solid ${T.border}`, borderRadius: 8 }}>
            <table style={{ borderCollapse: "collapse", minWidth: 820, width: "100%", fontSize: 11 }}>
              <thead><tr style={{ color: T.muted, textAlign: "left", background: "rgba(0,0,0,.12)" }}>
                {["Symbol / status", "Window", "N", ...FACTORS.map(([, label]) => `${label} β (t)`), "R²"].map((label) => <th key={label} style={{ padding: "9px 10px", borderBottom: `1px solid ${T.border}`, fontWeight: 550, whiteSpace: "nowrap" }}>{label}</th>)}
              </tr></thead>
              <tbody>{filtered.map((row) => <tr key={row.symbol} style={{ color: T.text }}>
                <td style={{ padding: "8px 10px", borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap" }}><strong>{row.symbol}</strong><div style={{ color: row.status === "ok" ? T.green : T.amber, fontSize: 10, marginTop: 3 }}>{row.status}</div></td>
                <td style={{ padding: "8px 10px", color: T.sub, borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap" }}>{row.windowStart ?? "—"} → {row.windowEnd ?? "—"}</td>
                <td style={{ padding: "8px 10px", color: T.sub, borderBottom: `1px solid ${T.border}` }}>{row.observations}</td>
                {FACTORS.map(([key]) => <td key={key} style={{ padding: "8px 10px", borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap" }}>
                  {row.status === "ok" ? <>{fmt(row.betas?.[key])} <span style={{ color: T.muted }}>({fmt(row.tstats?.[key])})</span></> : "—"}
                </td>)}
                <td style={{ padding: "8px 10px", color: T.sub, borderBottom: `1px solid ${T.border}` }}>{row.status === "ok" ? fmt(row.r2, 3) : "—"}</td>
              </tr>)}</tbody>
            </table>
          </div>
          {!filtered.length && <div style={{ color: T.muted, fontSize: 12, padding: 12 }}>No symbol matches that filter.</div>}
          {!query && payload.indiaExposures.length > 18 && <button onClick={() => setShowAll((value) => !value)} style={{ marginTop: 9, background: "transparent", color: T.accent, border: 0, cursor: "pointer", padding: 0, fontSize: 12 }}>{showAll ? "Show fewer" : `Show all ${payload.indiaExposures.length} estimates`}</button>}
          <div style={{ color: T.muted, fontSize: 11, lineHeight: 1.5, marginTop: 10 }}>β is the historical OLS association with a 1% daily factor move; t-stat is shown in parentheses. The estimator is not regime-conditioned, does not prove causality, and is not connected to the scorer or trader.</div>
        </> : market === "india" ? <div style={{ color: T.muted, fontSize: 12, padding: 12, border: `1px dashed ${T.border}`, borderRadius: 8 }}>No India per-symbol exposure estimates are stored yet.</div> : <div style={{ color: T.muted, fontSize: 12, padding: 12, border: `1px dashed ${T.border}`, borderRadius: 8 }}>A US per-symbol macro-exposure estimator is not built. The current US macro number is market-wide.</div>}

        <div style={{ color: T.muted, fontSize: 11, lineHeight: 1.5, marginTop: 14, borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>
          <strong style={{ color: T.sub }}>Historical analog status:</strong> {payload.historicalAnalog.reason} {payload.market === "us" ? `The append-only market-local regime ledger has ${payload.historicalAnalog.regimeRunCount} US run(s).` : `The append-only market-local regime ledger has ${payload.historicalAnalog.regimeRunCount} India run(s).`}
        </div>
      </>}

      <section id="learning-macro-evidence" aria-label="Macro forward outcome evidence" style={{ marginTop: 18, borderTop: `1px solid ${T.border}`, paddingTop: 16, scrollMarginTop: 24 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ color: T.text, fontSize: 14, fontWeight: 650 }}>Macro context vs. realized forward moves</div>
            <div style={{ color: T.muted, fontSize: 11, marginTop: 4 }}>Matured, benchmark-neutral research outcomes; one aggregate per date and instrument family.</div>
          </div>
          <label style={{ color: T.sub, fontSize: 11, display: "flex", gap: 7, alignItems: "center" }}>
            Horizon
            <select aria-label="Macro evidence horizon" value={horizon} onChange={(event) => setHorizon(Number(event.target.value))} style={{ background: "#11131A", color: T.text, border: `1px solid ${T.border}`, borderRadius: 7, padding: "6px 8px" }}>
              {[2, 5, 10, 20].map((days) => <option key={days} value={days}>{days} sessions</option>)}
            </select>
          </label>
        </div>
        {performanceError && <div role="status" style={{ color: T.red, fontSize: 12, padding: "12px 0" }}>Outcome evidence unavailable: {performanceError}</div>}
        {!performanceError && !performance && <div style={{ color: T.muted, fontSize: 12, padding: "12px 0" }}>Loading matured outcome evidence…</div>}
        {performance && <>
          <div style={{ color: T.sub, fontSize: 12, lineHeight: 1.55, margin: "10px 0 12px" }}>{performance.interpretation}</div>
          {performanceCells.length ? <div style={{ overflowX: "auto", border: `1px solid ${T.border}`, borderRadius: 8 }}>
            <table style={{ borderCollapse: "collapse", minWidth: 680, width: "100%", fontSize: 11 }}>
              <thead><tr style={{ color: T.muted, textAlign: "left", background: "rgba(0,0,0,.12)" }}>
                {["Instrument family", "Macro / score series", "Formula version", "Dates", "Horizon-spaced windows", "Symbol rows", "Spearman IC", "Evidence"].map((label) => <th key={label} style={{ padding: "9px 10px", borderBottom: `1px solid ${T.border}`, fontWeight: 550, whiteSpace: "nowrap" }}>{label}</th>)}
              </tr></thead>
              <tbody>{performanceCells.map((cell) => <tr key={`${cell.instrumentFamily}-${cell.series}-${cell.formulaVersion}`} style={{ color: T.text }}>
                <td style={{ padding: "8px 10px", borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap" }}>{cell.instrumentFamily.replaceAll("_", " ")}</td>
                <td style={{ padding: "8px 10px", borderBottom: `1px solid ${T.border}` }}>{cell.series}</td>
                <td style={{ padding: "8px 10px", color: T.sub, borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap" }}>{cell.formulaVersion}</td>
                <td style={{ padding: "8px 10px", color: T.sub, borderBottom: `1px solid ${T.border}` }}>{cell.matchedDates}</td>
                <td style={{ padding: "8px 10px", color: T.sub, borderBottom: `1px solid ${T.border}` }}>{cell.horizonSpacedWindows}</td>
                <td style={{ padding: "8px 10px", color: T.sub, borderBottom: `1px solid ${T.border}` }}>{cell.symbolRows}</td>
                <td style={{ padding: "8px 10px", borderBottom: `1px solid ${T.border}`, color: cell.spearmanIc == null ? T.muted : cell.spearmanIc >= 0 ? T.green : T.red }}>{fmt(cell.spearmanIc, 3)}</td>
                <td style={{ padding: "8px 10px", borderBottom: `1px solid ${T.border}`, color: cell.state === "descriptive" ? T.amber : T.muted }}>{cell.state}</td>
              </tr>)}</tbody>
            </table>
          </div> : <div style={{ color: T.muted, fontSize: 12, padding: 12, border: `1px dashed ${T.border}`, borderRadius: 8 }}>No matched macro/label rows at this horizon yet. This is insufficient evidence, not a zero or a pass.</div>}
          <div style={{ color: T.muted, fontSize: 11, lineHeight: 1.5, marginTop: 10 }}>
            <strong style={{ color: T.sub }}>Read this carefully:</strong> IC here is a descriptive time-series association, not cross-sectional stock-ranking IC. Horizon-spaced windows are not an effective sample size or independent episodes. No t-stat or promotion verdict is claimed. {performance.market === "india" ? "India macro remains out of the composite; factors are joined using their first-seen collection time." : "US macro is a shared score term; this cannot rank one US symbol above another on the same day."}
          </div>
          <div style={{ color: T.muted, fontSize: 11, lineHeight: 1.5, marginTop: 7 }}>
            <strong style={{ color: T.sub }}>Council coverage:</strong> each model receives the frozen deterministic dimension scores and available feature evidence, including US macro where present. It returns one overall score; there is no separate council macro score, so the app cannot claim a model relied on macro from its final score alone.
          </div>
        </>}
      </section>
    </div>
  );
}
