import { Suspense } from "react";
import BacktestPage from "@/components/dashboard/BacktestPage";
export const dynamic = "force-dynamic";
export default function Page() {
  return (
    <Suspense fallback={<div style={{ padding: "40px 28px", color: "#9B9EA8" }}>Loading backtest…</div>}>
      <BacktestPage />
    </Suspense>
  );
}
