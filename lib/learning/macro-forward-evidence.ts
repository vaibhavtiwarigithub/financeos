import { classifyInstrumentPolicy } from "@/lib/scoring/instrument-taxonomy";

export const MACRO_EVIDENCE_HORIZONS = [2, 5, 10, 20] as const;
export type MacroEvidenceMarket = "us" | "india";

type FactorRow = { series_id: string; obs_date: string; fetched_at: string; value: number | string };
type LabelRow = {
  horizon_days: number;
  benchmark_neutral_return: number | string | null;
  fwd_return?: number | string | null;
  decision_observations: {
    ts: string; symbol: string; market: string; macro_score: number | string | null;
    analyst_score: number | string | null; availability_mask: Record<string, boolean> | null;
    technical_as_of?: string | null;
    formula_lineage?: { versions?: Record<string, string> } | null;
  } | Array<{
    ts: string; symbol: string; market: string; macro_score: number | string | null;
    analyst_score: number | string | null; availability_mask: Record<string, boolean> | null;
    technical_as_of?: string | null;
    formula_lineage?: { versions?: Record<string, string> } | null;
  }> | null;
};

type Point = { date: string; value: number; returnValue: number; symbol: string };

export type MacroForwardCell = {
  market: MacroEvidenceMarket;
  instrumentFamily: string;
  instrument: string | null;
  series: string;
  formulaVersion: string;
  returnBasis: "benchmark_neutral" | "absolute_instrument";
  horizonSessions: number;
  matchedDates: number;
  horizonSpacedWindows: number;
  symbolRows: number;
  coveragePct: number;
  spearmanIc: number | null;
  state: "insufficient" | "descriptive";
};

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function observation(row: LabelRow) {
  const value = row.decision_observations;
  return Array.isArray(value) ? value[0] ?? null : value;
}

function averageRank(values: number[]): number[] {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array(values.length);
  for (let i = 0; i < sorted.length;) {
    let end = i + 1;
    while (end < sorted.length && sorted[end].value === sorted[i].value) end++;
    const rank = (i + 1 + end) / 2;
    for (let j = i; j < end; j++) ranks[sorted[j].index] = rank;
    i = end;
  }
  return ranks;
}

function correlation(x: number[], y: number[]): number | null {
  if (x.length !== y.length || x.length < 3) return null;
  const mx = x.reduce((a, b) => a + b, 0) / x.length;
  const my = y.reduce((a, b) => a + b, 0) / y.length;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : null;
}

function spearman(x: number[], y: number[]): number | null {
  if (x.length < 3) return null;
  return correlation(averageRank(x), averageRank(y));
}

const FACTOR_MAX_AGE_DAYS: Record<string, number> = {
  india_10y_yield_fred: 120,
  fii_net_cr: 5,
  dii_net_cr: 5,
  nifty50_close: 5,
  india_vix: 5,
  usdinr_spot: 5,
  brent_front: 5,
};

function indexFactorRows(rows: FactorRow[]): Map<string, Array<{ date: string; fetched: string; value: number }>> {
  const index = new Map<string, Array<{ date: string; fetched: string; value: number }>>();
  for (const row of rows) {
    const value = finite(row.value);
    if (value == null || !row.series_id || !row.obs_date || !row.fetched_at) continue;
    const list = index.get(row.series_id) ?? [];
    list.push({ date: row.obs_date, fetched: row.fetched_at, value });
    index.set(row.series_id, list);
  }
  for (const list of index.values()) list.sort((a, b) => b.date.localeCompare(a.date) || b.fetched.localeCompare(a.fetched));
  return index;
}

function asOfFactorChange(index: Map<string, Array<{ date: string; fetched: string; value: number }>>, series: string, decisionTs: string, decisionDate: string): number | null {
  const levels: Array<[string, number]> = [];
  const seen = new Set<string>();
  for (const row of index.get(series) ?? []) {
    if (row.date > decisionDate || row.fetched > decisionTs || seen.has(row.date)) continue;
    seen.add(row.date);
    levels.push([row.date, row.value]);
    if (levels.length === 2) break;
  }
  if (!levels.length) return null;
  const [current, previous] = levels;
  const day = (value: string) => Math.floor(Date.parse(`${value}T00:00:00Z`) / 86_400_000);
  const maxAgeDays = FACTOR_MAX_AGE_DAYS[series] ?? 5;
  if (day(decisionDate) - day(current[0]) > maxAgeDays) return null;
  if (series === "fii_net_cr" || series === "dii_net_cr") return current[1];
  if (levels.length < 2) return null;
  if (series !== "india_10y_yield_fred" && day(current[0]) - day(previous[0]) > maxAgeDays) return null;
  if (series === "india_10y_yield_fred") return current[1] - previous[1];
  if (previous[1] === 0) return null;
  return (current[1] / previous[1] - 1) * 100;
}

