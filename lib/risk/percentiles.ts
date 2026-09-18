// Phase 2 learning-core: MAE/MFE percentiles from the decision ledger — the
// raw material for dynamic (pattern-conditioned) stops/targets, replacing the
// fixed 7%/20% profile constants. Global per market+horizon (not per-symbol —
// a per-symbol cut needs far more data than exists yet; global is the
// documented fallback and, for now, the only tier built).

import { isEntryCandidateLong } from "@/lib/learning/entry-cohort";
import { fetchAllRows } from "@/lib/supabase/paginate";

export interface MaeMfePercentiles { stopMaePctile: number; targetMfePctile: number; n: number }
export interface MaeMfeReadiness { n: number; required: 60; ready: boolean; available: boolean }

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}

async function entryCandidateObservationIds(supabase: any, market: "us" | "india"): Promise<number[]> {
  const rows = await fetchAllRows<any>((from, to) => supabase.from("decision_observations")
    .select("id,symbol,ts,entry_eligible,direction,decision_context,discovery_source")
    .eq("market", market)
    .eq("entry_eligible", true)
    .eq("direction", "long")
    .order("id", { ascending: true })
    .range(from, to), "MAE/MFE entry observations");
  // Research can run more than once for the same symbol/session. Geometry is
  // an entry-policy sample, not a count of retries, so preserve the earliest
  // eligible decision for each symbol/session.
  const seenSymbolSessions = new Set<string>();
  return rows.filter((row) => isEntryCandidateLong({
    entryEligible: row.entry_eligible,
    direction: row.direction,
    decisionContext: row.decision_context,
    discoverySource: row.discovery_source,
  })).filter((row) => {
    const session = String(row.ts ?? "").slice(0, 10);
    const key = `${String(row.symbol ?? "")}|${session}`;
    if (!session || !row.symbol || seenSymbolSessions.has(key)) return false;
    seenSymbolSessions.add(key);
    return true;
  }).map((row) => Number(row.id)).filter(Number.isFinite);
}

export async function getGlobalMaeMfePercentiles(
  supabase: any, market: "us" | "india", horizonDays: number = 10,
  stopPctile = 0.25, targetPctile = 0.75
): Promise<MaeMfePercentiles | null> {
  try {
    if (![2, 5, 10, 20].includes(horizonDays)) return null;
    // Exit-policy samples must represent trades the long-entry policy could
    // actually have taken. Mixing rejected/neutral/short observations changes
    // the path distribution and can manufacture inappropriate stop/target levels.
    const ids = await entryCandidateObservationIds(supabase, market);
    if (ids.length === 0) return null;
    const labels = await fetchAllRows<any>((from, to) => supabase
      .from("observation_labels")
      .select("observation_id,max_adverse_excursion, max_favorable_excursion")
      .eq("horizon_days", horizonDays)
      .in("observation_id", ids)
      .order("id", { ascending: true })
      .range(from, to), "MAE/MFE labels");
    const finite = (value: unknown): number | null => value == null ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
    const seenObservationIds = new Set<string>();
    const valid = labels.map((l: any) => ({
      observationId: String(l.observation_id ?? ""),
      mae: finite(l.max_adverse_excursion),
      mfe: finite(l.max_favorable_excursion),
    })).filter((l: any): l is { observationId: string; mae: number; mfe: number } => {
      if (!l.observationId || l.mae == null || l.mfe == null || seenObservationIds.has(l.observationId)) return false;
      seenObservationIds.add(l.observationId);
      return true;
    });
    if (valid.length < 60) return null;

    const maes = valid.map((l: any) => l.mae).sort((a: number, b: number) => a - b);
    const mfes = valid.map((l: any) => l.mfe).sort((a: number, b: number) => a - b);
    if (maes.length < 60 || mfes.length < 60) return null;

    return {
      stopMaePctile: percentile(maes, stopPctile),   // negative number, e.g. -0.06
      targetMfePctile: percentile(mfes, targetPctile), // positive number, e.g. 0.15
      n: valid.length,
    };
  } catch {
    return null;
  }
}

export async function getMaeMfeReadiness(
  supabase: any,
  market: "us" | "india",
  horizonDays: number,
): Promise<MaeMfeReadiness> {
  return (await getMaeMfeReadinessByHorizons(supabase, market, [horizonDays]))[horizonDays]
    ?? { n: 0, required: 60, ready: false, available: false };
}

export async function getMaeMfeReadinessByHorizons(
  supabase: any,
  market: "us" | "india",
  horizonDays: number[],
): Promise<Record<number, MaeMfeReadiness>> {
  const requested = [...new Set(horizonDays.filter(day => [2, 5, 10, 20].includes(day)))];
  const result = Object.fromEntries(horizonDays.map(day => [day, { n: 0, required: 60, ready: false, available: false }])) as Record<number, MaeMfeReadiness>;
  if (!requested.length) return result;
  try {
    const ids = await entryCandidateObservationIds(supabase, market);
    if (!ids.length) {
      for (const day of requested) result[day] = { n: 0, required: 60, ready: false, available: true };
      return result;
    }
    const labels = await fetchAllRows<any>((from, to) => supabase.from("observation_labels")
      .select("horizon_days,max_adverse_excursion,max_favorable_excursion")
      .in("horizon_days", requested).in("observation_id", ids)
      .order("id", { ascending: true }).range(from, to), "MAE/MFE readiness labels");
    for (const day of requested) {
      const n = labels.filter((label: any) => Number(label.horizon_days) === day
        && label.max_adverse_excursion != null && label.max_favorable_excursion != null
        && Number.isFinite(Number(label.max_adverse_excursion))
        && Number.isFinite(Number(label.max_favorable_excursion))).length;
      result[day] = { n, required: 60, ready: n >= 60, available: true };
    }
    return result;
  } catch {
    return result;
  }
}
