import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";

// GET /api/calendar/earnings/coverage
//
// Feasibility / coverage report for the point-in-time earnings contract
// (features/known-anomalies §3 "Feasibility output"). Owner-gated, READ ONLY.
// This is a COVERAGE REPORT, not edge_signals and not a scored feature: it counts
// how many events currently have BOTH a first-reported actual AND a valid
// pre-announcement consensus, broken down by year and announcement session, so the
// owner can decide whether coverage floors are met before any PEAD work begins.
//
// An event is "eligible" when:
//   * earnings_calendar.eps_actual_first IS NOT NULL (first-reported actual captured), AND
//   * a consensus vintage exists for the same (symbol, report_date) whose snapshot
//     was taken STRICTLY BEFORE the actual became available (true point-in-time
//     pre-announcement consensus, available_at <= actual_available_at).
export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;

  const svc = createServiceClient();

  const { data: events, error: evErr } = await svc
    .from("earnings_calendar")
    .select("symbol, report_date, market, eps_actual_first, actual_available_at, announcement_session, restated_eps, eps_basis")
    .eq("market", "us");
  if (evErr) return NextResponse.json({ error: evErr.message }, { status: 500 });

  const { data: snaps, error: snErr } = await svc
    .from("earnings_consensus_snapshots")
    .select("symbol, report_date, consensus_eps, analyst_count, snapshot_at, available_at, basis")
    .eq("market", "us");
  if (snErr) return NextResponse.json({ error: snErr.message }, { status: 500 });

  type Snap = { symbol: string; report_date: string; consensus_eps: number | null; analyst_count: number | null; snapshot_at: string; available_at: string; basis: string | null };
  const snapList = (snaps ?? []) as Snap[];

  // Index snapshots by (symbol|report_date).
  const snapsByKey = new Map<string, Snap[]>();
  for (const s of snapList) {
    const k = `${s.symbol}|${s.report_date}`;
    (snapsByKey.get(k) ?? snapsByKey.set(k, []).get(k)!).push(s);
  }

  type Ev = { symbol: string; report_date: string; eps_actual_first: number | null; actual_available_at: string | null; announcement_session: string | null; restated_eps: number | null; eps_basis: string | null };
  const evList = (events ?? []) as Ev[];

  const yearOf = (d: string) => (d && d.length >= 4 ? d.slice(0, 4) : "unknown");
  const sess = (s: string | null) => s ?? "unknown";

  const byYear: Record<string, { events: number; withActual: number; withConsensus: number; eligible: number }> = {};
  const bySession: Record<string, { events: number; eligible: number }> = {};
  let totalEvents = 0, withActual = 0, withPreConsensus = 0, eligible = 0, corrections = 0;
  const analystCounts: number[] = [];
  let consensusWithCount = 0;
  const basisConflicts: string[] = [];

  for (const ev of evList) {
    totalEvents++;
    const yr = yearOf(ev.report_date);
    const ss = sess(ev.announcement_session);
    byYear[yr] ??= { events: 0, withActual: 0, withConsensus: 0, eligible: 0 };
    bySession[ss] ??= { events: 0, eligible: 0 };
    byYear[yr].events++;
    bySession[ss].events++;

    const hasActual = ev.eps_actual_first != null;
    if (hasActual) { withActual++; byYear[yr].withActual++; }
    if (ev.restated_eps != null) corrections++;

    const key = `${ev.symbol}|${ev.report_date}`;
    const evSnaps = snapsByKey.get(key) ?? [];
    // Pre-announcement = snapshot available strictly before the actual was known.
    // If no actual yet, any snapshot still counts as a pre-announcement vintage.
    const preSnaps = evSnaps.filter((s) =>
      !ev.actual_available_at || new Date(s.available_at).getTime() <= new Date(ev.actual_available_at).getTime());
    const hasPreConsensus = preSnaps.length > 0;
    if (hasPreConsensus) { withPreConsensus++; byYear[yr].withConsensus++; }

    for (const s of preSnaps) {
      if (s.analyst_count != null) { analystCounts.push(s.analyst_count); consensusWithCount++; }
      if (hasActual && ev.eps_basis && s.basis && !s.basis.startsWith(ev.eps_basis.split("_")[0])) {
        basisConflicts.push(`${ev.symbol} ${ev.report_date}: actual=${ev.eps_basis} vs consensus=${s.basis}`);
      }
    }

    if (hasActual && hasPreConsensus) { eligible++; byYear[yr].eligible++; bySession[ss].eligible++; }
  }

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    market: "us",
    note: "Coverage/feasibility report only. Not a scored feature, not edge_signals. No money-path effect.",
    totals: {
      events: totalEvents,
      with_first_reported_actual: withActual,
      with_pre_announcement_consensus: withPreConsensus,
      eligible_events: eligible,
      corrections_logged: corrections,
      consensus_vintages: snapList.length,
      consensus_with_analyst_count: consensusWithCount,
      analyst_count_coverage_pct: snapList.length > 0 ? Math.round((consensusWithCount / snapList.length) * 100) : 0,
    },
    by_year: byYear,
    by_session: bySession,
    basis_conflicts: basisConflicts.slice(0, 50),
    caveats: [
      "eligible_events counts events with BOTH a first-reported actual and a pre-announcement consensus vintage.",
      "Analyst-count coverage is expected to be 0% on the free Finnhub calendar (no contributor count field).",
      "Vintages only accumulate going forward from first capture; historical pre-announcement consensus cannot be reconstructed.",
    ],
  });
}
