"use client";
import BenchmarkPerformanceChart from "@/components/dashboard/BenchmarkPerformanceChart";

// US and India reuse paper's controls/registry/arithmetic, not its portfolio.
export default function LivePerformanceChart({
  market = "us", accounts, refreshKey = 0,
}: {
  market?: "us" | "india"; accounts?: string[];
  showHoldingsToggle?: boolean; refreshKey?: number;
}) {
  return <BenchmarkPerformanceChart market={market} book="live" accounts={accounts} refreshKey={refreshKey} />;
}
