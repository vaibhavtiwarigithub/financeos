/**
 * How the paper-entry loop must treat a portfolio-constructor sizing result.
 *
 * These three outcomes are NOT interchangeable, and conflating the first two is
 * what silently disabled US capital rotation from 2026-08-11 to 2026-08-25:
 *
 *   "bug"      non-finite size — a NaN coefficient/percentile/config leaked in.
 *              Fail closed. Never hand a NaN to rotation or to the fill RPC.
 *
 *   "no_room"  finite size of zero — the book genuinely cannot take this
 *              candidate at any size (gross cap, sector cap, or a residual under
 *              the minimum viable 0.5%). This is capital rotation's TRIGGER, not
 *              a reason to drop the candidate. It must fall through to the
 *              rotation evaluation, which sells a weaker holding to fund it.
 *
 *   "sized"    a positive allocation; proceed normally.
 *
 * The old code tested `!Number.isFinite(pct) || pct <= 0` and `continue`d on
 * both, so "no room" — the one state rotation exists to resolve — was thrown
 * away before rotation was ever consulted.
 */
export type ConstructorOutcome = "bug" | "no_room" | "sized";

export function classifyConstructorSize(sizePct: unknown): ConstructorOutcome {
  // Reject non-numbers BEFORE coercion. `Number(null)`, `Number("")` and
  // `Number([])` are all 0 — a missing or malformed size would otherwise be
  // classified as a legitimate "no room" and fall through to rotation as though
  // the constructor had deliberately sized it to zero. Absence is a defect, not
  // a portfolio state.
  if (typeof sizePct !== "number") return "bug";
  if (!Number.isFinite(sizePct)) return "bug";
  // Negative is not a meaningful allocation either; treat it as no room rather
  // than letting a sign error through as a position.
  if (sizePct <= 0) return "no_room";
  return "sized";
}
