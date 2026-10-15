import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { isEntryCandidateLong } from "@/lib/learning/entry-cohort";
import { mineFormulaCandidates, miningRationale, MINING_HORIZONS, MINING_DIMS, WEIGHT_GRID_STEP } from "@/lib/score-variants/mining";
import type { Dim, ObsRow } from "@/lib/score-variants/core";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const numberOrNull = (value: unknown): number | null => {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

function toObsRows(labels: any[]): ObsRow[] {
  const rows: ObsRow[] = [];
  for (const item of labels) {
    const raw = Array.isArray(item.decision_observations) ? item.decision_observations[0] : item.decision_observations;
    const y = numberOrNull(item.benchmark_neutral_return);
    if (!raw || y == null || !isEntryCandidateLong({
      entryEligible: raw.entry_eligible, direction: raw.direction,
      decisionContext: raw.decision_context, discoverySource: raw.discovery_source,
    })) continue;
    const mask = raw.availability_mask ?? {};
    const score = (name: string) => numberOrNull(raw[`${name}_score`]);
    const scores: Partial<Record<Dim, number | null>> = {
      fundamental: score("fundamental"), technical: score("technical"), sentiment: score("sentiment"), insider: score("insider"),
    };
    const avail: Partial<Record<Dim, boolean>> = Object.fromEntries(MINING_DIMS.map((dim) => [dim, mask[dim] === true])) as Partial<Record<Dim, boolean>>;
    rows.push({ ts: String(raw.ts), symbol: String(raw.symbol).toUpperCase(), y, analyst: numberOrNull(raw.analyst_score), scores, avail });
  }
  return rows;
}

function fingerprint(rows: readonly ObsRow[], market: string, horizon: number): string {
  const canonical = [...rows].sort((a, b) => a.ts.localeCompare(b.ts) || a.symbol.localeCompare(b.symbol)).map((r) => ({
    ts: r.ts, symbol: r.symbol, y: r.y, analyst: r.analyst, scores: r.scores, avail: r.avail,
  }));
  return createHash("sha256").update(JSON.stringify({ algorithm: "simplex-0.1-mean-session-rank-ic-v1", market, horizon, rows: canonical })).digest("hex");
}

export async function POST() {
  const gate = await requireOwner();
  if (gate) return gate;

  const svc = createServiceClient();
  const fitCells: Array<{ market: "us" | "india"; horizon: number; rows: ObsRow[]; fingerprint: string; result: ReturnType<typeof mineFormulaCandidates> }> = [];
  for (const market of ["us", "india"] as const) {
    for (const horizon of MINING_HORIZONS) {
      const labels = await fetchAllRows((from, to) => svc.from("observation_labels")
        .select("observation_id,benchmark_neutral_return,decision_observations!inner(id,ts,symbol,market,analyst_score,fundamental_score,technical_score,sentiment_score,insider_score,availability_mask,entry_eligible,direction,decision_context,discovery_source)")
        .eq("horizon_days", horizon).eq("decision_observations.market", market)
        .order("observation_id", { ascending: true }).range(from, to), "formula mining labels") as any[];
      const rows = toObsRows(labels);
      const dataFingerprint = fingerprint(rows, market, horizon);
      fitCells.push({ market, horizon, rows, fingerprint: dataFingerprint, result: mineFormulaCandidates(rows, horizon) });
    }
  }

  const runFingerprint = createHash("sha256").update(JSON.stringify({
    version: "formula_mining_v1", step: WEIGHT_GRID_STEP,
    cells: fitCells.map((c) => ({ market: c.market, horizon: c.horizon, fingerprint: c.fingerprint })),
  })).digest("hex");
  const variantSet = `formula_mined_v1_${runFingerprint.slice(0, 16)}`;
  const declarations: Array<Record<string, unknown>> = [];
  const summaries: Array<Record<string, unknown>> = [];

  for (const cell of fitCells) {
    const latestDecision = cell.rows.map((r) => r.ts).sort().at(-1) ?? null;
    const firstDecision = cell.rows.map((r) => r.ts).sort()[0] ?? null;
    const metadata = {
      variant_set: variantSet,
      fit_cutoff: latestDecision,
      dataset_fingerprint: cell.fingerprint,
      market: cell.market,
      horizon_days: cell.horizon,
      dimensions_available: cell.result.dimensionsAvailable,
      trials_considered: cell.result.trialsConsidered,
      first_decision: firstDecision,
      input_rows: cell.rows.length,
      complete_case_entry_rows: cell.result.rows,
      qualifying_sessions: cell.result.qualifyingSessions,
    };
    summaries.push({ ...metadata, candidates: cell.result.candidates.length });
    for (const candidate of cell.result.candidates) {
      const variantId = `${cell.market}_h${cell.horizon}_${candidate.role}`;
      declarations.push({
        variant_set: variantSet,
        variant_id: variantId,
        label: `${cell.market.toUpperCase()} h${cell.horizon} · ${candidate.label}`,
        weights: candidate.weights,
        rationale: miningRationale({
          runFingerprint, datasetFingerprint: cell.fingerprint, market: cell.market, horizonDays: cell.horizon,
          fitCutoff: latestDecision ?? "no-data", dimensionsAvailable: cell.result.dimensionsAvailable,
          trialCount: cell.result.trialsConsidered,
          totalRunTrials: fitCells.reduce((sum, c) => sum + c.result.trialsConsidered, 0), candidate,
        }),
      });
    }
  }

  if (!declarations.length) return NextResponse.json({ ok: false, error: "No complete-case formula candidates could be fitted; no registry rows were written.", summaries }, { status: 422 });

  // This is deliberately a one-shot historical fit. Re-fitting after inspecting
  // forward results would let us keep searching the same holdout. A future fit
  // requires a new, separately pre-registered protocol and untouched forward data.
  const priorRows = await fetchAllRows((from, to) => svc.from("score_variant_registry")
    .select("variant_set,rationale").like("variant_set", "formula_mined_v1_%")
    .order("declared_at", { ascending: true }).range(from, to), "existing formula mining declarations") as any[];
  const priorSets = [...new Set(priorRows.map((r) => String(r.variant_set)))];
  const otherSet = priorSets.find((set) => set !== variantSet);
  if (otherSet) return NextResponse.json({
    ok: false, error: "Historical mining is already frozen. Do not re-fit against a holdout after inspecting it.",
    existingVariantSet: otherSet, requestedVariantSet: variantSet,
  }, { status: 409 });

  // Deterministic set id makes a retry idempotent. Insert only missing immutable rows.
  const { data: existing, error: existingError } = await svc.from("score_variant_registry")
    .select("variant_id").eq("variant_set", variantSet);
  if (existingError) return NextResponse.json({ ok: false, error: "Could not check formula-set idempotency." }, { status: 500 });
  const known = new Set((existing ?? []).map((r: any) => r.variant_id));
  const missing = declarations.filter((r) => !known.has(String(r.variant_id)));
  if (missing.length) {
    const { error } = await svc.from("score_variant_registry").insert(missing);
    if (error) {
      // A concurrent identical request may have inserted the same immutable keys.
      const { data: afterRetry } = await svc.from("score_variant_registry").select("variant_id").eq("variant_set", variantSet);
      const after = new Set((afterRetry ?? []).map((r: any) => r.variant_id));
      if (declarations.some((r) => !after.has(String(r.variant_id)))) {
        return NextResponse.json({ ok: false, error: `Formula declarations were not fully persisted: ${error.message}` }, { status: 500 });
      }
    }
  }

  const { data: persisted, error: persistedError } = await svc.from("score_variant_registry")
    .select("variant_id,declared_at").eq("variant_set", variantSet).order("declared_at", { ascending: true });
  if (persistedError || !persisted?.length) return NextResponse.json({ ok: false, error: "Formula set was not verifiably persisted." }, { status: 500 });
  return NextResponse.json({
    ok: true, shadowOnly: true, behaviorChanged: false, variantSet, runFingerprint,
    candidateCount: persisted.length, declaredAt: persisted[persisted.length - 1].declared_at,
    trialCounts: [...new Set(fitCells.map((c) => c.result.trialsConsidered))], summaries,
    note: "Candidates were selected on the complete historical sample by design. Their in-sample fit is overfit/hindsight only; forward evidence starts at each immutable declared_at after nightly evaluation.",
  });
}
