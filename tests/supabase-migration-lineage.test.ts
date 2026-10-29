import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

describe("Supabase migration lineage", () => {
  it("has one SQL file per ordered migration version", () => {
    const directory = path.join(process.cwd(), "supabase/migrations");
    const files = readdirSync(directory).filter((file) => file.endsWith(".sql"));
    const versions = files.map((file) => {
      const match = file.match(/^(\d+)_/);
      expect(match, `${file} must begin with a numeric migration version`).not.toBeNull();
      return match![1];
    });

    expect(new Set(versions).size, "duplicate migration version prevents deterministic clean replay")
      .toBe(versions.length);
  });

  it("creates agent_runs before the first migration alters it", () => {
    const directory = path.join(process.cwd(), "supabase/migrations");
    const files = readdirSync(directory)
      .filter((file) => file.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));
    const create = /create\s+table(?:\s+if\s+not\s+exists)?\s+(?:public\.)?agent_runs\b/i;
    const alter = /alter\s+table\s+(?:public\.)?agent_runs\b/i;
    const replay = files.map((file) => readFileSync(path.join(directory, file), "utf8")).join("\n");
    const createAt = replay.search(create);
    const alterAt = replay.search(alter);

    expect(createAt, "fresh replay must include the original agent_runs baseline").toBeGreaterThanOrEqual(0);
    expect(alterAt, "expected the token tracking migration to extend agent_runs").toBeGreaterThanOrEqual(0);
    expect(createAt).toBeLessThan(alterAt);
  });

  it("seeds vault metadata with empty placeholders, never missing secret values", () => {
    const sql = readFileSync(
      path.join(process.cwd(), "supabase/migrations/011_api_key_vault.sql"),
      "utf8",
    );
    expect(sql).toMatch(/insert\s+into\s+api_key_vault\s*\(\s*key_name\s*,\s*key_value\b/i);
    expect(sql).toMatch(/\('ANTHROPIC_API_KEY',\s*''/);
    expect(sql).toMatch(/\('DEEPSEEK_API_KEY',\s*''/);
    expect(sql).toMatch(/\('MASSIVE_API_KEY',\s*''/);
    expect(sql).toMatch(/\('GROQ_API_KEY',\s*''/);
  });

  it("creates the original trade journal contract before mentor migrations reference it", () => {
    const directory = path.join(process.cwd(), "supabase/migrations");
    const files = readdirSync(directory)
      .filter((file) => file.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));
    const replay = files.map((file) => readFileSync(path.join(directory, file), "utf8")).join("\n");
    const createAt = replay.search(/create\s+table(?:\s+if\s+not\s+exists)?\s+(?:public\.)?trade_journal\b/i);
    const referenceAt = replay.search(/references\s+(?:public\.)?trade_journal\s*\(/i);

    expect(createAt, "fresh replay must include the production trade_journal baseline").toBeGreaterThanOrEqual(0);
    expect(referenceAt, "mentor dimension migration must retain its trade journal link").toBeGreaterThanOrEqual(0);
    expect(createAt).toBeLessThan(referenceAt);
    expect(replay).toMatch(/create\s+policy\s+"Users see own journal"[\s\S]*?auth\.uid\(\)\s*=\s*user_id/i);
  });

  it("restores legacy tables required by the early RLS repair migration", () => {
    const directory = path.join(process.cwd(), "supabase/migrations");
    const files = readdirSync(directory)
      .filter((file) => file.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));
    const replay = files.map((file) => readFileSync(path.join(directory, file), "utf8")).join("\n");
    const policyMigrationAt = replay.search(/'agent_memory'[,\s]/i);

    for (const table of ["agent_memory", "agent_alerts", "paper_nav_history", "price_cache", "risk_analytics_cache", "sector_breadth_history", "strategy_config", "trade_log", "trade_queue"]) {
      const createAt = replay.search(new RegExp(`create\\s+table(?:\\s+if\\s+not\\s+exists)?\\s+(?:public\\.)?${table}\\b`, "i"));
      expect(createAt, `fresh replay must include the production ${table} baseline`).toBeGreaterThanOrEqual(0);
      expect(policyMigrationAt, "fresh replay must retain the early cache-policy migration").toBeGreaterThan(createAt);
    }
    expect(replay).toMatch(/primary\s+key\s*\(\s*symbol\s*,\s*date\s*\)/i);
    expect(replay).toMatch(/account_source\s+text\s+not\s+null/i);
  });

  it("restores the production agent_memory baseline before its RLS policy migration", () => {
    const directory = path.join(process.cwd(), "supabase/migrations");
    const files = readdirSync(directory)
      .filter((file) => file.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));
    const replay = files.map((file) => readFileSync(path.join(directory, file), "utf8")).join("\n");
    const createAt = replay.search(/create\s+table\s+if\s+not\s+exists\s+public\.agent_memory\b/i);
    const policiesAt = replay.search(/'agent_memory'[,\s]/i);

    expect(createAt, "fresh replay must include the production agent_memory baseline").toBeGreaterThanOrEqual(0);
    expect(policiesAt, "fresh replay must retain the agent_memory RLS policy migration").toBeGreaterThan(createAt);
    expect(replay).toMatch(/embedding\s+extensions\.vector\s*\(\s*1536\s*\)/i);
    expect(replay).toMatch(/create\s+extension\s+if\s+not\s+exists\s+vector\s+with\s+schema\s+extensions/i);
  });

  it("restores the original agent_alerts schema before later issue-key and RLS migrations", () => {
    const directory = path.join(process.cwd(), "supabase/migrations");
    const files = readdirSync(directory)
      .filter((file) => file.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));
    const replay = files.map((file) => readFileSync(path.join(directory, file), "utf8")).join("\n");
    const createAt = replay.search(/create\s+table\s+if\s+not\s+exists\s+public\.agent_alerts\b/i);
    const issueKeyAt = replay.search(/alter\s+table\s+agent_alerts\s+add\s+column\s+if\s+not\s+exists\s+issue_key/i);
    const finalOwnerPolicyAt = replay.search(/create\s+policy\s+"agent_alerts_owner_read"[\s\S]*?on\s+public\.agent_alerts/i);

    expect(createAt, "fresh replay must include the original agent_alerts baseline").toBeGreaterThanOrEqual(0);
    expect(issueKeyAt, "issue-key migration must extend the baseline table").toBeGreaterThan(createAt);
    expect(finalOwnerPolicyAt, "later owner-scoped RLS policy must remain in the replay").toBeGreaterThan(issueKeyAt);
    expect(replay).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.agent_alerts\s*\([\s\S]*?category\s+text\s+not\s+null[\s\S]*?title\s+text\s+not\s+null/i);
    expect(replay).toMatch(/alerts_resolved_idx\s+on\s+public\.agent_alerts\s*\(\s*resolved\s*,\s*created_at\s+desc\s*\)/i);
  });

  it("restores the sensitive app_settings baseline before the RLS lock-down migration", () => {
    const directory = path.join(process.cwd(), "supabase/migrations");
    const files = readdirSync(directory)
      .filter((file) => file.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));
    const replay = files.map((file) => readFileSync(path.join(directory, file), "utf8")).join("\n");
    const createAt = replay.search(/create\s+table\s+if\s+not\s+exists\s+public\.app_settings\b/i);
    const lockAt = replay.search(/revoke\s+all\s+on\s+table\s+app_settings\s+from\s+anon\s*,\s*authenticated/i);

    expect(createAt, "fresh replay must include the original app_settings baseline").toBeGreaterThanOrEqual(0);
    expect(lockAt, "the sensitive-table lock-down migration must remain present").toBeGreaterThan(createAt);
    expect(replay).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.app_settings\s*\(\s*key\s+text\s+primary\s+key\s*,\s*value\s+text\s+not\s+null\s*,\s*updated_at\s+timestamptz\s+default\s+now\(\)\s*\)/i);
    expect(replay).toMatch(/alter\s+table\s+public\.app_settings\s+enable\s+row\s+level\s+security/i);
  });

  it("restores private live-account snapshots before their grants are revoked", () => {
    const directory = path.join(process.cwd(), "supabase/migrations");
    const files = readdirSync(directory)
      .filter((file) => file.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));
    const replay = files.map((file) => readFileSync(path.join(directory, file), "utf8")).join("\n");
    const createAt = replay.search(/create\s+table\s+if\s+not\s+exists\s+public\.live_account_snapshots\b/i);
    const lockAt = replay.search(/revoke\s+all\s+on\s+table\s+live_account_snapshots\s+from\s+anon\s*,\s*authenticated/i);

    expect(createAt, "fresh replay must include the original live snapshot baseline").toBeGreaterThanOrEqual(0);
    expect(lockAt, "the sensitive-table lock-down migration must remain present").toBeGreaterThan(createAt);
    expect(replay).toMatch(/account_id\s+text\s+not\s+null\s*,\s*equity\s+numeric\s*,\s*buying_power\s+numeric[\s\S]*?positions_json\s+jsonb/i);
    expect(replay).toMatch(/live_account_snapshots_account_id_unique\s+on\s+public\.live_account_snapshots\s*\(\s*account_id\s*\)/i);
    expect(replay).toMatch(/alter\s+table\s+public\.live_account_snapshots\s+enable\s+row\s+level\s+security/i);
    expect(replay).not.toMatch(/account_id\s+text\s+not\s+null\s+default/i);
  });

  it("installs pgvector before the first migration uses its vector type", () => {
    const directory = path.join(process.cwd(), "supabase/migrations");
    const files = readdirSync(directory)
      .filter((file) => file.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));
    const replay = files.map((file) => readFileSync(path.join(directory, file), "utf8")).join("\n");
    const extensionAt = replay.search(/create\s+extension\s+if\s+not\s+exists\s+vector\s+with\s+schema\s+extensions/i);
    const vectorUseAt = replay.search(/\bvector\s*\(\s*1024\s*\)\s+not\s+null/i);

    expect(extensionAt, "fresh replay must install pgvector in its production schema").toBeGreaterThanOrEqual(0);
    expect(vectorUseAt, "trade embedding schema must use the installed vector type").toBeGreaterThanOrEqual(0);
    expect(extensionAt).toBeLessThan(vectorUseAt);
  });

  it("creates scoring range guards with valid PostgreSQL NOT VALID syntax", () => {
    const sql = readFileSync(
      path.join(process.cwd(), "supabase/migrations/136_scoring_p0_schema.sql"),
      "utf8",
    );
    expect(sql).toMatch(/add\s+column\s+if\s+not\s+exists\s+rank_score\s+numeric\s*,[\s\S]*?add\s+column\s+if\s+not\s+exists\s+final_score\s+numeric/i);
    expect(sql).toMatch(/add\s+constraint\s+dobs_rank_score_range[\s\S]*?check\s*\(\s*rank_score[\s\S]*?\)\s+not\s+valid/i);
    expect(sql).toMatch(/add\s+constraint\s+dobs_final_score_range[\s\S]*?check\s*\(\s*final_score[\s\S]*?\)\s+not\s+valid/i);
    expect(sql).toMatch(/add\s+constraint\s+dobs_evidence_confidence_range[\s\S]*?not\s+valid/i);
    expect(sql).toMatch(/add\s+constraint\s+dobs_contradiction_penalty_range[\s\S]*?not\s+valid/i);
    expect(sql).toMatch(/add\s+constraint\s+dobs_p_win_range[\s\S]*?not\s+valid/i);
    expect(sql).not.toMatch(/add\s+column[^;]+check\s*\([^;]+\)\s+not\s+valid/i);
  });

  it("creates the trade-proposal execution index after its columns exist", () => {
    const directory = path.join(process.cwd(), "supabase/migrations");
    const files = readdirSync(directory)
      .filter((file) => file.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));
    const replay = files.map((file) => readFileSync(path.join(directory, file), "utf8")).join("\n");
    const executionColumnAt = replay.search(/add\s+column\s+if\s+not\s+exists\s+execution_mode\s+text/i);
    const indexAt = replay.search(/create\s+index\s+if\s+not\s+exists\s+trade_proposals_market_exec_idx/i);

    expect(executionColumnAt, "fresh replay must create execution_mode before indexing it").toBeGreaterThanOrEqual(0);
    expect(indexAt, "the market/execution index must remain in the migration chain").toBeGreaterThan(executionColumnAt);
    expect(replay).toMatch(/trade_proposals_market_exec_idx\s+on\s+public\.trade_proposals\s*\(\s*market\s*,\s*execution_mode\s*,\s*created_at\s+desc\s*\)/i);
  });

  it("creates the global app pause control before market controls seed from it", () => {
    const directory = path.join(process.cwd(), "supabase/migrations");
    const files = readdirSync(directory)
      .filter((file) => file.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));
    const replay = files.map((file) => readFileSync(path.join(directory, file), "utf8")).join("\n");
    const createAt = replay.search(/app_paused\s+boolean\s+not\s+null\s+default\s+false/i);
    const seedAt = replay.search(/select\s+app_paused\s+from\s+public\.strategy_config/i);

    expect(createAt, "fresh strategy_config must include the global pause master").toBeGreaterThanOrEqual(0);
    expect(seedAt, "market-controls migration must retain its pause-state seed").toBeGreaterThan(createAt);
  });

  it("replays prewarm schedule changes without assuming out-of-band cron rows", () => {
    const directory = path.join(process.cwd(), "supabase/migrations");
    const indiaScheduleFix = readFileSync(
      path.join(directory, "20260714050000_fix_india_prewarm_schedule.sql"),
      "utf8",
    );
    const weekendScheduleFix = readFileSync(
      path.join(directory, "20260714070000_weekend_warming.sql"),
      "utf8",
    );
    const restoration = readFileSync(
      path.join(directory, "20261029170000_restore_evidence_prewarm_crons.sql"),
      "utf8",
    );

    expect(indiaScheduleFix).toMatch(/if\s+v_jobid\s+is\s+not\s+null\s+then[\s\S]*?cron\.alter_job/i);
    expect(weekendScheduleFix).toMatch(/if\s+v_jobid\s+is\s+not\s+null\s+then\s+perform\s+cron\.alter_job/i);
    expect(restoration).toMatch(/if\s+not\s+exists\s*\(\s*select\s+1\s+from\s+cron\.job\s+where\s+jobname\s*=\s*'kairos-prewarm-us'\s*\)[\s\S]*?cron\.schedule/i);
    expect(restoration).toMatch(/if\s+not\s+exists\s*\(\s*select\s+1\s+from\s+cron\.job\s+where\s+jobname\s*=\s*'kairos-prewarm-india'\s*\)[\s\S]*?cron\.schedule/i);
    expect(restoration).toMatch(/kairos-prewarm-us[\s\S]*?2,7,12,17,22,27,32,37,42,47,52,57 12 \* \* \*/i);
    expect(restoration).toMatch(/kairos-prewarm-india[\s\S]*?2,12,22,32,42,52 3 \* \* \*/i);
  });

  it("keeps optional historical RLS helper revocations replay-safe", () => {
    const sql = readFileSync(
      path.join(process.cwd(), "supabase/migrations/20260715120000_security_rls_and_rpc_lockdown.sql"),
      "utf8",
    );
    expect(sql).toMatch(/to_regprocedure\('public\.rls_auto_enable\(\)'\)\s+is\s+not\s+null[\s\S]*?revoke execute on function public\.rls_auto_enable\(\) from anon, authenticated/i);
    expect(sql).toMatch(/to_regprocedure\('public\.rls_auto_enable\(\)'\)\s+is\s+not\s+null[\s\S]*?revoke execute on function public\.rls_auto_enable\(\) from public/i);
  });

  it("creates the paper-performance update timestamp before derived-truth repair uses it", () => {
    const baseline = readFileSync(
      path.join(process.cwd(), "supabase/migrations/003_paper_trading.sql"),
      "utf8",
    );
    const repair = readFileSync(
      path.join(process.cwd(), "supabase/migrations/20260720112631_repair_paper_performance_truth.sql"),
      "utf8",
    );
    expect(baseline).toMatch(/updated_at\s+timestamptz\s+default\s+now\(\)/i);
    expect(repair).toMatch(/updated_at\s*=\s*now\(\)/i);
  });

  it("creates the realized paper-trade return projection before its backfill", () => {
    const baseline = readFileSync(
      path.join(process.cwd(), "supabase/migrations/003_paper_trading.sql"),
      "utf8",
    );
    const backfill = readFileSync(
      path.join(process.cwd(), "supabase/migrations/20260806184656_backfill_paper_trade_realized_pnl_pct.sql"),
      "utf8",
    );
    expect(baseline).toMatch(/realized_pnl_pct\s+numeric/i);
    expect(baseline).toMatch(/exit_at\s+timestamptz/i);
    expect(backfill).toMatch(/set\s+realized_pnl_pct\s*=\s*pnl_pct/i);
    expect(backfill).toMatch(/coalesce\(exit_at,\s*closed_at\)/i);
  });

  it("appends decision-quality diagnostics after the established view columns", () => {
    const migration = readFileSync(
      path.join(process.cwd(), "supabase/migrations/20260817200000_decision_quality_single_source.sql"),
      "utf8",
    );
    const projection = migration.match(/\)\s*select\s+observation_id,([\s\S]*?)\s+from\s+resolved;/i)?.[1] ?? "";
    const establishedColumns = projection.match(/as\s+data_confidence,([\s\S]*?)as\s+confidence_band/i)?.[1] ?? "";
    expect(establishedColumns).toMatch(/as\s+quality_status/i);
    expect(projection.indexOf("AS confidence_band")).toBeGreaterThan(projection.indexOf("AS quality_status"));
    expect(projection.indexOf("       structural_coverage,")).toBeGreaterThan(projection.indexOf("AS confidence_band"));
    expect(projection.indexOf("AS confidence_source")).toBeGreaterThan(projection.indexOf("       structural_coverage,"));
  });

  it("creates archetype IC evidence before its cohort migration", () => {
    const baseline = readFileSync(
      path.join(process.cwd(), "supabase/migrations/003_paper_trading.sql"),
      "utf8",
    );
    const cohortMigration = readFileSync(
      path.join(process.cwd(), "supabase/migrations/20260828163000_archetype_ic_runs_cohort.sql"),
      "utf8",
    );
    expect(baseline).toMatch(/create table if not exists archetype_ic_runs\s*\([\s\S]*?unique\s*\(as_of_date, market, setup_type, horizon_days\)/i);
    expect(baseline).toMatch(/alter table archetype_ic_runs enable row level security/i);
    expect(baseline).toMatch(/create policy archetype_ic_runs_owner_read/i);
    expect(cohortMigration).toMatch(/alter table archetype_ic_runs\s+add column if not exists cohort/i);
  });

  it("creates the paper-trade high-water field before the exit capture migration", () => {
    const baseline = readFileSync(
      path.join(process.cwd(), "supabase/migrations/003_paper_trading.sql"),
      "utf8",
    );
    const migration = readFileSync(
      path.join(process.cwd(), "supabase/migrations/20260911153405_capture_closed_trade_high_water.sql"),
      "utf8",
    );
    expect(baseline).toMatch(/highest_price\s+numeric/i);
    expect(migration).toMatch(/paper_trades[\s\S]*?highest_price/i);
  });

  it("creates entry risk-level fields before the attribution capture migration", () => {
    const baseline = readFileSync(
      path.join(process.cwd(), "supabase/migrations/003_paper_trading.sql"),
      "utf8",
    );
    const migration = readFileSync(
      path.join(process.cwd(), "supabase/migrations/20260927212654_capture_entry_risk_levels_for_attribution.sql"),
      "utf8",
    );
    expect(baseline).toMatch(/stop_loss\s+numeric/i);
    expect(baseline).toMatch(/take_profit\s+numeric/i);
    expect(migration).toMatch(/public\.paper_trades\.stop_loss/i);
    expect(migration).toMatch(/public\.paper_trades\.take_profit/i);
  });

  it("creates the security event ledger before viewer-hardening policies target it", () => {
    const baseline = readFileSync(
      path.join(process.cwd(), "supabase/migrations/037_trader_proposals.sql"),
      "utf8",
    );
    const hardening = readFileSync(
      path.join(process.cwd(), "supabase/migrations/20260914140000_viewer_phase0_close_blanket_rls.sql"),
      "utf8",
    );
    expect(baseline).toMatch(/create table if not exists public\.security_events\s*\([\s\S]*?proposal_id integer references public\.trade_proposals\(id\)/i);
    expect(baseline).toMatch(/severity text not null check \(severity in \('low', 'medium', 'high', 'critical'\)\)/i);
    expect(baseline).toMatch(/alter table public\.security_events enable row level security/i);
    expect(baseline).toMatch(/grant usage, select on sequence public\.security_events_id_seq to service_role/i);
    expect(hardening).toMatch(/create policy "security_events_owner_read" on public\.security_events/i);
  });

  it("wraps the paper plan history table lock and schema changes in one transaction", () => {
    const sql = readFileSync(
      path.join(process.cwd(), "supabase/migrations/20261027150134_paper_position_plan_history.sql"),
      "utf8",
    ).trim();
    expect(sql).toMatch(/^begin\s*;/i);
    expect(sql).toMatch(/set local lock_timeout\s*=\s*'5s'\s*;[\s\S]*?lock table public\.paper_positions in share row exclusive mode/i);
    expect(sql).toMatch(/commit\s*;$/i);
  });

  it("hardens historical trigger helpers only when their untracked baseline exists", () => {
    const sql = readFileSync(
      path.join(process.cwd(), "supabase/migrations/20261027222643_pin_trigger_function_search_paths.sql"),
      "utf8",
    );
    expect(sql).toMatch(/to_regprocedure\('public\.agentic_position_ledger_block_mutation\(\)'\) is not null[\s\S]*?alter function public\.agentic_position_ledger_block_mutation\(\)/i);
    expect(sql).toMatch(/to_regprocedure\('public\.live_exit_ladder_shadow_block_mutation\(\)'\) is not null[\s\S]*?alter function public\.live_exit_ladder_shadow_block_mutation\(\)/i);
    expect(sql).toMatch(/alter function public\.india_news_snapshots_append_only\(\)[\s\S]*?alter function public\.prevent_profile_role_self_change\(\)/i);
  });
});
