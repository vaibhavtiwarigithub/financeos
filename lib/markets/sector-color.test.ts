import { describe, it, expect } from "vitest";
import { cellColor } from "./sector-color";

// Parse "rgb(r,g,b)" into channels.
function rgb(s: string): { r: number; g: number; b: number } {
  const m = s.match(/^rgb\((\d+),(\d+),(\d+)\)$/);
  if (!m) throw new Error(`not an rgb() string: ${s}`);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

const isGreenish = (c: { r: number; g: number; b: number }) => c.g > c.r && c.g >= c.b;
const isReddish = (c: { r: number; g: number; b: number }) => c.r > c.g && c.r > c.b;

describe("cellColor — ramp endpoints", () => {
  it("maps flat (0%) to the dark green #052E16, not indigo", () => {
    // The bug produced rgb(52,46,153) — indigo — for a flat sector.
    expect(cellColor(0)).toBe("rgb(5,46,22)");
    expect(rgb(cellColor(0))).not.toEqual({ r: 52, g: 46, b: 153 });
  });

  it("maps a full positive move (+3%) to the legend's green #34D399", () => {
    expect(cellColor(3)).toBe("rgb(52,211,153)");
  });

  it("maps a full negative move (-3%) to the legend's red #F87171", () => {
    expect(cellColor(-3)).toBe("rgb(248,113,113)");
  });

  it("saturates beyond the +/-3% cap", () => {
    expect(cellColor(10)).toBe(cellColor(3));
    expect(cellColor(-10)).toBe(cellColor(-3));
  });
});

describe("cellColor — a negative sector must never look positive", () => {
  it("renders a mildly negative sector as reddish, not teal/green", () => {
    // The bug produced rgb(65,109,109) — teal — for -0.1%.
    const c = rgb(cellColor(-0.1));
    expect(c).not.toEqual({ r: 65, g: 109, b: 109 });
    expect(isReddish(c)).toBe(true);
    expect(isGreenish(c)).toBe(false);
  });

  it("renders every negative move reddish and every positive move greenish", () => {
    for (const pct of [-0.01, -0.1, -0.5, -1, -2, -3, -5]) {
      const c = rgb(cellColor(pct));
      expect(isReddish(c), `cellColor(${pct}) should be reddish, got ${cellColor(pct)}`).toBe(true);
    }
    for (const pct of [0.5, 1, 2, 3, 5]) {
      const c = rgb(cellColor(pct));
      expect(isGreenish(c), `cellColor(${pct}) should be greenish, got ${cellColor(pct)}`).toBe(true);
    }
  });

  it("never lets a negative cell outrank a positive cell on the green channel", () => {
    // Directly pins the visual lie: -0.1% previously had g=109 while +0.1% had
    // g=52, so the DOWN sector looked greener than the UP sector.
    expect(rgb(cellColor(-0.1)).g).toBeLessThan(rgb(cellColor(0.1)).g);
  });
});

describe("cellColor — monotonic intensity", () => {
  it("darkens toward zero and brightens toward the cap on the positive side", () => {
    const g = [0, 0.5, 1, 2, 3].map((p) => rgb(cellColor(p)).g);
    for (let i = 1; i < g.length; i++) expect(g[i]).toBeGreaterThan(g[i - 1]);
  });

  it("darkens toward zero and brightens toward the cap on the negative side", () => {
    const r = [0, -0.5, -1, -2, -3].map((p) => rgb(cellColor(p)).r);
    for (let i = 1; i < r.length; i++) expect(r[i]).toBeGreaterThan(r[i - 1]);
  });
});
