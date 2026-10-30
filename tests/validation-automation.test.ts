import { describe, expect, it } from "vitest";
import { activateValidatedShadow, loadValidationAutomationPolicy } from "@/lib/validation/automation";

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
      market: "india", enabled: true, auto_shadow_enabled: true, auto_promote_enabled: true, max_active_shadows: 1,
    }), "india");
    expect(policy).toEqual({ market: "india", enabled: true, auto_shadow_enabled: true, auto_promote_enabled: true, max_active_shadows: 1 });
  });

  it("fails closed when the policy row is absent", async () => {
    const policy = await loadValidationAutomationPolicy(stub(null), "us");
    expect(policy.enabled).toBe(false);
    expect(policy.auto_shadow_enabled).toBe(false);
    expect(policy.auto_promote_enabled).toBe(false);
    expect(policy.max_active_shadows).toBe(0);
  });

  it("surfaces a policy read error so the scheduled producer cannot look healthy", async () => {
    await expect(loadValidationAutomationPolicy(stub(null, { message: "relation missing" }), "us"))
      .rejects.toThrow("validation automation policy read failed: relation missing");
  });

  it("retries a passed challenger through the existing shadow RPC after capacity frees", async () => {
    const rows: Record<string, any>[] = [
      { market: "us", enabled: true, auto_shadow_enabled: true, auto_promote_enabled: true, max_active_shadows: 1 },
      { id: 7, market: "us", state: "challenger", validation_experiment_id: 41 },
      { passed: true },
    ];
    let rpcArgs: unknown;
    const supabase = {
      from(table: string) {
        const builder: any = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: rows.shift(), error: null }),
        };
        return builder;
      },
      rpc: async (name: string, args: unknown) => {
        expect(name).toBe("activate_strategy_shadow");
        rpcArgs = args;
        return { data: { activated: false, reason: "shadow_capacity_reached" }, error: null };
      },
    };

    await expect(activateValidatedShadow(supabase, { market: "us", challengerId: 7 }))
      .resolves.toEqual({ activated: false, reason: "shadow_capacity_reached" });
    expect(rpcArgs).toEqual({ p_version_id: 7 });
  });

  it("does not call the shadow transition for an unvalidated or failed candidate", async () => {
    const rows: Record<string, any>[] = [
      { market: "india", enabled: true, auto_shadow_enabled: true, auto_promote_enabled: true, max_active_shadows: 1 },
      { id: 8, market: "india", state: "challenger", validation_experiment_id: 42 },
      { passed: false },
    ];
    let rpcCalled = false;
    const supabase = {
      from() {
        const builder: any = { select: () => builder, eq: () => builder, maybeSingle: async () => ({ data: rows.shift(), error: null }) };
        return builder;
      },
      rpc: async () => { rpcCalled = true; return { data: null, error: null }; },
    };
    await expect(activateValidatedShadow(supabase, { market: "india", challengerId: 8 }))
      .resolves.toEqual({ activated: false, reason: "validation_not_passed" });
    expect(rpcCalled).toBe(false);
  });
});
