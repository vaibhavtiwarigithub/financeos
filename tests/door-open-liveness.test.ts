import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("supabase/migrations/20261003143635_door_open_liveness_and_evening_coverage.sql", "utf8");

describe("leveraged door open-liveness + evening coverage schedule", () => {
  it("schedules one in-session liveness run per door at 14:35-14:38 UTC on weekdays, well before every entry window", () => {
    for (const [door, minute] of [["soxl", 35], ["tqqq", 36], ["sqqq", 37], ["soxs", 38]] as const) {
      expect(sql).toContain(`'kairos-${door}-open', '${minute} 14 * * 1-5'`);
      expect(sql).toContain(`'/api/agents/${door}/cron'`);
    }
    // 14:35 UTC is market hours in both seasons (10:35 ET EDT / 09:35 ET EST) and < 26 h before Monday's 15:05 UTC window.
    expect(sql).not.toContain("leveraged-live");
  });
  it("runs corporate-action coverage in the evening before the 22:15 UTC ATR collector", () => {
    expect(sql).toContain("'kairos-corporate-action-coverage-us-evening', '35,41,47,53 21 * * 1-5'");
  });
});

describe("L1 leveraged-ETF shadow collector scheduling (0 observations ever: hour-precision Vercel cron missed its 11:00-11:14 ET window)", () => {
  it("answers POST (kairos_call_agent always POSTs) and is scheduled minute-precisely through pg_cron", () => {
    expect(readFileSync("app/api/agents/leveraged-etf-shadow/collect/route.ts", "utf8")).toContain("export const POST = GET;");
    const migration = readFileSync("supabase/migrations/20261003145318_schedule_leveraged_etf_shadow_collector.sql", "utf8");
    expect(migration).toContain("'kairos-leveraged-etf-shadow', '3 15,16 * * 1-5'");
    expect(migration).toContain("'/api/agents/leveraged-etf-shadow/collect'");
  });
});
