import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildManifest } from "../scripts/evidence-data.mjs";
import {
  loadLocalFredMacroRaws,
  loadLocalNseCorporateActionRaws,
  loadLocalNsePriceRaws,
  loadLocalSecFundamentalRaws,
  verifyLocalEvidenceManifest,
} from "@/lib/replay/local-evidence";

const roots: string[] = [];
const hash = (body: string) => crypto.createHash("sha256").update(body).digest("hex");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

async function fixture(
  sourceId: "nse-bhavcopy" | "nse-corporate-actions" | "fred-alfred" | "sec-financial-statement-data-sets",
  market: "india" | "us",
  relativePath: string,
  body: string,
) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "kairos-evidence-"));
  roots.push(root);
  const file = path.join(root, relativePath);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, body);
  const manifest = buildManifest({
    datasetId: `${sourceId}-fixture`,
    sourceId,
    sourceAuthority: "official",
    evidenceClass: "promotion_candidate",
    market,
    dataKinds: sourceId === "nse-bhavcopy"
      ? ["ohlcv", "universe"]
      : sourceId === "nse-corporate-actions"
        ? ["corporate_action"]
        : sourceId === "sec-financial-statement-data-sets" ? ["fundamental"] : ["macro"],
    sourceVersion: "fixture",
    retrievedAt: "2026-07-29T00:00:00.000Z",
    files: [{
      relativePath: relativePath.replaceAll("\\", "/"),
      sourceUrl: `derived:${sourceId}`,
      sha256: hash(body),
      bytes: Buffer.byteLength(body),
      mediaType: "application/x-ndjson",
    }],
    coverage: { start: "2020-01-01", end: "2026-01-01", receivedFiles: 1 },
    normalization: { schemaVersion: "fixture.v1", codeGitSha: "test", status: "valid" },
  });
  const manifestPath = path.join(root, "manifests", `${manifest.datasetId}.json`);
  await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
  await fsp.writeFile(manifestPath, JSON.stringify(manifest));
  return { root, file, manifestPath };
}

describe("local historical evidence resolver", () => {
  it.skipIf(!process.env.KAIROS_EVIDENCE_MANIFEST)(
    "verifies every byte in an operator-bound local manifest",
    async () => {
      const manifest = await verifyLocalEvidenceManifest(
        process.env.KAIROS_EVIDENCE_MANIFEST!,
      );
      expect(manifest.datasetFingerprint).toMatch(/^[0-9a-f]{64}$/);
    },
    120_000,
  );

  it("verifies hashes and emits only requested NSE bars through the as-of date", async () => {
    const body = [
      JSON.stringify({ symbol: "RELIANCE", session_date: "2024-01-02", close: 100 }),
      JSON.stringify({ symbol: "TCS", session_date: "2024-01-02", close: 200 }),
      JSON.stringify({ symbol: "RELIANCE", session_date: "2024-01-03", close: 101 }),
    ].join("\n") + "\n";
    const { manifestPath, file } = await fixture(
      "nse-bhavcopy", "india", "normalized/nse/daily-bars.jsonl", body,
    );
    expect((await loadLocalNsePriceRaws(manifestPath, {
      symbol: "RELIANCE", through: "2024-01-02",
    })).map((row) => row.date)).toEqual(["2024-01-02"]);

    await fsp.appendFile(file, "{}\n");
    await expect(verifyLocalEvidenceManifest(manifestPath)).rejects.toThrow(/Byte-count mismatch|hash mismatch/);
  });

  it("selects the FRED vintage whose realtime interval contains as-of", async () => {
    const body = [
      JSON.stringify({ series_id: "CPIAUCSL", observation_date: "2024-01-01", realtime_start: "2024-02-10", realtime_end: "2024-03-09", value: 100 }),
      JSON.stringify({ series_id: "CPIAUCSL", observation_date: "2024-01-01", realtime_start: "2024-03-10", realtime_end: "9999-12-31", value: 101 }),
      JSON.stringify({ series_id: "CPIAUCSL", observation_date: "2024-03-01", realtime_start: "2024-04-10", realtime_end: "9999-12-31", value: 103 }),
      JSON.stringify({ series_id: "CPIAUCSL", observation_date: "2024-01-01", realtime_start: "2024-02-01", realtime_end: "9999-12-31", value: 999, replay_eligible: false }),
    ].join("\n") + "\n";
    const { manifestPath } = await fixture(
      "fred-alfred", "us", "normalized/fred/CPIAUCSL.jsonl", body,
    );
    const rows = await loadLocalFredMacroRaws(manifestPath, {
      seriesId: "CPIAUCSL",
      asOf: "2024-03-15",
    });
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as { value: number }).value).toBe(101);
    expect(rows[0].realtimeStart).toBe("2024-03-10");
  });

  it("loads NSE actions with a conservative ex-date clock", async () => {
    const body = `${JSON.stringify({
      symbol: "TCS",
      ex_date: "2024-01-19",
      announced_at: null,
      action_type: "dividend",
      amount_inr: 27,
    })}\n`;
    const { manifestPath } = await fixture(
      "nse-corporate-actions",
      "india",
      "normalized/nse-actions/corporate-actions.jsonl",
      body,
    );
    const rows = await loadLocalNseCorporateActionRaws(manifestPath, {
      symbol: "TCS",
      through: "2024-01-20",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      itemType: "corporate_action",
      exDate: "2024-01-19",
      announcedAt: undefined,
    });
  });

  it("loads only SEC facts available by the replay date", async () => {
    const body = [
      JSON.stringify({
        cik: "0000320193",
        metric: "revenue",
        accession: "a",
        period_end: "2023-12-30",
        available_on: "2024-02-03",
        duration_quarters: 1,
        unit: "USD",
        value: 100,
        tag: "RevenueFromContractWithCustomerExcludingAssessedTax",
      }),
      JSON.stringify({
        cik: "0000320193",
        metric: "revenue",
        accession: "a",
        period_end: "2023-12-30",
        available_on: "2024-02-03",
        duration_quarters: 1,
        unit: "USD",
        value: 100,
        tag: "SalesRevenueNet",
      }),
      JSON.stringify({
        cik: "0000320193",
        metric: "revenue",
        accession: "b",
        period_end: "2024-03-30",
        available_on: "2024-05-04",
        duration_quarters: 1,
        unit: "USD",
        value: 110,
        tag: "RevenueFromContractWithCustomerExcludingAssessedTax",
      }),
      JSON.stringify({
        cik: "0000320193", metric: "equity", accession: "c",
        period_end: "2023-12-30", available_on: "2024-02-03",
        duration_quarters: 0, unit: "USD", value: 50,
        tag: "StockholdersEquity",
      }),
      JSON.stringify({
        cik: "0000320193", metric: "equity", accession: "c",
        period_end: "2023-12-30", available_on: "2024-02-03",
        duration_quarters: 0, unit: "USD", value: 55,
        tag: "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
      }),
    ].join("\n") + "\n";
    const { manifestPath } = await fixture(
      "sec-financial-statement-data-sets",
      "us",
      "normalized/sec/primary-statement-facts.jsonl",
      body,
    );
    const rows = await loadLocalSecFundamentalRaws(manifestPath, {
      cik: "320193",
      symbol: "AAPL",
      asOf: "2024-03-01",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      itemType: "fundamental",
      symbol: "AAPL",
      filedAt: "2024-02-03",
    });
    expect((rows[0].payload as { tag: string }).tag).toBe(
      "RevenueFromContractWithCustomerExcludingAssessedTax",
    );
  });
});
