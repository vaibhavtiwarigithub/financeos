import { describe, expect, it } from "vitest";
import { assessCorporateActionPayload, selectCorporateActionCoverageBatch } from "./corporate-action-coverage";

describe("assessCorporateActionPayload", () => {
  const now = new Date("2026-09-27T12:00:00.000Z");

  it("treats a fresh, validated empty response as known zero events", () => {
    expect(assessCorporateActionPayload({
      kind: "split", payload: { data: [] },
      providerFetchedAt: "2026-09-27T11:00:00.000Z", now,
    })).toEqual({ status: "complete", recordsCount: 0, reason: null });
  });

  it("does not treat a missing provider payload as no events", () => {
    expect(assessCorporateActionPayload({
      kind: "dividend", payload: null,
      providerFetchedAt: "2026-09-27T11:00:00.000Z", now,
    }).status).toBe("invalid");
  });

  it("rejects old cache rows even if the copied slot is recent", () => {
    expect(assessCorporateActionPayload({
      kind: "split", payload: { data: [] },
      providerFetchedAt: "2026-08-01T00:00:00.000Z", now,
    }).status).toBe("stale");
  });

  it("rejects malformed events instead of silently skipping them", () => {
    expect(assessCorporateActionPayload({
      kind: "dividend", payload: { data: [{ ex_dividend_date: "2026-09-01", amount: "0" }] },
      providerFetchedAt: "2026-09-27T11:00:00.000Z", now,
    }).status).toBe("invalid");
  });

  it("rejects calendar dates that JavaScript would otherwise roll into the next month", () => {
    expect(assessCorporateActionPayload({
      kind: "split", payload: { data: [{ effective_date: "2026-02-31", split_factor: "2" }] },
      providerFetchedAt: "2026-09-27T11:00:00.000Z", now,
    }).status).toBe("invalid");
  });
});

describe("selectCorporateActionCoverageBatch", () => {
  it("rotates toward never-checked symbols instead of pinning the first five", () => {
    const prior = ["A", "B", "C", "D", "E"].flatMap((symbol) => [
      { symbol, action_type: "split", checked_at: "2026-09-26T00:00:00Z" },
      { symbol, action_type: "dividend", checked_at: "2026-09-26T00:00:00Z" },
    ]);
    expect(selectCorporateActionCoverageBatch(["A", "B", "C", "D", "E", "F", "G"], prior, 5)).toEqual(["F", "G", "A", "B", "C"]);
  });

  it("prioritizes the oldest side of a split/dividend pair", () => {
    const prior = [
      { symbol: "A", action_type: "split", checked_at: "2026-09-26T00:00:00Z" },
      { symbol: "A", action_type: "dividend", checked_at: "2026-09-20T00:00:00Z" },
      { symbol: "B", action_type: "split", checked_at: "2026-09-22T00:00:00Z" },
      { symbol: "B", action_type: "dividend", checked_at: "2026-09-22T00:00:00Z" },
    ];
    expect(selectCorporateActionCoverageBatch(["A", "B"], prior, 1)).toEqual(["A"]);
  });
});

import { symbolsNeedingCoverage } from "@/lib/shadows/corporate-action-coverage";

describe("symbolsNeedingCoverage", () => {
  const now = new Date("2026-09-28T12:00:00Z");
  const row = (symbol: string, action_type: string, checked_at: string, status = "complete") => ({ symbol, action_type, status, checked_at });

  it("skips symbols with fresh complete coverage for both kinds", () => {
    const rows = [row("AAA", "split", "2026-09-27T00:00:00Z"), row("AAA", "dividend", "2026-09-27T00:00:00Z")];
    expect(symbolsNeedingCoverage(["AAA"], rows, now)).toEqual([]);
  });

  it("selects never-checked, half-covered, stale and failed-check symbols, oldest first (a missing side ties with never-checked)", () => {
    const rows = [
      row("HALF", "split", "2026-09-27T00:00:00Z"),
      row("OLD", "split", "2026-09-01T00:00:00Z"), row("OLD", "dividend", "2026-09-01T00:00:00Z"),
      row("BAD", "split", "2026-09-27T00:00:00Z", "error"), row("BAD", "dividend", "2026-09-27T00:00:00Z", "error"),
    ];
    expect(symbolsNeedingCoverage(["HALF", "NEW", "OLD", "BAD"], rows, now, 5, 10)).toEqual(["HALF", "NEW", "OLD", "BAD"]);
  });

  it("bounds the batch", () => {
    expect(symbolsNeedingCoverage(["A", "B", "C"], [], now, 5, 2)).toHaveLength(2);
  });
});
