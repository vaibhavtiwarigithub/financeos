/**
 * Read-only Stage-0 diagnostic for technical-score horizon and sub-feature IC.
 *
 * Usage:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/technical-ic-stage0.ts
 *
 * This script never writes to Supabase. It reports both the conventional
 * session t-statistic and the app's conservative overlap-adjusted statistic;
 * the former is not promotion evidence for overlapping forward windows.
 */
import { createClient } from "@supabase/supabase-js";

type Market = "us" | "india";
type Row = {
  id: number;
  horizon: number;
  outcome: number;
  ts: string;
  symbol: string;
  analystScore: number | null;
  technicalScore: number | null;
  features: Record<string, any> | null;
  eligible: boolean;
  direction: string | null;
  technicalAvailable: boolean;
  discoverySource: string;
  instrumentFamily: string;
};

const HORIZONS = [2, 5, 10, 20] as const;
const MIN_CROSS_SECTION = 5;

function averageRanks(values: number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = Array<number>(values.length);
  for (let start = 0; start < indexed.length;) {
    let end = start + 1;
    while (end < indexed.length && indexed[end].value === indexed[start].value) end++;
    const rank = (start + 1 + end) / 2;
    for (let cursor = start; cursor < end; cursor++) ranks[indexed[cursor].index] = rank;
    start = end;
  }
  return ranks;
}

