/**
 * Judgment Coach rubric: the score's own breakdown.
 *
 * The evaluation prompt has always scored 0-100 against five weighted criteria,
 * but only the TOTAL was ever returned. A reader saw "68/100" with no way to
 * know which criterion cost the 32 points, so the number was unactionable: you
 * cannot fix a thesis you cannot see the marking of.
 *
 * These lines are ordered by POINTS LOST, so the first bullet is always the one
 * worth the most to fix next.
 */

export interface RubricCategory {
  key: string;
  label: string;
  pointsAvailable: number;
  /** What the criterion is actually asking, shown with the finding. */
  asks: string;
}

/** Weights match the prompt's rubric exactly; they sum to 100. */
export const RUBRIC_CATEGORIES: RubricCategory[] = [
  { key: "plausibility", label: "Plausibility & consistency", pointsAvailable: 30, asks: "Are the claims coherent and consistent with what is known about the company or sector?" },
  { key: "clarity_specificity", label: "Clarity & specificity", pointsAvailable: 20, asks: "Is this a specific, falsifiable claim with concrete triggers?" },
  { key: "risk_awareness", label: "Risk awareness", pointsAvailable: 20, asks: "Is the bear case acknowledged?" },
  { key: "contrarian_thinking", label: "Contrarian thinking", pointsAvailable: 15, asks: "Independent analysis, or crowded consensus?" },
  { key: "exit_strategy", label: "Exit strategy", pointsAvailable: 15, asks: "Do you know when you are wrong, and what the exit is?" },
];

export const RUBRIC_TOTAL_POINTS = RUBRIC_CATEGORIES.reduce((sum, c) => sum + c.pointsAvailable, 0);

export interface NormalisedRubricLine extends RubricCategory {
  pointsAwarded: number;
  pointsLost: number;
  finding: string;
}

export interface NormalisedRubric {
  /** Ordered by points lost, descending — biggest fix first. */
  lines: NormalisedRubricLine[];
  /** Sum of awarded points. This is the score that is actually defensible. */
  total: number;
  /** What the model claimed the total was, when it also reported one. */
  reportedScore: number | null;
  /**
   * The model's stated total minus the sum of its own parts.
   *
   * A model asked for both a total and a breakdown can return a breakdown that
   * does not add up to its total. Reporting the total while showing parts that
   * contradict it would put an unauditable number next to its own refutation,
   * so the SUM wins and the gap is surfaced rather than hidden.
   */
  discrepancy: number | null;
}

function clamp(value: unknown, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(max, Math.round(n)));
}

export function normaliseRubric(raw: unknown, reportedScore: unknown): NormalisedRubric {
  const rows = Array.isArray(raw) ? raw : [];
  const byKey = new Map<string, any>();
  for (const row of rows) {
    const key = String((row as any)?.category ?? "").trim().toLowerCase();
    if (key) byKey.set(key, row);
  }

  const lines: NormalisedRubricLine[] = RUBRIC_CATEGORIES.map((category) => {
    const row = byKey.get(category.key);
    // A missing category scores ZERO, not the full mark. Treating an absent
    // judgement as full credit would let a truncated or lazy response inflate
    // the total, which is the direction that flatters the user.
    const pointsAwarded = clamp(row?.points_awarded, category.pointsAvailable);
    const finding = String(row?.finding ?? "").trim()
      || (row ? "No finding returned for this criterion." : "This criterion was not assessed, so it scores zero.");
    return {
      ...category,
      pointsAwarded,
      pointsLost: category.pointsAvailable - pointsAwarded,
      finding,
    };
  });

  // Priority = the criterion costing the most points. Ties break by the larger
  // weight, so a 30-point criterion outranks a 15-point one at equal loss.
  lines.sort((a, b) => b.pointsLost - a.pointsLost || b.pointsAvailable - a.pointsAvailable);

  const total = lines.reduce((sum, line) => sum + line.pointsAwarded, 0);
  // Number(null) is 0 and Number("") is 0, both finite — so a coerce-first check
  // turns "the model reported no score" into "the model reported zero", which
  // would then be flagged as a discrepancy against a perfectly good breakdown.
  const reported =
    typeof reportedScore === "number" && Number.isFinite(reportedScore)
      ? Math.round(reportedScore)
      : null;

  return {
    lines,
    total,
    reportedScore: reported,
    discrepancy: reported == null ? null : reported - total,
  };
}
