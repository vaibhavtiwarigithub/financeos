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

  it("runs crypto paper entry every calendar day after the UTC research session", () => {
    const schedule = read("supabase/migrations/20260918015027_crypto_paper_daily_schedule.sql");
    expect(schedule).toContain("'45 0 * * *'");
    expect(schedule).toContain("cron.unschedule('kairos-crypto-paper-trade')");
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

  it("runs the approved paper lifecycle without a manual native-readiness hard-off", () => {
    const entry = read("app/api/agents/crypto-paper-trade/route.ts");
    expect(entry).not.toContain("CRYPTO_NATIVE_PAPER_READY");
    expect(entry).not.toContain("crypto_native_paper_execution_evidence_pending");
    expect(entry).toContain("fetchCryptoCandles(symbol, avKey ?? \"\")");
  });
});
