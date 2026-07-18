// webull_trade — runtime enable flag + allowlist reads. All fail CLOSED.
// The flag column `strategy_config.webull_trade_orders_enabled` does NOT exist in
// prod (migration 20260718120000 is written but UNAPPLIED), so ordersEnabled()
// reads an error and returns false today. This is the primary inert switch.

// Read the false-by-default order flag. Any error (column absent, read failure)
// → false. Never throws.
export async function webullTradeOrdersEnabled(svc: any): Promise<boolean> {
  try {
    const { data, error } = await svc
      .from("strategy_config")
      .select("webull_trade_orders_enabled")
      .limit(1)
      .maybeSingle();
    if (error) return false;
    return (data as any)?.webull_trade_orders_enabled === true;
  } catch {
    return false;
  }
}

// Count enabled Webull US trading accounts on the allowlist. The gate ladder
// requires EXACTLY one. Any read error → 0 (fail closed). There are NONE today.
export async function countWebullUsTradingAccounts(svc: any): Promise<number> {
  try {
    const { data, error } = await svc
      .from("broker_accounts")
      .select("account_number")
      .eq("broker", "webull_trade")
      .eq("market", "us")
      .eq("role", "trading");
    if (error) return 0;
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}

// Resolve the single allowlisted account, fail closed on 0 or >1 (ambiguous).
export async function resolveWebullTradingAccount(
  svc: any,
): Promise<{ ok: true; account: string } | { ok: false; error: string }> {
  try {
    const { data, error } = await svc
      .from("broker_accounts")
      .select("account_number, role")
      .eq("broker", "webull_trade")
      .eq("market", "us")
      .eq("role", "trading");
    if (error) return { ok: false, error: `webull_trade allowlist read failed: ${error.message}` };
    const rows = Array.isArray(data) ? data : [];
    if (rows.length !== 1) {
      return { ok: false, error: `expected exactly 1 allowlisted webull_trade US trading account, found ${rows.length}` };
    }
    const account = (rows[0] as any)?.account_number;
    if (!account) return { ok: false, error: "allowlisted webull_trade account has no account_number" };
    return { ok: true, account: String(account) };
  } catch (e) {
    return { ok: false, error: `webull_trade account resolution error: ${String(e)}` };
  }
}
