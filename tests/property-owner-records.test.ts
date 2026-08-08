import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { calculateOwnershipCost } from "@/lib/property/ownership-cost";
import { parseCensusGeocode } from "@/lib/property/geocode";
import { propertyWindowCutoff } from "@/lib/property/chart-windows";
import { parsePropertyEvidenceImport } from "@/lib/property/import-contract";

describe("property owner records", () => {
  it("calculates a complete monthly carrying cost without mixing annual and monthly inputs", () => {
    const result = calculateOwnershipCost({
      loanBalance: 300_000, annualMortgageRatePct: 6, remainingTermMonths: 360,
      annualPropertyTax: 6_000, annualInsurance: 2_400, annualMaintenance: 3_600,
      monthlyHoa: 100, monthlyOther: 50,
    });
    expect(result.propertyTax).toBe(500);
    expect(result.insurance).toBe(200);
    expect(result.maintenance).toBe(300);
    expect(result.total).toBeCloseTo(result.principalAndInterest + 1_150, 8);
  });

  it("does not invent principal and interest for an unfinanced property", () => {
    expect(calculateOwnershipCost({ loanBalance: 0, annualMortgageRatePct: 0, remainingTermMonths: 1, annualPropertyTax: 1_200, annualInsurance: 0, annualMaintenance: 0, monthlyHoa: 0, monthlyOther: 0 }).total).toBe(100);
  });

  it("extracts only non-sensitive geography from a unique Census match", () => {
    const result = parseCensusGeocode({ result: { addressMatches: [{ matchedAddress: "1 MAIN ST, AUSTIN, TX, 78701", addressComponents: { zip: "78701" }, geographies: { Counties: [{ NAME: "Travis County", GEOID: "48453" }] } }] } }, "2026-08-08T00:00:00.000Z");
    expect(result).toMatchObject({ state: "resolved", postalCode: "78701", countyName: "Travis County", countyGeoid: "48453" });
  });

  it("fails honestly on absent or ambiguous address matches", () => {
    expect(parseCensusGeocode({ result: { addressMatches: [] } }).state).toBe("no_match");
    expect(parseCensusGeocode({ result: { addressMatches: [{}, {}] } }).state).toBe("ambiguous");
  });

  it("supports the standard historical windows", () => {
    const now = new Date("2026-08-08T12:00:00Z");
    expect(propertyWindowCutoff("ytd", now)).toBe("2026-01-01");
    expect(propertyWindowCutoff("1m", now)).toBe("2026-07-08");
    expect(propertyWindowCutoff("20y", now)).toBe("2006-08-08");
    expect(propertyWindowCutoff("all", now)).toBeNull();
  });

  it("keeps the property-value ledger immutable, server-only, and archive-safe", () => {
    const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/20260808180110_property_asset_history.sql"), "utf8");
    expect(migration).toContain("property_asset_id uuid not null references public.property_assets(id) on delete restrict");
    expect(migration).toContain("alter table public.property_asset_history enable row level security");
    expect(migration).toContain("revoke all on public.property_asset_history from anon, authenticated");
    expect(migration).toContain("before update or delete on public.property_asset_history");
    expect(migration).toContain("archive_property_asset");
  });

  it("accepts only real calendar dates for encrypted tax and insurance evidence", () => {
    expect(parsePropertyEvidenceImport({ importType: "tax_notice", sourceLabel: "County notice", content: "Amount redacted", market: "austin", asOf: "2026-02-28" })).toMatchObject({ market: "austin" });
    expect(parsePropertyEvidenceImport({ importType: "tax_notice", sourceLabel: "County notice", content: "Amount redacted", market: "austin", asOf: "2026-02-31" })).toBeNull();
  });
});