const INDIA_SERIES: Array<{ id: string; label: string }> = [
  { id: "nifty50_close", label: "NIFTY 50 daily % change" },
  { id: "india_vix", label: "India VIX daily % change" },
  { id: "usdinr_spot", label: "USD/INR daily % change" },
  { id: "brent_front", label: "Brent daily % change" },
  { id: "india_10y_yield_fred", label: "India 10Y yield daily change (percentage points)" },
  { id: "fii_net_cr", label: "FII net flow (INR crore)" },
  { id: "dii_net_cr", label: "DII net flow (INR crore)" },
];

function sessionDate(obs: NonNullable<ReturnType<typeof observation>>): string {
  // Research can run after the market session or on a weekend. Use the actual
  // bar date carried in the frozen observation when available; timestamp date
  // is only a compatibility fallback for older rows.
  const barDate = obs.technical_as_of;
  return barDate && /^\d{4}-\d{2}-\d{2}$/.test(barDate) ? barDate : obs.ts.slice(0, 10);
}

// A deliberately small, reviewed exposure map. It identifies only the
// instruments whose underlying and direction are unambiguous for this test;
// it is not a general ETF taxonomy or trading allowlist.
const US_MACRO_EXPOSURES: Readonly<Record<string, { direction: 1 | -1 }>> = {
  SPY: { direction: 1 },
  QQQ: { direction: 1 },
  SOXX: { direction: 1 },
  SOXL: { direction: 1 },
  TQQQ: { direction: 1 },
  SOXS: { direction: -1 },
  SQQQ: { direction: -1 },
};

/**
 * Evaluate family scores against matured benchmark-neutral labels and the
 * fixed US instrument challenger against its own matured absolute returns.
 * One point per date/family or date/instrument prevents a same-day cross-section
 * from masquerading as independent macro evidence.
 */
