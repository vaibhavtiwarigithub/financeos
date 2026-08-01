export type FinancialDatasetsFailureCode =
  | "credit_exhausted"
  | "unauthorized"
  | "rate_limited"
  | "provider_error"
  | "network_error";

export interface FinancialDatasetsFailure {
  code: FinancialDatasetsFailureCode;
  httpStatus?: number;
}

// Provider error bodies are not persisted: they may contain account details.
// Reduce them to a stable, non-sensitive operational code instead.
export function classifyFinancialDatasetsFailure(
  httpStatus: number,
  responseBody: string,
): FinancialDatasetsFailure {
  const body = responseBody.toLowerCase();
  if (
    httpStatus === 402
    || /(?:balance|credit|funds?).{0,40}(?:\$?0(?:\.0+)?\b|exhausted|insufficient|depleted)/i.test(body)
    || /(?:out of|no) credits?/i.test(body)
  ) {
    return { code: "credit_exhausted", httpStatus };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { code: "unauthorized", httpStatus };
  }
  if (httpStatus === 429) {
    return { code: "rate_limited", httpStatus };
  }
  return { code: "provider_error", httpStatus };
}

export function financialDatasetsFailureDetail(failure: FinancialDatasetsFailure): string {
  const suffix = failure.httpStatus ? ` (HTTP ${failure.httpStatus})` : "";
  switch (failure.code) {
    case "credit_exhausted":
      return `FinancialDatasets credits are exhausted${suffix}.`;
    case "unauthorized":
      return `FinancialDatasets rejected the configured credential${suffix}.`;
    case "rate_limited":
      return `FinancialDatasets rate-limited the screener${suffix}.`;
    case "network_error":
      return "FinancialDatasets could not be reached before the bounded timeout.";
    default:
      return `FinancialDatasets returned an unavailable response${suffix}.`;
  }
}
