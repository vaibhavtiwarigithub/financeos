import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("supabase/migrations/20260807160000_property_parcel_evidence_stage1.sql", "utf8");
const worker = readFileSync("scripts/python/property_bulk_ingest.py", "utf8");
const workflow = readFileSync(".github/workflows/property-evidence.yml", "utf8");
const route = readFileSync("app/api/property/valuation-evidence/route.ts", "utf8");

describe("Property valuation Stage 1 safety contract", () => {
  it("stores keyed identifiers without address or owner columns", () => {
    expect(migration).toContain("parcel_key text not null");
    expect(migration).not.toMatch(/owner_name|grantor|grantee|address_key/i);
    expect(worker).toContain('lookup_key("parcel"');
    expect(worker).not.toContain('"address_key"');
  });

  it("preserves deed observations per immutable source snapshot", () => {
    expect(migration).toContain("event_key text not null");
    expect(migration).toContain("observed_snapshot_id uuid not null");
    expect(migration).toContain("unique (source_key, event_key, observed_snapshot_id)");
    expect(worker).toContain("DEEDNUMBER");
    expect(worker).toContain("DEEDDATE_MMDDYYYY");
  });

  it("keeps the large-file worker bounded and supply-chain pinned", () => {
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("actions/checkout@11d5960a326750d5838078e36cf38b85af677262");
    expect(workflow).toContain("actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065");
    expect(workflow).not.toContain("upload-artifact");
    expect(worker.indexOf("rest.scopes(source)")).toBeLessThan(worker.indexOf("download(url, target)"));
  });

  it("cannot fetch either county archive until its source contract is verified", () => {
    expect(worker).toContain("DISABLED_SOURCE_REASONS");
    expect(worker.indexOf("if source in DISABLED_SOURCE_REASONS")).toBeLessThan(worker.indexOf("SupabaseRest()"));
    expect(workflow).not.toContain("schedule:");
    expect(workflow).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(route).toContain("Valuation scope activation is disabled pending source licence verification");
  });

  it("cannot claim an AVM or market price", () => {
    expect(route).toContain("avmAvailable: false");
    expect(route).toContain("marketPriceAvailable: false");
    expect(route).toContain("parcelValueRangeAvailable: false");
  });
});
