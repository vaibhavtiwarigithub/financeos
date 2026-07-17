// Deterministic asset-class allocator (migration 175). NO LLM on this path.
// Maps macro regime → sleeve target weights WITHIN each sleeve's hard band, zeros
// disabled sleeves (leveraged ships off), and renormalizes to 100%. Pure +
// testable. SHIPPED OFF: computeAllocation returns null unless
// strategy_config.allocation_enabled is true, so nothing acts on it today.
//
// MACRO IS US-ONLY (2026-07-17). `macro_regime` has no `market` column and
// MacroSentinel is US-only by construction, so this file previously applied the
// US FRED verdict to India's sleeves. It now resolves the regime through
// ./regime, which scopes by market and enforces the same usability contract as
// lib/data/scores.ts (age bound + indicator floor, fail-safe to UNAVAILABLE
// never to calm). Macro UNAVAILABLE → NO allocation (null), never an untilted
// config echo — see computeAllocationDetailed for the full justification.
//
// Follow-up (money path, separate + validated): wire the equity sleeve target
// into paper-trade sizing, a slow rebalancer for the ETF/cash sleeves (weekly,
// 5% deadband), and evolve the regime→target mapping via the genome + validation
// gate. This file is the deterministic core only.

import { loadAllocationRegime, type AllocationRegime } from "./regime";

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

function finiteOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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

  let raw = active.map((s) => {
    const min = finiteOr(s.min_pct, 0);
    const max = Math.max(min, finiteOr(s.max_pct, 100));
    let t = finiteOr(s.target_pct, 0);
    if (s.sleeve === "equity") t += tilt;
    else if (s.sleeve === "defensive_etf") t -= tilt * 0.6;
    else if (s.sleeve === "cash") t -= tilt * 0.4;
    // leveraged + anything else: hold its target (bands still clamp it)
    return { s, t: clamp(finiteOr(t, 0), min, max), min, max };
  });

  let sum = raw.reduce((a, r) => a + r.t, 0);
  if (!Number.isFinite(sum) || sum <= 0) {
    const cash = raw.find((r) => r.s.sleeve === "cash" && r.max > 0);
    raw = raw.map((r) => ({
      ...r,
      t: r === cash ? clamp(100, r.min, r.max) : 0,
    }));
    sum = raw.reduce((a, r) => a + r.t, 0);
  }
  if (!Number.isFinite(sum) || sum <= 0) return [];
  return raw.map((r) => ({
    sleeve: r.s.sleeve,
    targetPct: Math.round((r.t / sum) * 1000) / 10,
    instruments: Array.isArray(r.s.instruments) ? r.s.instruments : [],
  }));
}

export interface AllocationResult {
  targets: SleeveTarget[] | null;
  /** Why there is (or isn't) an allocation. Always populated — never a silent default. */
  reason: string;
  macro: AllocationRegime | null;
}

/**
 * Load sleeves + current regime and compute targets, reporting WHY.
 *
 * REQUIRED-INPUT DECISION (macro unavailable → NO allocation, not a hole):
 * this function's entire contract is "macro regime → sleeve target weights".
 * The regime is not a garnish on the targets; it is the only input that turns
 * owner-configured `strategy_sleeves` rows into an allocation. With no
 * trustworthy regime there is nothing to compute — returning the base
 * `target_pct` values with tilt=0 would emit a config ECHO that is byte-for-byte
 * indistinguishable from a real "macro says neutral" verdict. That is exactly
 * the neutral-50-and-included fake that lib/data/scores.ts rejects for
 * macro_score, wearing a different hat. So: UNAVAILABLE → targets null.
 *
 * For India this is permanent until a real India regime is built. Deciding that
 * India should instead run STATIC (untilted) sleeve targets is a product call
 * nobody has approved; returning null defers it to the owner rather than
 * silently making it.
 *
 * HONEST TENSION (stated, not hidden): the one consumer today
 * (app/api/agents/paper-trade) only ever uses the equity target to SHRINK that
 * market's gross-equity cap. So "no allocation" leaves the owner's configured
 * `max_gross_exposure_pct` in force — LOOSER than any regime outcome would be,
 * including risk_off. This is accepted: falling back to the owner's own
 * approved limit is the documented default state (identical to
 * allocation_enabled=false, the live setting today), not a fabricated one. The
 * fail-safe rule this honors is "never assert calm we cannot evidence" — not
 * "always tighten". Tightening on absent evidence would be an unapproved
 * position change justified by nothing.
 */
export async function computeAllocationDetailed(
  svc: any,
  market: "us" | "india",
  now: Date = new Date(),
): Promise<AllocationResult> {
  try {
    const { data: cfg } = await svc.from("strategy_config").select("allocation_enabled").limit(1).maybeSingle();
    if (!(cfg as any)?.allocation_enabled) {
      return { targets: null, reason: "allocation disabled (strategy_config.allocation_enabled=false)", macro: null };
    }

    // Resolve the regime BEFORE loading sleeves: for India this returns
    // unavailable without ever touching macro_regime, so the US verdict cannot
    // reach an India allocation by any path.
    const macro = await loadAllocationRegime(svc, market, now);
    if (!macro.available) {
      return { targets: null, reason: `no allocation for ${market}: ${macro.reason}`, macro };
    }

    const { data: sleeves } = await svc.from("strategy_sleeves").select("*").eq("market", market);
    if (!sleeves || sleeves.length === 0) {
      return { targets: null, reason: `no strategy_sleeves rows for market=${market}`, macro };
    }

    return {
      targets: allocate(sleeves as SleeveRow[], normalizeRegime(macro.rawRegime)),
      reason: `allocated from ${macro.rawRegime} regime (week_of ${macro.asOf}, ${macro.indicators} indicators)`,
      macro,
    };
  } catch {
    // fail-soft — allocation is advisory; never break a caller
    return { targets: null, reason: "allocation failed (query error)", macro: null };
  }
}

/**
 * Load sleeves + current regime and compute targets. OFF-aware: returns null
 * when allocation_enabled is false (the default) so no caller acts on it, and
 * whenever macro is UNAVAILABLE (see computeAllocationDetailed). Thin wrapper —
 * use computeAllocationDetailed when you need the reason.
 */
export async function computeAllocation(svc: any, market: "us" | "india"): Promise<SleeveTarget[] | null> {
  return (await computeAllocationDetailed(svc, market)).targets;
}
