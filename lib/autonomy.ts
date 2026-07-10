// lib/autonomy.ts — the autonomy ladder (strategic review S1 / Build 1).
//
// A single declared maturity level gates how much the system may do with money.
// It is ADDITIVE to the existing controls (trading_enabled, per-market flags,
// kill switches): all of them must pass. This is the one place future autonomy
// work must consult.
//
// HARD SAFETY INVARIANT (disabled-by-default ladder, no active autonomous live
// mode): the app has NO code path that places a live order without a logged-in
// owner click — every broker gateway calls requireOwner(). Levels L4/L5 DESCRIBE
// a future autonomous envelope but DO NOT grant autonomous placement today.
// `AUTONOMOUS_LIVE_ENABLED` is the kill constant that keeps it that way; it must
// stay false until every item in the strategic review's "good enough to allow
// autonomous live trading" checklist is met and the owner explicitly opts in.

export const AUTONOMY_LEVELS = [
  "L0_research",      // research/score/explain only
  "L1_paper_auto",    // may place PAPER trades automatically
  "L2_shadow",        // live recommendations + shadow (hypothetical) fills
  "L3_live_manual",   // owner drafts/approves each live order (current default)
  "L4_live_small_auto", // future: auto-place within a tiny capped budget (NOT active)
  "L5_scaled_auto",   // future: larger allocation within hard caps (NOT active)
] as const;

export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = "L3_live_manual";

// Deployment-level flag for autonomous live trading. Set AUTONOMOUS_LIVE_ENABLED=true
// in Vercel env to unlock PA3. Both this AND the DB toggle (live_auto_enabled) must
// be true — neither alone is sufficient. LLMs and agents cannot change this env var.
export const AUTONOMOUS_LIVE_ENABLED = process.env.AUTONOMOUS_LIVE_ENABLED === "true";

function rank(level: string): number {
  const i = (AUTONOMY_LEVELS as readonly string[]).indexOf(level);
  return i < 0 ? -1 : i;
}

/** Is the given level valid? */
export function isAutonomyLevel(level: unknown): level is AutonomyLevel {
  return typeof level === "string" && (AUTONOMY_LEVELS as readonly string[]).includes(level);
}

/**
 * May a live order be placed at all under this autonomy level? True only at
 * L3 and above (manual live approved). L0/L1/L2 block ALL live orders — a
 * stricter master switch than trading_enabled. Unknown/invalid levels fail
 * closed to the default (L3) rather than opening things up.
 */
export function liveOrdersAllowed(level: string | null | undefined): boolean {
  const effective = isAutonomyLevel(level) ? level : DEFAULT_AUTONOMY_LEVEL;
  return rank(effective) >= rank("L3_live_manual");
}

/**
 * May the system AUTONOMOUSLY place a live order (no owner click) under this
 * level? Always false today regardless of level — governed by the hard cap.
 * Present so future autonomous callers have one honest gate to check.
 */
export function autonomousLivePlacementAllowed(level: string | null | undefined): boolean {
  if (!AUTONOMOUS_LIVE_ENABLED) return false;
  const effective = isAutonomyLevel(level) ? level : DEFAULT_AUTONOMY_LEVEL;
  return rank(effective) >= rank("L4_live_small_auto");
}
