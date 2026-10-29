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
});
