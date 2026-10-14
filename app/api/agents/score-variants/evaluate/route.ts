import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { HORIZONS, VARIANTS, VARIANT_SET, evaluateVariant, type ObsRow } from "@/lib/score-variants/core";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Measure-only nightly evaluation of the pre-registered score variants against the live composite. "forward" = observations dated at or
// after the variant set's declared_at (cannot have been used to choose the variants); "hindsight" = earlier observations, shown for reference
// only. Writes score_variant_eval_runs (append-only). Nothing in scoring, gates or trading reads it.

export async function GET(req: NextRequest) {
  const cron = verifyCronSecret(req);
  if (!cron) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const svc = createServiceClient();
  const batchId = randomUUID();

  const { data: registered, error: regError } = await svc.from("score_variant_registry").select("variant_id,declared_at").eq("variant_set", VARIANT_SET);
  if (regError || !registered?.length) return NextResponse.json({ ok: false, error: "variant registry unavailable" }, { status: 500 });
  const declaredMs = Math.min(...registered.map((r: any) => Date.parse(r.declared_at)));
  const known = new Set(registered.map((r: any) => r.variant_id));
  if (!VARIANTS.every((v) => known.has(v.id))) return NextResponse.json({ ok: false, error: "code variants differ from the registered set" }, { status: 500 });

  const summary: Array<{ market: string; horizon: number; rows: number; forwardRows: number }> = [];
  for (const market of ["us", "india"] as const) {
    for (const horizon of HORIZONS) {
      const labels = await fetchAllRows((from, to) => svc.from("observation_labels")
        .select("observation_id,benchmark_neutral_return,decision_observations!inner(id,ts,symbol,market,analyst_score,fundamental_score,technical_score,sentiment_score,availability_mask)")
        .eq("horizon_days", horizon).eq("decision_observations.market", market)
        .order("observation_id", { ascending: true }).range(from, to), "score variant labels") as any[];

      const all: ObsRow[] = [];
      for (const row of labels) {
        const o = Array.isArray(row.decision_observations) ? row.decision_observations[0] : row.decision_observations;
        const y = row.benchmark_neutral_return == null ? NaN : Number(row.benchmark_neutral_return);
        if (!o || !Number.isFinite(y)) continue;
        const mask = o.availability_mask ?? {};
        all.push({
          ts: String(o.ts), symbol: String(o.symbol).toUpperCase(), y, analyst: o.analyst_score == null ? null : Number(o.analyst_score),
          scores: { fundamental: o.fundamental_score == null ? null : Number(o.fundamental_score), technical: o.technical_score == null ? null : Number(o.technical_score), sentiment: o.sentiment_score == null ? null : Number(o.sentiment_score) },
          avail: { fundamental: mask.fundamental !== false, technical: mask.technical !== false, sentiment: mask.sentiment !== false },
        });
      }
      const forward = all.filter((r) => Date.parse(r.ts) >= declaredMs);
      const hindsight = all.filter((r) => Date.parse(r.ts) < declaredMs);
      summary.push({ market, horizon, rows: all.length, forwardRows: forward.length });

      const out: Record<string, unknown>[] = [];
      for (const [sample, rows] of [["forward", forward], ["hindsight", hindsight]] as const) {
        for (const def of VARIANTS) {
          const ev = evaluateVariant(def, rows, horizon);
          out.push({
            evaluation_batch_id: batchId, variant_set: VARIANT_SET, variant_id: def.id, market, sample, horizon_days: horizon,
            sessions: ev.sessions, avg_cross_section: Number(ev.avgCrossSection.toFixed(2)), independent_windows: Number(ev.independentWindows.toFixed(4)),
            variant_mean_ic: ev.variant.meanIc, variant_ic_t: ev.variant.icT, variant_top_fifth: ev.variant.topFifthExcess, variant_bottom_fifth: ev.variant.bottomFifthExcess, variant_spread: ev.variant.spread, variant_spread_t: ev.variant.spreadT,
            baseline_mean_ic: ev.baseline.meanIc, baseline_ic_t: ev.baseline.icT, baseline_top_fifth: ev.baseline.topFifthExcess, baseline_bottom_fifth: ev.baseline.bottomFifthExcess, baseline_spread: ev.baseline.spread, baseline_spread_t: ev.baseline.spreadT,
            classification: ev.classification, meets_adoption_gate: sample === "forward" && ev.meetsAdoptionGate, reason: sample === "hindsight" ? `HINDSIGHT sample (before the variants were declared): reference only. ${ev.reason}` : ev.reason,
          });
        }
      }
      const { error } = await svc.from("score_variant_eval_runs").insert(out);
      if (error) return NextResponse.json({ ok: false, error: `could not persist ${market} h${horizon}: ${error.message}` }, { status: 500 });
    }
  }

  await svc.from("agent_runs").insert({
    agent_type: "score_variants_evaluate", status: "done", market: "us", symbols: [], trigger_source: cron ? "scheduled" : "manual",
    signals_written: 0, completed_at: new Date().toISOString(), tokens_input: 0, tokens_output: 0, claude_calls: 0,
    result_summary: `Shadow only: ${summary.map((s) => `${s.market} h${s.horizon} ${s.forwardRows} forward / ${s.rows - s.forwardRows} hindsight rows`).join("; ")}; behavior changed=false`,
  });
  return NextResponse.json({ ok: true, shadowOnly: true, behaviorChanged: false, batchId, declaredAt: new Date(declaredMs).toISOString(), summary });
}

export const POST = GET;
