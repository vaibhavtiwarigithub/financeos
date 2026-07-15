import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { getSymbolProfile, type ProfileMarket } from "@/lib/data/symbol-profile";
import { computeRevisitReason } from "@/lib/revisit-reason";
import { isIndia } from "@/lib/india-data";

export const dynamic = "force-dynamic";

// GET /api/symbol-profile?symbol=NVDA&market=us|india
// Owner-gated. Returns the cached (read-through) Stock Context profile plus a
// computed "why revisit + when" reason. DISPLAY-ONLY — off the money path.
export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const sp = req.nextUrl.searchParams;
  const symbolRaw = sp.get("symbol");
  if (!symbolRaw) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const symbol = symbolRaw.trim().toUpperCase();

  const mktParam = sp.get("market");
  const market: ProfileMarket = mktParam === "india" ? "india"
    : mktParam === "us" ? "us"
    : (isIndia(symbol) ? "india" : "us");

  const svc = createServiceClient();

  // Read-through profile (fetches + caches when missing/stale). Fail-soft.
  let profile = null;
  try {
    profile = await getSymbolProfile(symbol, market, svc);
  } catch {
    profile = null;
  }

  // Revisit reason from data the app already holds. All reads are our own tables.
  let revisit = null;
  try {
    const [{ data: wl }, { data: rq }] = await Promise.all([
      svc.from("watchlist")
        .select("alert_on_earnings, expires_at")
        .eq("symbol", symbol)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      svc.from("research_queue")
        .select("priority, attempts, deferred_at")
        .eq("symbol", symbol)
        .eq("market", market)
        .maybeSingle(),
    ]);

    const r = computeRevisitReason({
      nextEarningsDate: profile?.next_earnings_date ?? null,
      alertOnEarnings: (wl as any)?.alert_on_earnings ?? null,
      expiresAt: (wl as any)?.expires_at ?? null,
      priority: (rq as any)?.priority ?? null,
      attempts: (rq as any)?.attempts ?? null,
      deferredAt: (rq as any)?.deferred_at ?? null,
    });
    revisit = r.urgency === "none" ? null : r;
  } catch {
    revisit = null;
  }

  return NextResponse.json({ profile, revisit });
}
