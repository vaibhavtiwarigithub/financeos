import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("crypto paper Stage 3 cloud contract", () => {
  it("schedules both crypto jobs through the existing Vault-backed pg_cron bridge", () => {
    const migration = read("supabase/migrations/20260916020000_crypto_paper_pool.sql");
    expect(migration).toContain("kairos-crypto-paper-trade");
    expect(migration).toContain("kairos-crypto-position-monitor");
    expect(migration).toContain("/api/agents/crypto-paper-trade");
    expect(migration).toContain("/api/agents/crypto-position-monitor");
    expect(migration).toContain("public.kairos_call_agent");
  });

  it("keeps local agent runner free of crypto production jobs", () => {
    expect(read("scripts/run-agents.ps1")).not.toMatch(/^\s*"crypto-(paper-trade|position-monitor)"\s*=/m);
  });

  it("does not permit a clock exit in the crypto monitor", () => {
    const monitor = read("app/api/agents/crypto-position-monitor/route.ts");
    expect(monitor).not.toContain("time_stop");
    expect(monitor).toContain("lowPrice: candle.low");
    expect(monitor).toContain("highPrice: candle.high");
  });

  it("fails closed when a fill or exit would use an older daily candle", () => {
    const entry = read("app/api/agents/crypto-paper-trade/route.ts");
    const monitor = read("app/api/agents/crypto-position-monitor/route.ts");
    expect(entry).toContain("last.date !== cryptoSessionDate()");
    expect(monitor).toContain("candle.date !== cryptoSessionDate()");
  });

  it("cannot create a crypto paper fill from the legacy equity-score ledger", () => {
    const entry = read("app/api/agents/crypto-paper-trade/route.ts");
    expect(entry).toContain("const CRYPTO_NATIVE_PAPER_READY = false");
    expect(entry).toContain("crypto_native_paper_execution_evidence_pending");
  });
});
