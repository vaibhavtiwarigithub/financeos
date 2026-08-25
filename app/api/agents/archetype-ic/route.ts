// POST/GET /api/agents/archetype-ic?market=us|india[&horizon=10]
//
// Grades every archetype weighting arm in `shadow_decisions` against realized
// benchmark-neutral forward returns, alongside the champion composite measured
// on the SAME observations.
//
// Measure-only: it writes to `archetype_ic_runs` and nothing else. No scoring,
// sizing, entry or exit path reads that table.
//
// GET is a dry run — returns the verdicts without writing, so the instrument can
// be inspected before it starts accumulating a ledger.
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { requireOwner } from "@/lib/auth/require-owner";
import { computeArchetypeIc, type ArchetypeScoreRow } from "@/lib/learning/archetype-ic";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const DEFAULT_HORIZONS = [10, 20] as const;

function marketFrom(req: NextRequest): "us" | "india" | null {
  const m = req.nextUrl.searchParams.get("market");
  return m === "us" || m === "india" ? m : null;
}

async function authorize(req: NextRequest): Promise<NextResponse | null> {
  if (verifyCronSecret(req)) return null;
  return requireOwner();
}

/**
 * Pull (archetype score, champion score, forward return) triples.
 *
 * The join is the whole point: `shadow_decisions.observation_id` gives both the
 * champion's own `analyst_score` and the label, so every archetype is graded on
 * exactly the rows it actually scored. `etf_trend` only ever scores ETFs — a
 * whole-market champion baseline would be a different universe.
 */
async function loadRows(svc: any, market: "us" | "india", horizonDays: number): Promise<ArchetypeScoreRow[]> {
  const rows: ArchetypeScoreRow[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await svc
      .from("shadow_decisions")
      .select("setup_type, symbol, ts, score, observation_id, decision_observations!inner(analyst_score, ts, observation_labels!inner(horizon_days, benchmark_neutral_return))")
      .eq("market", market)
      .not("setup_type", "is", null)
      .not("score", "is", null)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`shadow_decisions read failed: ${error.message}`);
    const page = (data ?? []) as any[];
    for (const r of page) {
      const obs = r.decision_observations;
      if (!obs) continue;
      const champion = Number(obs.analyst_score);
      const labels: any[] = Array.isArray(obs.observation_labels) ? obs.observation_labels : [obs.observation_labels];
      const label = labels.find((l: any) => l && Number(l.horizon_days) === horizonDays);
      const fwd = label == null ? Number.NaN : Number(label.benchmark_neutral_return);
      const score = Number(r.score);
      if (!Number.isFinite(champion) || !Number.isFinite(fwd) || !Number.isFinite(score)) continue;
      rows.push({
        market,
        setupType: String(r.setup_type),
        symbol: String(r.symbol),
        // Group by the OBSERVATION's date, not the shadow row's write time — the
        // decision is what clusters, and a shadow row can be written minutes later.
        date: String(obs.ts).slice(0, 10),
        ts: String(r.ts ?? obs.ts),
        score,
        championScore: champion,
        forwardReturn: fwd,
      });
    }
    if (page.length < PAGE) break;
  }
  return rows;
}

async function run(svc: any, market: "us" | "india", horizons: readonly number[], persist: boolean) {
  const asOfDate = new Date().toISOString().slice(0, 10);
  const reports: any[] = [];

  for (const horizonDays of horizons) {
    const all = await loadRows(svc, market, horizonDays);
    const bySetup = new Map<string, ArchetypeScoreRow[]>();
    for (const r of all) {
      const list = bySetup.get(r.setupType) ?? [];
      list.push(r);
      bySetup.set(r.setupType, list);
    }

    for (const [setupType, rows] of bySetup) {
      const result = computeArchetypeIc(rows, horizonDays);
      if (!result) continue;
      reports.push({ horizonDays, ...result });
      if (!persist) continue;
      const { error } = await svc.from("archetype_ic_runs").upsert({
        as_of_date: asOfDate,
        market,
        setup_type: setupType,
        horizon_days: horizonDays,
        qualifying_sessions: result.qualifyingSessions,
        observations: result.observations,
        rank_ic: result.rankIc,
        rank_ic_t: result.rankIcT,
        champion_rank_ic: result.championRankIc,
        ic_delta_vs_champion: result.icDeltaVsChampion,
        effective_observations: result.effectiveObs,
        status: result.status,
        reason: result.reason,
      }, { onConflict: "as_of_date,market,setup_type,horizon_days" });
      if (error) throw new Error(`archetype_ic_runs write failed: ${error.message}`);
    }
  }
  return { market, as_of_date: asOfDate, persisted: persist, reports };
}

function horizonsFrom(req: NextRequest): readonly number[] {
  const h = Number(req.nextUrl.searchParams.get("horizon"));
  return Number.isFinite(h) && h > 0 ? [h] : DEFAULT_HORIZONS;
}

export async function POST(req: NextRequest) {
  const gate = await authorize(req);
  if (gate) return gate;
  const market = marketFrom(req);
  if (!market) return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  try {
    return NextResponse.json(await run(createServiceClient(), market, horizonsFrom(req), true));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

/** Dry run — computes and returns, writes nothing. */
export async function GET(req: NextRequest) {
  const gate = await authorize(req);
  if (gate) return gate;
  const market = marketFrom(req);
  if (!market) return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  try {
    return NextResponse.json(await run(createServiceClient(), market, horizonsFrom(req), false));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
