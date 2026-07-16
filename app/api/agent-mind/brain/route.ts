import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { resolveDisplayWeights } from "@/lib/champion-weights";

export const dynamic = "force-dynamic";

// GET — one aggregated, read-only snapshot of "what the system believes now and
// how sure it is." Every number traces to a real table; nothing is LLM-invented.
// ?market=us|india scopes the champion/performance/regime sections.
export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  const market = new URL(req.url).searchParams.get("market") === "india" ? "india" : "us";

  // 1. Current champion (the working theory) for this market + its lineage.
  const { data: champion } = await svc
    .from("strategy_versions")
    .select("id, version, name, weights_snapshot, notes, promoted_at, parent_version_id, market, validation_experiment_id")
    .eq("market", market).eq("is_champion", true)
    .maybeSingle();
  let parent: any = null;
  if (champion?.parent_version_id) {
    const { data } = await svc.from("strategy_versions").select("version, name, weights_snapshot, promoted_at").eq("id", champion.parent_version_id).maybeSingle();
    parent = data ?? null;
  }

  // 2. Live per-dimension weights actually scoring today — the market's promoted
  // champion snapshot (falling back to the static per-risk-profile baseline), NOT
  // the vestigial global signal_weights row. US and India each show their own.
  const liveWeights = await resolveDisplayWeights(svc, market);

  // 3. Belief drift — priors whose confidence moved most (needs >=2 history rows).
  const { data: priors } = await svc.from("learning_priors").select("id, category, principle, confidence, enabled");
  const { data: hist } = await svc.from("learning_priors_history").select("prior_id, confidence, changed_at").order("changed_at", { ascending: true });
  const firstConf = new Map<number, number>();
  const lastConf = new Map<number, number>();
  for (const h of (hist ?? []) as any[]) {
    if (h.confidence == null) continue;
    if (!firstConf.has(h.prior_id)) firstConf.set(h.prior_id, h.confidence);
    lastConf.set(h.prior_id, h.confidence);
  }
  const priorById = new Map<number, any>((priors ?? []).map((p: any) => [p.id, p]));
  const drift = [...lastConf.keys()].map(id => {
    const p = priorById.get(id); if (!p) return null;
    const delta = (lastConf.get(id) ?? 0) - (firstConf.get(id) ?? 0);
    return { id, category: p.category, principle: p.principle, delta, current: p.confidence };
  }).filter(Boolean).filter((d: any) => Math.abs(d.delta) > 0.001).sort((a: any, b: any) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 8);

  // 4. Recent learning-log entries (hypotheses / weight moves).
  const { data: learnLog } = await svc
    .from("learning_log")
    .select("signal_adjusted, old_weight, new_weight, reason, note, trades_evaluated, created_at")
    .order("created_at", { ascending: false }).limit(8);

  // 5. Self-invented features + their IC-gate state.
  const { data: features } = await svc
    .from("feature_registry")
    .select("name, status, proposed_by, created_at")
    .order("created_at", { ascending: false }).limit(10);

  // 6. Current macro regime posture.
  const { data: regime } = await svc
    .from("macro_regime")
    .select("week_of, danger_score, regime, summary, ai_bubble_score")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();

  // 7. Track-record honesty — realized alpha + resolved-trade counts for context.
  const { data: perf } = await svc
    .from("paper_performance")
    .select("date, nav, total_pnl_pct, win_rate, win_count, loss_count, alpha_pct")
    .eq("market", market).order("date", { ascending: false }).limit(1).maybeSingle();
  const resolvedTrades = ((perf as any)?.win_count ?? 0) + ((perf as any)?.loss_count ?? 0);
  const priorCount = (priors ?? []).length;

  return NextResponse.json({
    market,
    champion: champion ?? null,
    champion_parent: parent,
    live_weights: liveWeights ?? null,
    belief_drift: drift,
    learning_log: learnLog ?? [],
    features: features ?? [],
    regime: regime ?? null,
    performance: perf ?? null,
    // Context so a belief with tiny N never reads as authoritative.
    evidence_context: { resolved_trades: resolvedTrades, prior_count: priorCount },
  });
}
