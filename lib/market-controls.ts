// Per-market pause / trading-enable state (migration 171), with a GLOBAL
// master-kill fallback so the legacy strategy_config.app_paused /
// trading_enabled switches still stop everything.
//
// Semantics (fail-safe):
//   isPaused(svc, market)         = global app_paused === true OR market row paused === true
//   isTradingEnabled(svc, market) = global trading_enabled !== false AND market row trading_enabled !== false
//
// Missing rows and read errors fail closed. A DB/API blip must block new entries
// and live orders, not permit them.

export type Mkt = "us" | "india";

function norm(market?: string | null): Mkt {
  return market === "india" ? "india" : "us";
}

async function readGlobal(svc: any): Promise<{ paused: boolean; trading: boolean }> {
  try {
    const { data, error } = await svc
      .from("strategy_config")
      .select("app_paused, trading_enabled")
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error(`[market-controls] strategy_config read failed; fail-closed: ${error.message}`);
      return { paused: true, trading: false };
    }
    return {
      paused: (data as any)?.app_paused === true,
      trading: (data as any)?.trading_enabled !== false,
    };
  } catch {
    return { paused: true, trading: false };
  }
}

async function readMarket(
  svc: any,
  market: Mkt,
): Promise<{ paused: boolean; trading: boolean }> {
  try {
    const { data, error } = await svc
      .from("market_controls")
      .select("paused, trading_enabled")
      .eq("market", market)
      .maybeSingle();
    if (error) {
      console.error(`[market-controls] market_controls(${market}) read failed; fail-closed: ${error.message}`);
      return { paused: true, trading: false };
    }
    if (!data) {
      console.error(`[market-controls] market_controls(${market}) row missing; fail-closed`);
      return { paused: true, trading: false };
    }
    return {
      paused: (data as any).paused === true,
      trading: (data as any).trading_enabled !== false,
    };
  } catch {
    return { paused: true, trading: false };
  }
}

/** True if this market's new-entry pause is active (global master OR market row). */
export async function isPaused(svc: any, market?: string): Promise<boolean> {
  const g = await readGlobal(svc);
  if (g.paused) return true;
  const r = await readMarket(svc, norm(market));
  return r.paused;
}

/** True if trading is enabled for this market (global master AND market row). */
export async function isTradingEnabled(svc: any, market?: string): Promise<boolean> {
  const g = await readGlobal(svc);
  if (!g.trading) return false;
  const r = await readMarket(svc, norm(market));
  return r.trading;
}

/** Pause / resume NEW ENTRIES for one market (drawdown breaker, manual). */
export async function setMarketPaused(
  svc: any,
  market: string,
  paused: boolean,
  reason?: string,
): Promise<void> {
  const m = norm(market);
  const { error } = await svc.from("market_controls").upsert(
    {
      market: m,
      paused,
      paused_reason: paused ? (reason ?? null) : null,
      paused_at: paused ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "market" },
  );
  if (error) throw new Error(`market_controls(${m}) pause write failed: ${error.message}`);
}

/** Enable / disable TRADING for one market (kill switch, manual re-enable). */
export async function setMarketTrading(
  svc: any,
  market: string,
  enabled: boolean,
  reason?: string,
): Promise<void> {
  const m = norm(market);
  const { error } = await svc.from("market_controls").upsert(
    {
      market: m,
      trading_enabled: enabled,
      paused_reason: enabled ? null : (reason ?? null),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "market" },
  );
  if (error) throw new Error(`market_controls(${m}) trading write failed: ${error.message}`);
}
