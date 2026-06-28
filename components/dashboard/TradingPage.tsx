"use client";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24",
  greenBg: "#052E16", redBg: "#3B0000", amberBg: "#2D1B00",
};

function dirBadge(d: string) {
  const up = d === "buy" || d === "long";
  return (
    <span style={{ fontSize: "11px", fontWeight: 700, padding: "2px 8px", borderRadius: "4px", background: up ? T.greenBg : T.redBg, color: up ? T.green : T.red }}>
      {d.toUpperCase()}
    </span>
  );
}

function statusBadge(s: string) {
  const cfg: Record<string, [string, string]> = {
    pending_approval: [T.amberBg, T.amber],
    approved: [T.greenBg, T.green],
    rejected: [T.redBg, T.red],
    executed: ["#1A1D27", "#9B9EA8"],
    cancelled: [T.redBg, T.red],
  };
  const [bg, color] = cfg[s] ?? ["#1A1D27", "#9B9EA8"];
  return (
    <span style={{ fontSize: "11px", fontWeight: 600, padding: "2px 8px", borderRadius: "4px", background: bg, color }}>
      {s.replace("_", " ")}
    </span>
  );
}

export default function TradingPage({ queue, tradeLog, strategy }: {
  queue: any[]; tradeLog: any[]; strategy: any;
}) {
  const supabase = createClient();
  const [acting, setActing] = useState<string | null>(null);
  const [tab, setTab] = useState<"queue" | "log">("queue");

  const pending = queue.filter(q => q.status === "pending_approval");
  const other = queue.filter(q => q.status !== "pending_approval");

  async function approve(id: string) {
    setActing(id);
    await supabase.from("trade_queue").update({ status: "approved", approved_at: new Date().toISOString() }).eq("id", id);
    window.location.reload();
  }

  async function reject(id: string) {
    setActing(id);
    await supabase.from("trade_queue").update({ status: "rejected" }).eq("id", id);
    window.location.reload();
  }

  return (
    <div style={{ padding: "28px", color: T.text, fontFamily: "'Inter', sans-serif" }}>

      {/* Header */}
      <div style={{ marginBottom: "28px" }}>
        <div style={{ fontSize: "11px", color: T.accent, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "6px" }}>Trade Control</div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h1 style={{ fontSize: "24px", fontWeight: 700, letterSpacing: "-0.02em" }}>Trading</h1>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <span style={{ fontSize: "12px", color: T.muted }}>Mode:</span>
            <span style={{ fontSize: "13px", fontWeight: 600, color: strategy?.mode === "auto" ? T.red : T.green }}>
              {strategy?.mode === "auto" ? "⚡ AUTO" : "✋ APPROVAL REQUIRED"}
            </span>
          </div>
        </div>
      </div>

      {/* Pending approvals — always shown first */}
      {pending.length > 0 && (
        <div style={{ marginBottom: "28px" }}>
          <div style={{ fontSize: "13px", fontWeight: 600, color: T.amber, marginBottom: "12px", display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: T.amber, display: "inline-block" }} />
            {pending.length} trade{pending.length > 1 ? "s" : ""} awaiting your approval
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {pending.map(t => (
              <div key={t.id} style={{ background: T.card, border: `1px solid ${T.amber}40`, borderRadius: "12px", padding: "20px", display: "flex", alignItems: "center", gap: "16px" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
                    <span style={{ fontWeight: 700, fontSize: "18px" }}>{t.symbol}</span>
                    {dirBadge(t.order_side)}
                    <span style={{ fontSize: "13px", color: T.textSub }}>{t.qty} shares</span>
                    {t.limit_price && <span style={{ fontSize: "13px", color: T.textSub }}>@ ${t.limit_price}</span>}
                  </div>
                  <div style={{ fontSize: "12px", color: T.muted }}>{t.rationale ?? "No rationale provided"}</div>
                  <div style={{ fontSize: "11px", color: T.muted, marginTop: "4px" }}>
                    Analyst score: <span style={{ color: T.accent, fontWeight: 600 }}>{t.analyst_score ?? "—"}</span>
                    {t.created_at && ` · Queued ${new Date(t.created_at).toLocaleString()}`}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "10px", shrink: 0 } as any}>
                  <button
                    onClick={() => approve(t.id)}
                    disabled={acting === t.id}
                    style={{ padding: "10px 22px", background: T.green, border: "none", borderRadius: "8px", color: "#000", fontWeight: 700, fontSize: "14px", cursor: "pointer", opacity: acting === t.id ? 0.6 : 1 }}
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => reject(t.id)}
                    disabled={acting === t.id}
                    style={{ padding: "10px 22px", background: T.redBg, border: `1px solid ${T.red}60`, borderRadius: "8px", color: T.red, fontWeight: 700, fontSize: "14px", cursor: "pointer", opacity: acting === t.id ? 0.6 : 1 }}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: "flex", gap: "4px", marginBottom: "20px", background: T.surface, padding: "4px", borderRadius: "10px", width: "fit-content" }}>
        {(["queue", "log"] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{ padding: "8px 20px", borderRadius: "8px", border: "none", cursor: "pointer", fontSize: "13px", fontWeight: 500, background: tab === t ? T.card : "transparent", color: tab === t ? T.text : T.muted }}
          >
            {t === "queue" ? `Queue (${other.length})` : `Trade Log (${tradeLog.length})`}
          </button>
        ))}
      </div>

      {/* Queue tab */}
      {tab === "queue" && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
          {other.length === 0 && pending.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 0", color: T.muted, fontSize: "14px" }}>
              No trades in queue. TraderAgent hasn't proposed anything yet.
            </div>
          ) : other.length === 0 ? (
            <div style={{ textAlign: "center", padding: "20px 0", color: T.muted, fontSize: "13px" }}>
              No other queue items.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ color: T.muted }}>
                  {["Symbol", "Side", "Qty", "Price", "Score", "Status", "Queued"].map(h => (
                    <th key={h} style={{ padding: "6px 12px 10px 0", fontWeight: 500, fontSize: "11px", letterSpacing: "0.05em", textTransform: "uppercase", textAlign: "left" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {other.map(t => (
                  <tr key={t.id} style={{ borderTop: `1px solid ${T.border}` }}>
                    <td style={{ padding: "10px 12px 10px 0", fontWeight: 700 }}>{t.symbol}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>{dirBadge(t.order_side)}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>{t.qty}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>{t.limit_price ? `$${t.limit_price}` : "market"}</td>
                    <td style={{ padding: "10px 12px 10px 0", fontWeight: 600, color: T.accent }}>{t.analyst_score ?? "—"}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>{statusBadge(t.status)}</td>
                    <td style={{ padding: "10px 0", color: T.muted, fontSize: "12px" }}>{t.created_at ? new Date(t.created_at).toLocaleDateString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Trade log tab */}
      {tab === "log" && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
          {tradeLog.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 0", color: T.muted, fontSize: "14px" }}>
              No executed trades yet.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ color: T.muted }}>
                  {["Symbol", "Side", "Qty", "Price", "P&L", "Executed"].map(h => (
                    <th key={h} style={{ padding: "6px 12px 10px 0", fontWeight: 500, fontSize: "11px", letterSpacing: "0.05em", textTransform: "uppercase", textAlign: "left" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tradeLog.map(t => (
                  <tr key={t.id} style={{ borderTop: `1px solid ${T.border}` }}>
                    <td style={{ padding: "10px 12px 10px 0", fontWeight: 700 }}>{t.symbol}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>{dirBadge(t.order_side)}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>{t.qty}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>{t.fill_price ? `$${t.fill_price}` : "—"}</td>
                    <td style={{ padding: "10px 12px 10px 0", fontWeight: 600, color: (t.realized_pnl ?? 0) >= 0 ? T.green : T.red }}>
                      {t.realized_pnl != null ? `${t.realized_pnl >= 0 ? "+" : ""}$${t.realized_pnl.toFixed(2)}` : "—"}
                    </td>
                    <td style={{ padding: "10px 0", color: T.muted, fontSize: "12px" }}>{t.executed_at ? new Date(t.executed_at).toLocaleDateString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
