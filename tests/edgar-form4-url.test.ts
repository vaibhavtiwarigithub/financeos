import { describe, expect, it } from "vitest";
import { buildForm4XmlUrl, stripXslRenderPrefix } from "@/lib/data/edgar-insider";

// Regression tests for the Form 4 URL defect (2026-07-16): the route and the
// adapter both built `<accession>.xml`, which is not a real EDGAR artifact. It
// 404'd on every filing ever fetched, and `if (!xmlRes.ok) continue` turned that
// into `[]` — so the UI showed a confident "No recent insider trades found."
// over a 100% failure rate.
//
// Every URL/shape below was verified against live SEC responses on 2026-07-16.

describe("stripXslRenderPrefix", () => {
  // primaryDocument for Form 4 ALWAYS points at the XSL rendering, which SEC
  // serves as text/html. That path returns 200 but contains no machine tags —
  // parsing it yields zero transactions. The raw XML is the same name without
  // the prefix.
  it.each([
    ["xslF345X06/form4.xml", "form4.xml"],
    ["xslF345X05/form4.xml", "form4.xml"],
    // Filenames vary by filer agent — the prefix must be stripped, never the
    // filename assumed.
    ["xslF345X06/tm2618092-2_4seq1.xml", "tm2618092-2_4seq1.xml"], // TSLA
    ["xslF345X06/wk-form4_1784149645.xml", "wk-form4_1784149645.xml"], // MA
  ])("strips the xsl render prefix from %s", (input, expected) => {
    expect(stripXslRenderPrefix(input)).toBe(expected);
  });

  it("leaves an already-raw document name untouched", () => {
    expect(stripXslRenderPrefix("form4.xml")).toBe("form4.xml");
  });
});

describe("buildForm4XmlUrl", () => {
  // The exact accession the audit verified by hand: the route's URL 404s, this
  // one returns 200 and parses.
  it("resolves the real primary document for the Visa accession", () => {
    expect(
      buildForm4XmlUrl("0001403161", "0001403161-26-000090", "xslF345X06/form4.xml")
    ).toBe(
      "https://www.sec.gov/Archives/edgar/data/1403161/000140316126000090/form4.xml"
    );
  });

  it("never builds the accession-named URL that 404s", () => {
    const url = buildForm4XmlUrl("0001403161", "0001403161-26-000090", "xslF345X06/form4.xml");
    expect(url).not.toContain("0001403161-26-000090.xml");
  });

  it("never points at the xsl rendering, which serves HTML not XML", () => {
    const url = buildForm4XmlUrl("0001318605", "0001104659-26-075213", "xslF345X06/tm2618092-2_4seq1.xml");
    expect(url).not.toContain("xslF345X");
    expect(url).toBe(
      "https://www.sec.gov/Archives/edgar/data/1318605/000110465926075213/tm2618092-2_4seq1.xml"
    );
  });

  // The zero-padded CIK 301-redirects; the path must use the unpadded form.
  it("uses the unpadded CIK in the archive path", () => {
    const url = buildForm4XmlUrl("0000320193", "0001140361-26-025622", "xslF345X06/form4.xml");
    expect(url).toContain("/edgar/data/320193/");
    expect(url).not.toContain("/edgar/data/0000320193/");
  });

  // A filing with no XML primary document can't be parsed. Returning null lets
  // the caller SKIP it rather than count it as a read failure.
  it.each([[null], [undefined], [""], ["0001403161-26-000090-index.html"]])(
    "returns null for a non-XML primary document (%s)",
    (doc) => {
      expect(buildForm4XmlUrl("0001403161", "0001403161-26-000090", doc as any)).toBeNull();
    }
  );
});
