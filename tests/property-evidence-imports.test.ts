import { describe, expect, it } from "vitest";
import { parsePropertyEvidenceImport } from "@/lib/property/import-contract";

describe("property owner evidence imports", () => {
  it("accepts a bounded tax notice without exposing a third document type", () => {
    expect(parsePropertyEvidenceImport({ importType: "tax_notice", sourceLabel: "Travis 2026", content: "Amount due", market: "austin", asOf: "2026-01-15" })).toEqual({ importType: "tax_notice", sourceLabel: "Travis 2026", content: "Amount due", market: "austin", asOf: "2026-01-15" });
  });

  it("rejects unsupported evidence, bad dates, and unknown markets", () => {
    expect(parsePropertyEvidenceImport({ importType: "comps", sourceLabel: "x", content: "x" })).toBeNull();
    expect(parsePropertyEvidenceImport({ importType: "insurance_quote", sourceLabel: "x", content: "x", asOf: "01/15/2026" })).toBeNull();
    expect(parsePropertyEvidenceImport({ importType: "tax_notice", sourceLabel: "x", content: "x", asOf: "2026-02-31" })).toBeNull();
    expect(parsePropertyEvidenceImport({ importType: "insurance_quote", sourceLabel: "x", content: "x", market: "us" })).toBeNull();
  });

  it("trims user input while preserving the evidence contract", () => {
    expect(parsePropertyEvidenceImport({ importType: "insurance_quote", sourceLabel: "  Carrier quote  ", content: "  Coverage detail  ", market: null, asOf: null })).toMatchObject({ sourceLabel: "Carrier quote", content: "Coverage detail", market: null, asOf: null });
  });
});
