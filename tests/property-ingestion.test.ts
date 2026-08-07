import { describe, it, expect } from "vitest";
import { keepObservation } from "@/lib/property/sources";
import { ACTIVE_PROPERTY_ADAPTERS } from "@/lib/property/sources";

describe("keepObservation — revisions must survive the `since` filter", () => {
  const since = "2026-06-30";

  it("admits a REVISION of an already-collected period", () => {
    // The bug this replaces: `as_of <= since` dropped every revision, so a
    // source republishing a corrected value for an old month could never be
    // ingested — and the schema's revision_state column could never be used.
    expect(keepObservation("2026-03-31", since, "revised")).toBe(true);
    expect(keepObservation(since, since, "revised")).toBe(true);
  });

  it("still skips an INITIAL observation at or before the newest stored date", () => {
    expect(keepObservation("2026-03-31", since, "initial")).toBe(false);
    expect(keepObservation(since, since, "initial")).toBe(false);
  });

  it("admits any observation newer than the newest stored date", () => {
    expect(keepObservation("2026-07-31", since, "initial")).toBe(true);
    expect(keepObservation("2026-07-31", since, "revised")).toBe(true);
  });

  it("admits everything on a first run, when nothing is stored", () => {
    expect(keepObservation("1977-06-30", null, "initial")).toBe(true);
  });
});

describe("adapter market coverage is declared, not inferred from an empty result", () => {
  it("every active adapter declares US-only coverage explicitly", () => {
    // Returning zero rows and returning "this source cannot cover this market"
    // are different facts. Conflating them reported Bengaluru as a successful
    // collection with no data, hiding a real coverage gap.
    for (const adapter of ACTIVE_PROPERTY_ADAPTERS) {
      expect(adapter.supportsMarket("austin")).toBe(true);
      expect(adapter.supportsMarket("phoenix")).toBe(true);
      expect(adapter.supportsMarket("bengaluru")).toBe(false);
    }
  });

  it("exposes the three official US adapters", () => {
    expect(ACTIVE_PROPERTY_ADAPTERS.map((a) => a.sourceKey).sort())
      .toEqual(["bls-laus", "fhfa-hpi", "fred-mortgage"]);
  });
});
