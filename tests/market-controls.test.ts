import { describe, expect, it, vi } from "vitest";
import { isPaused, isTradingEnabled } from "@/lib/market-controls";

function svc(globalResult: any, marketResult: any) {
  return {
    from(table: string) {
      const result = table === "strategy_config" ? globalResult : marketResult;
      const builder: any = {
        select: () => builder,
        limit: () => builder,
        eq: () => builder,
        maybeSingle: async () => result,
      };
      return builder;
    },
  };
}

describe("market-controls", () => {
  it("fails closed when the global strategy_config read errors", async () => {
    const s = svc(
      { data: null, error: { message: "db unavailable" } },
      { data: { paused: false, trading_enabled: true }, error: null },
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(isPaused(s, "us")).resolves.toBe(true);
    await expect(isTradingEnabled(s, "us")).resolves.toBe(false);
    err.mockRestore();
  });

  it("fails closed when the per-market row read errors or is missing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(isPaused(svc(
      { data: { app_paused: false, trading_enabled: true }, error: null },
      { data: null, error: { message: "rls denied" } },
    ), "india")).resolves.toBe(true);
    await expect(isTradingEnabled(svc(
      { data: { app_paused: false, trading_enabled: true }, error: null },
      { data: null, error: null },
    ), "india")).resolves.toBe(false);
    err.mockRestore();
  });
});
