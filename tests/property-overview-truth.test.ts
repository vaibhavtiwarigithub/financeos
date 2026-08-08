import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = readFileSync("app/api/property/overview/route.ts", "utf8");
const component = readFileSync("components/property/PropertyOverview.tsx", "utf8");

describe("property overview truth surface", () => {
  it("reads only non-sensitive active asset metadata for the owner summary", () => {
    const assetQuery = route.slice(route.indexOf('from("property_assets")'), route.indexOf(']);', route.indexOf('from("property_assets")')));
    expect(assetQuery).toContain('select("geography_slug, asset_type")');
    expect(assetQuery).toContain('.eq("owner_id", ownerId)');
    expect(assetQuery).toContain('.is("archived_at", null)');
    expect(assetQuery).not.toContain("encrypted_payload");
  });

  it("reports source activation and private-storage state instead of static P0 claims", () => {
    expect(route).toContain('activation_state === "active"');
    expect(route).toContain("propertyEncryptionReady()");
    expect(component).toContain("Active private records");
    expect(component).toContain("Active sources");
    expect(component).not.toContain("Not enabled in this phase");
    expect(component).not.toContain("P0 establishes");
  });
});
