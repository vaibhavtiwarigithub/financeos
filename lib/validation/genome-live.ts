// Phase 3 learning-core, Build 1 finish: make the champion's genome a LIVE
// control surface. Until now the genome was written + hashed onto signals but
// no live code read it — the decision path took score_threshold from
// strategy_config and exit/sizing from hardcoded percentiles. This helper is
// the single place the live path loads the promoted champion's genome.
//
// Behavior-preserving by construction: a market with no promoted champion, or a
// champion row with a null/legacy genome, resolves to DEFAULT_GENOME — whose
// fields (score_threshold 60, stop_mae_pctile 25, target_mfe_pctile 75,
// horizon 10, cap 10, floor 2) exactly match the values the live path used
// before this wiring existed. Nothing changes live until a genome-bearing
// challenger is validated (Build 2 fail-closed gate) AND owner-promoted.

import { DEFAULT_GENOME, validateGenomeBounds, genomeHash, type StrategyGenome } from "@/lib/validation/genome";

export interface ResolvedGenome {
  genome: StrategyGenome;
  source: "champion" | "default";
  hash: string;
}

// Merge a partial/stored genome onto DEFAULT_GENOME so a champion that only
// carries the fields the learner mutates (older rows, or a challenger that
// changed one leaf) still yields a fully-populated, in-bounds genome. Any field
// group missing on the stored genome falls back to the default group.
function hydrate(stored: Partial<StrategyGenome> | null | undefined): StrategyGenome {
  const d = DEFAULT_GENOME;
  const s = stored ?? {};
  return {
    features: { ...d.features, ...(s.features ?? {}) },
    entry:    { ...d.entry,    ...(s.entry ?? {}) },
    universe: { ...d.universe, ...(s.universe ?? {}) },
    horizon_days: s.horizon_days ?? d.horizon_days,
    exit:     { ...d.exit,     ...(s.exit ?? {}) },
    sizing:   { ...d.sizing,   ...(s.sizing ?? {}) },
    regime:   { ...d.regime,   ...(s.regime ?? {}) },
  };
}

// Loads the promoted champion's genome for a market. Best-effort: any query
// failure, missing champion, or out-of-bounds stored genome degrades to
// DEFAULT_GENOME (source: "default") so the caller always gets a safe,
// in-bounds genome and the live path never throws on genome load.
export async function loadChampionGenome(
  supabase: any,
  market: "us" | "india",
): Promise<ResolvedGenome> {
  const fallback = (): ResolvedGenome => ({ genome: DEFAULT_GENOME, source: "default", hash: genomeHash(DEFAULT_GENOME) });
  try {
    // Mirror the per-market champion resolution used in research-agent.ts:
    // market-scoped first, fall back to the global champion pre-057 (no market
    // column → the .eq("market",...) query errors).
    let row: any = null;
    const scoped = await supabase.from("strategy_versions").select("genome")
      .eq("is_champion", true).eq("market", market)
      .order("promoted_at", { ascending: false }).limit(1).maybeSingle();
    if (scoped.error) {
      const legacy = await supabase.from("strategy_versions").select("genome")
        .eq("is_champion", true).order("promoted_at", { ascending: false }).limit(1).maybeSingle();
      row = legacy.data;
    } else {
      row = scoped.data;
    }

    const stored = (row?.genome ?? null) as Partial<StrategyGenome> | null;
    if (!stored) return fallback();

    const genome = hydrate(stored);
    // Defense in depth: the promotion path already bounds-checks, but a genome
    // that somehow stored an out-of-bounds value must not size a live-sized
    // paper fill. Reject to default rather than trust it.
    const bounds = validateGenomeBounds(genome);
    if (!bounds.ok) return fallback();

    return { genome, source: "champion", hash: genomeHash(genome) };
  } catch {
    return fallback();
  }
}
