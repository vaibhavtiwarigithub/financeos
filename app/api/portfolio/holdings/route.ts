import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchAllAccounts } from "@/lib/brokers";
import { computeRiskMetrics } from "@/lib/portfolio-risk";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [accounts, pendingProposals] = await Promise.all([
    fetchAllAccounts(),
    // Load pending proposals for impact calculation
    createServiceClient()
      .from("trade_proposals")
      .select("symbol, side, qty, price_at_proposal")
      .eq("status", "pending_review")
      .then(r => r.data ?? []),
  ]);

  const allHoldings = accounts.flatMap(a => a.holdings);
  const risk = computeRiskMetrics(allHoldings, pendingProposals as any);

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
