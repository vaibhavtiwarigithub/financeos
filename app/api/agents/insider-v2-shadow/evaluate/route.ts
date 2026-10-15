import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { HORIZONS, evaluateVariant, type ObsRow, type VariantDef } from "@/lib/score-variants/core";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Measure-only, forward-only. Compares insider v2 (planned 10b5-1 sales ignored) with insider v1 (live logic) computed from the SAME Form 4
// filings, on the same rows: the "baseline" slot of evaluateVariant carries v1, not the live composite. Observations are joined to the latest
// shadow row at or before their date (max 3 days stale); only observations after the registered declaration count. Writes to
// score_variant_eval_runs under variant_set 'insider_v2'. Nothing in scoring, gates or trading reads it.

const VARIANT_SET = "insider_v2";
const DEF: VariantDef = { id: "insider_v2_discretionary", label: "Insider v2 (ignores planned sales)", weights: { insider_v2: 1 } };
const MAX_STALE_DAYS = 3;
const dayMs = 86400_000;

export async function GET(req: NextRequest) {
  const cron = verifyCronSecret(req);
  if (!cron) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const svc = createServiceClient();
  const batchId = randomUUID();

  const { data: registered, error: regError } = await svc.from("score_variant_registry").select("variant_id,declared_at").eq("variant_set", VARIANT_SET);
  if (regError || !registered?.some((r: any) => r.variant_id === DEF.id)) return NextResponse.json({ ok: false, error: "insider v2 registry entry unavailable" }, { status: 500 });
  const declaredMs = Math.min(...registered.map((r: any) => Date.parse(r.declared_at)));

  const shadow = await fetchAllRows((f, t) => svc.from("insider_v2_shadow").select("symbol,as_of,v1_score,v1_available,v2_score,v2_available").order("id", { ascending: true }).range(f, t), "insider v2 shadow") as any[];
  const bySymbol = new Map<string, Array<{ ms: number; v1: number | null; v1a: boolean; v2: number | null; v2a: boolean }>>();
  for (const s of shadow) {
    const list = bySymbol.get(s.symbol) ?? [];
    list.push({ ms: Date.parse(s.as_of), v1: s.v1_score == null ? null : Number(s.v1_score), v1a: s.v1_available === true, v2: s.v2_score == null ? null : Number(s.v2_score), v2a: s.v2_available === true });
    bySymbol.set(s.symbol, list);
  }
  for (const list of bySymbol.values()) list.sort((a, b) => a.ms - b.ms);

  const summary: Array<{ horizon: number; rows: number; paired: number }> = [];
  for (const horizon of HORIZONS) {
    const labels = await fetchAllRows((f, t) => svc.from("observation_labels")
      .select("observation_id,benchmark_neutral_return,decision_observations!inner(id,ts,symbol,market)")
      .eq("horizon_days", horizon).eq("decision_observations.market", "us")
      .gte("decision_observations.ts", new Date(declaredMs).toISOString())
      .order("observation_id", { ascending: true }).range(f, t), "insider v2 labels") as any[];

    const rows: ObsRow[] = [];
    for (const row of labels) {
      const o = Array.isArray(row.decision_observations) ? row.decision_observations[0] : row.decision_observations;
      const y = row.benchmark_neutral_return == null ? NaN : Number(row.benchmark_neutral_return);
      if (!o || !Number.isFinite(y)) continue;
      const obsMs = Date.parse(String(o.ts).slice(0, 10));
      const sym = String(o.symbol).toUpperCase();
      const cand = (bySymbol.get(sym) ?? []).filter((s) => s.ms <= obsMs && obsMs - s.ms <= MAX_STALE_DAYS * dayMs).pop();
      if (!cand) continue;
      rows.push({ ts: String(o.ts), symbol: sym, y, analyst: cand.v1a ? cand.v1 : null, scores: { insider_v2: cand.v2 }, avail: { insider_v2: cand.v2a } });
    }
    const ev = evaluateVariant(DEF, rows, horizon);
    summary.push({ horizon, rows: labels.length, paired: rows.filter((r) => r.analyst != null && r.avail.insider_v2).length });
    const { error } = await svc.from("score_variant_eval_runs").insert({
      evaluation_batch_id: batchId, variant_set: VARIANT_SET, variant_id: DEF.id, market: "us", sample: "forward", horizon_days: horizon,
      sessions: ev.sessions, avg_cross_section: Number(ev.avgCrossSection.toFixed(2)), independent_windows: Number(ev.independentWindows.toFixed(4)),
      variant_mean_ic: ev.variant.meanIc, variant_ic_t: ev.variant.icT, variant_top_fifth: ev.variant.topFifthExcess, variant_bottom_fifth: ev.variant.bottomFifthExcess, variant_spread: ev.variant.spread, variant_spread_t: ev.variant.spreadT,
      paired_spread_delta: ev.pairedSpreadDelta, paired_spread_delta_t: ev.pairedSpreadDeltaT,
      baseline_mean_ic: ev.baseline.meanIc, baseline_ic_t: ev.baseline.icT, baseline_top_fifth: ev.baseline.topFifthExcess, baseline_bottom_fifth: ev.baseline.bottomFifthExcess, baseline_spread: ev.baseline.spread, baseline_spread_t: ev.baseline.spreadT,
      classification: ev.classification, meets_adoption_gate: ev.meetsAdoptionGate,
      reason: `Baseline here is insider v1 computed from the same filings (not the live composite). ${ev.reason}`,
    });
    if (error) return NextResponse.json({ ok: false, error: `could not persist h${horizon}: ${error.message}` }, { status: 500 });
  }

  await svc.from("agent_runs").insert({
    agent_type: "insider_v2_evaluate", status: "done", market: "us", symbols: [], trigger_source: cron ? "scheduled" : "manual",
    signals_written: 0, completed_at: new Date().toISOString(), tokens_input: 0, tokens_output: 0, claude_calls: 0,
    result_summary: `Shadow only: ${summary.map((s) => `h${s.horizon} ${s.paired} paired of ${s.rows} labelled`).join("; ")}; behavior changed=false`,
  });
  return NextResponse.json({ ok: true, shadowOnly: true, behaviorChanged: false, batchId, declaredAt: new Date(declaredMs).toISOString(), summary });
}

export const POST = GET;
