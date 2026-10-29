import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Disposable local Supabase integration tests for the autonomous-live money path.
 *
 * These are the "required tests" from the live-auto fix prompt, implemented as
 * REAL integration tests against the live Supabase project — NOT mocks:
 *
 *   Test 1  schema/migration presence  — the live_auto_* strategy_config columns
 *                                         and the reserve_live_order_budget_v2 RPC
 *                                         exist on the target DB (clean-replay proxy).
 *   Test 2  RPC permission matrix       — anon CANNOT call reserve_live_order_budget_v2;
 *                                         service_role CAN.
 *   Test 6  atomic reservation          — two simultaneous reservations that would
 *                                         breach the daily trade cap create only ONE row.
 *
 * ── SAFETY / OPT-IN ────────────────────────────────────────────────────────────
 * The ENTIRE suite is wrapped in `describe.skipIf(!process.env.RUN_DB_INTEGRATION)`.
 * With RUN_DB_INTEGRATION unset (the default, including CI and `npm test`) every
 * test here is SKIPPED — it never touches the DB and never mutates the money path.
 *
 * To run it a developer MUST explicitly opt in by setting BOTH the flag and the
 * Supabase credentials (same env-var names the app itself uses):
 *
 *   RUN_DB_INTEGRATION=1
 *   NEXT_PUBLIC_SUPABASE_URL=...            (lib/supabase/service.ts, client.ts)
 *   SUPABASE_SERVICE_ROLE_KEY=...           (lib/supabase/service.ts)
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY=...       (lib/supabase/client.ts)
 *
 *   RUN_DB_INTEGRATION=1 npx vitest run tests/db-integration.test.ts
 *
 * NOTE ON WRITES: this suite refuses every non-local Supabase URL. The positive
 * paths of Test 2 and Test 6 exercise the real RPC,
 * which inserts durable `broker_orders` reservation rows (`pending_submit`). This
 * RESERVES budget — it does NOT place a broker order (a separate worker submits
 * fills). All test rows use clearly-synthetic, per-run-unique symbols/markets
 * (`__TEST__…`). The concurrency case uses US market semantics to exercise the
 * live BUY cap but runs only against the disposable local database. This is
 * inherent to testing an insert-on-success RPC and is why the suite is opt-in,
 * default-skipped, and hard-blocked from non-local endpoints.
 */

const RUN = !!process.env.RUN_DB_INTEGRATION;

// reserve_live_order_budget_v2 signature (supabase/migrations/143 + 147):
//   p_proposal_id bigint, p_market text, p_broker text, p_broker_env text,
//   p_symbol text, p_side text, p_qty numeric, p_order_type text,
//   p_limit_price numeric, p_estimated_notional numeric, p_currency text,
//   p_max_daily_trades integer, p_max_daily_notional numeric, p_execution_actor text
type ReserveArgs = {
  p_proposal_id: number | null;
  p_market: string;
  p_broker: string;
  p_broker_env: string;
  p_symbol: string;
  p_side: string;
  p_qty: number;
  p_order_type: string;
  p_limit_price: number | null;
  p_estimated_notional: number;
  p_currency: string;
  p_max_daily_trades: number | null;
  p_max_daily_notional: number | null;
  p_execution_actor: string;
};

// A minimal, clearly-synthetic reservation. Overridable per test.
function reserveArgs(overrides: Partial<ReserveArgs> = {}): ReserveArgs {
  return {
    p_proposal_id: null,
    p_market: "us",
    p_broker: "__test__",
    p_broker_env: "paper", // paper => daily caps skipped; not the live money path
    p_symbol: "__TEST__",
    p_side: "sell", // sell => never counts against live BUY daily caps
    p_qty: 1,
    p_order_type: "market",
    p_limit_price: null,
    p_estimated_notional: 0.01, // smallest sensible notional
    p_currency: "USD",
    p_max_daily_trades: null,
    p_max_daily_notional: null,
    p_execution_actor: "owner",
    ...overrides,
  };
}

