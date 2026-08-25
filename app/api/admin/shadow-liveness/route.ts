// GET /api/admin/shadow-liveness
//
// Detects the "frozen but green" failure mode: a shadow program that LOOKS healthy
// (rows exist, registry says "collecting") while it has silently stopped producing
// new evidence.
//
// This exists because pit-fundamentals failed exactly that way. It held 184 rows,
// one per symbol, and every dashboard read it as collecting. In reality
// captureFundamentalsFact threw on every restatement (supabase's PostgrestFilterBuilder
// has no .catch) and returned null, so no symbol had refreshed since first observation
// — for weeks. A row COUNT could never have caught it; only row RECENCY could.
//
// So the check here is deliberately not "are there rows". It is "has this program
// written anything lately, and is that consistent with what it claims to be".
import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { SHADOW_PROGRAMS } from "@/lib/shadows/registry";
import { requireOwner } from "@/lib/auth/require-owner";
import { ARCHETYPES } from "@/lib/scoring/archetypes";

export const dynamic = "force-dynamic";

type Verdict = "live" | "stale" | "frozen" | "empty" | "expected_empty" | "unknown";

// Evidence table + its write-timestamp column, per program id. A program whose
// evidence lives across several tables names the one that MUST grow when it runs.
const PROBES: Record<string, { table: string; tsCol: string; expectedIdleHours: number }> = {
  "dimension-diagnostics":       { table: "dimension_diagnostic_findings",        tsCol: "created_at",  expectedIdleHours: 48 },
  "decision-label-coverage":     { table: "observation_labels",                   tsCol: "matured_at",  expectedIdleHours: 48 },
  "exit-geometry":               { table: "observation_labels",                   tsCol: "matured_at",  expectedIdleHours: 48 },
  "evidence-router":             { table: "evidence_policy_evaluations",          tsCol: "created_at",  expectedIdleHours: 48 },
  "degradation-guard":           { table: "evidence_degradation_events",          tsCol: "created_at",  expectedIdleHours: 48 },
  "india-news-evidence":         { table: "evidence_cache_v2",                    tsCol: "fetched_at",  expectedIdleHours: 48 },
  "setup-experts":               { table: "shadow_decisions",                     tsCol: "ts",          expectedIdleHours: 72 },
  "technical-calibration":       { table: "edge_signals",                         tsCol: "created_at",  expectedIdleHours: 48 },
  "pit-fundamental-qualification": { table: "fundamental_facts",                  tsCol: "captured_at", expectedIdleHours: 72 },
  "capital-rotation":            { table: "rotation_events",                      tsCol: "created_at",  expectedIdleHours: 72 },
  "earnings-risk":               { table: "earnings_risk_observations",           tsCol: "created_at",  expectedIdleHours: 72 },
  "exogenous-risk":              { table: "exogenous_observations",               tsCol: "created_at",  expectedIdleHours: 48 },
  "international-allocation":    { table: "international_allocation_assessments", tsCol: "created_at",  expectedIdleHours: 192 },
  "autonomous-live":             { table: "trade_proposals",                      tsCol: "created_at",  expectedIdleHours: 72 },
  "challenger-validation":       { table: "validation_experiments",               tsCol: "created_at",  expectedIdleHours: 192 },
  "downside-hedge":              { table: "downside_hedge_events",                tsCol: "created_at",  expectedIdleHours: 168 },
  "specialist-feature-packs":    { table: "instrument_registry",                  tsCol: "last_observed_at", expectedIdleHours: 8760 },
};

// A program whose registry entry says it is off / foundation-only is ALLOWED to be
// empty — that is an honest declaration, not a fault. Anything else that is empty
// or long-idle while claiming to collect is the failure this endpoint hunts.
function declaredInactive(currentInfluence: string): boolean {
  const s = currentInfluence.toLowerCase();
  return s.startsWith("off") || s.includes("no source adapter") || s.includes("schema foundation only");
}

// ── Setup-expert COVERAGE, not just liveness ────────────────────────────────
//
// Recency alone cannot catch a PARTIAL outage. Between 2026-07-13 and
// 2026-08-24 the `setup-experts` probe above reported "live" every single day
// while 4 of the 6 archetypes and the entire India market wrote nothing:
// migration 163's unique index was (observation_id, policy_version_id) NULLS
// NOT DISTINCT, and every archetype row carries a NULL policy_version_id, so
// any batch of two or more experts for one observation collided and Postgres
// rejected the WHOLE batch. Only single-expert batches (ETFs, and US names
// below the value_inflection threshold) ever landed — enough to keep the table
// growing and the liveness check green.
//
// So this asks the question recency cannot: is EVERY expert that the router can
// emit actually present, per market, in the recent window?
const COVERAGE_WINDOW_HOURS = 72;

