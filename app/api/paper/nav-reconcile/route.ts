import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

// A4 / P0-4 residual — read-only NAV reconciliation report.
//
// The `open_positions` write bug silently corrupted stored `paper_portfolio.nav`
// on historical rows (a rejected PostgREST update whose error was swallowed). The
// in-run invariant in position-monitor makes FUTURE drift observable but does not
// retro-audit rows already corrupted. This endpoint re-derives the invariant
// read-only so the owner can SEE which pools are off and by how much — it never
// mutates a ledger. Corrections, if any, are a separate owner-approved action.
//
// Invariant (same as position-monitor): for each market pool,
//   nav  ==  cash_balance  +  Σ over that market's open lots of qty·(current_price ?? avg_cost)
// within tol = max(0.01, |nav|·1e-6). paper_positions has no closed flag — every
// row is a currently-held lot — so no open/closed filter is needed.
//
// Owner-gated, GET-only, force-dynamic. No cron trigger (a report, not a job).
export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;

  const svc = createServiceClient();

  const [{ data: pools, error: poolErr }, { data: positions, error: posErr }] = await Promise.all([
    svc.from("paper_portfolio").select("id, market, cash_balance, nav"),
    svc.from("paper_positions").select("qty, avg_cost, current_price, market"),
  ]);
  if (poolErr) return NextResponse.json({ error: `paper_portfolio read failed: ${poolErr.message}` }, { status: 500 });
  if (posErr) return NextResponse.json({ error: `paper_positions read failed: ${posErr.message}` }, { status: 500 });

  // Mark-to-market of open lots per market (current_price, falling back to avg_cost).
  const mtmByMarket: Record<string, number> = {};
  for (const p of positions ?? []) {
    const market = String((p as any).market ?? "us");
    const lot = Number((p as any).qty ?? 0) * Number((p as any).current_price ?? (p as any).avg_cost ?? 0);
    mtmByMarket[market] = (mtmByMarket[market] ?? 0) + lot;
  }

  const report = (pools ?? []).map((pool: any) => {
    const market = String(pool.market ?? "us");
    const cash = Number(pool.cash_balance ?? 0);
    const nav = Number(pool.nav ?? 0);
    const positionsMtm = mtmByMarket[market] ?? 0;
    const expectedNav = cash + positionsMtm;
    const drift = Math.abs(nav - expectedNav);
    const tol = Math.max(0.01, Math.abs(nav) * 1e-6);
    return {
      pool_id: pool.id,
      market,
      cash_balance: cash,
      stored_nav: nav,
      positions_mtm: positionsMtm,
      expected_nav: expectedNav,
      drift,
      tolerance: tol,
      reconciled: drift <= tol,
      // Signed gap: positive = stored NAV overstated vs holdings.
      overstated_by: nav - expectedNav,
    };
  });

  const drifted = report.filter((r: (typeof report)[number]) => !r.reconciled);
  return NextResponse.json({
    generated_at: new Date().toISOString(),
    read_only: true,
    pools_checked: report.length,
    pools_drifted: drifted.length,
    all_reconciled: drifted.length === 0,
    report,
  });
}
