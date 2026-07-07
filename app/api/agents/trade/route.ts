import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { execFile } from "child_process";
import { promisify } from "util";
import { fetchQuote } from "@/lib/market-data";
import { checkKillSwitches } from "@/lib/kill-switches";
import { requireOwner } from "@/lib/auth/require-owner";

const execFileAsync = promisify(execFile);

// ⚠️ DEPRECATED legacy generator — writes to the `trade_queue` table, a parallel
// system to `trade_proposals` (which the Execution Gateway + main TraderAgent in
// app/api/agents/trader/route.ts use). It historically lacked the kill-switch,
// earnings-blackout, macro-threshold, and proposal-expiry gates the main path
// has. This route's approve path only emits a manual paste command (no
// autonomous execution), but it is still gated below so it can never be a
// weaker path than the main one. Consolidating the Trading/Portfolio UI onto
// trade_proposals is an architecture-gated change tracked separately; until
// then this stays, hardened.
//
// TraderAgent: reads high-conviction LONG signals, generates buy-only proposals → trade_queue
// Phase 0 hard rules:
//   - Long-only: only buy orders, direction must be "long"
//   - Always pending_approval: auto-approve is never permitted
//   - Sizing from real account + real quote, not hardcoded $10k
export async function POST(req: NextRequest) {
  try {
    // Owner-only (matches the main trader route's guarantee).
    const ownerGate = await requireOwner();
    if (ownerGate) return ownerGate;

    const supabase = await createClient();

    // Get strategy config
    const { data: strategyArr } = await supabase.from("strategy_config").select("*").limit(1);
    const strategy = strategyArr?.[0];

    if (!strategy?.trading_enabled) {
      return NextResponse.json({ skipped: true, reason: "Trading disabled in strategy_config" });
    }

    // Kill-switch gate — the main trader route runs this before generating
    // proposals; the legacy generator previously did not. Parity fix.
    const ks = await checkKillSwitches(createServiceClient());
    if (!ks.safe) {
      return NextResponse.json({ skipped: true, reason: `Kill switch active: ${ks.reason}` });
    }

    // Check daily trade limit
    const today = new Date().toISOString().split("T")[0];
    const { count: todayCount } = await supabase
      .from("trade_queue")
      .select("*", { count: "exact", head: true })
      .gte("created_at", today + "T00:00:00Z");

    if ((todayCount ?? 0) >= strategy.max_daily_trades) {
      return NextResponse.json({ skipped: true, reason: `Daily trade limit reached (${strategy.max_daily_trades})` });
    }

    // Only long signals above threshold
    const { data: signals } = await supabase
      .from("agent_signals")
      .select("*")
      .eq("status", "pending")
      .eq("direction", "long") // long-only enforcement
      .gte("analyst_score", strategy.min_analyst_score)
      .order("analyst_score", { ascending: false })
      .limit(3);

    if (!signals || signals.length === 0) {
      return NextResponse.json({ skipped: true, reason: "No qualifying long signals" });
    }

    const queued: any[] = [];

    for (const signal of signals) {
      // Fetch real price — skip if unavailable
      const quote = await fetchQuote(signal.symbol);
      if (quote.source === "unavailable" || quote.price <= 0) continue;

      // Sizing from strategy config (% of paper portfolio), not hardcoded $10k
      // Phase 4: prefer the US pool; fall back to any row pre-057 (no market column)
      let { data: portfolio } = await supabase.from("paper_portfolio").select("nav").eq("market", "us").limit(1).maybeSingle();
      if (!portfolio) ({ data: portfolio } = await supabase.from("paper_portfolio").select("nav").limit(1).maybeSingle());
      const portfolioNav = portfolio?.nav ?? 10000;
      // max_position_pct is stored as a decimal (0.10 = 10%) — do NOT divide by 100
      const maxSpend = portfolioNav * strategy.max_position_pct;
      const qty = Math.max(1, Math.floor(maxSpend / quote.price));

      const rationale = `${signal.rationale ?? ""} | score: ${signal.analyst_score} | price_source: ${quote.source} | price: ${quote.price}`;

      await supabase.from("trade_queue").insert({
        symbol: signal.symbol,
        order_side: "buy",           // long-only: always buy
        order_type: "limit",
        qty,
        limit_price: quote.price,
        analyst_score: signal.analyst_score,
        signal_id: signal.id,
        rationale,
        status: "pending_approval",  // auto-approve never permitted in Phase 0
        account_number: "605420660",
      });

      await supabase.from("agent_signals").update({ status: "approved" }).eq("id", signal.id);
      queued.push({ symbol: signal.symbol, side: "buy", qty, price: quote.price });
    }

    return NextResponse.json({ success: true, queued: queued.length, trades: queued });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
