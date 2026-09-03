import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("components/dashboard/PortfolioPage.tsx", "utf8");

describe("Paper Portfolio mobile trades scroll contract", () => {
  it("keeps the wrapper as the sole horizontal scroller", () => {
    expect(source).toContain('data-testid="paper-trades-scroll"');
    expect(source).toContain('overscrollBehaviorX: "contain"');
    expect(source).toContain('display: "table"');
    expect(source).toContain('maxWidth: "none"');
    expect(source).toContain('overflow: "visible"');
  });

  it("pins the symbol column while the remaining columns move", () => {
    expect(source).toContain('position: "sticky", left: 0, zIndex: 2');
    expect(source).toContain('position: "sticky", left: 0, zIndex: 1');
  });
});
