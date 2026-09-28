import { describe, expect, it } from "vitest";
import { massiveActionPath, normalizeMassiveActions } from "@/lib/shadows/massive-corporate-actions";
import { assessCorporateActionPayload } from "@/lib/shadows/corporate-action-coverage";

const now = new Date("2026-09-28T12:00:00Z");
const fetched = "2026-09-27T12:00:00Z";

describe("Massive corporate-action normalization", () => {
  it("maps a split to new shares per old share", () => {
    const out = normalizeMassiveActions("split", { status: "OK", results: [{ execution_date: "2024-06-10", split_from: 1, split_to: 10, ticker: "NVDA" }] });
    expect(out).toEqual({ data: [{ effective_date: "2024-06-10", split_factor: 10 }] });
    expect(assessCorporateActionPayload({ kind: "split", payload: out, providerFetchedAt: fetched, now }).status).toBe("complete");
  });

  it("maps a reverse split below one", () => {
    const out = normalizeMassiveActions("split", { status: "OK", results: [{ execution_date: "2025-01-02", split_from: 10, split_to: 1 }] });
    expect(out?.data[0].split_factor).toBeCloseTo(0.1);
  });

  it("maps a dividend and treats an empty OK result as a valid empty history", () => {
    const div = normalizeMassiveActions("dividend", { status: "OK", results: [{ ex_dividend_date: "2026-08-10", cash_amount: 0.27 }] });
    expect(div).toEqual({ data: [{ ex_dividend_date: "2026-08-10", amount: 0.27 }] });
    const empty = normalizeMassiveActions("split", { status: "OK", results: [] });
    expect(empty).toEqual({ data: [] });
    expect(assessCorporateActionPayload({ kind: "split", payload: empty, providerFetchedAt: fetched, now })).toMatchObject({ status: "complete", recordsCount: 0 });
  });

  it("refuses payloads that cannot certify completeness", () => {
    expect(normalizeMassiveActions("split", null)).toBeNull();
    expect(normalizeMassiveActions("split", { status: "ERROR", results: [] })).toBeNull();
    expect(normalizeMassiveActions("split", { status: "OK" })).toBeNull();
    expect(normalizeMassiveActions("dividend", { status: "OK", results: [], next_url: "https://x/next" })).toBeNull();
    expect(normalizeMassiveActions("split", { status: "OK", results: [{ execution_date: "2024-06-10", split_from: 0, split_to: 10 }] })).toBeNull();
    expect(normalizeMassiveActions("dividend", { status: "OK", results: [
      { ex_dividend_date: "2026-08-10", cash_amount: 0.2 }, { ex_dividend_date: "2026-08-10", cash_amount: 0.1 },
    ] })).toBeNull();
  });

  it("a non-positive dividend is flagged invalid by the shared assessor, not silently accepted", () => {
    const out = normalizeMassiveActions("dividend", { status: "OK", results: [{ ex_dividend_date: "2026-08-10", cash_amount: 0 }] });
    expect(assessCorporateActionPayload({ kind: "dividend", payload: out, providerFetchedAt: fetched, now }).status).toBe("invalid");
  });

  it("builds bounded per-symbol paths", () => {
    expect(massiveActionPath("split", "brk.b", "2026-01-01")).toBe("/v3/reference/splits?ticker=BRK.B&execution_date.gte=2026-01-01&limit=100");
    expect(massiveActionPath("dividend", "AAPL", "2026-01-01")).toContain("/v3/reference/dividends?ticker=AAPL&ex_dividend_date.gte=2026-01-01");
  });
});
