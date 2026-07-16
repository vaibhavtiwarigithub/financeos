// Per-market champion signal weights — the single resolver every DISPLAY surface
// uses instead of the vestigial global `signal_weights` row.
//
// The REAL weights scoring uses are the market-scoped champion's snapshot
// (`strategy_versions` where is_champion + market) — NOT the single-row global
// `signal_weights` table, which `lib/research-agent.ts` stopped reading in commit
// abc27c51. This mirrors that resolution (champion-first → static per-risk-profile
// baseline) so US and India each surface their OWN champion weights and never a
// shared global blob. Display/email only — never on the money/scoring path.

import type { SupabaseClient } from "@supabase/supabase-js";

export type WeightsMarket = "us" | "india";

export interface DisplayWeights {
  fundamental_weight: number;
  technical_weight: number;
  sentiment_weight: number;
  macro_weight: number;
  insider_weight: number;
  /** Champion promoted_at when a champion is in force, else null (baseline). */
  updated_at: string | null;
  /** Provenance so the UI can be honest about where these came from. */
  source: "market_champion" | "risk_profile_baseline";
  /** Champion version string when source === "market_champion". */
  version: string | null;
}

// Static per-risk-profile baseline — mirrors PROFILE_WEIGHTS in lib/research-agent.ts.
// Used only when no champion has been promoted for the market.
const PROFILE_WEIGHTS: Record<string, Record<string, number>> = {
  conservative: { fundamental: 0.4, technical: 0.2, sentiment: 0.15, macro: 0.15, insider: 0.1 },
  balanced: { fundamental: 0.3, technical: 0.25, sentiment: 0.2, macro: 0.15, insider: 0.1 },
  aggressive: { fundamental: 0.2, technical: 0.3, sentiment: 0.25, macro: 0.15, insider: 0.1 },
};

/**
 * Resolve the weights to DISPLAY for a market: the market's promoted champion
 * snapshot, falling back to the static per-risk-profile baseline. Never reads the
 * global `signal_weights` row.
 *
 * Resilient to a pre-057 schema (no `market` column on strategy_versions): the
 * market-filtered query errors, so we fall back to the global champion, preserving
 * prior behavior.
 */
export async function resolveDisplayWeights(
  svc: SupabaseClient,
  market: WeightsMarket,
): Promise<DisplayWeights> {
  let champion: any = null;
  {
    const scoped = await svc
      .from("strategy_versions")
      .select("version, weights_snapshot, promoted_at")
      .eq("is_champion", true)
      .eq("market", market)
      .order("promoted_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (scoped.error) {
      const legacy = await svc
        .from("strategy_versions")
        .select("version, weights_snapshot, promoted_at")
        .eq("is_champion", true)
        .order("promoted_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      champion = legacy.data;
    } else {
      champion = scoped.data;
    }
  }

  // Risk-profile baseline (global strategy_config; risk_profile is not per-market).
  const { data: strategy } = await svc
    .from("strategy_config")
    .select("risk_profile")
    .limit(1)
    .maybeSingle();
  const profileKey = ((strategy as any)?.risk_profile ?? "balanced") as string;
  const baseline = PROFILE_WEIGHTS[profileKey] ?? PROFILE_WEIGHTS.balanced;

  // The snapshot may use short keys ({fundamental: 0.3}) from a seed row or the
  // *_weight keys ({fundamental_weight: 0.3}) LearnerAgent's challengers write —
  // read both, exactly as lib/research-agent.ts does.
  const snap = (champion as any)?.weights_snapshot ?? null;
  const cw = (short: string, full: string): number | undefined => {
    if (!snap) return undefined;
    const v = snap[short] ?? snap[full];
    return typeof v === "number" ? v : undefined;
  };
  const usingChampion = !!snap;

  return {
    fundamental_weight: cw("fundamental", "fundamental_weight") ?? baseline.fundamental,
    technical_weight: cw("technical", "technical_weight") ?? baseline.technical,
    sentiment_weight: cw("sentiment", "sentiment_weight") ?? baseline.sentiment,
    macro_weight: cw("macro", "macro_weight") ?? baseline.macro,
    insider_weight: cw("insider", "insider_weight") ?? baseline.insider,
    updated_at: usingChampion ? ((champion as any)?.promoted_at ?? null) : null,
    source: usingChampion ? "market_champion" : "risk_profile_baseline",
    version: usingChampion ? ((champion as any)?.version ?? null) : null,
  };
}
