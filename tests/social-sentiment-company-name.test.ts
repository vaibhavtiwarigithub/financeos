import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanCompanyName } from "@/lib/social-sentiment";

describe("cleanCompanyName", () => {
  it("strips legal suffixes and share-class noise so GDELT can match prose", () => {
    expect(cleanCompanyName("AbbVie Inc.")).toBe("AbbVie");
    expect(cleanCompanyName("Lowe's Companies, Inc.")).toBe("Lowe's Companies");
    expect(cleanCompanyName("American Tower Corporation (REIT)")).toBe("American Tower");
    expect(cleanCompanyName("Fortinet, Inc. Common Stock")).toBe("Fortinet");
  });
  it("returns undefined for empty or too-short names so the ticker query is kept", () => {
    expect(cleanCompanyName(null)).toBeUndefined();
    expect(cleanCompanyName("Co.")).toBeUndefined();
  });
});

describe("sentiment availability alert guard", () => {
  const src = readFileSync("lib/research-agent.ts", "utf8");
  it("does not page critical on a small batch", () => {
    expect(src).toContain("DIM_AVAIL_CRIT_MIN_APPLICABLE = 20");
    expect(src).toContain("rate < DIM_AVAIL_CRIT && appl >= DIM_AVAIL_CRIT_MIN_APPLICABLE");
  });
});