export function buildMacroForwardEvidence(
  market: MacroEvidenceMarket,
  labels: LabelRow[],
  factorRows: FactorRow[],
): MacroForwardCell[] {
  const factorIndex = indexFactorRows(factorRows);
  const prepared: Array<{ horizon: number; family: string; instrument: string | null; date: string; symbol: string; y: number; returnBasis: "benchmark_neutral" | "absolute_instrument"; signals: Record<string, number>; versions: Record<string, string> }> = [];
  const labelDenominators = new Map<string, Set<string>>();

  for (const row of labels) {
    const obs = observation(row);
    const benchmarkReturn = finite(row.benchmark_neutral_return);
    const absoluteReturn = finite(row.fwd_return);
    if (!obs || obs.market !== market || (benchmarkReturn == null && absoluteReturn == null) || !MACRO_EVIDENCE_HORIZONS.includes(row.horizon_days as any)) continue;
    const date = sessionDate(obs);
    const family = classifyInstrumentPolicy({ symbol: obs.symbol, market }).family;
    const lineageVersions = obs.formula_lineage?.versions ?? {};
    const key = `${row.horizon_days}|${family}`;
    if (benchmarkReturn != null) {
      const dates = labelDenominators.get(key) ?? new Set<string>(); dates.add(date); labelDenominators.set(key, dates);
    }

    // The established family series keeps its benchmark-neutral estimand.
    const familySignals: Record<string, number> = {};
    const familyVersions: Record<string, string> = {};
    if (market === "us") {
      const macro = obs.availability_mask?.macro ? finite(obs.macro_score) : null;
      const composite = finite(obs.analyst_score);
      if (macro != null) { familySignals.macro_score = macro; familyVersions.macro_score = String(lineageVersions.macro ?? "legacy_unknown"); }
      if (composite != null) { familySignals.composite_score = composite; familyVersions.composite_score = String(lineageVersions.composite ?? "legacy_unknown"); }
    } else {
      for (const series of INDIA_SERIES) {
        const value = asOfFactorChange(factorIndex, series.id, obs.ts, date);
        if (value != null) { familySignals[series.label] = value; familyVersions[series.label] = "india_macro_factor_change_v1"; }
      }
      const composite = finite(obs.analyst_score);
      if (composite != null) { familySignals.composite_score = composite; familyVersions.composite_score = String(lineageVersions.composite ?? "legacy_unknown"); }
    }
    if (benchmarkReturn != null && Object.keys(familySignals).length) {
      prepared.push({ horizon: row.horizon_days, family, instrument: null, date, symbol: obs.symbol, y: benchmarkReturn,
        returnBasis: "benchmark_neutral", signals: familySignals, versions: familyVersions });
    }

    // The instrument challenger has a different estimand and is deliberately
    // represented as a separate series so missing benchmark marks cannot make
    // absolute returns leak into the existing family-excess comparison.
    if (market === "us" && absoluteReturn != null) {
      const macro = obs.availability_mask?.macro ? finite(obs.macro_score) : null;
      const exposure = US_MACRO_EXPOSURES[String(obs.symbol).toUpperCase()];
      if (exposure && macro != null) {
        const instrument = String(obs.symbol).toUpperCase();
        const signals = {
          us_macro_underlying_raw_v1: macro,
          us_macro_exposure_oriented_v1: exposure.direction === 1 ? macro : 100 - macro,
        };
        prepared.push({ horizon: row.horizon_days, family, instrument, date, symbol: obs.symbol, y: absoluteReturn,
          returnBasis: "absolute_instrument", signals,
          versions: {
            us_macro_underlying_raw_v1: "us_macro_score_favorable_v1",
            us_macro_exposure_oriented_v1: "us_macro_exposure_direction_v1_20261028",
          } });
      }
    }
  }

  const grouped = new Map<string, Map<string, Point[]>>();
  for (const row of prepared) {
    for (const [series, value] of Object.entries(row.signals)) {
      const version = row.versions[series] ?? "legacy_unknown";
      const key = `${row.horizon}|${row.family}|${row.instrument ?? "family"}|${row.returnBasis}|${series}|${version}`;
      const byDate = grouped.get(key) ?? new Map<string, Point[]>();
      const points = byDate.get(row.date) ?? [];
      points.push({ date: row.date, value, returnValue: row.y, symbol: row.symbol });
      byDate.set(row.date, points); grouped.set(key, byDate);
    }
  }

  const cells: MacroForwardCell[] = [];
  for (const [key, byDate] of grouped) {
    const [horizonRaw, family, instrumentRaw, returnBasisRaw, series, formulaVersion] = key.split("|");
    const horizon = Number(horizonRaw);
    const allDates = [...(labelDenominators.get(`${horizon}|${family}`) ?? [])].sort();
    const points = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, values]) => ({
      date,
      // factor/score is shared within a decision date; use its median to make
      // malformed or legacy duplicate rows harmless. Returns are one family
      // aggregate per date, never individual symbols as independent samples.
      x: median(values.map((v) => v.value)),
      y: median(values.map((v) => v.returnValue)),
      n: new Set(values.map((v) => v.symbol)).size,
    }));
    const spaced = points.filter((_, index) => index % horizon === 0);
    const nWindows = spaced.length;
    const coverage = allDates.length ? points.length / allDates.length : 0;
    const ic = spearman(spaced.map((p) => p.x), spaced.map((p) => p.y));
    const symbolRows = points.reduce((sum, point) => sum + point.n, 0);
    cells.push({
      market, instrumentFamily: family, instrument: instrumentRaw === "family" ? null : instrumentRaw,
      series, formulaVersion, returnBasis: returnBasisRaw as MacroForwardCell["returnBasis"], horizonSessions: horizon,
      matchedDates: points.length, horizonSpacedWindows: nWindows, symbolRows,
      coveragePct: coverage, spearmanIc: ic,
      state: nWindows >= 12 && ic != null ? "descriptive" : "insufficient",
    });
  }
  return cells.sort((a, b) => a.horizonSessions - b.horizonSessions || a.instrumentFamily.localeCompare(b.instrumentFamily) || a.series.localeCompare(b.series));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
