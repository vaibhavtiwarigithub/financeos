import { describe, expect, it } from "vitest";
import { resolveDisplayWeights } from "./champion-weights";

function chain(result: { data: unknown; error: unknown }) {
  const q: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit"]) {
    q[method] = () => q;
  }
  q.maybeSingle = async () => result;
  return q;
}

describe("resolveDisplayWeights", () => {
  it("fails closed to the profile baseline when the market-scoped champion query fails", async () => {
    let championQueries = 0;
    const svc = {
      from(table: string) {
        if (table === "strategy_versions") {
          championQueries++;
          return chain({ data: null, error: { message: "schema mismatch" } });
        }
        return chain({ data: { risk_profile: "conservative" }, error: null });
      },
    };

    const result = await resolveDisplayWeights(svc as never, "india");

    expect(championQueries).toBe(1);
    expect(result.source).toBe("risk_profile_baseline");
    expect(result.fundamental_weight).toBe(0.4);
    expect(result.version).toBeNull();
  });

  it("uses only the requested market champion snapshot", async () => {
    const svc = {
      from(table: string) {
        if (table === "strategy_versions") {
          return chain({
            data: {
              version: "india-v2",
              promoted_at: "2026-07-15T00:00:00Z",
              weights_snapshot: {
                fundamental_weight: 0.22,
                technical_weight: 0.31,
                sentiment_weight: 0.2,
                macro_weight: 0.17,
                insider_weight: 0.1,
              },
            },
            error: null,
          });
        }
        return chain({ data: { risk_profile: "balanced" }, error: null });
      },
    };

    const result = await resolveDisplayWeights(svc as never, "india");

    expect(result.source).toBe("market_champion");
    expect(result.version).toBe("india-v2");
    expect(result.technical_weight).toBe(0.31);
  });
});
