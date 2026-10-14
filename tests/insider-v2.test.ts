import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseForm4Detailed, scoreInsiderV1V2 } from "@/lib/data/insider-v2";

const tx = (code: string, shares: number, price: number) =>
  `<nonDerivativeTransaction><transactionCoding><transactionCode>${code}</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>${shares}</value></transactionShares><transactionPricePerShare><value>${price}</value></transactionPricePerShare></transactionAmounts></nonDerivativeTransaction>`;
const doc = (flag: string | null, ...txns: string[]) => `<ownershipDocument>${flag == null ? "" : `<aff10b5One>${flag}</aff10b5One>`}${txns.join("")}</ownershipDocument>`;

describe("parseForm4Detailed", () => {
  it("reads the filing-level 10b5-1 flag and transactions", () => {
    const f = parseForm4Detailed(doc("true", tx("S", 10, 100), tx("M", 5, 0)));
    expect(f.planned).toBe(true);
    expect(f.txns).toEqual([{ code: "S", value: 1000 }, { code: "M", value: 0 }]);
  });
  it("treats a missing tag as unknown, never as planned or discretionary", () => {
    expect(parseForm4Detailed(doc(null, tx("S", 1, 1))).planned).toBeNull();
    expect(parseForm4Detailed(doc("false", tx("S", 1, 1))).planned).toBe(false);
  });
});

describe("scoreInsiderV1V2", () => {
  const planned = (n: number) => parseForm4Detailed(doc("true", ...Array.from({ length: n }, () => tx("S", 100, 10))));
  it("an issuer that only sells on 10b5-1 plans scores 10 on v1 but v2 is unavailable, not bearish", () => {
    const r = scoreInsiderV1V2([planned(5)]);
    expect(r.v1Available).toBe(true); expect(r.v1Score).toBe(10);
    expect(r.plannedSellCount).toBe(5); expect(r.v2Available).toBe(false); expect(r.v2Score).toBeNull();
  });
  it("v2 counts open-market buys and discretionary sales only", () => {
    const r = scoreInsiderV1V2([planned(4), parseForm4Detailed(doc("false", tx("P", 100, 10), tx("P", 100, 10), tx("S", 100, 10)))]);
    expect(r.v2Available).toBe(true);
    expect(r.v2Score).toBe(Math.round(10 + (2000 / 3000) * 80));
    expect(r.v1Score).toBeLessThan(r.v2Score as number);
  });
  it("sales in filings without the flag are excluded from v2 rather than guessed", () => {
    const r = scoreInsiderV1V2([parseForm4Detailed(doc(null, tx("S", 1, 1), tx("S", 1, 1), tx("S", 1, 1)))]);
    expect(r.unknownSellCount).toBe(3); expect(r.v2Available).toBe(false); expect(r.v1Available).toBe(true);
  });
});

describe("insider v2 shadow wiring", () => {
  const producer = readFileSync("app/api/agents/insider-v2-shadow/route.ts", "utf8");
  const evaluator = readFileSync("app/api/agents/insider-v2-shadow/evaluate/route.ts", "utf8");
  const migration = readFileSync("supabase/migrations/20261014173458_insider_v2_shadow.sql", "utf8");
  it("producer writes only its own table and never touches scoring tables", () => {
    const written = [...producer.matchAll(/from\("([a-z_0-9]+)"\)\s*\.(?:upsert|insert)/g)].map((m) => m[1]);
    expect(new Set(written)).toEqual(new Set(["insider_v2_shadow", "agent_runs"]));
    expect(producer).toContain("behavior changed=false");
  });
  it("evaluator is forward-only and pairs v2 with v1 on the same rows", () => {
    expect(evaluator).toContain('gte("decision_observations.ts"');
    expect(evaluator).toContain("analyst: cand.v1a ? cand.v1 : null");
    expect(evaluator).toContain('sample: "forward"');
  });
  it("shadow table is append-only with RLS, variant is registered immutably", () => {
    expect(migration).toContain("insider_v2_shadow_no_change");
    expect(migration).toContain("enable row level security");
    expect(migration).toContain("'insider_v2_discretionary'");
  });
});
