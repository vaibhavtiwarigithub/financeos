import { describe, it, expect } from "vitest";
import { ZillowZhviZipAdapter, ZIP_PROPERTY_ADAPTERS, PropertySourceUnavailableError } from "@/lib/property/sources";

function csv(rows: string[][]): string {
  return rows.map((row) => row.map((cell) => (cell.includes(",") ? `"${cell}"` : cell)).join(",")).join("\n");
}

const HEADER = ["RegionID", "RegionName", "Metro", "2026-05-31", "2026-06-30", "2026-07-31"];

describe("ZillowZhviZipAdapter — ZIP-level area context", () => {
  it("declares US-only coverage, matching every other active adapter", () => {
    const adapter = new ZillowZhviZipAdapter();
    expect(adapter.supportsMarket("austin")).toBe(true);
    expect(adapter.supportsMarket("phoenix")).toBe(true);
    expect(adapter.supportsMarket("bengaluru")).toBe(false);
    expect(ZIP_PROPERTY_ADAPTERS.map((a) => a.sourceKey)).toEqual(["zillow-zhvi-zip"]);
  });

  it("keeps only ZIPs whose Metro column matches the requested market, with the last-3-columns trend intact", async () => {
    const body = csv([
      HEADER,
      ["1", "78701", "Austin-Round Rock-Georgetown, TX", "500000", "505000", "510000"],
      ["2", "85001", "Phoenix-Mesa-Chandler, AZ", "400000", "402000", "404000"],
      ["3", "10001", "New York-Newark-Jersey City, NY-NJ-PA", "900000", "905000", "910000"],
    ]);
    const adapter = new ZillowZhviZipAdapter();
    const observations = await adapter.fetch({
      market: "austin",
      fetchText: async () => ({ body, lastModified: "Wed, 01 Jul 2026 00:00:00 GMT" }),
    });
    expect(observations.every((o) => o.zip === "78701")).toBe(true);
    expect(observations.map((o) => o.asOf).sort()).toEqual(["2026-05-31", "2026-06-30", "2026-07-31"]);
    const latest = observations.find((o) => o.asOf === "2026-07-31");
    expect(latest?.value).toBe(510000);
    expect(latest?.metric).toBe("zhvi_all_homes");
    expect(latest?.market).toBe("austin");
  });

  it("returns nothing for a market with no matching ZIPs in the file (missing-data path), without throwing", async () => {
    const body = csv([HEADER, ["3", "10001", "New York-Newark-Jersey City, NY-NJ-PA", "900000", "905000", "910000"]]);
    const adapter = new ZillowZhviZipAdapter();
    const observations = await adapter.fetch({ market: "phoenix", fetchText: async () => ({ body, lastModified: null }) });
    expect(observations).toEqual([]);
  });

  it("raises a typed unavailable error on transport failure rather than reporting an empty success", async () => {
    const adapter = new ZillowZhviZipAdapter();
    await expect(adapter.fetch({
      market: "austin",
      fetchText: async () => { throw new Error("HTTP 503"); },
    })).rejects.toMatchObject({ name: "PropertySourceUnavailableError", code: "zillow_zhvi_transport_unavailable" } satisfies Partial<PropertySourceUnavailableError>);
  });

  it("raises a typed error when required columns are missing (malformed upstream file)", async () => {
    const adapter = new ZillowZhviZipAdapter();
    await expect(adapter.fetch({
      market: "austin",
      fetchText: async () => ({ body: csv([["RegionID", "SomeOtherColumn"], ["1", "x"]]), lastModified: null }),
    })).rejects.toMatchObject({ name: "PropertySourceUnavailableError", code: "zillow_zhvi_invalid_response" });
  });
});
