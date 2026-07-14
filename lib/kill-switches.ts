// §4 kill-switch checks from Agent Knowledge Doctrine v1
// Call checkKillSwitches() before any paper or live trade execution.
//
// The book/market are EXPLICIT (P0-1): the caller declares whether this is a
// paper or a live check and, for live, the exact resolved trading account.
// Mode is NOT inferred from live_auto_enabled any more — an L3 manual-live order
// (live_auto_enabled=false) must still measure real live NAV, not paper NAV.
//
//   checkKillSwitches(svc, { market, book: "paper" | "live", accountId? })
//
// Live path: reads live_account_snapshots for the given account. Fail-closed for
// BUY (risk increase) when the account is missing, has no snapshots, or the newest
// snapshot is stale. A tripped drawdown/daily-loss/accuracy switch blocks BUY but
// NOT a risk-reducing SELL — the caller still verifies held quantity separately.
// Live NAV is measured against that account's own history (its snapshot peak), not
// a static START_NAV, so a small real account is not measured against $10k.

import { DEFAULT_KILL_SWITCH_DIALS } from "@/lib/risk-profiles";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import { setMarketTrading } from "@/lib/market-controls";

export type TradingBook = "paper" | "live";

export interface KillSwitchContext {
  market: string;
  book: TradingBook;
  /** Resolved live trading account. Optional — falls back to
   *  strategy_config.active_account_{market} when omitted (live book only). */
  accountId?: string;
}

export interface KillSwitchResult {
  /** Risk-INCREASE (BUY / new exposure) allowed. */
  safe: boolean;
  /** Risk-REDUCTION (a verified held SELL) allowed. Only a hard/security lock or
   *  paper trip clears this; a live drawdown/loss/accuracy trip leaves it true. */
  sellAllowed: boolean;
  reason?: string;
  tripped?: "daily_loss" | "accuracy" | "drawdown" | "stale_snapshot" | "no_baseline";
}

// Paper starting NAV only. NOT used for the live path (see getLiveNavSeries).
const START_NAV: Record<string, number> = { us: 10000, india: 1000000 };

// A live NAV snapshot older than this fails closed for BUY. Documented, env-tunable.
// Default 6h: recent enough that intraday NAV is trustworthy for a backstop check,
// loose enough not to block on a sync cadence measured in hours. A stale snapshot
// only blocks BUY — a risk-reducing SELL is never blocked on freshness.
const LIVE_SNAPSHOT_MAX_AGE_MS =
  Number(process.env.KS_LIVE_SNAPSHOT_MAX_AGE_MS) || 6 * 60 * 60 * 1000;

// Minimum closed-trade sample before the accuracy kill switch may trip. Below
// this, win-rate is statistical noise (5 trades at 20% = one loss) and halting a
// market on it is a false alarm — India tripped at exactly 5. Matches the locked
// "10+ closed trades before Phase 1" rule. Drawdown/daily-loss brakes are
// unaffected; this ONLY governs the accuracy gate's validity.
const MIN_ACCURACY_SAMPLE = 10;

// Per-market scope helper for paper tables (pre-057 fallback: no market column → unscoped).
async function scoped(q: any, market: string): Promise<any> {
  const r = await q.eq("market", market);
  if (r.error) return await q;
  return r;
}

// ── Live data helpers ────────────────────────────────────────────────────────

type LiveNavSeries = {
  current: number;
  yesterday: number | null;
  /** Peak from this account's OWN 90-day snapshot history. No START_NAV floor —
   *  a real $36 account must not be measured against a static $10k peak. */
  peak90: number;
  /** Timestamp of the newest snapshot, for the freshness gate. */
  newestAt: number;
};

