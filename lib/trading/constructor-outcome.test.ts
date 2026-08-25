import { describe, it, expect } from "vitest";
import { classifyConstructorSize } from "./constructor-outcome";

describe("classifyConstructorSize", () => {
  it("treats a positive allocation as sized", () => {
    expect(classifyConstructorSize(10)).toBe("sized");
    expect(classifyConstructorSize(0.5)).toBe("sized");
  });

  // The regression. A finite zero means "the book has no room", which is
  // capital rotation's trigger. Collapsing it into the NaN branch is what made
  // rotation unreachable on the gross-cap path for two weeks.
  it("treats a finite zero as no_room, NOT as a bug", () => {
    expect(classifyConstructorSize(0)).toBe("no_room");
    expect(classifyConstructorSize(-0)).toBe("no_room");
    expect(classifyConstructorSize(-3)).toBe("no_room");
  });

  // Equally load-bearing in the other direction: a NaN is a real defect and
  // must fail closed, never reach rotation or the fill RPC as a "no room".
  it("treats a non-finite size as a bug", () => {
    expect(classifyConstructorSize(Number.NaN)).toBe("bug");
    expect(classifyConstructorSize(Infinity)).toBe("bug");
    expect(classifyConstructorSize(-Infinity)).toBe("bug");
    expect(classifyConstructorSize(undefined)).toBe("bug");
    expect(classifyConstructorSize(null)).toBe("bug");
    expect(classifyConstructorSize("abc")).toBe("bug");
  });

  it("never returns the same class for NaN and for zero", () => {
    expect(classifyConstructorSize(Number.NaN)).not.toBe(classifyConstructorSize(0));
  });
});
