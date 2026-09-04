import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const kite = readFileSync("lib/kite.ts", "utf8");
const panel = readFileSync("components/dashboard/IndiaLivePanel.tsx", "utf8");

describe("Coin read-only contract", () => {
  it("uses the official holdings read endpoint and exposes no Coin write helper", () => {
    expect(kite).toContain('kiteGet("/mf/holdings"');
    expect(kite).not.toMatch(/kite(Post|Delete)\("\/mf\//);
  });

  it("keeps Coin visibly separate from equity scoring and orders", () => {
    expect(panel).toContain("NO ORDER ACCESS");
    expect(panel).toContain("excluded from equity research, stops, targets");
    expect(panel).not.toContain("/api/kite/mf/order");
  });
});
