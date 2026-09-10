import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// THE DEFECT THIS GUARDS.
//
// discovery_snapshot_members.discovery_source is constrained to a fixed list in
// SQL, and SymbolEntry.discovery_source is a TypeScript union. They are two
// copies of the same set, and they have now drifted twice:
//
//   2026-08-01  edge_relative_strength added in code, constraint fixed after.
//   2026-09-04  Crypto Watch Stage 2 added crypto_basket in code; the constraint
//               was NOT updated until 2026-09-10.
//
// The second one ran for six days. Every member of a research run is written in
// ONE insert, so the rejected crypto rows discarded the WHOLE batch: US research
// runs recorded no discovery provenance at all, and Miss Review could not
// reconstruct which symbols were admitted. The ledger is fail-soft, so nothing
// broke loudly — it just silently stopped recording, surfacing only as the
// recurring `research-discovery-ledger:us` warn.
//
// Adding a discovery source must now fail this test until the migration exists.

const agent = readFileSync(join(process.cwd(), "lib/research-agent.ts"), "utf8");

/**
 * The DiscoverySource union, read from its declaration.
 *
 * Comments are stripped BEFORE looking for the terminating semicolon: one of the
 * trailing comments contains a literal ";" ("...EdgeScout candidate; admission
 * only"), which truncated a naive scan and silently dropped the last member.
 */
function unionMembers(): string[] {
  const start = agent.indexOf("export type DiscoverySource =");
  expect(start, "DiscoverySource declaration not found").toBeGreaterThan(-1);
  const uncommented = agent.slice(start, start + 4000).replace(/\/\/[^\n]*/g, "");
  const decl = uncommented.slice(0, uncommented.indexOf(";"));
  return [...decl.matchAll(/"([a-z_]+)"/g)].map(m => m[1]).sort();
}

/**
 * The allowed list from the LATEST migration that redefines the constraint.
 * Migrations are applied in filename order, so the last one wins.
 */
function constraintMembers(): string[] {
  const dir = join(process.cwd(), "supabase/migrations");
  const relevant = readdirSync(dir)
    .filter(f => f.endsWith(".sql"))
    .sort()
    .filter(f => readFileSync(join(dir, f), "utf8").includes("discovery_snapshot_members_discovery_source_check"));
  expect(relevant.length, "no migration defines the constraint").toBeGreaterThan(0);

  const sql = readFileSync(join(dir, relevant[relevant.length - 1]), "utf8");
  const addIdx = sql.lastIndexOf("add constraint");
  const body = sql.slice(addIdx);
  const inList = body.slice(body.indexOf("in ("), body.indexOf("))"));
  return [...inList.matchAll(/'([a-z_]+)'/g)].map(m => m[1]).sort();
}

describe("DiscoverySource union and the SQL check constraint stay in sync", () => {
  it("every code value is permitted by the constraint", () => {
    const code = unionMembers();
    const sql = constraintMembers();
    const missing = code.filter(v => !sql.includes(v));
    expect(
      missing,
      `These discovery_source values exist in lib/research-agent.ts but the check ` +
      `constraint rejects them, so the ENTIRE run's ledger insert will fail: ` +
      `${missing.join(", ")}. Add a migration redefining ` +
      `discovery_snapshot_members_discovery_source_check.`,
    ).toEqual([]);
  });

  it("the constraint permits nothing the code cannot produce", () => {
    const code = unionMembers();
    const sql = constraintMembers();
    const extra = sql.filter(v => !code.includes(v));
    expect(
      extra,
      `The constraint allows values no longer in DiscoverySource: ${extra.join(", ")}. ` +
      `Either restore them in code or tighten the constraint.`,
    ).toEqual([]);
  });

  it("crypto_basket specifically is allowed (the 2026-09-04 regression)", () => {
    expect(unionMembers()).toContain("crypto_basket");
    expect(constraintMembers()).toContain("crypto_basket");
  });

  it("the set is non-trivial, so a parse failure cannot pass silently", () => {
    expect(unionMembers().length).toBeGreaterThanOrEqual(10);
    expect(constraintMembers().length).toBeGreaterThanOrEqual(10);
  });
});
