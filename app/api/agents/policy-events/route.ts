import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import { requireOwner } from "@/lib/auth/require-owner";
import { FRED_SERIES, fredSeriesDated } from "@/lib/data/fred-macro";
import { createServiceClient } from "@/lib/supabase/service";
import {
  completePostEventWindow,
  compoundReturn,
  FOMC_SCHEDULE,
  impactFingerprint,
  resolveScheduledDecision,
  scheduledDecisionTimeReached,
  targetRanges,
  type FrozenReturn,
} from "@/lib/policy-events/fomc";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type EventRow = {
  id: string;
  scheduled_date: string;
  status: "scheduled" | "decided";
  actual_effective_date: string | null;
};

type ExpectationRow = {
  event_id: string;
  captured_at: string;
  expected_target_lower: number;
  expected_target_upper: number;
};

type ReturnRow = {
  symbol: string;
  session_date: string;
  simple_return: number;
  price_basis: "adjusted_close" | "raw_close";
  source: string;
  available_at: string;
};

function round(value: number): number { return Math.round(value * 1e8) / 1e8; }

function latestPreDecisionExpectation(rows: ExpectationRow[], eventDate: string): ExpectationRow | null {
  const cutoff = `${eventDate}T23:59:59.999Z`;
  return rows
    .filter((row) => row.captured_at < cutoff)
    .sort((a, b) => b.captured_at.localeCompare(a.captured_at))[0] ?? null;
}

function frozenReturnsBySymbol(rows: ReturnRow[]): Map<string, FrozenReturn[]> {
  // `symbol_daily_returns` is append-only. Select the latest row available for
  // each symbol/session at this calculation time; its fingerprint is persisted
  // in the derived impact row, so a later vendor revision appends rather than
  // silently rewriting this observation.
  const newest = new Map<string, ReturnRow>();
  for (const row of rows) {
    const key = `${row.symbol.toUpperCase()}|${row.session_date}`;
    const existing = newest.get(key);
    if (!existing || existing.available_at < row.available_at) newest.set(key, row);
  }
  const grouped = new Map<string, FrozenReturn[]>();
  for (const row of newest.values()) {
    if (!Number.isFinite(Number(row.simple_return)) || Number(row.simple_return) <= -1) continue;
    const symbol = row.symbol.toUpperCase();
    const values = grouped.get(symbol) ?? [];
    values.push({
      sessionDate: row.session_date,
      simpleReturn: Number(row.simple_return),
      priceBasis: row.price_basis,
      source: row.source,
    });
    grouped.set(symbol, values);
  }
  for (const rowsForSymbol of grouped.values()) rowsForSymbol.sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
  return grouped;
}

function sameSessions(rows: FrozenReturn[], sessionDates: string[]): FrozenReturn[] | null {
  const byDate = new Map(rows.map((row) => [row.sessionDate, row]));
  const selected = sessionDates.map((date) => byDate.get(date)).filter((row): row is FrozenReturn => Boolean(row));
  return selected.length === sessionDates.length ? selected : null;
}

