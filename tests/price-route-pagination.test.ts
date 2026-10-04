import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("viewer price route reads every stored bar (PostgREST caps one response at 1,000 rows)", () => {
  const src = readFileSync("app/api/research/price/route.ts", "utf8");
  it("paginates instead of a single limit(2500) read", () => {
    expect(src).toContain("fetchAllRows(");
    expect(src).not.toContain(".limit(2500)");
  });
});
