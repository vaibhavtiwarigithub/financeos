// Phase 1 learning-core: read-only walk-forward dataset builder over the
// decision_observations x observation_labels ledger. No writes here.

import { fetchAllRows } from "@/lib/supabase/paginate";

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
  // The availability_mask ResearchAgent actually used to weight this
  // observation live (lib/scoring/weighted-score.ts) — required so the
  // Validation Engine can replay the EXACT same scoring rule instead of
  // coalescing missing scores to 50 with a fixed weight split.
  availability_mask: Record<string, boolean> | null;
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
  // Paginated: `.limit(5000)` returned PostgREST's 1,000-row maximum, so the
  // learner was training on 19% of the US cohort (5,223 rows) chosen by ts
  // order — the OLDEST fifth. Ordered by id, not ts, because ts is not unique
  // and a non-unique sort key makes page boundaries unstable.
  // Errors PROPAGATE. The previous `if (obsErr || !obsRows?.length) return []`
  // collapsed a failed read and a genuinely empty cohort into the same answer,
  // so a broken query trained the learner on nothing and looked like a quiet day.
  const obsRows = await fetchAllRows((from, to) => supabase
    .from("decision_observations")
    .select("id, ts, market, symbol, analyst_score, fundamental_score, technical_score, sentiment_score, macro_score, insider_score, direction, entry_eligible, score_threshold, availability_mask")
    .eq("market", market)
    .order("id", { ascending: true })
    .range(from, to), "decision_observations");
  if (!obsRows.length) return [];

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
      availability_mask: o.availability_mask ?? null,
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
// ALL WINDOWS ARE COUNTED IN MARKET SESSIONS, NOT CALENDAR DAYS.
//
// THE BUG THIS REPLACES (fixed 2026-09-01). The previous implementation
// documented itself as market-horizon purged but did the arithmetic in calendar
// milliseconds:
//
//   const DAY = 86400_000;
//   const purgeCutoffMs = testStart - horizonDays * DAY;
//
// `horizonDays` is a MARKET-session horizon — the labels it purges against are
// h2/h5/h10/h20/h60/h120 forward SESSIONS. Subtracting calendar days spans only
// ~6-7 trading sessions for a nominal 10, so observations whose label windows
// still overlapped the test window stayed in training. Labels leaked, and every
// walk-forward result computed with it was optimistically biased.
//
// The old unit test never caught this because its fixture emitted one row per
// CONSECUTIVE CALENDAR DAY, weekends included, making calendar days and sessions
// identical by construction. The fixture encoded the same assumption as the bug.
//
// The session calendar is derived from the distinct decision dates present in
// the data, so market holidays are handled without a separate calendar source.
//
// - folds: chronological, anchored (train window grows each fold).
// - testSessions: length of each test window, in sessions.
// - purge: drop the last `horizonSessions` of each train window — those rows'
//   label windows extend into (or past) the test window and would leak.
// - embargo: skip `embargoSessions` (default = horizonSessions) after each test
//   window before the NEXT fold's test window may begin.
export function walkForwardFolds(
  rows: LabeledObservation[],
  opts?: {
    folds?: number;
    /** Sessions per test window. `testDays` is accepted as a legacy alias. */
    testSessions?: number;
    testDays?: number;
    /** Forward-label horizon in sessions. `horizonDays` is a legacy alias. */
    horizonSessions?: number;
    horizonDays?: number;
    /** Sessions to skip after a test window. `embargoDays` is a legacy alias. */
    embargoSessions?: number;
    embargoDays?: number;
  }
): WalkForwardFold[] {
  if (rows.length === 0) return [];
  const folds = opts?.folds ?? 5;
  // The legacy `*Days` names always MEANT sessions — the defect was the
  // arithmetic, not the intent — so the aliases carry through unchanged.
  const testSessions = opts?.testSessions ?? opts?.testDays ?? 30;
  const horizonSessions = opts?.horizonSessions ?? opts?.horizonDays ?? 10;
  const embargoSessions = opts?.embargoSessions ?? opts?.embargoDays ?? horizonSessions;

  const sorted = [...rows].sort((a, b) => a.ts.localeCompare(b.ts));

  // The observed trading calendar: one entry per distinct decision date. Holidays
  // and weekends are absent because no decision was recorded on them.
  const sessions: string[] = [];
  const sessionIndex = new Map<string, number>();
  for (const r of sorted) {
    const day = String(r.ts).slice(0, 10);
    if (!sessionIndex.has(day)) {
      sessionIndex.set(day, sessions.length);
      sessions.push(day);
    }
  }
  const idxOf = (r: LabeledObservation) => sessionIndex.get(String(r.ts).slice(0, 10))!;
  const lastIdx = sessions.length - 1;

  const out: WalkForwardFold[] = [];
  let testStartIdx = testSessions;
  for (let f = 0; f < folds && testStartIdx <= lastIdx; f++) {
    const testEndIdx = Math.min(testStartIdx + testSessions, lastIdx + 1); // exclusive
    // Train must end `horizonSessions` BEFORE the test window opens, so no
    // training row's forward label can reach into it.
    const purgeCutoffIdx = testStartIdx - horizonSessions;

    if (purgeCutoffIdx > 0) {
      const train = sorted.filter(r => idxOf(r) < purgeCutoffIdx);
      const test = sorted.filter(r => {
        const i = idxOf(r);
        return i >= testStartIdx && i < testEndIdx;
      });
      if (train.length > 0 && test.length > 0) {
        out.push({
          train, test,
          trainEnd: sessions[purgeCutoffIdx - 1],
          testEnd: sessions[Math.min(testEndIdx, lastIdx + 1) - 1],
        });
      }
    }

    testStartIdx = testEndIdx + embargoSessions;
  }
  return out;
}
