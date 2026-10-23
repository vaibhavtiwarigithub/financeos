// Owner-only collection-health audit for every Upgrade Path registry entry.
// This endpoint reports evidence liveness only; it never asserts P&L readiness.
import { SHADOW_PROGRAMS } from "@/lib/shadows/registry";
import { ARCHETYPES } from "@/lib/scoring/archetypes";
import { fetchAllRows } from "@/lib/supabase/paginate";
import {
  evaluateShadowLiveness,
  missingProbeProgramIds,
  scheduledJobsForMarket,
  SHADOW_EVIDENCE_PROBES,
  type CronEvidence,
} from "@/lib/shadows/liveness";


const COVERAGE_WINDOW_HOURS = 72;

async function setupExpertCoverage(sb: any, now: number, market: "us" | "india") {
  const since = new Date(now - COVERAGE_WINDOW_HOURS * 3_600_000).toISOString();
  let data: any[];
  try {
    data = await fetchAllRows((from, to) => sb
      .from("shadow_decisions")
      .select("market,setup_type")
      .eq("market", market)
      .gte("ts", since)
      .order("id", { ascending: true })
      .range(from, to), "shadow liveness setup-expert coverage");
  } catch (error: any) {
    return { verdict: "unknown", note: error?.message ?? "setup-expert coverage query failed" };
  }

  const seen = new Set(data.map((row) => `${row.market}:${row.setup_type}`));
  const expected = ARCHETYPES
    .filter((archetype) => (archetype.id.startsWith("india") ? "india" : "us") === market)
    .map((archetype) => `${market}:${archetype.id}`);
  const missing = expected.filter((key) => !seen.has(key));
  return {
    verdict: missing.length === 0 ? "live" : "stale",
    window_hours: COVERAGE_WINDOW_HOURS,
    expected_experts: expected.length,
    present_experts: expected.length - missing.length,
    missing_experts: missing,
    note: missing.length === 0
      ? `All ${expected.length} market:expert pairs wrote within ${COVERAGE_WINDOW_HOURS}h.`
      : `${missing.length}/${expected.length} market:expert pairs have no row within ${COVERAGE_WINDOW_HOURS}h: ${missing.join(", ")}.`,
  };
}

