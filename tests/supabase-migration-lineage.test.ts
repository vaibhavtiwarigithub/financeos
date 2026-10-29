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
});
