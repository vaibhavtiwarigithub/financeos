import { cookies } from "next/headers";
import { createServiceClient } from "@/lib/supabase/service";
import TradingPage from "@/components/dashboard/TradingPage";

export const revalidate = 30;

export default async function Page() {
  const supabase = createServiceClient();

  // Server component — can't call useMarket() (client-only context). Reads the
  // `mkt` cookie MarketProvider keeps in sync instead, same pattern as the Home
  // and Agents pages. Every market-tagged query below is scoped to it; nothing
  // was scoped before, so India `.NS` signals/trades surfaced under the US $ book.
  const cookieStore = await cookies();
  const market = cookieStore.get("mkt")?.value === "india" ? "india" : "us";

  const [
    { data: signals },
    { data: trades },
    { data: strategyArr },
    { data: portfolio },
    { data: highScoreSignals },
    { data: positions },
    { data: liveOrders },
  ] = await Promise.all([
    supabase.from("agent_signals").select("*, research_packets(*)").eq("market", market).eq("status", "pending").order("created_at", { ascending: false }).limit(20),
    supabase.from("paper_trades").select("*").eq("market", market).order("executed_at", { ascending: false }).limit(30),
    supabase.from("strategy_config").select("*").limit(1),
    // This market's pool only. maybeSingle so a missing market column pre-057 yields null gracefully.
    supabase.from("paper_portfolio").select("*").eq("market", market).limit(1).maybeSingle(),
    // Trade queue feeds a Robinhood-US approval flow — there is no India order
    // routing, so under the ₹ view we don't fetch it at all (the UI shows a
    // "US only" note). Under US it's scoped to US so India names can never enter
    // a US broker queue. Same treatment as PortfolioPage's Trade Queue tab.
    market === "india"
      ? Promise.resolve({ data: [] as any[] })
      : supabase.from("agent_signals").select("id, symbol, direction, analyst_score, conviction, rationale, created_at, status").eq("market", "us").eq("status", "pending").gte("analyst_score", 60).order("analyst_score", { ascending: false }).limit(20),
    supabase.from("paper_positions").select("symbol,market,current_price,updated_at").eq("market", market),
    supabase.from("broker_orders")
      .select("id, symbol, side, qty, estimated_value, status, broker_order_id, error, created_at, market")
      .eq("market", market)
      .in("status", ["pending_submit", "submitted", "partially_filled", "unknown_needs_reconcile", "filled", "error"])
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  return (
    <TradingPage
      pendingSignals={signals ?? []}
      tradeLog={trades ?? []}
      strategy={strategyArr?.[0] ?? null}
      portfolio={portfolio ?? null}
      queue={highScoreSignals ?? []}
      positions={positions ?? []}
      market={market}
      liveOrders={liveOrders ?? []}
    />
  );
}