export async function GET() {
  return NextResponse.json({
    message: "Use POST to synchronize official FOMC outcomes and record-only impacts.",
    expectationSource: "unconfigured",
  });
}

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    const gate = await requireOwner();
    if (gate) return gate;
  }

  const svc = createServiceClient();
  const now = new Date();

  const { error: scheduleError } = await svc.from("policy_rate_events").upsert(
    FOMC_SCHEDULE.map((event) => ({
      market: "us",
      authority: "fomc",
      scheduled_date: event.scheduledDate,
      official_source_url: event.sourceUrl,
      updated_at: now.toISOString(),
    })),
    { onConflict: "authority,scheduled_date" },
  );
  if (scheduleError) return NextResponse.json({ error: scheduleError.message }, { status: 500 });

  const [{ data: events, error: eventsError }, lower, upper] = await Promise.all([
    svc.from("policy_rate_events").select("id,scheduled_date,status,actual_effective_date").eq("authority", "fomc").order("scheduled_date", { ascending: false }),
    fredSeriesDated(FRED_SERIES.fedTargetLower, 500),
    fredSeriesDated(FRED_SERIES.fedTargetUpper, 500),
  ]);
  if (eventsError) return NextResponse.json({ error: eventsError.message }, { status: 500 });

  const eventRows = (events ?? []) as EventRow[];
  const ids = eventRows.map((event) => event.id);
  const expectationsResult = ids.length
    ? await svc.from("policy_rate_expectation_snapshots").select("event_id,captured_at,expected_target_lower,expected_target_upper").in("event_id", ids)
    : { data: [] as ExpectationRow[], error: null };
  if (expectationsResult.error) return NextResponse.json({ error: expectationsResult.error.message }, { status: 500 });
  const expectationByEvent = new Map<string, ExpectationRow[]>();
  for (const expectation of (expectationsResult.data ?? []) as ExpectationRow[]) {
    const rows = expectationByEvent.get(expectation.event_id) ?? [];
    rows.push(expectation);
    expectationByEvent.set(expectation.event_id, rows);
  }

  const ranges = targetRanges(lower, upper);
  let decisionsRecorded = 0;
  for (const event of eventRows) {
    if (!scheduledDecisionTimeReached(event.scheduled_date, now)) continue;
    const actual = resolveScheduledDecision(ranges, event.scheduled_date);
    if (!actual) continue; // FRED unavailable or not published: preserve the existing record.
    const expected = latestPreDecisionExpectation(expectationByEvent.get(event.id) ?? [], event.scheduled_date);
    const surpriseBps = expected
      ? round(((actual.lower + actual.upper - expected.expected_target_lower - expected.expected_target_upper) / 2) * 100)
      : null;
    const { error } = await svc.from("policy_rate_events").update({
      status: "decided",
      actual_effective_date: actual.effectiveDate,
      actual_target_lower: actual.lower,
      actual_target_upper: actual.upper,
      actual_source: "fred:DFEDTARL/DFEDTARU",
      surprise_bps: surpriseBps,
      decided_at: now.toISOString(),
      updated_at: now.toISOString(),
    }).eq("id", event.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    decisionsRecorded++;
  }

  const decided = eventRows.filter((event) => scheduledDecisionTimeReached(event.scheduled_date, now))
    .map((event) => ({ ...event, actual_effective_date: resolveScheduledDecision(ranges, event.scheduled_date)?.effectiveDate ?? event.actual_effective_date }))
    .filter((event): event is EventRow & { actual_effective_date: string } => Boolean(event.actual_effective_date));
  const earliest = decided.map((event) => event.actual_effective_date).sort()[0];
  if (!earliest) return NextResponse.json({ scheduled: FOMC_SCHEDULE.length, decisionsRecorded, impactsRecorded: 0, expectationSource: "unconfigured" });

  const { data: returnRows, error: returnsError } = await svc
    .from("symbol_daily_returns")
    .select("symbol,session_date,simple_return,price_basis,source,available_at")
    .eq("market", "us")
    .gte("session_date", earliest)
    .order("available_at", { ascending: false })
    .limit(50000);
  if (returnsError) return NextResponse.json({ error: returnsError.message }, { status: 500 });

  const returnsBySymbol = frozenReturnsBySymbol((returnRows ?? []) as ReturnRow[]);
  const spy = returnsBySymbol.get("SPY") ?? [];
  const impacts: Record<string, unknown>[] = [];
  for (const event of decided) {
    for (const horizon of [1, 5]) {
      const benchmarkWindow = completePostEventWindow(spy, event.actual_effective_date, horizon);
      const benchmarkDates = benchmarkWindow?.map((row) => row.sessionDate) ?? null;
      const benchmarkReturn = benchmarkWindow ? compoundReturn(benchmarkWindow) : null;
      const benchmarkBasis = new Set(benchmarkWindow?.map((row) => row.priceBasis) ?? []);
      for (const [symbol, symbolRows] of returnsBySymbol) {
        // A raw post-event move is still useful evidence. It must not disappear
        // just because the benchmark was never captured. Relative performance is
        // withheld until the exact same frozen benchmark sessions are available.
        const window = benchmarkDates
          ? sameSessions(symbolRows, benchmarkDates)
          : completePostEventWindow(symbolRows, event.actual_effective_date, horizon);
        if (!window) continue;
        const symbolReturn = compoundReturn(window);
        if (symbolReturn == null) continue;
        const symbolBasis = new Set(window.map((row) => row.priceBasis));
        const comparable = benchmarkReturn != null && benchmarkBasis.size === 1 && symbolBasis.size === 1
          && [...benchmarkBasis][0] === [...symbolBasis][0];
        impacts.push({
          event_id: event.id,
          symbol,
          benchmark_symbol: "SPY",
          horizon_sessions: horizon,
          first_session_date: window[0].sessionDate,
          last_session_date: window[window.length - 1].sessionDate,
          symbol_return_pct: round(symbolReturn * 100),
          benchmark_return_pct: comparable ? round(benchmarkReturn! * 100) : null,
          excess_return_pct: comparable ? round((symbolReturn - benchmarkReturn!) * 100) : null,
          symbol_price_basis: [...symbolBasis][0],
          benchmark_price_basis: comparable ? [...benchmarkBasis][0] : null,
          source_fingerprint: impactFingerprint({ eventId: event.id, symbol, horizonSessions: horizon, rows: window, benchmarkRows: benchmarkWindow ?? [] }),
          available_at: now.toISOString(),
        });
      }
    }
  }
  if (impacts.length) {
    const { error: impactsError } = await svc.from("policy_event_impacts").upsert(impacts, {
      onConflict: "event_id,symbol,horizon_sessions,source_fingerprint",
      ignoreDuplicates: true,
    });
    if (impactsError) return NextResponse.json({ error: impactsError.message }, { status: 500 });
  }

  return NextResponse.json({
    scheduled: FOMC_SCHEDULE.length,
    decisionsRecorded,
    impactsRecorded: impacts.length,
    frozenReturnSymbols: returnsBySymbol.size,
    expectationSource: "unconfigured",
  });
}
