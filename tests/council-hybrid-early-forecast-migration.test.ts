import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("hybrid council per-member forecast persistence migration", () => {
  const sql = readFileSync("supabase/migrations/20261031021326_llm_council_publish_hybrid_member_scores.sql", "utf8");
  const earlyPersistence = sql.slice(sql.indexOf("if b.run_id is not null and b.execution_mode='hybrid'"), sql.indexOf("if exists(select 1 from public.llm_council_jobs where batch_id=b.id and round=stage"));

  it("persists only completed non-debate hybrid member results with their submission timestamp", () => {
    expect(earlyPersistence).toContain("b.debate_rounds=0");
    expect(earlyPersistence).toContain("round=0 and status='completed'");
    expect(earlyPersistence).toContain("j.submitted_at");
    expect(earlyPersistence).toContain("on conflict (run_id,model_requested,execution_source) do nothing");
  });

  it("does not finalize a run or compute consensus before the all-member gate", () => {
    expect(earlyPersistence).not.toContain("update public.llm_council_runs");
    expect(earlyPersistence).not.toContain("percentile_cont");
  });
});
