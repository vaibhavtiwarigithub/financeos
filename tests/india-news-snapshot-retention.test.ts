import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/20261116163000_verified_india_news_snapshot_retention.sql"), "utf8");
const candidateMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261116180000_india_news_archive_candidate.sql"), "utf8");
const consumer = fs.readFileSync(path.join(root, "app/api/agents/llm-events/route.ts"), "utf8");

describe("India news snapshot cold retention", () => {
  it("keeps the live batch reader inside the seven-day retained window", () => {
    expect(consumer).toContain("const SNAPSHOT_LOOKBACK_DAYS = 7;");
    expect(consumer).toMatch(/from\("india_news_snapshots"\)[\s\S]*?\.gte\("fetched_at", since\)/);
  });

  it("keeps updates blocked and gates deletes behind a bounded exact-cohort RPC", () => {
    expect(migration).toContain("IF TG_OP = 'DELETE' AND current_user = 'postgres' THEN");
    expect(migration).toContain("RAISE EXCEPTION 'india_news_snapshots is append-only outside verified retention'");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("p_expected_rows > 10000");
    expect(migration).toContain("p_cutoff > transaction_timestamp() - interval '7 days'");
    expect(migration).toContain("actual_rows <> p_expected_rows");
    expect(migration).toContain("actual_min_id <> p_expected_min_id");
    expect(migration).toContain("actual_max_id <> p_expected_max_id");
    expect(migration).toContain("actual_digest IS DISTINCT FROM p_expected_digest");
    expect(migration).toContain("DELETE FROM public.india_news_snapshots WHERE fetched_at < p_cutoff");
    expect(migration).toContain("TO service_role");
    expect(migration).toContain("FROM anon, authenticated");
  });

  it("exposes one bounded, ordered candidate snapshot only to the service role", () => {
    expect(candidateMigration).toContain("get_india_news_snapshots_archive_candidate");
    expect(candidateMigration).toContain("p_cutoff > transaction_timestamp() - interval '7 days'");
    expect(candidateMigration).toContain("actual_rows > 10000");
    expect(candidateMigration).toContain("jsonb_agg(row_json ORDER BY id)");
    expect(candidateMigration).toContain("md5(string_agg(md5(row_json::text), '' ORDER BY id))");
    expect(candidateMigration).toContain("TO service_role");
    expect(candidateMigration).toContain("FROM anon, authenticated");
  });
});