async function getLiveNavSeries(
  supabase: any,
  accountId: string,
  market: string,
): Promise<LiveNavSeries | null> {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { data: snaps } = await supabase
    .from("live_account_snapshots")
    .select("equity, portfolio_value, captured_at")
    .eq("account_id", accountId)
    .gte("captured_at", since)
    .order("captured_at", { ascending: false });

  if (!snaps || snaps.length === 0) return null;

  const nav = (s: any): number =>
    Number(s.equity ?? s.portfolio_value ?? 0);
  const current = nav(snaps[0]);
  if (!Number.isFinite(current) || current <= 0) return null;

  const newestAt = new Date((snaps[0] as any).captured_at as string).getTime();
  if (!Number.isFinite(newestAt)) return null;

  const zone = market === "india" ? "Asia/Kolkata" : "America/New_York";
  const localDate = (value: string | number) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date(value));
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  };
  const currentTradingDate = localDate((snaps[0] as any).captured_at);
  const yesterdaySnap = (snaps as any[]).find(
    (s: any) => localDate(s.captured_at) < currentTradingDate,
  );
  const yesterday = yesterdaySnap ? nav(yesterdaySnap) : null;

  // Peak from actual account navs only — this account's own high-water mark.
  const navs = (snaps as any[]).map(nav).filter((n) => Number.isFinite(n) && n > 0);
  const peak90 = navs.length > 0 ? Math.max(...navs) : current;

  return { current, yesterday, peak90, newestAt };
}

