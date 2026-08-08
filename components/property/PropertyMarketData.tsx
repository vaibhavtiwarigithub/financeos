"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, RefreshCw } from "lucide-react";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { marketById, sourcesForMarket, type PropertyMarketId } from "@/lib/property/registry";
import { PT, PropertyPageFrame } from "./PropertyPrimitives";
import { PROPERTY_CHART_WINDOWS, propertyWindowCutoff, type PropertyChartWindowId } from "@/lib/property/chart-windows";
import { usePropertyMarket } from "@/lib/property/market-context";

type Observation = { source_key: string; metric_key: string; native_unit: string; value: number | string; as_of: string; revision_state: string };
type Forecast = { metric_key: string; horizon_days: number; cutoff_at: string; lower_value: number | string; base_value: number | string; upper_value: number | string; model_version: string; state: string };
type Run = { source_key: string; outcome: string; started_at: string; rows_written: number | null; error_code: string | null };

/** Cap plotted points so a 2,889-row weekly series stays legible and cheap. */
const MAX_POINTS = 220;
function downsample<T>(rows: T[]): T[] {
  if (rows.length <= MAX_POINTS) return rows;
  const step = rows.length / MAX_POINTS;
  const out: T[] = [];
  for (let i = 0; i < MAX_POINTS; i++) out.push(rows[Math.floor(i * step)]);
  // Always keep the true latest point — a sampled series that drops the most
  // recent observation misreports "as of" on the very number people read first.
  const last = rows[rows.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

const METRIC_LABEL: Record<string, string> = {
  price_index: "Home price index (FHFA)",
  rent_reference_studio: "HUD studio area rent reference (not a property estimate)",
  rent_reference_one_bedroom: "HUD one-bedroom area rent reference (not a property estimate)",
  rent_reference_two_bedroom: "HUD two-bedroom area rent reference (not a property estimate)",
  rent_reference_three_bedroom: "HUD three-bedroom area rent reference (not a property estimate)",
  rent_reference_four_bedroom: "HUD four-bedroom area rent reference (not a property estimate)",
  mortgage_rate: "30-year mortgage rate (FRED)",
  unemployment_rate: "Metro unemployment (BLS LAUS)",
};

export default function PropertyMarketData({ marketId: initialMarketId }: { marketId?: PropertyMarketId }) {
  const { market: marketId, setMarket } = usePropertyMarket();
  const market = marketById(marketId);
  const [payload, setPayload] = useState<{ observations: Observation[]; forecasts: Forecast[]; runs: Run[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [windowId, setWindowId] = useState<PropertyChartWindowId>("5y");

  useEffect(() => { if (initialMarketId) setMarket(initialMarketId); }, [initialMarketId, setMarket]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/property/overview?market=${marketId}`, { cache: "no-store" });
      // The previous version never checked this, so a 5xx rendered as "no
      // observations yet" — an outage was indistinguishable from an empty market.
      if (!response.ok) throw new Error(`Market evidence unavailable (HTTP ${response.status})`);
      setPayload(await response.json());
      setLoadError(null);
    } catch (error) {
      setPayload(null);
      setLoadError(error instanceof Error ? error.message : "Market evidence unavailable");
    } finally {
      setLoading(false);
    }
  }, [marketId]);

  useEffect(() => { void load(); }, [load]);

  const cutoff = useMemo(() => {
    return propertyWindowCutoff(windowId);
  }, [windowId]);

  const grouped = useMemo(() => {
    const map = new Map<string, Observation[]>();
    for (const row of payload?.observations ?? []) {
      if (cutoff && row.as_of < cutoff) continue;
      map.set(row.metric_key, [...(map.get(row.metric_key) ?? []), row]);
    }
    return map;
  }, [payload, cutoff]);

  const forecastByMetric = useMemo(() => {
    const map = new Map<string, Forecast>();
    for (const f of payload?.forecasts ?? []) if (f.state === "shadow" && !map.has(f.metric_key)) map.set(f.metric_key, f);
    return map;
  }, [payload]);

  // Sources that structurally cannot cover this market, straight from the run
  // ledger. Bengaluru showing three empty charts with no explanation was the
  // dishonest-coverage failure; this states the gap instead.
  const notApplicable = useMemo(
    () => [...new Set((payload?.runs ?? []).filter((r) => r.outcome === "not_applicable").map((r) => r.source_key))],
    [payload],
  );
  const failedRuns = useMemo(
    () => (payload?.runs ?? []).filter((r) => r.outcome === "failed").slice(0, 3),
    [payload],
  );

  async function collect() {
    setMessage("Collecting official releases…");
    try {
      const response = await fetch(`/api/property/collect?market=${marketId}`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `Collection failed (HTTP ${response.status})`);
      const rows = (result.results ?? []) as Array<{ outcome: string; rowsWritten?: number }>;
      const ok = rows.filter((r) => r.outcome === "success").length;
      const na = rows.filter((r) => r.outcome === "not_applicable").length;
      const failed = rows.filter((r) => r.outcome === "failed").length;
      const unavailable = rows.filter((r) => r.outcome === "unavailable").length;
      const written = rows.reduce((sum, r) => sum + (r.rowsWritten ?? 0), 0);
      // Report every category. Counting only successes made a market with no
      // applicable sources read as a failed collection.
      setMessage([
        `${ok} succeeded (${written} new rows)`,
        na ? `${na} not applicable to this market` : null,
        unavailable ? `${unavailable} unavailable` : null,
        failed ? `${failed} failed` : null,
      ].filter(Boolean).join(" · "));
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Collection failed");
    }
  }

  return <PropertyPageFrame eyebrow="Market explorer" title={`${market.label} market pack`} description={market.scope} help={{ whatItDoes: "Displays the approved market-level time series for the selected city and their source health. It is context for property decisions, not a property valuation.", whatToLookFor: ["Check the observation date and source before relying on a chart.", "A dashed line is a shadow forecast range, not a price promise.", "Bengaluru has no US-data substitute; unavailable coverage is shown explicitly."] }} action={<button onClick={() => void collect()} disabled={loading} style={{ border: `1px solid ${PT.border}`, background: PT.surface, color: PT.textSub, borderRadius: "6px", padding: "8px 11px", fontSize: "11px", cursor: "pointer", display: "flex", alignItems: "center", gap: "6px" }}><RefreshCw size={13} />Refresh official data</button>}>
    <div className="property-market-data" style={{ padding: "28px", maxWidth: "1500px" }}>

    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", margin: "20px 0 16px" }}>{PROPERTY_CHART_WINDOWS.map(w => <button key={w.id} type="button" onClick={() => setWindowId(w.id)} style={{ padding: "5px 11px", border: `1px solid ${w.id === windowId ? PT.accent : PT.border}`, background: "transparent", borderRadius: "5px", color: w.id === windowId ? PT.accent : PT.muted, fontSize: "10px", cursor: "pointer" }}>{w.label}</button>)}</div>

    {message ? <div style={{ color: PT.textSub, fontSize: "11px", marginBottom: "12px" }}>{message}</div> : null}

    {loadError ? (
      <div role="alert" style={{ border: `1px solid ${PT.red}`, borderRadius: "7px", padding: "18px", color: PT.red, fontSize: "12px", display: "flex", gap: "9px", alignItems: "center" }}>
        <AlertTriangle size={16} />{loadError} — this is a load failure, not an empty market.
      </div>
    ) : loading ? <div style={{ color: PT.muted, padding: "50px 0" }}>Loading property evidence…</div>
      : grouped.size === 0 ? (
        <div style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", padding: "34px 20px", color: PT.muted, textAlign: "center", fontSize: "12px" }}>
          <div style={{ color: PT.text, marginBottom: "7px" }}>No observations for {market.label} in this window.</div>
          {notApplicable.length
            ? <div>The active official sources ({notApplicable.join(", ")}) publish <strong style={{ color: PT.amber }}>US-only</strong> data and structurally cannot cover this market. No US value is substituted here.</div>
            : <div>Only active, permitted source adapters can populate these charts. Try a longer window or refresh official data.</div>}
        </div>
      ) : (
        <div className="property-market-chart-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: "12px" }}>
          {[...grouped].map(([metric, rows]) => {
            const latest = rows[rows.length - 1];
            const forecast = forecastByMetric.get(metric);
            const points: Array<Record<string, unknown>> = downsample(rows).map((r) => ({ as_of: r.as_of, observed: Number(r.value) }));
            // The forecast is drawn as a separate series with its own band, so an
            // estimate can never be mistaken for an observation.
            if (forecast) {
              const at = new Date(new Date(forecast.cutoff_at).getTime() + forecast.horizon_days * 86_400_000).toISOString().slice(0, 10);
              points[points.length - 1] = { ...points[points.length - 1], forecast: Number(latest.value), band: [Number(latest.value), Number(latest.value)] };
              points.push({ as_of: at, forecast: Number(forecast.base_value), band: [Number(forecast.lower_value), Number(forecast.upper_value)] });
            }
            return <section key={metric} style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", background: PT.surface, overflow: "hidden" }}>
              <div style={{ padding: "13px 15px", borderBottom: `1px solid ${PT.border}`, display: "flex", justifyContent: "space-between", gap: "8px" }}>
                <div>
                  <strong style={{ fontSize: "12px", color: PT.text }}>{METRIC_LABEL[metric] ?? metric.replaceAll("_", " ")}</strong>
                  <div style={{ fontSize: "9px", color: PT.muted, marginTop: "3px" }}>{latest.source_key} · {latest.native_unit} · as of {latest.as_of} · {rows.length} observations{rows.length > MAX_POINTS ? ` (${MAX_POINTS} plotted)` : ""}</div>
                </div>
                <Activity size={14} color={PT.accent} />
              </div>
              <div className="property-chart" style={{ height: "230px", padding: "12px 8px" }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={points}>
                    <CartesianGrid stroke={PT.border} vertical={false} />
                    <XAxis dataKey="as_of" tick={{ fill: PT.muted, fontSize: 9 }} minTickGap={35} />
                    <YAxis tick={{ fill: PT.muted, fontSize: 9 }} domain={["auto", "auto"]} />
                    <Tooltip contentStyle={{ background: PT.cardRaised, border: `1px solid ${PT.border}`, borderRadius: "6px", fontSize: "10px" }} />
                    {forecast ? <Area dataKey="band" name="Forecast range" stroke="none" fill={PT.amber} fillOpacity={0.15} isAnimationActive={false} /> : null}
                    <Line type="monotone" dataKey="observed" name="Observed" stroke={PT.accent} dot={false} strokeWidth={2} isAnimationActive={false} connectNulls={false} />
                    {forecast ? <Line type="monotone" dataKey="forecast" name="Forecast (shadow)" stroke={PT.amber} strokeDasharray="4 3" dot={false} strokeWidth={2} isAnimationActive={false} connectNulls /> : null}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              {forecast ? <div style={{ padding: "0 15px 12px", fontSize: "9px", color: PT.amber }}>Dashed line and shaded band are a shadow forecast ({forecast.model_version}); they are decision support, never a promise and never a trading input.</div> : null}
              {metric.startsWith("rent_reference_") ? <div style={{ padding: "0 15px 12px", fontSize: "9px", color: PT.amber }}>HUD Fair Market Rent is an annual metro affordability reference by bedroom count. It is not a comparable rent, appraisal, rent estimate, or underwriting input.</div> : null}
            </section>;
          })}
        </div>
      )}

    {failedRuns.length ? (
      <section style={{ marginTop: "18px", border: `1px solid ${PT.red}`, borderRadius: "7px", padding: "12px 15px" }}>
        <div style={{ color: PT.red, fontSize: "11px", fontWeight: 700, marginBottom: "6px" }}>Recent source failures</div>
        {failedRuns.map((r, i) => <div key={i} style={{ fontSize: "10px", color: PT.textSub }}>{r.source_key} · {new Date(r.started_at).toLocaleString()} · {r.error_code ?? "error"}</div>)}
      </section>
    ) : null}

    <section style={{ marginTop: "20px", borderTop: `1px solid ${PT.border}`, paddingTop: "16px" }}>
      <h2 style={{ fontSize: "13px", margin: "0 0 9px" }}>Source status</h2>
      {sourcesForMarket(marketId).map(source => <div className="property-source-row" key={source.id} style={{ display: "grid", gridTemplateColumns: "1.2fr .7fr 1.5fr", gap: "10px", padding: "9px 0", borderBottom: `1px solid ${PT.border}`, fontSize: "10px" }}><span style={{ color: PT.text }}>{source.name}</span><span style={{ color: source.state === "active" ? PT.accent : source.state === "deferred" ? PT.red : PT.amber }}>{source.state.replaceAll("_", " ")}</span><span style={{ color: PT.muted }}>{source.role}</span></div>)}
      <div style={{ marginTop: "10px", fontSize: "9px", color: PT.muted }}>This product uses FHFA Data but is neither endorsed nor certified by FHFA. Mortgage rates via FRED (Federal Reserve Bank of St. Louis). Unemployment via U.S. Bureau of Labor Statistics. This product uses the HUD User Data API but is not endorsed or certified by HUD User. HUD FMR is an area affordability reference only.</div>
    </section>
    <style>{`
      @media (max-width: 720px) {
        .property-market-data { padding: 18px 16px !important; overflow-x: hidden; }
        .property-market-chart-grid { grid-template-columns: minmax(0, 1fr) !important; }
        .property-source-row { grid-template-columns: minmax(0, 1fr) !important; gap: 4px !important; padding: 12px 0 !important; }
      }
    `}</style>
    </div>
  </PropertyPageFrame>;
}
