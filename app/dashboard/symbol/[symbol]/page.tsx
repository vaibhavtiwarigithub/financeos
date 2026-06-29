import { createServiceClient } from "@/lib/supabase/service";
import SymbolDetailPage from "@/components/dashboard/SymbolDetailPage";

export default async function SymbolPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const sym = symbol.toUpperCase();
  const svc = createServiceClient();

  const [{ data: signals }, { data: trades }] = await Promise.all([
    svc.from("agent_signals")
      .select("id, direction, analyst_score, rationale, created_at, status, conviction")
      .eq("symbol", sym)
      .order("created_at", { ascending: false })
      .limit(20),
    svc.from("paper_trades")
      .select("id, order_side, qty, fill_price, executed_at, rationale, analyst_score")
      .eq("symbol", sym)
      .order("executed_at", { ascending: false })
      .limit(10),
  ]);

  return (
    <SymbolDetailPage
      symbol={sym}
      signals={signals ?? []}
      trades={trades ?? []}
    />
  );
}
