import { describe, it, expect, vi } from "vitest";
import { BlsLausAdapter, BLS_HISTORY_YEARS, createPropertyCollectionRun, HudFmrAdapter, keepObservation, PropertySourceUnavailableError } from "@/lib/property/sources";
import { ACTIVE_PROPERTY_ADAPTERS } from "@/lib/property/sources";
import { PROPERTY_SOURCES } from "@/lib/property/registry";

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

  it("exposes the bounded official US adapters", () => {
    expect(ACTIVE_PROPERTY_ADAPTERS.map((a) => a.sourceKey).sort())
      .toEqual(["bls-laus", "fhfa-hpi", "fred-mortgage", "hud-fmr"]);
  });
});

describe("BLS local unemployment history", () => {
  it("requests the documented 20-year context window", async () => {
    let request: RequestInit | undefined;
    await new BlsLausAdapter().fetch({
      market: "austin",
      since: null,
      fetchText: async (_url, init) => {
        request = init;
        return { body: JSON.stringify({ Results: { series: [{ data: [] }] } }), lastModified: null };
      },
    });
    const payload = JSON.parse(String(request?.body));
    expect(Number(payload.endyear) - Number(payload.startyear) + 1).toBe(BLS_HISTORY_YEARS);
  });
});

describe("HUD FMR rental reference adapter", () => {
  const fetchText = vi.fn(async () => ({ body: JSON.stringify({ data: { year: "2026", basicdata: {
    "Efficiency": 1200, "One-Bedroom": 1350, "Two-Bedroom": 1600, "Three-Bedroom": 2100, "Four-Bedroom": 2550,
  } } }), lastModified: "Wed, 01 Oct 2025 00:00:00 GMT" }));

  it("normalizes only annual metro affordability references by bedroom count", async () => {
    const adapter = new HudFmrAdapter(() => "server-token");
    const rows = await adapter.fetch({ market: "austin", since: null, fetchText });
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ sourceKey: "hud-fmr", market: "austin", metric: "rent_reference_studio", asOf: "2026-10-01", nativeUnit: "USD/month studio", value: 1200, sourceVersion: "HUD FMR 2026" });
    expect(fetchText).toHaveBeenCalledWith(expect.stringContaining("METRO12420M12420"), expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer server-token" }) }));
  });

  it("uses only the published MSA row when HUD supplies a SAFMR ZIP array", async () => {
    const adapter = new HudFmrAdapter(() => "server-token");
    const rows = await adapter.fetch({ market: "phoenix", since: null, fetchText: async () => ({ body: JSON.stringify({ data: { year: 2026, basicdata: [
      { zip_code: "85001", "One-Bedroom": 9999 }, { zip_code: "MSA level", "Efficiency": 900, "One-Bedroom": 1100, "Two-Bedroom": 1300, "Three-Bedroom": 1700, "Four-Bedroom": 2100 },
    ] } }), lastModified: null }) });
    expect(rows.find((row) => row.nativeUnit === "USD/month one_bedroom")?.value).toBe(1100);
  });

  it("fails explicitly when the server token is not configured", async () => {
    await expect(new HudFmrAdapter(() => "").fetch({ market: "austin", since: null, fetchText }))
      .rejects.toMatchObject({ name: "PropertySourceUnavailableError", code: "hud_fmr_token_unconfigured" } satisfies Partial<PropertySourceUnavailableError>);
  });

  it("does not cover Bengaluru", () => {
    expect(new HudFmrAdapter(() => "server-token").supportsMarket("bengaluru")).toBe(false);
  });

  it("does not present the uncontracted RBI portal as a running collector", () => {
    expect(PROPERTY_SOURCES.find((source) => source.id === "rbi-hpi")?.state).toBe("contract_pending");
  });
});

describe("property collection fetch accounting", () => {
  it("deduplicates within one invocation but isolates overlapping invocations", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200, headers: { "last-modified": "today" } }));
    vi.stubGlobal("fetch", fetchMock);
    const first = createPropertyCollectionRun();
    const second = createPropertyCollectionRun();
    await Promise.all([
      first.fetchText("https://example.test/data"),
      first.fetchText("https://example.test/data"),
      second.fetchText("https://example.test/data"),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.fetchCount()).toBe(1);
    expect(second.fetchCount()).toBe(1);
    vi.unstubAllGlobals();
  });
});