export async function loadShadowCollectionHealth(sb: any, onlyMarket?: "us" | "india") {
  const now = Date.now();
  const cronResult = await sb.rpc("get_shadow_cron_health");
  const cronRows = (cronResult.data ?? []) as CronEvidence[];
  const entries = SHADOW_PROGRAMS.flatMap(program => program.markets.filter(market => !onlyMarket || market === onlyMarket).map(market => ({ program, market })));
  const readProgram = async ({ program, market }: typeof entries[number]) => {
      const probe = SHADOW_EVIDENCE_PROBES[program.id];
      const base = {
        id: program.id,
        name: program.name,
        market,
        category: program.category,
        attribution_class: program.attributionClass,
        declared_influence: program.currentInfluence,
        cron_jobs: scheduledJobsForMarket(program, market),
      };
      if (!probe) return { ...base, verdict: "unknown", note: "No collection contract is registered." };
      if (cronResult.error) return { ...base, table: probe.table, verdict: "unknown", note: `Cron schedule truth unavailable: ${cronResult.error.message}` };

    try {
      let count: number | null = null;
      let lastWrite: string | null = null;
      if (probe.mode !== "off" && probe.mode !== "inert") {
        if (!probe.table || !probe.tsCol) return { ...base, verdict: "unknown", note: "Evidence table/timestamp contract is incomplete." };
        let headQuery = sb.from(probe.table).select("*", { count: "exact", head: true });
        if (probe.marketCol) headQuery = probe.includeGlobalContext ? headQuery.in(probe.marketCol, [market, "global"]) : headQuery.eq(probe.marketCol, market);
        for (const [column, value] of Object.entries(probe.equals ?? {})) headQuery = headQuery.eq(column, value);
        for (const [column, values] of Object.entries(probe.in ?? {})) headQuery = headQuery.in(column, values);
        const head = await headQuery;
        if (head.error) return { ...base, verdict: "unknown", note: `Evidence query failed: ${head.error.message}` };
        if (typeof head.count !== "number" || !Number.isFinite(head.count) || head.count < 0) return { ...base, verdict: "unknown", note: "Evidence count unavailable." };
        count = head.count;
        if (head.count > 0) {
          let latestQuery = sb.from(probe.table)
            .select(probe.tsCol)
            .not(probe.tsCol, "is", null)
            .order(probe.tsCol, { ascending: false })
            .limit(1);
          if (probe.marketCol) latestQuery = probe.includeGlobalContext ? latestQuery.in(probe.marketCol, [market, "global"]) : latestQuery.eq(probe.marketCol, market);
          for (const [column, value] of Object.entries(probe.equals ?? {})) latestQuery = latestQuery.eq(column, value);
          for (const [column, values] of Object.entries(probe.in ?? {})) latestQuery = latestQuery.in(column, values);
          const latest = await latestQuery;
          if (latest.error) return { ...base, verdict: "unknown", note: `Latest evidence timestamp query failed: ${latest.error.message}` };
          lastWrite = (latest.data?.[0] as any)?.[probe.tsCol] ?? null;
        }
      }
      const result = evaluateShadowLiveness({ program, market, probe, count, lastWrite, cronRows, nowMs: now });
      const expertCoverage = program.id === "setup-experts" ? await setupExpertCoverage(sb, now, market) : null;
      return {
        ...base,
        table: probe.table,
        evidence_contract: probe.note,
        market_scope: probe.includeGlobalContext ? "market_and_global_context" : probe.marketCol ? "market_local" : probe.marketScope === "single_market" ? "single_market" : "shared_evidence",
        verdict: result.verdict,
        note: result.note,
        rows: count,
        last_write: result.lastWrite,
        idle_hours: result.idleHours == null ? null : Math.round(result.idleHours * 10) / 10,
        schedules: result.schedules,
        ...(expertCoverage ? { setup_expert_coverage: expertCoverage } : {}),
      };
    } catch (error: any) {
      return { ...base, table: probe.table, verdict: "unknown", note: String(error?.message ?? error) };
    }
  };
  // Exact counts can scan shared ledgers. Bound the audit fan-out instead of
  // competing with research and label maturation for dozens of DB connections.
  const programs: Awaited<ReturnType<typeof readProgram>>[] = [];
  for (let offset = 0; offset < entries.length; offset += 4) {
    programs.push(...await Promise.all(entries.slice(offset, offset + 4).map(readProgram)));
  }

  const tally = programs.reduce<Record<string, number>>((acc, row: any) => {
    acc[row.verdict] = (acc[row.verdict] ?? 0) + 1;
    return acc;
  }, {});
  const missingProbes = missingProbeProgramIds(SHADOW_PROGRAMS);
  const attention = [
    ...programs.filter((row: any) => ["frozen", "stale", "empty", "missing_schedule", "inactive_schedule", "unexpected_schedule", "never_run", "failed_schedule_run", "stale_schedule_run", "unknown"].includes(row.verdict)),
    ...programs.flatMap((row: any) => row.setup_expert_coverage?.verdict === "stale"
      ? [{ id: `${row.id}-coverage`, market: row.market, ...row.setup_expert_coverage }]
      : []),
  ];

  return {
    checked_at: new Date().toISOString(),
    tally,
    registry_count: SHADOW_PROGRAMS.length,
    market_view_count: programs.length,
    probe_coverage: { registered: SHADOW_PROGRAMS.length - missingProbes.length, expected: SHADOW_PROGRAMS.length, missing: missingProbes },
    attribution_warning: "Collection liveness proves only that source evidence exists or is being collected. It does not prove a portfolio-level paired replay or causal P&L impact.",
    attention,
    programs,
  };
}
