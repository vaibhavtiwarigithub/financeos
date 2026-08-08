"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, BookOpenCheck, ChartNoAxesCombined, ShieldCheck } from "lucide-react";
import { Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from "recharts";
import { EmptyState, fieldStyle, FieldLabel, LocalOnlyNotice, PropertyPageFrame, PT, StatCell } from "./PropertyPrimitives";
import { calibrationBlocker, MIN_MATURED_OUTCOMES, summarizeCalibration, type MaturedOutcome } from "@/lib/property/calibration";
import { PROPERTY_MARKETS, type PropertyMarketId } from "@/lib/property/registry";
import { usePropertyMarket } from "@/lib/property/market-context";

// Forecasts here are SHADOW decision support. They are never a promise, and
// nothing on this page is read by a securities score, an order, or any money
// path. The user "assumption fan" below is explicitly NOT written to the
// forecast ledger — it is compound-interest arithmetic on numbers the owner
// typed, and it is labelled as such so it can never be mistaken for a Kairos
// prediction that was scored against reality.

type Outcome = { actual_value: number | string; evaluated_at: string; absolute_error: number | string; interval_covered: boolean };
type Forecast = {
  id: number;
  geography_slug: PropertyMarketId;
  metric_key: string;
  horizon_days: number;
  cutoff_at: string;
  lower_value: number | string;
  base_value: number | string;
  upper_value: number | string;
  model_version: string;
  state: string;
  outcome: Outcome | null;
};

const METRIC_LABEL: Record<string, string> = {
  price_index: "Home price index",
  rent_index: "Rent index",
  mortgage_rate: "Mortgage rate",
};

function maturityDate(f: Forecast): string {
  return new Date(new Date(f.cutoff_at).getTime() + f.horizon_days * 86_400_000).toISOString().slice(0, 10);
}

export default function ForecastLearningWorkspace() {
  const { market, setMarket } = usePropertyMarket();
  const [forecasts, setForecasts] = useState<Forecast[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // User assumption fan — local only, never persisted.
  const [baseline, setBaseline] = useState("100");
  const [growth, setGrowth] = useState("");
  const [uncertainty, setUncertainty] = useState("3");
  const [years, setYears] = useState("5");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/property/forecasts", { cache: "no-store" });
      // A 5xx must never render as "no forecasts yet" — an outage and an empty
      // ledger look identical to a reader unless we say which it is.
      if (!response.ok) throw new Error(`Forecast ledger unavailable (HTTP ${response.status})`);
      const json = await response.json();
      setForecasts(json.forecasts ?? []);
      setLoadError(null);
    } catch (error) {
      setForecasts([]);
      setLoadError(error instanceof Error ? error.message : "Forecast ledger unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const scenario = useMemo(() => {
    const start = Number(baseline); const rate = Number(growth);
    const spread = Math.max(0, Number(uncertainty) || 0);
    const count = Math.min(15, Math.max(1, Math.round(Number(years) || 1)));
    if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(rate) || growth.trim() === "") return [];
    return Array.from({ length: count + 1 }, (_, year) => ({
      year,
      base: Number((start * (1 + rate / 100) ** year).toFixed(2)),
      lower: Number((start * (1 + (rate - spread) / 100) ** year).toFixed(2)),
      upper: Number((start * (1 + (rate + spread) / 100) ** year).toFixed(2)),
    }));
  }, [baseline, growth, uncertainty, years]);

  const matured = useMemo(() => forecasts.filter((f) => f.outcome != null), [forecasts]);

  // Calibration is computed per (market, metric). US and India are never pooled
  // — different currencies, sources and publication calendars.
  const calibration = useMemo(() => {
    const groups = new Map<string, { market: string; metric: string; rows: MaturedOutcome[] }>();
    for (const f of matured) {
      const key = `${f.geography_slug}|${f.metric_key}`;
      const bucket = groups.get(key) ?? { market: f.geography_slug, metric: f.metric_key, rows: [] };
      bucket.rows.push({
        intervalCovered: f.outcome!.interval_covered,
        absoluteError: Number(f.outcome!.absolute_error),
        baseValue: Number(f.base_value),
      });
      groups.set(key, bucket);
    }
    return [...groups.values()].map((g) => summarizeCalibration(g.market, g.metric, g.rows));
  }, [matured]);

  const scoreable = calibration.filter((c) => c.sufficient).length;

  // Forecast-vs-actual, only for matured rows. An unmatured forecast has no
  // actual to plot and must not appear as a point at zero.
  const chart = useMemo(() => matured.map((f) => ({
    label: `${METRIC_LABEL[f.metric_key] ?? f.metric_key} · ${maturityDate(f)}`,
    lower: Number(f.lower_value),
    base: Number(f.base_value),
    upper: Number(f.upper_value),
    band: [Number(f.lower_value), Number(f.upper_value)] as [number, number],
    actual: Number(f.outcome!.actual_value),
  })), [matured]);

  return (
    <PropertyPageFrame eyebrow="Shadow workspace" title="Forecasts & learning" description="Shadow forecasts scored against what was later observed. Nothing here is a promise, and no securities score, order or money path reads it." help={{ whatItDoes: "Shows persisted market-level shadow forecasts beside eventual observations. It also keeps your separate manual compound-growth scenario out of the learning ledger.", whatToLookFor: ["Calibration is withheld until at least 10 outcomes mature for the exact market and metric.", "Dashed ranges are forecast scenarios, not a property appraisal or price guarantee.", "Your manual assumption chart is useful for planning but is not a Kairos prediction."] }}>
      <div className="property-stat-row" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", borderBottom: `1px solid ${PT.border}` }}>
        <StatCell label="SHADOW FORECASTS" value={loading ? "…" : String(forecasts.length)} detail="Append-only ledger" />
        <StatCell label="MATURED OUTCOMES" value={loading ? "…" : String(matured.length)} detail="Horizon elapsed and observed" />
        <StatCell label="SCOREABLE COHORTS" value={loading ? "…" : String(scoreable)} tone={scoreable ? PT.accent : PT.amber} detail={`Needs ${MIN_MATURED_OUTCOMES} matured each`} />
        <StatCell label="ADVISORY STATUS" value="Disabled" detail="Decision support only, never an input" />
      </div>

      {loadError ? (
        <div role="alert" style={{ margin: "14px 28px 0", padding: "11px 13px", border: `1px solid ${PT.red}`, borderRadius: "6px", color: PT.red, fontSize: "11px", display: "flex", gap: "8px", alignItems: "center" }}>
          <AlertTriangle size={15} />{loadError} — this is a load failure, not an empty ledger.
        </div>
      ) : null}

      <div className="property-page-body" style={{ padding: "22px 28px", display: "grid", gap: "18px" }}>
        <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", overflow: "hidden" }}>
          <div style={{ padding: "13px 15px", display: "flex", alignItems: "center", gap: "8px", borderBottom: `1px solid ${PT.border}`, background: PT.surface }}>
            <BookOpenCheck size={15} color={PT.accent} /><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>Forecast range versus observed outcome</h2>
          </div>
          {loading ? <EmptyState title="Loading the forecast ledger" detail="Reading persisted shadow forecasts and any matured outcomes." />
            : chart.length === 0 ? (
              <EmptyState
                title={forecasts.length ? `${forecasts.length} forecast(s) recorded, none matured yet` : "No forecasts recorded yet"}
                detail={forecasts.length
                  ? "A forecast is scored only after its horizon elapses AND a later observation exists for that metric. Nothing is plotted until then."
                  : "The weekly job kairos-property-forecast runs Sundays at 10:30 UTC and writes a shadow forecast per market and metric once that metric has enough observation history. Price-index forecasts use a 365-day horizon and mortgage-rate 90 days, so the first scoreable outcome is at least a quarter away."} />
            ) : (
              <div className="property-chart" style={{ height: "320px", padding: "16px 10px 8px" }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chart} margin={{ top: 8, right: 15, left: 0, bottom: 30 }}>
                    <CartesianGrid stroke={PT.border} vertical={false} />
                    <XAxis dataKey="label" tick={{ fill: PT.muted, fontSize: 9 }} angle={-12} textAnchor="end" height={54} />
                    <YAxis tick={{ fill: PT.muted, fontSize: 10 }} domain={["auto", "auto"]} />
                    <Tooltip contentStyle={{ background: PT.cardRaised, border: `1px solid ${PT.border}`, borderRadius: "6px", fontSize: "11px" }} />
                    <Legend wrapperStyle={{ fontSize: "10px" }} />
                    <Area dataKey="band" name="Forecast range" stroke="none" fill={PT.amber} fillOpacity={0.15} isAnimationActive={false} />
                    <Line type="monotone" dataKey="base" name="Forecast (base)" stroke={PT.amber} strokeDasharray="4 3" dot strokeWidth={2} isAnimationActive={false} />
                    <Scatter dataKey="actual" name="Observed actual" fill={PT.accent} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
        </section>

        <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", overflow: "hidden" }}>
          <div style={{ padding: "13px 15px", display: "flex", alignItems: "center", gap: "8px", borderBottom: `1px solid ${PT.border}`, background: PT.surface }}>
            <ShieldCheck size={15} color={PT.blue} /><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>Calibration</h2>
            <span style={{ marginLeft: "auto", color: PT.muted, fontSize: "9px" }}>n is shown for every cohort; rates are withheld below {MIN_MATURED_OUTCOMES}</span>
          </div>
          {calibration.length === 0 ? (
            <EmptyState title="Nothing to calibrate yet" detail={`Calibration compares each forecast interval against the value later observed. It reports a coverage rate only once a market-and-metric cohort reaches ${MIN_MATURED_OUTCOMES} matured outcomes; below that a percentage would be arithmetic noise.`} />
          ) : (
            <>
              <div className="property-table-header" style={{ display: "grid", gridTemplateColumns: "1fr 1fr .5fr .9fr .9fr 1.6fr", gap: "8px", padding: "9px 12px", color: PT.muted, fontSize: "9px", fontWeight: 800, borderBottom: `1px solid ${PT.border}` }}>
                <span>MARKET</span><span>METRIC</span><span>n</span><span>COVERAGE</span><span>MAPE</span><span>STATUS</span>
              </div>
              {calibration.map((c) => {
                const blocker = calibrationBlocker(c);
                return (
                  <div className="property-table-row" key={`${c.market}-${c.metric}`} style={{ display: "grid", gridTemplateColumns: "1fr 1fr .5fr .9fr .9fr 1.6fr", gap: "8px", alignItems: "center", padding: "12px", borderBottom: `1px solid ${PT.border}`, color: PT.textSub, fontSize: "10px" }}>
                    <span data-label="MARKET" style={{ color: PT.text }}>{PROPERTY_MARKETS.find((m) => m.id === c.market)?.label ?? c.market}</span>
                    <span data-label="METRIC">{METRIC_LABEL[c.metric] ?? c.metric}</span>
                    <span data-label="N">{c.n}</span>
                    <span data-label="COVERAGE">{c.intervalCoveragePct == null ? "—" : `${c.intervalCoveragePct.toFixed(0)}%`}</span>
                    <span data-label="MAPE">{c.meanAbsolutePercentError == null ? "—" : `${c.meanAbsolutePercentError.toFixed(2)}%`}</span>
                    <span data-label="READINESS" style={{ color: blocker ? PT.amber : PT.accent }}>{blocker ?? "Scoreable"}</span>
                  </div>
                );
              })}
            </>
          )}
        </section>

        {forecasts.length ? (
          <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", overflow: "hidden" }}>
            <div style={{ padding: "13px 15px", borderBottom: `1px solid ${PT.border}`, background: PT.surface }}><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>Forecast evidence ledger</h2></div>
            <div className="property-table-header" style={{ display: "grid", gridTemplateColumns: ".9fr 1fr .8fr .8fr 1fr .8fr", gap: "8px", padding: "9px 12px", color: PT.muted, fontSize: "9px", fontWeight: 800, borderBottom: `1px solid ${PT.border}` }}>
              <span>MARKET</span><span>METRIC</span><span>CUTOFF</span><span>MATURES</span><span>RANGE / ACTUAL</span><span>COVERED</span>
            </div>
            {forecasts.slice(0, 40).map((f) => (
              <div className="property-table-row" key={f.id} style={{ display: "grid", gridTemplateColumns: ".9fr 1fr .8fr .8fr 1fr .8fr", gap: "8px", alignItems: "center", padding: "12px", borderBottom: `1px solid ${PT.border}`, color: PT.textSub, fontSize: "10px" }}>
                <span data-label="MARKET" style={{ color: PT.text }}>{PROPERTY_MARKETS.find((m) => m.id === f.geography_slug)?.label ?? f.geography_slug}</span>
                <span data-label="METRIC">{METRIC_LABEL[f.metric_key] ?? f.metric_key}</span>
                <span data-label="CUTOFF">{f.cutoff_at.slice(0, 10)}</span>
                <span data-label="MATURES">{maturityDate(f)}</span>
                <span data-label="RANGE / ACTUAL">{Number(f.lower_value).toFixed(2)}–{Number(f.upper_value).toFixed(2)}{f.outcome ? ` → ${Number(f.outcome.actual_value).toFixed(2)}` : ""}</span>
                <span data-label="COVERED" style={{ color: !f.outcome ? PT.muted : f.outcome.interval_covered ? PT.accent : PT.red }}>
                  {!f.outcome ? "unmatured" : f.outcome.interval_covered ? "yes" : "no"}
                </span>
              </div>
            ))}
          </section>
        ) : null}

        <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "minmax(280px, 350px) minmax(0, 1fr)", gap: "18px", alignItems: "stretch" }}>
          <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", padding: "16px", background: PT.surface }}>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "14px" }}><ChartNoAxesCombined size={15} color={PT.accent} /><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>Assumption fan</h2></div>
            <div style={{ display: "grid", gap: "12px" }}>
              <FieldLabel label="Market">
                <select value={market} onChange={(e) => setMarket(e.target.value as PropertyMarketId)} style={fieldStyle}>
                  {PROPERTY_MARKETS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </FieldLabel>
              <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <FieldLabel label="Starting index"><input inputMode="decimal" value={baseline} onChange={(e) => setBaseline(e.target.value)} style={fieldStyle} /></FieldLabel>
                <FieldLabel label="Years"><input inputMode="numeric" value={years} onChange={(e) => setYears(e.target.value)} style={fieldStyle} /></FieldLabel>
                <FieldLabel label="Annual change %"><input inputMode="decimal" value={growth} onChange={(e) => setGrowth(e.target.value)} placeholder="Enter assumption" style={fieldStyle} /></FieldLabel>
                <FieldLabel label="Range +/- %"><input inputMode="decimal" value={uncertainty} onChange={(e) => setUncertainty(e.target.value)} style={fieldStyle} /></FieldLabel>
              </div>
              <LocalOnlyNotice>Compound-interest scenario math on your own numbers. It uses no market data, is never written to the forecast ledger above, and is never scored for calibration.</LocalOnlyNotice>
            </div>
          </section>
          <section style={{ minWidth: 0, border: `1px solid ${PT.border}`, borderRadius: "7px", overflow: "hidden" }}>
            <div style={{ padding: "13px 15px", borderBottom: `1px solid ${PT.border}`, background: PT.surface, display: "flex", justifyContent: "space-between", gap: "12px" }}>
              <div><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>{PROPERTY_MARKETS.find((m) => m.id === market)?.label} user scenario</h2><div style={{ color: PT.muted, fontSize: "9px", marginTop: "3px" }}>Index basis; not a currency valuation</div></div>
              <span style={{ color: PT.blue, fontSize: "9px", fontWeight: 800 }}>USER ASSUMPTION</span>
            </div>
            <div className="property-chart" style={{ height: "300px", padding: "16px 10px 8px" }}>
              {scenario.length === 0 ? <EmptyState title="Enter an annual-change assumption" detail="The chart stays blank until you supply a scenario. Kairos will not invent a market forecast to fill this space." /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={scenario} margin={{ top: 8, right: 15, left: 0, bottom: 8 }}>
                    <defs><linearGradient id="propertyScenarioBand" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={PT.blue} stopOpacity={0.18} /><stop offset="100%" stopColor={PT.blue} stopOpacity={0.02} /></linearGradient></defs>
                    <CartesianGrid stroke={PT.border} vertical={false} />
                    <XAxis dataKey="year" tick={{ fill: PT.muted, fontSize: 10 }} label={{ value: "Year", position: "insideBottom", offset: -2, fill: PT.muted, fontSize: 10 }} />
                    <YAxis tick={{ fill: PT.muted, fontSize: 10 }} domain={["auto", "auto"]} />
                    <Tooltip contentStyle={{ background: PT.cardRaised, border: `1px solid ${PT.border}`, borderRadius: "6px", fontSize: "11px" }} />
                    <Area type="monotone" dataKey="upper" stroke="transparent" fill="url(#propertyScenarioBand)" name="Upper path" />
                    <Line type="monotone" dataKey="upper" stroke={PT.blue} strokeDasharray="4 4" dot={false} name="Upper path" />
                    <Line type="monotone" dataKey="base" stroke={PT.accent} strokeWidth={2} dot={false} name="Base path" />
                    <Line type="monotone" dataKey="lower" stroke={PT.blue} strokeDasharray="4 4" dot={false} name="Lower path" />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>
          </section>
        </div>
      </div>
    </PropertyPageFrame>
  );
}
