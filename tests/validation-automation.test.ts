import { describe, expect, it } from "vitest";
import { loadValidationAutomationPolicy } from "@/lib/validation/automation";

function stub(row: any, error: any = null) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: row, error }),
  };
  return { from: () => builder };
}

describe("validation automation policy", () => {
  it("uses the persisted market policy", async () => {
    const policy = await loadValidationAutomationPolicy(stub({
      market: "india", enabled: true, auto_shadow_enabled: true, max_active_shadows: 1,
    }), "india");
    expect(policy).toEqual({ market: "india", enabled: true, auto_shadow_enabled: true, max_active_shadows: 1 });
  });

  it("fails closed when the migration is absent or the policy query fails", async () => {
    const policy = await loadValidationAutomationPolicy(stub(null, { message: "relation missing" }), "us");
    expect(policy.enabled).toBe(false);
    expect(policy.auto_shadow_enabled).toBe(false);
    expect(policy.max_active_shadows).toBe(0);
  });
});
