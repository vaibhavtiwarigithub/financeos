"use client";
import { useEffect, useState } from "react";

const T = { card: "#1A1D27", border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280", green: "#34D399", greenBg: "#052E16", amber: "#FBBF24", amberBg: "#2D1B00", red: "#F87171", redBg: "#3B0000", accent: "#818CF8" };
type Plan = { id: number; symbol: string; qty: number; entry_price: number | null; stop_price: number; status: string; armed_at: string | null; terminal_reason: string | null; created_at: string };

export default function GuardianProtectionPanel() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = async () => { setLoading(true); try { const r = await fetch("/api/manual-trade-guardian/plans"); const d = await r.json(); setPlans(d.plans ?? []); } finally { setLoading(false); } };
  useEffect(() => { void load(); }, []);
  const action = async (planId: number, next: "arm" | "decline" | "cancel") => {
    setWorking(planId); setNotice(null);
    try { const r = await fetch("/api/manual-trade-guardian/plans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan_id: planId, action: next }) }); const d = await r.json(); setNotice(d.message ?? d.error ?? "Unable to update Guardian plan."); if (r.ok) await load(); } finally { setWorking(null); }
  };
  return <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 20, marginBottom: 20 }}>
    <div style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
      <div><div style={{ color: T.text, fontWeight: 750, fontSize: 15 }}>Manual Trade Guardian</div><div style={{ color: T.sub, fontSize: 12, marginTop: 4 }}>Protect manual buys in the agentic Robinhood account with an owner-armed software stop.</div></div>
      <span style={{ color: T.amber, background: T.amberBg, padding: "4px 8px", borderRadius: 6, fontSize: 10, fontWeight: 800, letterSpacing: ".06em" }}>OWNER TAP REQUIRED</span>
    </div>
    <div style={{ color: T.amber, fontSize: 12, lineHeight: 1.45, marginTop: 12, padding: "10px 12px", background: T.amberBg, borderRadius: 8 }}>
      Arming stores a software stop only — it does not place a broker order. A market exit can be submitted only after a verified breach and only when the existing live-autonomy deployment flag and your live enablement switch are both on.
    </div>
    {notice && <div style={{ color: T.sub, fontSize: 12, marginTop: 10 }}>{notice}</div>}
    {loading ? <div style={{ color: T.muted, fontSize: 12, paddingTop: 14 }}>Loading protection plans…</div> : plans.length === 0 ? <div style={{ color: T.muted, fontSize: 12, paddingTop: 14 }}>No manual-buy protection plans are awaiting action.</div> : <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
      {plans.map(p => { const armed = p.status === "armed"; const pending = p.status === "pending_approval"; const color = armed ? T.green : pending ? T.amber : T.red; const bg = armed ? T.greenBg : pending ? T.amberBg : T.redBg; return <div key={p.id} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div><div style={{ color: T.text, fontSize: 14, fontWeight: 750 }}>{p.symbol} <span style={{ color: T.sub, fontWeight: 500 }}>· {Number(p.qty).toLocaleString()} shares</span></div><div style={{ color: T.sub, fontSize: 12, marginTop: 4 }}>Stop ${Number(p.stop_price).toFixed(2)}{p.entry_price ? ` · entry $${Number(p.entry_price).toFixed(2)}` : ""}</div></div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ color, background: bg, padding: "4px 7px", borderRadius: 5, fontSize: 10, fontWeight: 800 }}>{p.status.replaceAll("_", " ").toUpperCase()}</span>{pending && <><button disabled={working === p.id} onClick={() => action(p.id, "arm")} style={{ background: T.green, color: "#05120b", border: "none", padding: "7px 10px", borderRadius: 6, fontWeight: 800, cursor: "pointer", fontSize: 11 }}>Arm stop</button><button disabled={working === p.id} onClick={() => action(p.id, "decline")} style={{ background: "transparent", color: T.sub, border: `1px solid ${T.border}`, padding: "7px 10px", borderRadius: 6, cursor: "pointer", fontSize: 11 }}>Decline</button></>}{armed && <button disabled={working === p.id} onClick={() => action(p.id, "cancel")} style={{ background: "transparent", color: T.red, border: `1px solid ${T.red}55`, padding: "7px 10px", borderRadius: 6, cursor: "pointer", fontSize: 11 }}>Disarm</button>}</div>
      </div>; })}
    </div>}
  </section>;
}
