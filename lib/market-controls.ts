// Per-market pause / trading-enable state (migration 171), with a GLOBAL
// master-kill fallback so the legacy strategy_config.app_paused /
// trading_enabled switches still stop EVERYTHING.
//
// Semantics (fail-safe):
//   isPaused(svc, market)        = global app_paused === true  OR market row paused === true
//   isTradingEnabled(svc, market)= global trading_enabled !== false AND market row trading_enabled !== false
//
// So a market's own circuit breaker isolates to that market, while the global
// switch (or a missing market row) still behaves as before. All reads/writes use
// the service client; owner UI reads market_controls directly under RLS.

export type Mkt = "us" | "india";

function norm(market?: string | null): Mkt {
  return market === "india" ? "india" : "us";
}

async function readGlobal(svc: any): Promise<{ paused: boolean; trading: boolean }> {
  try {
    const { data } = await svc
      .from("strategy_config")
      .select("app_paused, trading_enabled")
      .limit(1)
      .maybeSingle();
    return {
      paused: (data as any)?.app_paused === true,
      trading: (data as any)?.trading_enabled !== false, // default enabled
    };
  } catch {
    // Fail CLOSED on a read error — a DB blip must not let entries/trades through
    // (matches the money-path gates' original fail-closed behavior).
    return { paused: true, trading: false };
  }
}

async function readMarket(
  svc: any,
  market: Mkt,
): Promise<{ paused: boolean; trading: boolean } | null> {
  try {
    const { data } = await svc
      .from("market_controls")
      .select("paused, trading_enabled")
      .eq("market", market)
      .maybeSingle();
    if (!data) return null;
    return {
      paused: (data as any).paused === true,
      trading: (data as any).trading_enabled !== false,
    };
  } catch {
    return null; // pre-migration / read error → fall back to global only
  }
}

/** True if this market's new-entry pause is active (global master OR market row). */
export async function isPaused(svc: any, market?: string): Promise<boolean> {
  const g = await readGlobal(svc);
  if (g.paused) return true;
  const r = await readMarket(svc, norm(market));
  return r ? r.paused : false;
}

/** True if trading is enabled for this market (global master AND market row). */
export async function isTradingEnabled(svc: any, market?: string): Promise<boolean> {
  const g = await readGlobal(svc);
  if (!g.trading) return false;
  const r = await readMarket(svc, norm(market));
  return r ? r.trading : true;
}

/** Pause / resume NEW ENTRIES for one market (drawdown breaker, manual). */
export async function setMarketPaused(
  svc: any,
  market: string,
  paused: boolean,
  reason?: string,
): Promise<void> {
  const m = norm(market);
  await svc.from("market_controls").upsert(
    {
      market: m,
      paused,
      paused_reason: paused ? (reason ?? null) : null,
      paused_at: paused ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "market" },
  );
}

/** Enable / disable TRADING for one market (kill switch, manual re-enable). */
export async function setMarketTrading(
  svc: any,
  market: string,
  enabled: boolean,
  reason?: string,
): Promise<void> {
  const m = norm(market);
  await svc.from("market_controls").upsert(
    {
      market: m,
      trading_enabled: enabled,
      paused_reason: enabled ? null : (reason ?? null),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "market" },
  );
}
