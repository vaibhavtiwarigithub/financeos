import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { isEntryCandidateLong } from "@/lib/learning/entry-cohort";
import { HORIZONS, VARIANTS, VARIANT_SET, evaluateVariant, type ObsRow } from "@/lib/score-variants/core";
import { asMinedVariant, MINING_HORIZONS, parseMiningRationale } from "@/lib/score-variants/mining";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function loadObservationRows(svc: ReturnType<typeof createServiceClient>, market: "us" | "india", horizon: number, entryOnly = false): Promise<ObsRow[]> {
  const labels = await fetchAllRows((from, to) => svc.from("observation_labels")
    .select("observation_id,benchmark_neutral_return,decision_observations!inner(id,ts,symbol,market,analyst_score,fundamental_score,technical_score,sentiment_score,insider_score,availability_mask,entry_eligible,direction,decision_context,discovery_source)")
    .eq("horizon_days", horizon).eq("decision_observations.market", market)
    .order("observation_id", { ascending: true }).range(from, to), "score variant labels") as any[];
  const all: ObsRow[] = [];
  for (const row of labels) {
    const o = Array.isArray(row.decision_observations) ? row.decision_observations[0] : row.decision_observations;
    const y = row.benchmark_neutral_return == null ? NaN : Number(row.benchmark_neutral_return);
    if (!o || !Number.isFinite(y)) continue;
    if (entryOnly && !isEntryCandidateLong({ entryEligible: o.entry_eligible, direction: o.direction, decisionContext: o.decision_context, discoverySource: o.discovery_source })) continue;
    const mask = o.availability_mask ?? {};
    const value = (name: string) => o[`${name}_score`] == null ? null : Number(o[`${name}_score`]);
    all.push({
      ts: String(o.ts), symbol: String(o.symbol).toUpperCase(), y, analyst: o.analyst_score == null ? null : Number(o.analyst_score),
      scores: { fundamental: value("fundamental"), technical: value("technical"), sentiment: value("sentiment"), insider: value("insider") },
      avail: { fundamental: mask.fundamental === true, technical: mask.technical === true, sentiment: mask.sentiment === true, insider: mask.insider === true },
    });
  }
  return all;
}

