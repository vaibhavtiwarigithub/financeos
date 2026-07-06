// Phase 1 learning-core: read-only walk-forward dataset builder over the
// decision_observations x observation_labels ledger. No writes here.

export interface LabeledObservation {
  id: number;
  ts: string; // decision timestamp
  market: "us" | "india";
  symbol: string;
  analyst_score: number;
  fundamental_score: number | null;
  technical_score: number | null;
  sentiment_score: number | null;
  macro_score: number | null;
  insider_score: number | null;
  direction: string | null;
  entry_eligible: boolean;
  score_threshold: number | null;
  // label fields for ONE horizon
  horizon_days: number;
  fwd_return: number | null;
  benchmark_return: number | null;
  benchmark_neutral_return: number | null;
  max_adverse_excursion: number | null;
  max_favorable_excursion: number | null;
}

export interface WalkForwardFold {
  train: LabeledObservation[];
  test: LabeledObservation[];
  trainEnd: string;
  testEnd: string;
}

// Join decision_observations × observation_labels for one market+horizon,
// ordered by ts ascending. Only matured (labeled) rows are returned.
export async function loadLabeledDataset(
  supabase: any,
  market: "us" | "india",
  horizonDays: 2 | 5 | 10 | 20
): Promise<LabeledObservation[]> {
  const { data: obsRows, error: obsErr } = await supabase
    .from("decision_observations")
    .select("id, ts, market, symbol, analyst_score, fundamental_score, technical_score, sentiment_score, macro_score, insider_score, direction, entry_eligible, score_threshold")
    .eq("market", market)
    .order("ts", { ascending: true })
    .limit(5000);
  if (obsErr || !obsRows?.length) return [];

  const ids = obsRows.map((r: any) => r.id);
  const { data: labelRows, error: labErr } = await supabase
    .from("observation_labels")
    .select("observation_id, horizon_days, fwd_return, benchmark_return, benchmark_neutral_return, max_adverse_excursion, max_favorable_excursion")
    .eq("horizon_days", horizonDays)
    .in("observation_id", ids);
  if (labErr || !labelRows?.length) return [];

  const labelByObs = new Map<number, any>(labelRows.map((l: any) => [l.observation_id, l]));
  const out: LabeledObservation[] = [];
  for (const o of obsRows) {
    const l = labelByObs.get(o.id);
    if (!l) continue; // not matured for this horizon
    out.push({
      id: o.id, ts: o.ts, market: o.market, symbol: o.symbol,
      analyst_score: Number(o.analyst_score),
      fundamental_score: o.fundamental_score != null ? Number(o.fundamental_score) : null,
      technical_score: o.technical_score != null ? Number(o.technical_score) : null,
      sentiment_score: o.sentiment_score != null ? Number(o.sentiment_score) : null,
      macro_score: o.macro_score != null ? Number(o.macro_score) : null,
      insider_score: o.insider_score != null ? Number(o.insider_score) : null,
      direction: o.direction, entry_eligible: !!o.entry_eligible,
      score_threshold: o.score_threshold != null ? Number(o.score_threshold) : null,
      horizon_days: horizonDays,
      fwd_return: l.fwd_return != null ? Number(l.fwd_return) : null,
      benchmark_return: l.benchmark_return != null ? Number(l.benchmark_return) : null,
      benchmark_neutral_return: l.benchmark_neutral_return != null ? Number(l.benchmark_neutral_return) : null,
      max_adverse_excursion: l.max_adverse_excursion != null ? Number(l.max_adverse_excursion) : null,
      max_favorable_excursion: l.max_favorable_excursion != null ? Number(l.max_favorable_excursion) : null,
    });
  }
  return out;
}

// Purged, embargoed, anchored walk-forward split. Pure function — no DB access,
// so it's independently unit-testable against a hand-built fixture.
//
// - folds: chronological, anchored (train window grows each fold).
// - testDays: length of each test window in calendar days.
// - purge: drop the LAST `horizonDays` of each train window — those rows' label
//   windows extend into (or past) the test window and would leak the future.
// - embargo: skip `embargoDays` (default = horizonDays) immediately after each
//   test window before the NEXT fold's train window may resume.
export function walkForwardFolds(
  rows: LabeledObservation[],
  opts?: { folds?: number; testDays?: number; horizonDays?: number; embargoDays?: number }
): WalkForwardFold[] {
  if (rows.length === 0) return [];
  const folds = opts?.folds ?? 5;
  const testDays = opts?.testDays ?? 30;
  const horizonDays = opts?.horizonDays ?? 10;
  const embargoDays = opts?.embargoDays ?? horizonDays;

  const sorted = [...rows].sort((a, b) => a.ts.localeCompare(b.ts));
  const firstTs = new Date(sorted[0].ts).getTime();
  const lastTs = new Date(sorted[sorted.length - 1].ts).getTime();
  const DAY = 86400_000;

  const out: WalkForwardFold[] = [];
  // Anchor the first test window `testDays` after the start, then step forward.
  let testStart = firstTs + testDays * DAY;
  for (let f = 0; f < folds && testStart < lastTs; f++) {
    const testEndMs = Math.min(testStart + testDays * DAY, lastTs + DAY);
    const purgeCutoffMs = testStart - horizonDays * DAY; // train must end before this

    const train = sorted.filter(r => new Date(r.ts).getTime() < purgeCutoffMs);
    const test = sorted.filter(r => {
      const t = new Date(r.ts).getTime();
      return t >= testStart && t < testEndMs;
    });

    if (train.length > 0 && test.length > 0) {
      out.push({
        train, test,
        trainEnd: new Date(purgeCutoffMs).toISOString(),
        testEnd: new Date(testEndMs).toISOString(),
      });
    }

    // Advance past the test window + embargo before the next fold's test starts.
    testStart = testEndMs + embargoDays * DAY;
  }
  return out;
}
