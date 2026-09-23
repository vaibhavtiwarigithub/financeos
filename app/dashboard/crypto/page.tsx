import { createServiceClient } from "@/lib/supabase/service";
import { getSessionRole } from "@/lib/auth/session-role";
import CryptoBookPage from "@/components/dashboard/CryptoBookPage";

export const dynamic = "force-dynamic";

export default async function Page() {
  const supabase = createServiceClient();
  const [
    { data: pool }, { data: positions }, { data: trades }, { data: perf },
    { data: latestUniverse }, { data: shadows }, { data: strategies },
  ] = await Promise.all([
    supabase.from("paper_portfolio").select("nav,cash_balance,updated_at").eq("market", "crypto").maybeSingle(),
    supabase.from("paper_positions").select("symbol,qty,entry_price,current_price,stop_loss,price_target,updated_at").eq("market", "crypto").order("symbol"),
    // Same pattern as the equities Paper Portfolio page's trades tab: capped
    // display slice, most recent first. Crypto's book is far smaller than
    // equities' — 100 rows currently covers every closed trade — but if that
    // stops being true, win-rate/realized-P&L should move to the exact head
    // counts app/dashboard/portfolio/page.tsx uses instead of this slice.
    supabase.from("paper_trades").select("id,symbol,outcome,realized_pnl,executed_at,closed_at").eq("market", "crypto").order("executed_at", { ascending: false }).limit(100),
    // Full history (not just the latest row) — the shared PaperBookHeader's
    // NAV sparkline needs a series, matching the equities page's own 60-row fetch.
    supabase.from("paper_performance").select("date,nav,total_pnl_pct").eq("market", "crypto").order("date", { ascending: true }).limit(60),
    supabase.from("crypto_universe_runs").select("id,observed_at,source,status,summary,error").order("observed_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("crypto_geometry_shadows").select("symbol,strategy_version,decision,refusal_reason,geometry,observed_at").order("observed_at", { ascending: false }).limit(20),
    supabase.from("crypto_strategy_versions").select("version,state,is_champion,created_at,notes").order("created_at", { ascending: false }).limit(10),
  ]);
  const { data: members } = latestUniverse?.id
    ? await supabase.from("crypto_universe_members").select("symbol,broker_tradeable,account_eligible,history_days,quote_observed_at,bid,ask,spread_pct,admitted,refusal_reason,raw").eq("run_id", latestUniverse.id).order("admitted", { ascending: false }).order("symbol").limit(60)
    : { data: [] as any[] };

  // Crypto's book is read-only observability for everyone (no owner-only
  // action buttons exist on this page — no order/approve/reject controls,
  // unlike the equities Trade Queue tab) — per the Dual-Perspective UI Rule,
  // that's an explicit decision, not a silent omission: viewerMode only
  // controls the disclaimer banner text here, nothing is hidden.
  const { role } = await getSessionRole();

  return (
    <CryptoBookPage
      pool={pool ?? null}
      positions={positions ?? []}
      trades={trades ?? []}
      perf={perf ?? []}
      latestUniverse={latestUniverse ?? null}
      shadows={shadows ?? []}
      strategies={strategies ?? []}
      members={members ?? []}
      viewerMode={role === "viewer"}
    />
  );
}
