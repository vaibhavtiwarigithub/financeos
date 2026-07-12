import { createServiceClient } from "@/lib/supabase/service";
import LivePortfolioSwitch from "@/components/dashboard/LivePortfolioSwitch";

export const revalidate = 60;

export default async function Page() {
  const svc = createServiceClient();
  const { data: snaps } = await svc
    .from("live_account_snapshots")
    .select("*")
    .order("captured_at", { ascending: false });

  const { data: files } = await svc
    .from("uploaded_trade_files")
    .select("*")
    .order("uploaded_at", { ascending: false });

  const { data: decisionStats } = await svc
    .from("trade_decisions")
    .select("id, enrichment_status")
    .limit(1000);

  const total = decisionStats?.length ?? 0;
  const enriched = decisionStats?.filter((d: any) => d.enrichment_status === "enriched").length ?? 0;
  const pending = total - enriched;

  return (
    <LivePortfolioSwitch
      usProps={{
        liveSnaps: snaps ?? [],
        initialFiles: files ?? [],
        decisionStats: { total, enriched, pending },
      }}
    />
  );
}
