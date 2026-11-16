import { afterEach, describe, expect, it, vi } from "vitest";

const health = vi.hoisted(() => ({ report: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/system-health", () => ({ reportIssue: health.report, resolveIssue: health.resolve }));
import { measureCloudflareD1Storage } from "./monitor";

const savedUrl = process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_URL;
const savedToken = process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_TOKEN;
afterEach(() => {
  if (savedUrl === undefined) delete process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_URL;
  else process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_URL = savedUrl;
  if (savedToken === undefined) delete process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_TOKEN;
  else process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_TOKEN = savedToken;
  health.report.mockReset(); health.resolve.mockReset();
});

function configure() {
  process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_URL = "https://archive.example";
  process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_TOKEN = "a-long-test-token-with-at-least-32-characters";
}

describe("measureCloudflareD1Storage", () => {
  it("reports size and flags a loading mirror without declaring it healthy", async () => {
    configure();
    const result = await measureCloudflareD1Storage(261678, async (input, init) => {
      expect(String(input)).toBe("https://archive.example/v1/status");
      expect(new Headers(init?.headers).has("Authorization")).toBe(true);
      return Response.json({ dataset: { expected_rows: 261678, verified_rows: 99000, state: "loading",
        mirrorBudgetDay: null, mirrorRowsToday: 0, mirrorRowsDailyLimit: 15000 },
        d1Bytes: 17_715_200, databaseLimitBytes: 500_000_000, remainingDatabaseBytes: 482_284_800,
        r2ObjectCount: 80, r2BytesConservative: 183_503_475, r2BudgetBytes: 8_000_000_000, r2RemainingBytes: 7_816_496_525 });
    });
    expect(result.status).toBe("loading_or_unverified");
    expect(result.rowsComplete).toBe(false);
    expect(health.report).toHaveBeenCalledWith(expect.objectContaining({ issueKey: "cloudflare-d1-archive-storage", severity: "warn" }));
  });

  it("clears the capacity alert only for a complete, low-usage mirror", async () => {
    configure();
    const result = await measureCloudflareD1Storage(261678, async () => Response.json({
      dataset: { expected_rows: 261678, verified_rows: 261678, state: "verified",
        mirrorBudgetDay: "2026-11-16", mirrorRowsToday: 0, mirrorRowsDailyLimit: 15000 },
      d1Bytes: 17_715_200, databaseLimitBytes: 500_000_000, remainingDatabaseBytes: 482_284_800,
      r2ObjectCount: 80, r2BytesConservative: 183_503_475, r2BudgetBytes: 8_000_000_000, r2RemainingBytes: 7_816_496_525,
    }));
    expect(result.status).toBe("healthy");
    expect(result.sourceRowsMatch).toBe(true);
    expect(result.mirrorBudget).toEqual({ utcDay: "2026-11-16", rowsAcceptedToday: 0, rowsDailyLimit: 15000, remainingRowsToday: 15000 });
    expect(health.resolve).toHaveBeenCalledWith("cloudflare-d1-archive-storage");
  });

  it("warns before the D1 live-mirror write budget is exhausted", async () => {
    configure();
    const result = await measureCloudflareD1Storage(261678, async () => Response.json({
      dataset: { expected_rows: 261678, verified_rows: 261678, state: "verified",
        mirrorBudgetDay: "2026-11-16", mirrorRowsToday: 12000, mirrorRowsDailyLimit: 15000 },
      d1Bytes: 17_715_200, databaseLimitBytes: 500_000_000, remainingDatabaseBytes: 482_284_800,
      r2ObjectCount: 80, r2BytesConservative: 183_503_475, r2BudgetBytes: 8_000_000_000, r2RemainingBytes: 7_816_496_525,
    }));
    expect(result.status).toBe("warning");
    expect(health.report).toHaveBeenCalledWith(expect.objectContaining({
      issueKey: "cloudflare-d1-archive-storage", title: "Cloudflare D1 daily mirror-write budget is near its cap",
    }));
  });

  it("fails closed on unreachable or inconsistent capacity reports", async () => {
    configure();
    await expect(measureCloudflareD1Storage(261678, async () => new Response(null, { status: 503 }))).rejects.toThrow("status failed (503)");
    await expect(measureCloudflareD1Storage(261678, async () => Response.json({
      dataset: { expected_rows: 1, verified_rows: 1, state: "verified" },
      d1Bytes: 17_715_200, databaseLimitBytes: 500_000_000, remainingDatabaseBytes: 1,
      r2ObjectCount: 0, r2BytesConservative: 0, r2BudgetBytes: 8_000_000_000, r2RemainingBytes: 0,
    }))).rejects.toThrow("invalid report");
  });

  it("does not call a mirror complete when a committed Supabase row was not mirrored", async () => {
    configure();
    const result = await measureCloudflareD1Storage(261679, async () => Response.json({
      dataset: { expected_rows: 261678, verified_rows: 261678, state: "verified",
        mirrorBudgetDay: "2026-11-16", mirrorRowsToday: 0, mirrorRowsDailyLimit: 15000 },
      d1Bytes: 17_715_200, databaseLimitBytes: 500_000_000, remainingDatabaseBytes: 482_284_800,
      r2ObjectCount: 80, r2BytesConservative: 183_503_475, r2BudgetBytes: 8_000_000_000, r2RemainingBytes: 7_816_496_525,
    }));
    expect(result.status).toBe("loading_or_unverified");
    expect(result.sourceRowsMatch).toBe(false);
    expect(health.report).toHaveBeenCalledWith(expect.objectContaining({
      issueKey: "cloudflare-d1-archive-storage", title: "Cloudflare D1 archive is not fully verified",
    }));
    expect(health.resolve).not.toHaveBeenCalledWith("cloudflare-d1-archive-storage");
  });
});
