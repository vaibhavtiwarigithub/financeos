export type ValuationCoverageState =
  | "available"
  | "no_rows"
  | "inactive"
  | "not_connected"
  | "error";

export type ValuationSourceCoverage = {
  sourceKey: string;
  sourceName: string;
  officialUrl: string;
  state: ValuationCoverageState;
  activationState: string | null;
  /** Null means the current schema cannot measure coverage. It never means zero. */
  rowCount: number | null;
  latestRun: {
    outcome: string;
    startedAt: string;
    completedAt: string | null;
    rowsWritten: number | null;
    errorCode: string | null;
  } | null;
};

export type ValuationTrendRow = {
  asOf: string;
  value: number;
  nativeUnit: string;
  sourceKey: string;
  revisionState: string;
};

export type ValuationAssessedValueRow = {
  /** Opaque parcel/account reference only; never a street address or owner name. */
  parcelRef: string;
  taxYear: number;
  assessedValue: number;
  currency: "USD";
  appraisedValue: number | null;
  sourceKey: "tcad-appraisal";
  asOf: string;
};

export type ValuationScope = {
  id: string;
  market: "phoenix" | "austin";
  kind: "postal_code" | "parcel";
  /** ZIP for Phoenix; always redacted for an Austin parcel. */
  label: string;
  active: boolean;
};

export type PropertyValuationStageOneResponse = {
  contractVersion: 1;
  generatedAt: string;
  claims: {
    avmAvailable: false;
    marketPriceAvailable: false;
    parcelValueRangeAvailable: false;
  };
  encryptionReady: boolean;
  scopes: ValuationScope[];
  phoenix: {
    capability: "recorded_transfer_evidence_status";
    sales: ValuationSourceCoverage;
  };
  austin: {
    capability: "assessed_value_reference_only";
    assessment: ValuationSourceCoverage;
    assessedValueRows: ValuationAssessedValueRow[];
    metroTrend: {
      state: "available" | "no_rows";
      rows: ValuationTrendRow[];
    };
  };
};
