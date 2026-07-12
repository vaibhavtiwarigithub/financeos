import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { fetchRobinhoodBrokerAccounts, fetchKiteBrokerAccount } from "@/lib/brokers";
import { computeRiskMetrics } from "@/lib/portfolio-risk";
import { createServiceClient } from "@/lib/supabase/service";
import type { BrokerAccount } from "@/lib/brokers/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Market scope: ?market= wins, else the `mkt` cookie, else US. Currency follows.
  const cookieMkt = (await cookies()).get("mkt")?.value;
  const q = req.nextUrl.searchParams.get("market");
  const market: "us" | "india" = (q ?? cookieMkt) === "india" ? "india" : "us";
  const currency = market === "india" ? "₹" : "$";

  // Pending proposals feed the "proposal impact" panel (US only).
  async function loadProposals() {
    if (market === "india") return [];
    const { data } = await createServiceClient()
      .from("trade_proposals").select("symbol, side, qty, price_at_proposal")
      .eq("status", "pending_review");
    return data ?? [];
  }

  // Fetch live per-account data for the per-account risk sections.
  // US: Robinhood accounts. India: Kite account.
  async function fetchLiveAccounts(): Promise<BrokerAccount[]> {
    if (market === "india") {
      const kite = await fetchKiteBrokerAccount();
      return [kite];
    }
    return fetchRobinhoodBrokerAccounts();
  }

  const [liveAccounts, pendingProposals] = await Promise.all([
    fetchLiveAccounts(),
    loadProposals(),
  ]);

  // This endpoint is explicitly the LIVE portfolio. Never substitute the paper
  // book when a broker fetch fails: that produced plausible-looking risk numbers
  // under a "live" heading while the account pills showed a broker error.
  const liveHoldings = liveAccounts.flatMap(a => a.holdings);
  const risk = await computeRiskMetrics(liveHoldings, pendingProposals as any, { market, currency });

  // Per-account risk: compute independently for each live account.
  // Skips error-only accounts and accounts with zero holdings.
  const accountRisks = await Promise.all(
    liveAccounts
      .filter(a => !a.error && a.holdings.length > 0)
      .map(async a => {
        const accountRisk = await computeRiskMetrics(a.holdings, [], { market, currency });
        return {
          accountId: a.accountId ?? a.source,
          accountLabel: a.accountLabel ?? a.source,
          source: a.source,
          totalValue: a.totalValue,
          cashBalance: a.cashBalance,
          error: a.error,
          risk: accountRisk,
        };
      }),
  );

  // Account pills: show live accounts + error stubs for any that failed.
  const errorAccounts = liveAccounts.filter(a => a.error).map(a => ({
    source: a.source,
    accountId: a.accountId,
    accountLabel: a.accountLabel,
    totalValue: 0,
    cashBalance: 0,
    holdingCount: 0,
    fetchedAt: a.fetchedAt,
    error: a.error,
  }));

  const accountPills = [
    ...liveAccounts.filter(a => !a.error).map(a => ({
      source: a.source,
      accountId: a.accountId,
      accountLabel: a.accountLabel,
      totalValue: a.totalValue,
      cashBalance: a.cashBalance,
      holdingCount: a.holdings.length,
      fetchedAt: a.fetchedAt,
    })),
    ...errorAccounts,
  ];

  return NextResponse.json({
    accounts: accountPills,
    risk,
    accountRisks,
    fetchedAt: new Date().toISOString(),
  });
}