// Estimate live trade accuracy from broker_orders filled pairs.
// Approximation: most recent prior BUY avg_fill_price vs SELL avg_fill_price.
// Returns null when fewer than 5 countable pairs exist.
async function getLiveAccuracy(
  supabase: any,
  market: string,
): Promise<{ wins: number; total: number } | null> {
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: sells } = await supabase
    .from("broker_orders")
    .select("symbol, avg_fill_price, created_at")
    .eq("market", market)
    .eq("broker_env", "live")
    .eq("side", "sell")
    .eq("status", "filled")
    .gte("created_at", since30);

  if (!sells || (sells as any[]).length < 5) return null;

  const symbols = [...new Set((sells as any[]).map((s: any) => s.symbol as string))];
  const since180 = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
  const { data: buys } = await supabase
    .from("broker_orders")
    .select("symbol, avg_fill_price, created_at")
    .eq("market", market)
    .eq("broker_env", "live")
    .eq("side", "buy")
    .eq("status", "filled")
    .in("symbol", symbols)
    .gte("created_at", since180);

  const buysBySymbol: Record<string, any[]> = {};
  for (const b of (buys ?? []) as any[]) {
    (buysBySymbol[b.symbol] ??= []).push(b);
  }

  let wins = 0;
  let counted = 0;
  for (const sell of (sells as any[])) {
    const prior = (buysBySymbol[sell.symbol] ?? [])
      .filter((b: any) => b.created_at < sell.created_at)
      .sort((a: any, b: any) =>
        (b.created_at as string).localeCompare(a.created_at),
      )[0];
    if (!prior) continue;
    counted++;
    if (Number(sell.avg_fill_price) > Number(prior.avg_fill_price)) wins++;
  }

  return counted >= MIN_ACCURACY_SAMPLE ? { wins, total: counted } : null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function checkKillSwitches(
  supabase: any,
  ctx: KillSwitchContext | string = "us",
): Promise<KillSwitchResult> {
  // Back-compat shim: a bare market string is treated as a PAPER check. Every
  // live caller MUST pass the explicit object form with book:"live".
  const { market, book, accountId }: KillSwitchContext =
    typeof ctx === "string"
      ? { market: ctx, book: "paper" }
      : ctx;
  const isLive = book === "live";
  const startNav = START_NAV[market] ?? 10000;

  const { data: cfg } = await supabase
    .from("strategy_config")
    .select(
      "ks_daily_loss_pct, ks_drawdown_pct, ks_accuracy_pct, active_account_us, active_account_india",
    )
    .maybeSingle();

  const rawDailyLoss = Number(cfg?.ks_daily_loss_pct);
  const rawDrawdown = Number(cfg?.ks_drawdown_pct);
  const rawAccuracy = Number(cfg?.ks_accuracy_pct);
  const dailyLossLimit =
    Number.isFinite(rawDailyLoss) && rawDailyLoss !== 0
      ? rawDailyLoss
      : DEFAULT_KILL_SWITCH_DIALS.ks_daily_loss_pct;
  const drawdownLimit =
    Number.isFinite(rawDrawdown) && rawDrawdown !== 0
      ? rawDrawdown
      : DEFAULT_KILL_SWITCH_DIALS.ks_drawdown_pct;
  const accuracyLimit =
    Number.isFinite(rawAccuracy) && rawAccuracy !== 0
      ? rawAccuracy
      : DEFAULT_KILL_SWITCH_DIALS.ks_accuracy_pct;

  // Live account: explicit accountId wins; else fall back to the market's
  // configured active account (keeps sync/autonomous callers simple).
  const activeAccount: string | null = isLive
    ? (accountId ??
       (market === "india"
         ? (cfg?.active_account_india ?? null)
         : (cfg?.active_account_us ?? null)))
    : null;

  // ── Collect metrics (live vs paper path) ──────────────────────────────────
  let nav: number;
  let yesterday: number | null = null;
  let peak: number | null = null;
  let accuracyData: { wins: number; total: number } | null = null;

  if (isLive) {
    // Live path: read from live_account_snapshots + broker_orders fills.
    // Fail-closed for BUY (risk increase) on any of: no account, no snapshot,
    // stale snapshot. A SELL (risk reduction) is NEVER blocked by these — the
    // caller still verifies exact held quantity separately.
    if (!activeAccount) {
      return {
        safe: false,
        sellAllowed: true,
        tripped: "no_baseline",
        reason: `No live account configured for ${market.toUpperCase()} — BUY fail-closed. Set active_account_${market} before live trading. (SELL still permitted with held-qty verification.)`,
      };
    }
    const liveSeries = await getLiveNavSeries(supabase, activeAccount, market);
    if (!liveSeries) {
      return {
        safe: false,
        sellAllowed: true,
        tripped: "no_baseline",
        reason:
          "No live account snapshots found — BUY fail-closed. Run broker sync (/api/broker/orders/sync) to seed live NAV. (SELL still permitted with held-qty verification.)",
      };
    }
    const ageMs = Date.now() - liveSeries.newestAt;
    if (ageMs > LIVE_SNAPSHOT_MAX_AGE_MS) {
      return {
        safe: false,
        sellAllowed: true,
        tripped: "stale_snapshot",
        reason: `Live NAV snapshot is ${(ageMs / 3.6e6).toFixed(1)}h old (max ${(LIVE_SNAPSHOT_MAX_AGE_MS / 3.6e6).toFixed(1)}h) — BUY fail-closed until broker sync refreshes it. (SELL still permitted with held-qty verification.)`,
      };
    }
    nav = liveSeries.current;
    yesterday = liveSeries.yesterday;
    peak = liveSeries.peak90;
    accuracyData = await getLiveAccuracy(supabase, market);
  } else {
    // Paper path (original): paper_portfolio, paper_performance, paper_trades.
    const [{ data: portfolio }, { data: recentPerf }, { data: closedTrades }] =
      await Promise.all([
        supabase
          .from("paper_portfolio")
          .select("nav, updated_at")
          .eq("market", market)
          .limit(1)
          .maybeSingle(),
        scoped(
          supabase
            .from("paper_performance")
            .select("date, nav, market")
            .order("date", { ascending: true })
            .limit(90),
          market,
        ),
        scoped(
          supabase
            .from("paper_trades")
            .select("outcome, executed_at, realized_pnl, market")
            .not("outcome", "is", null)
            .gte(
              "executed_at",
              new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
            ),
          market,
        ),
      ]);

    nav = portfolio?.nav ?? startNav;

    const today = new Date().toISOString().slice(0, 10);
    const perfArr: any[] = recentPerf ?? [];
    yesterday = perfArr.filter((p) => p.date < today).at(-1)?.nav ?? null;

    const navHistory = perfArr.map((p: any) => p.nav as number);
    peak =
      navHistory.length > 0 ? Math.max(...navHistory, startNav) : null;

    if (closedTrades && (closedTrades as any[]).length >= MIN_ACCURACY_SAMPLE) {
      const wins = (closedTrades as any[]).filter(
        (t) => t.outcome === "win",
      ).length;
      accuracyData = { wins, total: (closedTrades as any[]).length };
    }
  }

  // A live risk-switch trip halts NEW exposure (BUY) but must not block a
  // risk-reducing SELL. A paper trip blocks both (paper sim has no such carve-out).
  const sellAllowedOnTrip = isLive;

  // ── Kill switch 1: single-day loss beyond threshold ───────────────────────
  if (yesterday !== null && Number.isFinite(yesterday) && yesterday > 0) {
    const dailyLossPct = ((nav - yesterday) / yesterday) * 100;
    if (dailyLossPct < dailyLossLimit) {
      await disableTrading(
        supabase,
        market,
        `Daily loss ${dailyLossPct.toFixed(1)}% exceeds ${dailyLossLimit}% threshold`,
      );
      return {
        safe: false,
        sellAllowed: sellAllowedOnTrip,
        tripped: "daily_loss",
        reason: `Daily loss ${dailyLossPct.toFixed(1)}% > ${dailyLossLimit}%`,
      };
    }
  }

  // ── Kill switch 2: 30-day accuracy below threshold ────────────────────────
  // Requires a statistically meaningful sample; below MIN_ACCURACY_SAMPLE the
  // gate stays silent (accuracyData is already null under the floor, this is a
  // defensive belt-and-suspenders check).
  if (accuracyData && accuracyData.total >= MIN_ACCURACY_SAMPLE) {
    const accuracy = (accuracyData.wins / accuracyData.total) * 100;
    if (accuracy < accuracyLimit) {
      await disableTrading(
        supabase,
        market,
        `30-day accuracy ${accuracy.toFixed(0)}% below ${accuracyLimit}% threshold`,
      );
      return {
        safe: false,
        sellAllowed: sellAllowedOnTrip,
        tripped: "accuracy",
        reason: `30d accuracy ${accuracy.toFixed(0)}% < ${accuracyLimit}% (${accuracyData.total} trades)`,
      };
    }
  }

  // ── Kill switch 3: drawdown from 90-day peak ──────────────────────────────
  if (peak !== null && peak > 0) {
    const drawdownPct = ((peak - nav) / peak) * 100;
    if (drawdownPct > drawdownLimit) {
      await disableTrading(
        supabase,
        market,
        `Drawdown ${drawdownPct.toFixed(1)}% exceeds ${drawdownLimit}% from peak $${peak.toFixed(0)}`,
      );
      return {
        safe: false,
        sellAllowed: sellAllowedOnTrip,
        tripped: "drawdown",
        reason: `Drawdown ${drawdownPct.toFixed(1)}% > ${drawdownLimit}% from peak`,
      };
    }
  }

  // All clear — auto-resolve stale health alert (does NOT re-enable trading;
  // a human re-enables in Settings after reviewing the trip).
  await resolveIssue(`killswitch:${market}`);
  return { safe: true, sellAllowed: true };
}

