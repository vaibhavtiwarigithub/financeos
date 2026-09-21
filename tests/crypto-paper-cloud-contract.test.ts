import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("crypto paper Stage 3 cloud contract", () => {
  it("uses the constrained discovery source separately from native pipeline identity", () => {
    const research = read("app/api/agents/crypto-research-shadow/route.ts");
    expect(research).toContain('source: "screener", score_source: "crypto_native_shadow_v1"');
    expect(research).toContain("cryptoResearchInventory(");
    expect(read("app/api/agents/crypto-paper-trade/route.ts")).toContain("await requireOwner()");
  });
  it("passes a numeric mandate version to the production integer RPC contract", () => {
    const entry = read("app/api/agents/crypto-paper-trade/route.ts");
    expect(entry).toContain("version: 1,");
    expect(entry).not.toContain('version: "crypto-v1-static"');
    expect(entry).toContain("p_mandate_version: CRYPTO_MANDATE.version");
  });
  it("isolates the crypto RPC mandate and refuses source drift", () => {
    const sql = read("supabase/migrations/20260921141353_crypto_paper_fill_contract.sql");
    expect(sql).toContain("contract drift; refusing patch");
    expect(sql).toContain("v_mandate_max_names := 3");
    expect(sql).toContain("s.score_source = ''crypto_native_shadow_v1''");
    expect(sql).toContain("s.analyst_score = p_analyst_score");
    expect(sql).toContain("open_position_exists");
  });
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
