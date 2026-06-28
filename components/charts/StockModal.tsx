"use client";
import { lazy, Suspense, useEffect } from "react";
const PriceChart = lazy(() => import("@/components/charts/PriceChart"));

const T = { bg: "rgba(0,0,0,0.7)", card: "#1A1D27", border: "#252836", muted: "#6B7280" };

export default function StockModal({ symbol, onClose }: { symbol: string; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      style={{ position: "fixed", inset: 0, background: T.bg, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "16px", padding: "24px", width: "min(720px, 95vw)", maxHeight: "90vh", overflow: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
          <div style={{ fontSize: "16px", fontWeight: 700, color: "#ECEDEF" }}>{symbol} Price Chart</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: T.muted, fontSize: "20px", cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>
        <Suspense fallback={<div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "40px 0" }}>Loading…</div>}>
          <PriceChart symbol={symbol} height={320} />
        </Suspense>
      </div>
    </div>
  );
}
