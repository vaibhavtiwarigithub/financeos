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
  sourceKey: "tcad-assessment";
  asOf: string;
};

export type PropertyValuationStageOneResponse = {
  contractVersion: 1;
  generatedAt: string;
  claims: {
    avmAvailable: false;
    marketPriceAvailable: false;
    parcelValueRangeAvailable: false;
  };
  phoenix: {
    capability: "parcel_and_sale_evidence_status";
    parcels: ValuationSourceCoverage;
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
