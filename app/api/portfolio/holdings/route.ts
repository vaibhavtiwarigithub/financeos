import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { fetchAllAccounts } from "@/lib/brokers";
import { computeRiskMetrics } from "@/lib/portfolio-risk";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Market scope: ?market= wins, else the `mkt` cookie, else US. Currency follows.
  const cookieMkt = (await cookies()).get("mkt")?.value;
  const q = req.nextUrl.searchParams.get("market");
  const market: "us" | "india" = (q ?? cookieMkt) === "india" ? "india" : "us";
  const currency = market === "india" ? "₹" : "$";

  // Pending proposals feed the "proposal impact" panel. trade_proposals is NOT
  // market-tagged and the TraderAgent proposes US only, so we load them for US
  // and skip for India — never inject US $ proposals into a ₹ book.
  async function loadProposals() {
    if (market === "india") return [];
    const { data } = await createServiceClient()
      .from("trade_proposals").select("symbol, side, qty, price_at_proposal")
      .eq("status", "pending_review");
    return data ?? [];
  }

  const [accounts, pendingProposals] = await Promise.all([
    fetchAllAccounts(market),
    loadProposals(),
  ]);

  const allHoldings = accounts.flatMap(a => a.holdings);
  const risk = await computeRiskMetrics(allHoldings, pendingProposals as any, { market, currency });

  return NextResponse.json({
    accounts: accounts.map(a => ({
      source: a.source,
      totalValue: a.totalValue,
      cashBalance: a.cashBalance,
      holdingCount: a.holdings.length,
      fetchedAt: a.fetchedAt,
      error: a.error,
    })),
    risk,
    fetchedAt: new Date().toISOString(),
  });
}
