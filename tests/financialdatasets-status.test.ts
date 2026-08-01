import { describe, expect, it } from "vitest";
import {
  classifyFinancialDatasetsFailure,
  financialDatasetsFailureDetail,
} from "@/lib/data/financialdatasets-status";

describe("FinancialDatasets failure classification", () => {
  it("recognizes a zero-balance response without retaining its body", () => {
    const failure = classifyFinancialDatasetsFailure(400, "Account balance is $0.00; add credits");
    expect(failure).toEqual({ code: "credit_exhausted", httpStatus: 400 });
    expect(financialDatasetsFailureDetail(failure)).toBe("FinancialDatasets credits are exhausted (HTTP 400).");
  });

  it("classifies auth, pacing, and generic provider failures", () => {
    expect(classifyFinancialDatasetsFailure(401, "bad key").code).toBe("unauthorized");
    expect(classifyFinancialDatasetsFailure(429, "slow down").code).toBe("rate_limited");
    expect(classifyFinancialDatasetsFailure(503, "maintenance").code).toBe("provider_error");
  });
});