function spearman(left: number[], right: number[]): number | null {
  if (left.length !== right.length || left.length < 2) return null;
  const x = averageRanks(left);
  const y = averageRanks(right);
  const xMean = mean(x)!;
  const yMean = mean(y)!;
  let numerator = 0;
  let xSum = 0;
  let ySum = 0;
  for (let index = 0; index < x.length; index++) {
    const xDelta = x[index] - xMean;
    const yDelta = y[index] - yMean;
    numerator += xDelta * yDelta;
    xSum += xDelta ** 2;
    ySum += yDelta ** 2;
  }
  const denominator = Math.sqrt(xSum * ySum);
  return denominator > 0 ? numerator / denominator : null;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sampleSd(values: number[]): number | null {
  if (values.length < 2) return null;
  const average = mean(values)!;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function sessionIc(rows: Row[], valueOf: (row: Row) => number | null) {
  const bySession = new Map<string, Array<{ value: number; outcome: number }>>();
  for (const row of rows) {
    const value = valueOf(row);
    if (value === null) continue;
    const date = row.ts.slice(0, 10);
    const session = bySession.get(date) ?? [];
    session.push({ value, outcome: row.outcome });
    bySession.set(date, session);
  }
  const sessions = [...bySession.entries()].flatMap(([date, values]) => {
    if (values.length < MIN_CROSS_SECTION) return [];
    const ic = spearman(values.map((item) => item.value), values.map((item) => item.outcome));
    return ic !== null && Number.isFinite(ic) ? [{ date, ic, n: values.length }] : [];
  }).sort((a, b) => a.date.localeCompare(b.date));
  const values = sessions.map((session) => session.ic);
  const average = mean(values);
  const sd = sampleSd(values);
  const horizon = rows[0]?.horizon ?? 0;
  const naiveT = average !== null && sd ? average / (sd / Math.sqrt(values.length)) : null;
  const nEffective = horizon > 0 ? values.length / horizon : 0;
  const overlapAdjustedT = average !== null && sd && nEffective > 0
    ? average / (sd / Math.sqrt(nEffective))
    : null;
  return {
    rows: rows.filter((row) => valueOf(row) !== null).length,
    sessions: sessions.length,
    mean_session_rank_ic: average,
    naive_t: naiveT,
    effective_observations: nEffective,
    overlap_adjusted_t: overlapAdjustedT,
    positive_session_share: values.length ? values.filter((value) => value > 0).length / values.length : null,
    first_session: sessions[0]?.date ?? null,
    last_session: sessions.at(-1)?.date ?? null,
  };
}

function technical(row: Row): Record<string, any> {
  return row.features?.technical ?? {};
}

function groupedTechnicalIc(rows: Row[], keyOf: (row: Row) => string) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = keyOf(row) || "unknown";
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return Object.fromEntries([...groups.entries()]
    .map(([key, group]) => [key, sessionIc(group, (row) => row.technicalScore)] as const)
    .sort((left, right) => right[1].rows - left[1].rows));
}

const subfeatures: Record<string, (row: Row) => number | null> = {
  rsi14: (row) => finite(technical(row).rsi14),
  price_vs_ema20: (row) => technical(row).priceVsEma20 === "above" ? 1 : technical(row).priceVsEma20 === "below" ? -1 : 0,
  price_vs_ema50: (row) => technical(row).priceVsEma50 === "above" ? 1 : technical(row).priceVsEma50 === "below" ? -1 : 0,
  trend20d: (row) => technical(row).trend20d === "up" ? 1 : technical(row).trend20d === "down" ? -1 : 0,
  volume_vs_avg20: (row) => finite(technical(row).volumeVsAvg20),
  last_return_pct: (row) => finite(technical(row).lastReturnPct),
  atr_pct: (row) => {
    const atr = finite(technical(row).atr14);
    const price = finite(technical(row).price);
    return atr !== null && price !== null && price > 0 ? atr / price : null;
  },
  adx14: (row) => finite(technical(row).adx14),
  macd_histogram: (row) => finite(technical(row).macdHistogram),
  relative_strength: (row) => finite(technical(row).rsVsSpy),
  clean_of_breakdown_veto: (row) => typeof technical(row).breakdown_veto?.vetoed === "boolean"
    ? technical(row).breakdown_veto.vetoed ? 0 : 1
    : null,
};

async function loadRows(client: any, market: Market, horizon: number): Promise<Row[]> {
  const output: Row[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client
      .from("observation_labels")
      .select("id,observation_id,horizon_days,benchmark_neutral_return,decision_observations!inner(id,ts,symbol,market,analyst_score,technical_score,features,availability_mask,entry_eligible,direction,discovery_source)")
      .eq("horizon_days", horizon)
      .eq("decision_observations.market", market)
      .not("benchmark_neutral_return", "is", null)
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`${market} h${horizon} query failed: ${error.message}`);
    const page = (data ?? []) as any[];
    for (const source of page) {
      const decisionValue = (source as any).decision_observations;
      const decision = Array.isArray(decisionValue) ? decisionValue[0] : decisionValue;
      const outcome = finite((source as any).benchmark_neutral_return);
      if (!decision || outcome === null) continue;
      output.push({
        id: Number(decision.id), horizon, outcome,
        ts: String(decision.ts), symbol: String(decision.symbol),
        analystScore: finite(decision.analyst_score), technicalScore: finite(decision.technical_score),
        features: decision.features ?? null,
        eligible: decision.entry_eligible === true,
        direction: decision.direction == null ? null : String(decision.direction),
        technicalAvailable: decision.availability_mask?.technical === true,
        discoverySource: String(decision.discovery_source ?? "unknown"),
        instrumentFamily: String(decision.features?.instrument?.family ?? decision.features?.instrument?.kind ?? "unknown"),
      });
    }
    if (page.length < pageSize) break;
  }
  return output;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const report: Record<string, unknown> = {
    generated_at: new Date().toISOString(),
    cohort: "entry_eligible=true AND direction=long AND technical available",
    note: "Read-only diagnostic. Overlap-adjusted t uses nEffective=session_count/horizon. Sub-features are exploratory and are not multiple-testing-cleared.",
    markets: {},
  };
  for (const market of ["us", "india"] as const) {
    const horizons: Record<string, unknown> = {};
    for (const horizon of HORIZONS) {
      const loaded = await loadRows(client, market, horizon);
      const rows = loaded.filter((row) => row.eligible && row.direction === "long" && row.technicalAvailable);
      horizons[`h${horizon}`] = {
        loaded_rows: loaded.length,
        cohort_rows: rows.length,
        composite: sessionIc(rows, (row) => row.analystScore),
        technical_score: sessionIc(rows, (row) => row.technicalScore),
        subfeatures: Object.fromEntries(Object.entries(subfeatures).map(([name, valueOf]) => [name, sessionIc(rows, valueOf)])),
        ...(horizon === 10 ? {
          h10_concentration: {
            by_discovery_source: groupedTechnicalIc(rows, (row) => row.discoverySource),
            by_instrument_family: groupedTechnicalIc(rows, (row) => row.instrumentFamily),
          },
        } : {}),
      };
    }
    (report.markets as Record<string, unknown>)[market] = horizons;
  }
  if (process.argv.includes("--summary")) {
    const summary = Object.fromEntries(Object.entries(report.markets as Record<string, any>).map(([market, horizons]) => [
      market,
      Object.fromEntries(Object.entries(horizons as Record<string, any>).map(([horizon, values]) => [horizon, {
        loaded_rows: values.loaded_rows,
        cohort_rows: values.cohort_rows,
        composite: values.composite,
        technical_score: values.technical_score,
        rsi14: values.subfeatures.rsi14,
        price_vs_ema20: values.subfeatures.price_vs_ema20,
        price_vs_ema50: values.subfeatures.price_vs_ema50,
        trend20d: values.subfeatures.trend20d,
        volume_vs_avg20: values.subfeatures.volume_vs_avg20,
        ...(values.h10_concentration ? { h10_concentration: values.h10_concentration } : {}),
      }])),
    ]));
    process.stdout.write(`${JSON.stringify({ generated_at: report.generated_at, cohort: report.cohort, markets: summary }, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
