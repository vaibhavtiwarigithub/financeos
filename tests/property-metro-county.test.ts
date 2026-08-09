import { describe, expect, it } from "vitest";
import { countiesForMarket } from "@/lib/property/registry";
import { CensusAcsCountyAdapter } from "@/lib/property/county-sources";

describe("property metro county coverage", () => {
  it("declares every Austin and Phoenix metro county explicitly", () => {
    expect(countiesForMarket("austin").map((county) => county.countyFips)).toEqual(["48021", "48055", "48209", "48453", "48491"]);
    expect(countiesForMarket("phoenix").map((county) => county.countyFips)).toEqual(["04013", "04021"]);
    expect(countiesForMarket("bengaluru")).toEqual([]);
  });
  it("rejects ACS collection without a server key", async () => {
    const adapter = new CensusAcsCountyAdapter(() => "");
    await expect(adapter.fetch({ market: "austin", fetchText: async () => ({ body: "[]", lastModified: null }) })).rejects.toMatchObject({ code: "census_api_key_unconfigured" });
  });
});
