import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { EVENT_TYPES } from "@/lib/events/vocabulary";
import { cohortValue, MIN_INSTANCES, summarizeBaseRate, type BaseRateSummary } from "@/lib/events/outcomes";

export const dynamic = "force-dynamic";

// Event ledger step 3 — read-only base-rate report.
//
// MEASUREMENT ONLY. Read-only. Nothing here is consumed by a score, a gate, a
// size, an entry, an exit, a promotion or a broker call.
//
// THE REPORT'S JOB IS TO REFUSE
// The most likely failure of this whole feature is acting at n=8 because the
// story is good. So below MIN_INSTANCES the summary carries nulls, not numbers
// with a caveat beside them — a caveat is something a reader skips, an absent
// number is not. n is returned on every row either way.
//
// US and India are separate rows and are NEVER pooled. A cross-market average
// would be meaningless (different benchmarks, different sessions, different
// currency) and is explicitly forbidden.

interface OutcomeJoin {
  horizon_days: number;
  benchmark_neutral_return: number | null;
  fwd_return: number | null;
  subject_symbol: string | null;
  benchmark_symbol: string;
  market_events: { event_type: string; market: string } | null;
}

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const url = new URL(req.url);
  const marketFilter = url.searchParams.get("market");
  const svc = createServiceClient();

  const { data, error } = await svc
    .from("market_event_outcomes")
    .select("horizon_days, benchmark_neutral_return, fwd_return, subject_symbol, benchmark_symbol, market_events!inner(event_type, market)")
    .limit(5000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Group by (event_type, market, horizon). The market is part of the key, not
  // a filter applied afterwards, so a pooled row cannot be produced by accident.
  const groups = new Map<string, number[]>();
  for (const row of (data ?? []) as unknown as OutcomeJoin[]) {
    const ev = row.market_events;
    if (!ev) continue;
    if (marketFilter && ev.market !== marketFilter) continue;
    const value = cohortValue(row);
    if (value == null) continue;
    const key = `${ev.event_type}|${ev.market}|${row.horizon_days}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(value);
    else groups.set(key, [value]);
  }

  const summaries: BaseRateSummary[] = [];
  for (const [key, returns] of groups) {
    const [eventType, market, horizon] = key.split("|");
    summaries.push(summarizeBaseRate(eventType, market, Number(horizon), returns));
  }
  summaries.sort((a, b) =>
    a.market.localeCompare(b.market) || a.eventType.localeCompare(b.eventType) || a.horizonDays - b.horizonDays);

  const sufficient = summaries.filter((s) => s.sufficient).length;

  return NextResponse.json({
    minInstances: MIN_INSTANCES,
    cohorts: summaries.length,
    cohortsAboveFloor: sufficient,
    summaries,
    // The count of types tested is reported WITH the results, per R4: every
    // additional type is another trial, and there is no false-discovery
    // correction available yet (walk-forward-ic-folds Open Decision #3).
    typesTested: EVENT_TYPES.length,
    note: sufficient === 0
      ? `No cohort has reached ${MIN_INSTANCES} matured instances, so no base rate is estimated. n is reported for each cohort. This is the designed outcome at this sample size, not a failure.`
      : `${sufficient} of ${summaries.length} cohorts are above the floor of ${MIN_INSTANCES}. Any estimate is uncorrected for multiple testing across ${EVENT_TYPES.length} event types.`,
  });
}
