import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Pins the guarantees that make the forward shadow trustworthy: forward evidence is separated from hindsight by the registered declaration time,
// the definitions in code must match the immutable registry, and the client panel stays free of server-only imports.
const evaluator = readFileSync("app/api/agents/score-variants/evaluate/route.ts", "utf8");
const panel = readFileSync("components/dashboard/ScoreVariantsPanel.tsx", "utf8");
const migration = readFileSync("supabase/migrations/20261014150619_score_variant_shadow.sql", "utf8");

describe("score variant forward shadow wiring", () => {
  it("splits forward from hindsight on the registered declaration time", () => {
    expect(evaluator).toContain("Date.parse(r.ts) >= declaredMs");
    expect(evaluator).toContain("Date.parse(r.ts) < declaredMs");
    expect(evaluator).toContain('sample === "forward" && ev.meetsAdoptionGate');
  });
  it("refuses to run if the code's variants differ from the registered set", () => {
    expect(evaluator).toContain("code variants differ from the registered set");
  });
  it("registers the variants immutably and seeds exactly the three declared ids", () => {
    expect(migration).toContain("score_variant_registry_no_change");
    expect(migration).toContain("llm_event_append_only");
    for (const id of ["fundamental_only", "fundamental_sentiment", "composite_ex_insider"]) expect(migration).toContain(`'${id}'`);
  });
  it("keeps the client panel free of server-only imports", () => {
    const imports = [...panel.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.every((i) => ["react", "lucide-react", "@/lib/market-context"].includes(i))).toBe(true);
  });
});
