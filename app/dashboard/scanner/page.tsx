import { Suspense } from "react";
import ScannerPage from "@/components/dashboard/ScannerPage";
export const dynamic = "force-dynamic";
export default function Page() {
  return (
    <Suspense fallback={<div style={{ padding: "40px 28px", color: "#9B9EA8" }}>Loading scanner…</div>}>
      <ScannerPage />
    </Suspense>
  );
}
