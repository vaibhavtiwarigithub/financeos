import { describe, expect, it } from "vitest";
import {
  normaliseRubric, RUBRIC_CATEGORIES, RUBRIC_TOTAL_POINTS,
} from "@/lib/mentor/rubric";

// Judgment Coach returned only a TOTAL score. A reader saw "68/100" with no way
// to know which criterion cost the 32 points, so the number was unactionable.
// These lines are the marking, ordered by what is worth the most to fix.

const full = () => RUBRIC_CATEGORIES.map((c) => ({
  category: c.key, points_available: c.pointsAvailable,
  points_awarded: c.pointsAvailable, finding: `full marks for ${c.key}`,
}));

describe("rubric weights", () => {
  it("sums to exactly 100, matching the prompt", () => {
    expect(RUBRIC_TOTAL_POINTS).toBe(100);
  });
});

describe("priority ordering", () => {
  it("puts the biggest points loss first", () => {
    const raw = full();
    raw.find((r) => r.category === "exit_strategy")!.points_awarded = 0;      // -15
    raw.find((r) => r.category === "risk_awareness")!.points_awarded = 12;    // -8
    raw.find((r) => r.category === "plausibility")!.points_awarded = 28;      // -2
    const result = normaliseRubric(raw, 83);
    expect(result.lines.map((l) => l.key).slice(0, 3))
      .toEqual(["exit_strategy", "risk_awareness", "plausibility"]);
    expect(result.lines[0].pointsLost).toBe(15);
  });

  it("breaks ties toward the heavier criterion", () => {
    // Equal loss: a 30-point criterion matters more than a 15-point one, because
    // the remaining upside is larger.
    const raw = full();
    raw.find((r) => r.category === "plausibility")!.points_awarded = 25;      // -5 of 30
    raw.find((r) => r.category === "contrarian_thinking")!.points_awarded = 10; // -5 of 15
    const result = normaliseRubric(raw, 90);
    const idx = (k: string) => result.lines.findIndex((l) => l.key === k);
    expect(idx("plausibility")).toBeLessThan(idx("contrarian_thinking"));
  });
});

describe("the breakdown is the score", () => {
  it("prefers the SUM when the model's stated total contradicts its own parts", () => {
    // A model asked for a total and a breakdown can return parts that do not add
    // up. Showing the total beside a contradicting breakdown puts an unauditable
    // number next to its own refutation.
    const raw = full();
    raw.find((r) => r.category === "exit_strategy")!.points_awarded = 0;
    const result = normaliseRubric(raw, 99);   // model claims 99; parts say 85
    expect(result.total).toBe(85);
    expect(result.reportedScore).toBe(99);
    expect(result.discrepancy).toBe(14);
  });

  it("reports no discrepancy when they agree", () => {
    expect(normaliseRubric(full(), 100).discrepancy).toBe(0);
  });
});

describe("missing or malformed input fails toward a LOWER score", () => {
  it("scores an unassessed criterion ZERO, not full marks", () => {
    // Full credit for an absent judgement would let a truncated response inflate
    // the total — the direction that flatters the user.
    const partial = full().filter((r) => r.category !== "plausibility");
    const result = normaliseRubric(partial, 70);
    const line = result.lines.find((l) => l.key === "plausibility")!;
    expect(line.pointsAwarded).toBe(0);
    expect(result.total).toBe(RUBRIC_TOTAL_POINTS - 30);
    expect(line.finding).toContain("not assessed");
  });

  it("returns every category even when the model returns nothing", () => {
    const result = normaliseRubric(null, null);
    expect(result.lines).toHaveLength(RUBRIC_CATEGORIES.length);
    expect(result.total).toBe(0);
    expect(result.reportedScore).toBeNull();
    expect(result.discrepancy).toBeNull();
  });

  it("clamps an over-award to the criterion's ceiling", () => {
    const raw = full();
    raw.find((r) => r.category === "exit_strategy")!.points_awarded = 999;
    const result = normaliseRubric(raw, 100);
    expect(result.lines.find((l) => l.key === "exit_strategy")!.pointsAwarded).toBe(15);
    expect(result.total).toBe(100);
  });

  it("ignores an unknown category rather than inventing a line for it", () => {
    const raw = [...full(), { category: "vibes", points_available: 50, points_awarded: 50, finding: "n/a" }];
    const result = normaliseRubric(raw, 100);
    expect(result.lines).toHaveLength(RUBRIC_CATEGORIES.length);
    expect(result.total).toBe(100);
  });
});
