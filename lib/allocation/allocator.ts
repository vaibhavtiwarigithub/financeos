// Deterministic asset-class allocator (migration 175). NO LLM on this path.
// Maps macro regime → sleeve target weights WITHIN each sleeve's hard band, zeros
// disabled sleeves (leveraged ships off), and renormalizes to 100%. Pure +
// testable. SHIPPED OFF: computeAllocation returns null unless
// strategy_config.allocation_enabled is true, so nothing acts on it today.
//
// Follow-up (money path, separate + validated): wire the equity sleeve target
// into paper-trade sizing, a slow rebalancer for the ETF/cash sleeves (weekly,
// 5% deadband), and evolve the regime→target mapping via the genome + validation
// gate. This file is the deterministic core only.

export type Regime = "risk_on" | "neutral" | "risk_off";

export interface SleeveRow {
  market: string;
  sleeve: string;           // equity | defensive_etf | cash | leveraged
  target_pct: number;
  min_pct: number;
  max_pct: number;
  instruments: string[];
  enabled: boolean;
}

export interface SleeveTarget {
  sleeve: string;
  targetPct: number;        // renormalized to sum 100 across enabled sleeves
  instruments: string[];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Normalize a raw macro-regime label to the allocator's 3-state enum. */
export function normalizeRegime(raw: unknown): Regime {
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("risk_off") || s.includes("risk-off") || s.includes("bear") || s.includes("defensive")) return "risk_off";
  if (s.includes("risk_on") || s.includes("risk-on") || s.includes("bull") || s.includes("aggressive")) return "risk_on";
  return "neutral";
}

/**
 * Deterministic allocation. Start from each enabled sleeve's target, tilt by
 * regime (risk_off shifts weight OUT of equity into defensive/cash; risk_on the
 * reverse), clamp each to its hard band, then renormalize to 100%. Disabled
 * sleeves (e.g. leveraged) contribute 0.
 */
export function allocate(sleeves: SleeveRow[], regime: Regime): SleeveTarget[] {
  const active = sleeves.filter((s) => s.enabled);
  if (active.length === 0) return [];

  const tilt = regime === "risk_off" ? -15 : regime === "risk_on" ? 10 : 0;

  const raw = active.map((s) => {
    let t = s.target_pct;
    if (s.sleeve === "equity") t = s.target_pct + tilt;
    else if (s.sleeve === "defensive_etf") t = s.target_pct - tilt * 0.6;
    else if (s.sleeve === "cash") t = s.target_pct - tilt * 0.4;
    // leveraged + anything else: hold its target (bands still clamp it)
    return { s, t: clamp(t, s.min_pct, s.max_pct) };
  });

  const sum = raw.reduce((a, r) => a + r.t, 0) || 1;
  return raw.map((r) => ({
    sleeve: r.s.sleeve,
    targetPct: Math.round((r.t / sum) * 1000) / 10,
    instruments: Array.isArray(r.s.instruments) ? r.s.instruments : [],
  }));
}

/**
 * Load sleeves + current regime and compute targets. OFF-aware: returns null
 * when allocation_enabled is false (the default) so no caller acts on it.
 */
export async function computeAllocation(svc: any, market: "us" | "india"): Promise<SleeveTarget[] | null> {
  try {
    const { data: cfg } = await svc.from("strategy_config").select("allocation_enabled").limit(1).maybeSingle();
    if (!(cfg as any)?.allocation_enabled) return null;

    const { data: sleeves } = await svc.from("strategy_sleeves").select("*").eq("market", market);
    if (!sleeves || sleeves.length === 0) return null;

    const { data: regimeRow } = await svc
      .from("macro_regime")
      .select("regime")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return allocate(sleeves as SleeveRow[], normalizeRegime((regimeRow as any)?.regime));
  } catch {
    return null; // fail-soft — allocation is advisory; never break a caller
  }
}
