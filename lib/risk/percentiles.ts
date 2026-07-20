// Phase 2 learning-core: MAE/MFE percentiles from the decision ledger — the
// raw material for dynamic (pattern-conditioned) stops/targets, replacing the
// fixed 7%/20% profile constants. Global per market+horizon (not per-symbol —
// a per-symbol cut needs far more data than exists yet; global is the
// documented fallback and, for now, the only tier built).

export interface MaeMfePercentiles { stopMaePctile: number; targetMfePctile: number; n: number }

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
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
    const { data: obsIds } = await supabase.from("decision_observations").select("id")
      .eq("market", market).eq("entry_eligible", true).eq("direction", "long").limit(5000);
    const ids = (obsIds ?? []).map((r: any) => r.id);
    if (ids.length === 0) return null;
    const { data: labels } = await supabase
      .from("observation_labels")
      .select("max_adverse_excursion, max_favorable_excursion")
      .eq("horizon_days", horizonDays)
      .in("observation_id", ids)
      .limit(5000);
    if (!labels || labels.length < 60) return null;

    const maes = labels.map((l: any) => Number(l.max_adverse_excursion)).filter(Number.isFinite).sort((a: number, b: number) => a - b);
    const mfes = labels.map((l: any) => Number(l.max_favorable_excursion)).filter(Number.isFinite).sort((a: number, b: number) => a - b);
    if (maes.length < 60 || mfes.length < 60) return null;

    return {
      stopMaePctile: percentile(maes, stopPctile),   // negative number, e.g. -0.06
      targetMfePctile: percentile(mfes, targetPctile), // positive number, e.g. 0.15
      n: labels.length,
    };
  } catch {
    return null;
  }
}