describe.skipIf(!RUN)("live Supabase DB integration (opt-in: RUN_DB_INTEGRATION=1)", () => {
  let service: SupabaseClient;
  let anon: SupabaseClient;

  beforeAll(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!url || !serviceKey || !anonKey) {
      throw new Error(
        "RUN_DB_INTEGRATION is set but Supabase creds are missing. Provide " +
          "NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and " +
          "NEXT_PUBLIC_SUPABASE_ANON_KEY."
      );
    }

    const hostname = new URL(url).hostname;
    if (hostname !== "localhost" && hostname !== "127.0.0.1") {
      throw new Error(
        "RUN_DB_INTEGRATION is restricted to the disposable local Supabase instance; refusing a non-local URL."
      );
    }

    service = createClient(url, serviceKey, { auth: { persistSession: false } });
    anon = createClient(url, anonKey, { auth: { persistSession: false } });
  });

  // ── Test 1: schema / migration presence (clean-replay proxy) ──────────────────
  describe("Test 1 — schema presence", () => {
    it("strategy_config exposes the live_auto_* control columns", async () => {
      // Selecting the columns is a PostgREST-native presence probe: a missing
      // column yields a PGRST/42703 error. No rows are mutated.
      const { error } = await service
        .from("strategy_config")
        .select(
          [
            "live_auto_enabled",
            "live_auto_enabled_until",
            "live_auto_policy_version",
            "live_auto_daily_cap_usd",
            "live_auto_max_per_order_usd",
            "live_auto_min_evidence_confidence",
            "live_auto_max_open_positions",
            "live_auto_max_orders_per_day",
            "live_auto_mode_us",
            "live_auto_mode_india",
          ].join(",")
        )
        .limit(1);

      expect(error, error ? `column presence probe failed: ${error.message}` : "").toBeNull();
    });

    it("reserve_live_order_budget_v2 RPC exists (invalid-actor guard fires, no insert)", async () => {
      // Passing an invalid execution actor makes the function raise
      // 'invalid_execution_actor' BEFORE any insert. Reaching that error (rather
      // than a 'function does not exist' 404) proves the RPC is present without
      // writing a broker_orders row.
      const { data, error } = await service.rpc(
        "reserve_live_order_budget_v2",
        reserveArgs({ p_execution_actor: "__not_a_real_actor__" })
      );

      expect(data).toBeNull();
      expect(error).toBeTruthy();
      expect(error?.message ?? "").toMatch(/invalid_execution_actor/i);
    });
  });

  // ── Test 2: RPC permission matrix ─────────────────────────────────────────────
  describe("Test 2 — permission matrix", () => {
    it("anon CANNOT call reserve_live_order_budget_v2 (execute revoked)", async () => {
      // Migration 147 REVOKEs EXECUTE from PUBLIC/anon/authenticated. anon must be
      // rejected at the permission layer regardless of arguments — no row inserted.
      const { data, error } = await anon.rpc(
        "reserve_live_order_budget_v2",
        reserveArgs()
      );

      expect(data).toBeNull();
      expect(error).toBeTruthy();
      // PostgREST surfaces a permission-denied / not-exposed error for anon.
      expect(error?.message ?? "").toMatch(
        /permission denied|not.*(exist|expose)|denied|forbidden/i
      );
    });

    it("service_role CAN call it and receives a reservation id (writes 1 synthetic paper row)", async () => {
      // Positive path: service_role is granted EXECUTE. paper env + sell side keep
      // this off the live daily-cap path. This DOES insert one durable synthetic
      // reservation row (documented; inherent to an insert-on-success RPC).
      const { data, error } = await service.rpc(
        "reserve_live_order_budget_v2",
        reserveArgs({ p_symbol: `__TEST__${Date.now()}` })
      );

      expect(error, error ? `service_role reservation failed: ${error.message}` : "").toBeNull();
      expect(typeof data).toBe("number"); // bigint reservation id
    });
  });

  // ── Test 6: atomic concurrent reservation (only ONE row) ──────────────────────
  describe("Test 6 — concurrent reservations are atomic", () => {
    it("two simultaneous over-cap reservations create exactly ONE reservation", async () => {
      // The supported market is required because the RPC validates market/timezone.
      // The disposable database is reset before each CI run, so no prior live
      // reservations exist; US live BUY + cap=1 admits exactly one of these calls.
      const market = "us";
      const args = reserveArgs({
        p_market: market,
        p_broker_env: "live",
        p_side: "buy",
        p_symbol: "__TEST_CONC__",
        p_estimated_notional: 0.01,
        p_max_daily_trades: 1,
        p_max_daily_notional: null,
        p_execution_actor: "autonomous_worker",
      });

      const [a, b] = await Promise.all([
        service.rpc("reserve_live_order_budget_v2", args),
        service.rpc("reserve_live_order_budget_v2", args),
      ]);

      const results = [a, b];
      const succeeded = results.filter((r) => !r.error && r.data != null);
      const failed = results.filter((r) => r.error);

      expect(succeeded.length).toBe(1); // exactly one reservation row created
      expect(failed.length).toBe(1);
      expect(failed[0].error?.message ?? "").toMatch(/daily_trade_limit/i);
    });
  });
});
