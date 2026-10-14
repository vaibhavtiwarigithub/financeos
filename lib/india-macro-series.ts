// India macro series ingestion (measure-only). Numbers come from authoritative or market-data sources,
// never from an LLM. Stored append-only in india_macro_observations; no scorer, gate or trade path reads it.
// Why: MacroSentinel is US-only (FRED), India has no macro read, and the dated history is the prerequisite for
// any later regime x company-exposure feature (features/llm-event-extraction-shadow).

export type MacroSource = "fred" | "yahoo" | "nse";

export interface MacroSeriesSpec {
  id: string; // stable key stored in india_macro_observations.series_id
  source: MacroSource;
  provider: string; // FRED series id, Yahoo symbol, or NSE endpoint tag
  label: string;
  unit: string;
  /** Drop the still-forming bar for instruments that trade through the collection time. */
  dropToday?: boolean;
  /** Approximate publication lag, for readers; observations are stored by their own obs_date. */
  note: string;
}

export const INDIA_MACRO_SERIES: readonly MacroSeriesSpec[] = [
  { id: "india_10y_yield_fred", source: "fred", provider: "INDIRLTLT01STM", label: "India 10Y government bond yield (OECD via FRED)", unit: "pct", note: "monthly; 2-3 month publication lag" },
  { id: "usdinr_fred", source: "fred", provider: "DEXINUS", label: "USD/INR (Fed H.10)", unit: "inr_per_usd", note: "daily; about 1 week lag" },
  { id: "brent_fred", source: "fred", provider: "DCOILBRENTEU", label: "Brent crude spot (EIA via FRED)", unit: "usd_per_bbl", note: "daily; about 1 week lag" },
  { id: "india_vix", source: "yahoo", provider: "^INDIAVIX", label: "India VIX", unit: "index_points", note: "near real time" },
  { id: "nifty50_close", source: "yahoo", provider: "^NSEI", label: "NIFTY 50 close", unit: "index_points", note: "near real time" },
  { id: "niftybees_close", source: "yahoo", provider: "NIFTYBEES.NS", label: "NIFTYBEES ETF close (index-sleeve shadow instrument)", unit: "inr", note: "near real time; INR 200+ crore/day turnover" },
  { id: "usdinr_spot", source: "yahoo", provider: "INR=X", label: "USD/INR spot", unit: "inr_per_usd", dropToday: true, note: "near real time; 24h instrument" },
  { id: "brent_front", source: "yahoo", provider: "BZ=F", label: "Brent front-month future", unit: "usd_per_bbl", dropToday: true, note: "near real time; 24h instrument" },
  { id: "fii_net_cr", source: "nse", provider: "fiidiiTradeReact", label: "FII/FPI net cash-market flow", unit: "inr_crore", note: "daily provisional, NSE" },
  { id: "dii_net_cr", source: "nse", provider: "fiidiiTradeReact", label: "DII net cash-market flow", unit: "inr_crore", note: "daily provisional, NSE" },
];

export interface MacroObservation {
  series_id: string;
  source: MacroSource;
  obs_date: string;
  value: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Yahoo v8 chart JSON -> dated closes. Null/non-finite closes are dropped; dates are the UTC calendar date of the bar. */
export function parseYahooChart(spec: MacroSeriesSpec, json: any, todayUtc: string): MacroObservation[] {
  const result = json?.chart?.result?.[0];
  const ts: unknown[] = result?.timestamp ?? [];
  const closes: unknown[] = result?.indicators?.quote?.[0]?.close ?? [];
  const out: MacroObservation[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = Number(ts[i]);
    const value = Number(closes[i]);
    if (!Number.isFinite(t) || closes[i] == null || !Number.isFinite(value)) continue;
    const date = new Date(t * 1000).toISOString().slice(0, 10);
    if (spec.dropToday && date >= todayUtc) continue;
    out.push({ series_id: spec.id, source: spec.source, obs_date: date, value });
  }
  return out;
}

/** FRED observations (already numeric and dated) -> rows; malformed dates dropped. */
export function fredToObservations(spec: MacroSeriesSpec, obs: ReadonlyArray<{ date: string; value: number }>): MacroObservation[] {
  return obs
    .filter((o) => ISO_DATE.test(o.date) && Number.isFinite(o.value))
    .map((o) => ({ series_id: spec.id, source: spec.source, obs_date: o.date, value: o.value }));
}

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

/** NSE date "10-Jul-2026" -> "2026-07-10"; null if unparseable. */
export function nseDateToIso(raw: string | null): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec((raw ?? "").trim());
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  return mm ? `${m[3]}-${mm}-${m[1].padStart(2, "0")}` : null;
}

export function fiiDiiToObservations(session: { date: string | null; fiiNet: number | null; diiNet: number | null } | null): MacroObservation[] {
  const date = nseDateToIso(session?.date ?? null);
  if (!session || !date) return [];
  const rows: MacroObservation[] = [];
  if (session.fiiNet != null && Number.isFinite(session.fiiNet)) rows.push({ series_id: "fii_net_cr", source: "nse", obs_date: date, value: session.fiiNet });
  if (session.diiNet != null && Number.isFinite(session.diiNet)) rows.push({ series_id: "dii_net_cr", source: "nse", obs_date: date, value: session.diiNet });
  return rows;
}
