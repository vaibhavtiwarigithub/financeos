import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const frame = readFileSync("components/property/PropertyPrimitives.tsx", "utf8");
const guidedPages = [
  "components/property/PropertyOverview.tsx",
  "components/property/PropertyMarketData.tsx",
  "components/property/PropertyValuationStageOne.tsx",
  "components/property/MyPropertiesWorkspace.tsx",
  "components/property/PropertyEvidenceImportsWorkspace.tsx",
  "components/property/OpportunitiesWorkspace.tsx",
  "components/property/FinancingWorkspace.tsx",
  "components/property/ForecastLearningWorkspace.tsx",
  "app/property/sources/page.tsx",
];

describe("Property page help", () => {
  it("uses the same collapsible guidance contract as the Investing workspace", () => {
    expect(frame).toContain("WHAT&apos;S HERE");
    expect(frame).toContain("WHAT TO LOOK FOR");
    expect(frame).toContain("Show page help");
  });

  it("keeps guidance attached to every Property destination", () => {
    for (const page of guidedPages) {
      expect(readFileSync(page, "utf8"), page).toContain("help={{");
    }
  });
});
