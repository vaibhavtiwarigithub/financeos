import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
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
});
