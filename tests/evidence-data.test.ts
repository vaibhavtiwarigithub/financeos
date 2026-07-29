import { describe, expect, it } from "vitest";
import {
  assertNseSessionDate,
  assertAllowedUrl,
  buildManifest,
  canonicalJson,
  normalizeFredObservations,
  normalizeNseCorporateAction,
  normalizeNseRow,
  normalizeSecNumericFact,
  nseBhavcopyUrl,
  safeArchiveEntries,
  isCurrentNormalizer,
} from "../scripts/evidence-data.mjs";

describe("governed historical evidence intake", () => {
  it("canonicalizes and fingerprints manifests independent of object key order", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    const input = {
      datasetId: "x",
      sourceId: "fred",
      sourceAuthority: "official",
      evidenceClass: "promotion_candidate",
      market: "us",
      dataKinds: ["macro"],
      sourceVersion: "v1",
      retrievedAt: "2026-07-29T00:00:00.000Z",
      files: [{ relativePath: "b", sourceUrl: "https://fred.stlouisfed.org/b", sha256: "2", bytes: 2, mediaType: "text/csv" },
        { relativePath: "a", sourceUrl: "https://fred.stlouisfed.org/a", sha256: "1", bytes: 1, mediaType: "text/csv" }],
      coverage: { start: "2020-01-01", end: "2020-01-02", receivedFiles: 2 },
    };
    expect(buildManifest(input).datasetFingerprint).toBe(buildManifest({ ...input, files: [...input.files].reverse() }).datasetFingerprint);
  });

  it("tracks current normalizers per source schema, not whole-script hash", () => {
    expect(isCurrentNormalizer({
      sourceId: "nse-bhavcopy",
      normalization: { status: "valid", schemaVersion: "nse-daily-bars.jsonl.v2", codeSha256: "old" },
    })).toBe(true);
    expect(isCurrentNormalizer({
      sourceId: "nse-bhavcopy",
      normalization: { status: "valid", schemaVersion: "nse-daily-bars.jsonl.v1", codeSha256: "new" },
    })).toBe(false);
    expect(isCurrentNormalizer({
      sourceId: "fred-alfred",
      normalization: { status: "valid", schemaVersion: "fred-vintages.jsonl.v1", codeSha256: "old" },
    })).toBe(true);
  });

  it("allows only explicit HTTPS evidence hosts", () => {
    expect(() => assertAllowedUrl("https://www.sec.gov/a.zip")).not.toThrow();
    expect(() => assertAllowedUrl("http://www.sec.gov/a.zip")).toThrow(/HTTPS/);
    expect(() => assertAllowedUrl("https://evil.example/a.zip")).toThrow(/allowlisted/);
    expect(() => assertAllowedUrl("https://user:secret@www.sec.gov/a.zip")).toThrow(/Credentials/);
  });

  it("rejects archive path traversal", () => {
    expect(safeArchiveEntries(["sub.txt", "nested/num.txt"])).toBe(true);
    expect(safeArchiveEntries(["../escape.txt"])).toBe(false);
    expect(safeArchiveEntries(["C:\\escape.txt"])).toBe(false);
    expect(safeArchiveEntries(["/escape.txt"])).toBe(false);
  });

  it("uses the correct NSE URL across the UDiFF cutover", () => {
    expect(nseBhavcopyUrl("2023-12-29")).toContain("/2023/DEC/cm29DEC2023bhav.csv.zip");
    expect(nseBhavcopyUrl("2024-01-02")).toContain("BhavCopy_NSE_CM_0_0_0_20240102_F_0000.csv.zip");
  });

  it("normalizes old and UDiFF NSE EQ rows and skips other series", () => {
    const oldHeaders = ["SYMBOL", "SERIES", "OPEN", "HIGH", "LOW", "CLOSE", "TOTTRDQTY", "TOTTRDVAL", "TIMESTAMP"];
    const old = normalizeNseRow(oldHeaders, ["RELIANCE", "EQ", "100", "110", "95", "105", "1000", "103000", "02-JAN-2024"], "abc");
    expect(old).toMatchObject({ symbol: "RELIANCE", session_date: "2024-01-02", close: 105, currency: "INR" });
    const legacyYear = normalizeNseRow(oldHeaders, ["RELIANCE", "EQ", "100", "110", "95", "105", "1000", "103000", "13-Jul-20"], "abc");
    expect(legacyYear).toMatchObject({ symbol: "RELIANCE", session_date: "2020-07-13" });
    expect(normalizeNseRow(oldHeaders, ["GSEC", "GS", "100", "101", "99", "100", "1", "100", "02-JAN-2024"], "abc")).toBeNull();

    const newHeaders = ["TradDt", "TckrSymb", "SctySrs", "OpnPric", "HghPric", "LwPric", "ClsPric", "TtlTradgVol", "TtlTrfVal"];
    const current = normalizeNseRow(newHeaders, ["2025-07-29", "TCS", "EQ", "3000", "3100", "2990", "3050", "50", "152500"], "def");
    expect(current).toMatchObject({
      symbol: "TCS",
      session_date: "2025-07-29",
      high: 3100,
      volume: 50,
      turnover: 152500,
    });
    expect(() => assertNseSessionDate(current!, "2025-07-28", "stale.zip")).toThrow(
      /contains 2025-07-29; expected 2025-07-28/,
    );
  });

  it("preserves FRED realtime intervals and null missing values", () => {
    expect(normalizeFredObservations("CPIAUCSL", [
      { date: "2020-01-01", realtime_start: "2020-02-13", realtime_end: "2020-03-10", value: "258.7" },
      { date: "2020-02-01", realtime_start: "2020-03-11", realtime_end: "9999-12-31", value: "." },
    ])).toEqual([
      { series_id: "CPIAUCSL", observation_date: "2020-01-01", realtime_start: "2020-02-13", realtime_end: "2020-03-10", value: 258.7 },
      { series_id: "CPIAUCSL", observation_date: "2020-02-01", realtime_start: "2020-03-11", realtime_end: "9999-12-31", value: null },
    ]);
  });

  it("normalizes only deterministic NSE price-affecting action semantics", () => {
    expect(normalizeNseCorporateAction({
      series: "EQ", symbol: "NESTLEIND", isin: "INE239A01016",
      exDate: "05-Jan-2024", recDate: "05-Jan-2024",
      subject: "Face Value Split (Sub-Division) - From Rs10/- Per Share To Re 1/- Per Share",
    }, "abc")).toMatchObject({
      action_type: "split",
      ex_date: "2024-01-05",
      adjustment_factor: 10,
      adjustment_status: "parsed",
      availability_clock: "ex_date_conservative",
    });
    expect(normalizeNseCorporateAction({
      series: "EQ", symbol: "TCS", exDate: "19-Jan-2024",
      subject: "Interim Dividend - Rs 9 Per Share Special Dividend - Rs 18 Per Share",
    }, "abc")).toMatchObject({ action_type: "dividend", amount_inr: 27 });
    expect(normalizeNseCorporateAction({
      series: "EQ", symbol: "NEWGEN", exDate: "12-Jan-2024", subject: "Bonus 1:1",
    }, "abc")).toMatchObject({ action_type: "bonus", adjustment_factor: 2 });
    expect(normalizeNseCorporateAction({
      series: "IV", symbol: "INDIGRID", exDate: "31-Jan-2024", subject: "Distribution",
    }, "abc")).toBeNull();
  });

  it("keeps only non-dimensional SEC primary facts with valid period semantics", () => {
    const submission = {
      adsh: "0000320193-24-000123",
      cik: "320193",
      name: "APPLE INC",
      form: "10-Q",
      filed: "20240503",
      accepted: "2024-05-03 18:04:00.0",
      fy: "2024",
      fp: "Q2",
    };
    expect(normalizeSecNumericFact(submission, {
      tag: "RevenueFromContractWithCustomerExcludingAssessedTax",
      version: "us-gaap/2024",
      ddate: "20240330",
      qtrs: "1",
      uom: "USD",
      value: "90753000000",
      coreg: "",
      segments: "",
    }, "IS", "hash")).toMatchObject({
      cik: "0000320193",
      metric: "revenue",
      available_on: "2024-05-04",
      period_end: "2024-03-30",
      duration_quarters: 1,
    });
    expect(normalizeSecNumericFact(submission, {
      tag: "Assets",
      version: "us-gaap/2024",
      ddate: "20240330",
      qtrs: "1",
      uom: "USD",
      value: "1",
      coreg: "",
      segments: "",
    }, "BS", "hash")).toBeNull();
    expect(normalizeSecNumericFact(submission, {
      tag: "NetIncomeLoss",
      version: "us-gaap/2024",
      ddate: "20240330",
      qtrs: "1",
      uom: "USD",
      value: "1",
      coreg: "",
      segments: "{\"dimension\":\"value\"}",
    }, "IS", "hash")).toBeNull();
  });
});