async function setupExpertCoverage(sb: any, now: number) {
  const since = new Date(now - COVERAGE_WINDOW_HOURS * 3_600_000).toISOString();
  const { data, error } = await sb
    .from("shadow_decisions")
    .select("market,setup_type")
    .gte("ts", since);
  if (error) return { verdict: "unknown" as Verdict, note: error.message };

  const seen = new Set((data ?? []).map((r: any) => `${r.market}:${r.setup_type}`));
  // `family_uncapped_v1:*` is emitted per instrument family rather than by the
  // archetype router, so it is not part of the expected fixed set.
  const expected: string[] = [];
  for (const a of ARCHETYPES) {
    expected.push(`${a.id.startsWith("india") ? "india" : "us"}:${a.id}`);
  }
  const missing = expected.filter(k => !seen.has(k));

  return {
    verdict: (missing.length === 0 ? "live" : "stale") as Verdict,
    window_hours: COVERAGE_WINDOW_HOURS,
    expected_experts: expected.length,
    present_experts: expected.length - missing.length,
    missing_experts: missing,
    note: missing.length === 0
      ? `all ${expected.length} market:expert pairs wrote within ${COVERAGE_WINDOW_HOURS}h`
      : `PARTIAL: ${missing.length}/${expected.length} market:expert pairs wrote NOTHING in ${COVERAGE_WINDOW_HOURS}h ` +
        `(${missing.join(", ")}). The table is still growing, so the liveness probe cannot see this.`,
  };
}

export async function GET() {
  // Owner-only: this enumerates internal program state and evidence-table health.
  const denied = await requireOwner();
  if (denied) return denied;

  const cookieStore = await cookies();
  const sb = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  );

  const now = Date.now();
  const rows = await Promise.all(SHADOW_PROGRAMS.map(async (p) => {
    const probe = PROBES[p.id];
    const base = {
      id: p.id, name: p.name, category: p.category,
      declared_influence: p.currentInfluence,
      cron_jobs: p.cronJobs,
    };
    if (!probe) return { ...base, verdict: "unknown" as Verdict, note: "no evidence probe registered" };

    try {
      const head = await sb.from(probe.table).select("*", { count: "exact", head: true });
      if (head.error) {
        return { ...base, verdict: "unknown" as Verdict, table: probe.table, note: head.error.message };
      }
      const count = head.count ?? 0;
      const inactive = declaredInactive(p.currentInfluence);

      if (count === 0) {
        return {
          ...base, table: probe.table, rows: 0,
          verdict: (inactive ? "expected_empty" : "empty") as Verdict,
          note: inactive
            ? "no rows, and the registry declares this program off / foundation-only"
            : "NO ROWS while the registry claims it is collecting",
        };
      }

      const last = await sb.from(probe.table)
        .select(probe.tsCol).order(probe.tsCol, { ascending: false }).limit(1);
      const lastWrite = (last.data?.[0] as any)?.[probe.tsCol] ?? null;
      const idleHours = lastWrite ? (now - new Date(lastWrite).getTime()) / 3_600_000 : null;

      let verdict: Verdict = "live";
      let note = "writing on schedule";
      if (idleHours == null) {
        verdict = "unknown"; note = `rows exist but ${probe.tsCol} is null — cannot prove recency`;
      } else if (idleHours > probe.expectedIdleHours * 3) {
        verdict = inactive ? "expected_empty" : "frozen";
        note = inactive
          ? "idle, and declared off"
          : `FROZEN: ${count} rows but nothing written for ${Math.round(idleHours)}h ` +
            `(expected a write every ~${probe.expectedIdleHours}h). Row count looks healthy; the program is not running.`;
      } else if (idleHours > probe.expectedIdleHours) {
        // A program the registry declares off is expected to sit idle; only a
        // program claiming to collect is "stale".
        verdict = inactive ? "expected_empty" : "stale";
        note = inactive
          ? `idle ${Math.round(idleHours)}h, and declared off`
          : `no write for ${Math.round(idleHours)}h, past the ${probe.expectedIdleHours}h expectation`;
      }

      return {
        ...base, table: probe.table, rows: count,
        last_write: lastWrite,
        idle_hours: idleHours == null ? null : Math.round(idleHours * 10) / 10,
        verdict, note,
      };
    } catch (e: any) {
      return { ...base, verdict: "unknown" as Verdict, note: String(e?.message ?? e) };
    }
  }));

  const tally = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] ?? 0) + 1; return acc;
  }, {});

  const setupExperts = await setupExpertCoverage(sb, now);

  return NextResponse.json({
    checked_at: new Date().toISOString(),
    tally,
    // Completeness, which recency structurally cannot answer. See setupExpertCoverage.
    setup_expert_coverage: setupExperts,
    // The two that matter operationally: something claiming to collect that isn't.
    attention: [
      ...rows.filter(r => r.verdict === "frozen" || r.verdict === "empty"),
      ...(setupExperts.verdict === "stale"
        ? [{ id: "setup-experts-coverage", verdict: setupExperts.verdict, note: setupExperts.note }]
        : []),
    ],
    programs: rows,
  });
}