async function disableTrading(
  supabase: any,
  market: string,
  reason: string,
): Promise<void> {
  console.error(`[kill-switch] TRADING DISABLED (${market}): ${reason}`);
  // Per-market disable (migration 171): halt ONLY this market's trading, not the
  // other's. isTradingEnabled(market) also honors the global strategy_config
  // master-kill, so a true "stop everything" still works.
  await setMarketTrading(supabase, market, false, reason);
  await reportIssue({
    issueKey: `killswitch:${market}`,
    severity: "critical",
    category: "trading",
    title: `Kill switch tripped (${market.toUpperCase()}) — trading auto-disabled`,
    detail: `${reason}. Trading is halted for ${market.toUpperCase()} until you review and re-enable it in Settings → Trading.`,
  });

  // G8: flag resting live orders for human review. No auto-cancel — no LLM
  // or cron may cancel a live order; the owner does it manually at the broker.
  try {
    const { data: flagged } = await supabase
      .from("broker_orders")
      .update({
        risk_status: "kill_switch_review_required",
        risk_status_at: new Date().toISOString(),
        risk_status_reason: reason,
      })
      .eq("market", market)
      .eq("broker_env", "live")
      .in("status", [
        "pending_submit",
        "submitted",
        "partially_filled",
        "unknown_needs_reconcile",
      ])
      .is("risk_status", null)
      .select("id");
    if (flagged && (flagged as any[]).length > 0) {
      await reportIssue({
        issueKey: `killswitch-orders:${market}`,
        severity: "critical",
        category: "trading",
        title: `${(flagged as any[]).length} open live ${market.toUpperCase()} order(s) need review (kill switch)`,
        detail: `The kill switch tripped while ${(flagged as any[]).length} live order(s) were still open. They are flagged kill_switch_review_required — cancel them manually at the broker if needed.`,
      });
    }
  } catch {
    /* flagging is best-effort — must never block the kill switch itself */
  }
}