async function loadEntryObservationRows(svc: ReturnType<typeof createServiceClient>, market: "us" | "india", horizon: number): Promise<ObsRow[]> {
  return loadObservationRows(svc, market, horizon, true);
}

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
  const observations = new Map<string, ObsRow[]>();
  const entryObservations = new Map<string, ObsRow[]>();
  for (const market of ["us", "india"] as const) {
    for (const horizon of HORIZONS) {
      const all = await loadObservationRows(svc, market, horizon);
      observations.set(`${market}:${horizon}`, all);
      const forward = all.filter((r) => Date.parse(r.ts) >= declaredMs);
      const hindsight = all.filter((r) => Date.parse(r.ts) < declaredMs);
      summary.push({ market, horizon, rows: all.length, forwardRows: forward.length });

      const out: Record<string, unknown>[] = [];
      for (const [sample, rows] of [["forward", forward], ["hindsight", hindsight]] as const) {
        for (const def of VARIANTS) {
          const ev = evaluateVariant(def, rows, horizon, market);
          out.push({
            evaluation_batch_id: batchId, variant_set: VARIANT_SET, variant_id: def.id, market, sample, horizon_days: horizon,
            sessions: ev.sessions, avg_cross_section: Number(ev.avgCrossSection.toFixed(2)), independent_windows: Number(ev.independentWindows.toFixed(4)),
            variant_mean_ic: ev.variant.meanIc, variant_ic_t: ev.variant.icT, variant_top_fifth: ev.variant.topFifthExcess, variant_bottom_fifth: ev.variant.bottomFifthExcess, variant_spread: ev.variant.spread, variant_spread_t: ev.variant.spreadT,
            paired_spread_delta: ev.pairedSpreadDelta, paired_spread_delta_t: ev.pairedSpreadDeltaT,
            baseline_mean_ic: ev.baseline.meanIc, baseline_ic_t: ev.baseline.icT, baseline_top_fifth: ev.baseline.topFifthExcess, baseline_bottom_fifth: ev.baseline.bottomFifthExcess, baseline_spread: ev.baseline.spread, baseline_spread_t: ev.baseline.spreadT,
            classification: ev.classification, meets_adoption_gate: false, reason: `${sample === "hindsight" ? "HINDSIGHT: reference only. " : ""}session-distance-hac-v2-descriptive; t is descriptive, not calibrated small-sample inference. ${ev.reason}`,
          });
        }
      }
      const { error } = await svc.from("score_variant_eval_runs").insert(out);
      if (error) return NextResponse.json({ ok: false, error: `could not persist ${market} h${horizon}: ${error.message}` }, { status: 500 });
    }
  }

  // The miner declares each formula independently. Never use the set's oldest
  // timestamp: that would leak pre-declaration labels into a newer candidate's
  // forward cohort. The historical formulas are never adoption-eligible here.
  const { data: minedRows, error: minedError } = await svc.from("score_variant_registry")
    .select("variant_set,variant_id,label,weights,declared_at,rationale")
    .like("variant_set", "formula_mined_v1_%").order("declared_at", { ascending: true });
  if (minedError) return NextResponse.json({ ok: false, error: "Could not load immutable mined formulas." }, { status: 500 });
  const minedOut: Record<string, unknown>[] = [];
  for (const row of minedRows ?? []) {
    const meta = parseMiningRationale(row.rationale);
    const def = asMinedVariant(row);
    const market = meta?.market;
    const horizon = Number(meta?.horizonDays);
    const declaredAt = Date.parse(String(row.declared_at));
    if (!meta || !def || (market !== "us" && market !== "india") || !(MINING_HORIZONS as readonly number[]).includes(horizon) || !Number.isFinite(declaredAt)) {
      return NextResponse.json({ ok: false, error: `Invalid immutable formula declaration: ${row.variant_set}/${row.variant_id}` }, { status: 500 });
    }
    const cacheKey = `${market}:${horizon}`;
    let all = entryObservations.get(cacheKey);
    if (!all) {
      all = await loadEntryObservationRows(svc, market, horizon);
      entryObservations.set(cacheKey, all);
    }
    const forward = all.filter((r) => Date.parse(r.ts) >= declaredAt);
    const hindsight = all.filter((r) => Date.parse(r.ts) < declaredAt);
    for (const [sample, rows] of [["forward", forward], ["hindsight", hindsight]] as const) {
      const ev = evaluateVariant(def, rows, horizon, market);
      minedOut.push({
        evaluation_batch_id: batchId, variant_set: row.variant_set, variant_id: row.variant_id, market,
        sample, horizon_days: horizon, sessions: ev.sessions, avg_cross_section: Number(ev.avgCrossSection.toFixed(2)),
        independent_windows: Number(ev.independentWindows.toFixed(4)),
        variant_mean_ic: ev.variant.meanIc, variant_ic_t: ev.variant.icT, variant_top_fifth: ev.variant.topFifthExcess,
        variant_bottom_fifth: ev.variant.bottomFifthExcess, variant_spread: ev.variant.spread, variant_spread_t: ev.variant.spreadT,
        paired_spread_delta: ev.pairedSpreadDelta, paired_spread_delta_t: ev.pairedSpreadDeltaT,
        baseline_mean_ic: ev.baseline.meanIc, baseline_ic_t: ev.baseline.icT, baseline_top_fifth: ev.baseline.topFifthExcess,
        baseline_bottom_fifth: ev.baseline.bottomFifthExcess, baseline_spread: ev.baseline.spread,
        classification: ev.classification, meets_adoption_gate: false,
        reason: sample === "hindsight"
          ? `OVERFIT/HINDSIGHT: this formula was selected on historical labels. These rows are only the fit diagnostic, never evidence of generalization. Declared ${row.declared_at}. ${ev.reason}`
          : `Forward-only shadow; labels must come from observations at or after this formula's own declaration (${row.declared_at}). No automatic promotion or trading consumer. ${ev.reason}`,
      });
    }
  }
  if (minedOut.length) {
    const { error } = await svc.from("score_variant_eval_runs").insert(minedOut);
    if (error) return NextResponse.json({ ok: false, error: `could not persist mined formula shadow rows: ${error.message}` }, { status: 500 });
  }

  const runTime = new Date().toISOString();
  const runRows = (["us", "india"] as const).map((market) => ({
    agent_type: "score_variants_evaluate", status: "done", market, symbols: [], trigger_source: cron ? "scheduled" : "manual",
    signals_written: 0, completed_at: runTime, tokens_input: 0, tokens_output: 0, claude_calls: 0,
    result_summary: `Shadow only: ${summary.filter((s) => s.market === market).map((s) => `h${s.horizon} ${s.forwardRows} forward / ${s.rows - s.forwardRows} hindsight rows`).join("; ")}; ${minedOut.filter((r) => r.market === market).length / 2} mined candidates evaluated; behavior changed=false`,
  }));
  const { error: runError } = await svc.from("agent_runs").insert(runRows);
  if (runError) return NextResponse.json({ ok: false, error: `Evaluations persisted but market-local run records failed: ${runError.message}`, batchId }, { status: 500 });
  return NextResponse.json({ ok: true, shadowOnly: true, behaviorChanged: false, batchId, declaredAt: new Date(declaredMs).toISOString(), summary, minedCandidates: minedOut.length / 2 });
}

export const POST = GET;
