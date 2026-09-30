import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  reportIssue: vi.fn(async () => undefined),
  resolveIssue: vi.fn(async () => undefined),
}));

vi.mock("@/lib/system-health", () => ({
  reportIssue: h.reportIssue,
  resolveIssue: h.resolveIssue,
}));

import { priceFor } from "@/lib/llm-router";

beforeEach(() => {
  h.reportIssue.mockClear();
  h.resolveIssue.mockClear();
});

describe("verified LLM pricing clears stale health notices", () => {
  it("resolves the old pricing-unverified issue when an exact price exists", () => {
    const rates = priceFor("deepseek-flash");

    expect(rates[0]).toBeGreaterThan(0);
    expect(rates[1]).toBeGreaterThan(0);
    expect(h.resolveIssue).toHaveBeenCalledWith("pricing-unverified:deepseek-flash");
    expect(h.reportIssue).not.toHaveBeenCalled();
  });

  it("does not clear a warning for a model that still has no exact price", () => {
    const rates = priceFor("model-without-a-price-or-fallback");

    expect(rates).toEqual([0, 0]);
    expect(h.resolveIssue).not.toHaveBeenCalled();
    expect(h.reportIssue).toHaveBeenCalledWith(expect.objectContaining({
      issueKey: "pricing-unverified:model-without-a-price-or-fallback",
    }));
  });
});
