import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const deny = await requireOwner();
  if (deny) return deny;

  const { searchParams } = new URL(req.url);
  const mandateId = searchParams.get("mandateId");
  const market = searchParams.get("market");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "20"), 50);

  const supabase = createServiceClient();
  let q = supabase
    .from("strategy_evaluations")
    .select(
      "id, mandate_id, market, evaluated_at, evaluator_version, dataset_hash, " +
      "window_start, window_end, n_trades_total, n_trades_evaluable, tainted_count, excluded_count, " +
      "book_sharpe, book_sortino, book_max_drawdown, book_win_rate, book_expectancy_pct, " +
      "book_alpha_pct, book_benchmark_symbol, book_cost_adjusted_return_pct, book_slip_vs_modeled_bps, " +
      "health_label, health_reason, promotion_eligible, created_at",
      // mandate_snapshot excluded from list view (large; available via single row fetch)
    )
    .order("evaluated_at", { ascending: false })
    .limit(limit);

  if (mandateId) q = q.eq("mandate_id", mandateId);
  if (market) q = q.eq("market", market);

  const { data, error } = await q;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, evaluations: data ?? [] });
}
