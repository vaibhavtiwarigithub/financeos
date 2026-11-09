import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("council cron window consolidation migration", () => {
  const sql = readFileSync("supabase/migrations/20261109123000_consolidate_council_cron_windows.sql", "utf8");

  it("retains the exact union of all existing India and US quarter-hour windows", () => {
    expect(sql).toContain("*/15 4-5,7-8,11-12 * * 1-5");
    expect(sql).toContain("*/15 13-16,18-20,22-23 * * 1-5");
    expect(sql).toContain("*/15 11-12 * * 1-5");
    expect(sql).toContain("*/15 4-5 * * 1-5");
    expect(sql).toContain("*/15 7-8 * * 1-5");
    expect(sql).toContain("*/15 22-23 * * 1-5");
    expect(sql).toContain("*/15 13-16 * * 1-5");
    expect(sql).toContain("*/15 18-20 * * 1-5");
  });

  it("fails closed unless every audited active command and source window matches", () => {
    expect(sql).toContain("command = expected_command");
    expect(sql).toContain("IF matching_rows <> 1 THEN");
    expect(sql).toContain("RAISE EXCEPTION 'Unexpected council schedule");
  });

  it("retains the base per-market job and removes only the four duplicate rows", () => {
    expect(sql).toContain("cron.alter_job(survivor_jobid, schedule := merged_window)");
    expect(sql).toContain("'kairos-council-us-am','kairos-council-us-pm'");
    expect(sql).toContain("'kairos-council-india-am','kairos-council-india-mid'");
    expect(sql).toContain("cron.unschedule(duplicate.jobid)");
    expect(sql).not.toContain("UPDATE cron.job");
  });
});
