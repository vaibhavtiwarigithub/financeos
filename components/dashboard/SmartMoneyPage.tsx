"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/dashboard/PageHeader";
import InfoTooltip from "@/components/dashboard/InfoTooltip";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24",
  greenBg: "#052E16", redBg: "#3B0000", amberBg: "#2D1B00",
};

function timeAgo(iso: string) {
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function ScorePill({ score, dim }: { score: number; dim: string }) {
  const color = score >= 70 ? T.green : score >= 50 ? T.amber : T.red;
  return (
    <span style={{ fontSize: "10px", fontWeight: 600, padding: "2px 6px", borderRadius: "4px", background: color + "18", color, border: `1px solid ${color}30`, whiteSpace: "nowrap" }}>
      {dim} {score}
    </span>
  );
}

const CLASS_META: Record<string, { label: string; color: string; icon: string }> = {
  us_equity: { label: "US Equity", color: T.accent, icon: "📈" },
  etf:       { label: "ETF",       color: T.amber,  icon: "◎" },
  metal:     { label: "Metal",     color: "#F59E0B", icon: "⚡" },
};

// Muted "no free India feed" placeholder for US-only tiles (insider / Form 4 /
// options flow). We never fabricate India insider/options data.
function IndiaUnavailable({ what }: { what: string }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "40px 20px", textAlign: "center" }}>
      <div style={{ fontSize: "28px", marginBottom: "10px", opacity: 0.5 }}>🇮🇳</div>
      <div style={{ fontWeight: 600, fontSize: "14px", color: T.textSub, marginBottom: "6px" }}>US only — no free India {what} feed</div>
      <div style={{ fontSize: "12px", color: T.muted, maxWidth: "420px", margin: "0 auto", lineHeight: 1.6 }}>
        {what} data is sourced from SEC EDGAR / Alpha Vantage, which cover US listings only.
        Switch the market toggle to US to view this tile.
      </div>
    </div>
  );
}

export default function SmartMoneyPage({ signals, tradeQueue, highInsider, market = "us", embedded }: {
  signals: any[]; tradeQueue: any[]; highInsider: any[]; market?: "us" | "india"; embedded?: boolean;
}) {
  const isIndia = market === "india";
  const router = useRouter();
  const [tab, setTab] = useState<"queue" | "insider" | "form4" | "signals" | "classes">("queue");
  const [acting, setActing] = useState<string | null>(null);
  const [sendingToAlpaca, setSendingToAlpaca] = useState<string | null>(null);
  const [sendingLive, setSendingLive] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);

  // Form 4 / EDGAR state
  const [edgarLoading, setEdgarLoading] = useState(false);
  const [edgarData, setEdgarData] = useState<any | null>(null);
  const [edgarError, setEdgarError] = useState<string | null>(null);
  const [edgarFetched, setEdgarFetched] = useState(false);

  // India NSE state (insider PIT disclosures + option-chain flow)
  const [nseInsider, setNseInsider] = useState<{ trades: any[]; available: boolean } | null>(null);
  const [nseInsiderLoading, setNseInsiderLoading] = useState(false);
  const [nseOptSymbol, setNseOptSymbol] = useState<"NIFTY" | "BANKNIFTY">("NIFTY");
  const [nseOptions, setNseOptions] = useState<any | null>(null);
  const [nseOptionsLoading, setNseOptionsLoading] = useState(false);

  useEffect(() => {
    if (!isIndia || tab !== "insider" || nseInsider !== null || nseInsiderLoading) return;
    setNseInsiderLoading(true);
    fetch("/api/india/insider")
      .then((r) => r.json())
      .then((d) => { setNseInsider(d); setNseInsiderLoading(false); })
      .catch(() => { setNseInsider({ trades: [], available: false }); setNseInsiderLoading(false); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, isIndia]);

  useEffect(() => {
    if (!isIndia || tab !== "form4") return;
    setNseOptions(null);
    setNseOptionsLoading(true);
    fetch(`/api/india/options?symbol=${nseOptSymbol}`)
      .then((r) => r.json())
      .then((d) => { setNseOptions(d); setNseOptionsLoading(false); })
      .catch(() => { setNseOptions({ available: false }); setNseOptionsLoading(false); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, isIndia, nseOptSymbol]);

  useEffect(() => {
    if (isIndia || tab !== "form4" || edgarFetched || edgarLoading) return;
    setEdgarLoading(true);
    setEdgarError(null);
    fetch("/api/markets/edgar-insiders")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setEdgarError(d.error);
        else setEdgarData(d);
        setEdgarFetched(true);
        setEdgarLoading(false);
      })
      .catch((e) => {
        setEdgarError(e.message);
        setEdgarLoading(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // trade_proposals' real pending status is "pending_review" (matches
  // /api/agents/trader's insert). "pending_approval" checked too for any
  // stale/legacy rows — harmless, never the actual value going forward.
  const pending = tradeQueue.filter(t => t.status === "pending_review" || t.status === "pending_approval");
  const decided = tradeQueue.filter(t => t.status !== "pending_review" && t.status !== "pending_approval");

  // Signal breakdown by asset class
  const byClass: Record<string, any[]> = {};
  for (const s of signals) {
    const cls = s.asset_class ?? "us_equity";
    if (!byClass[cls]) byClass[cls] = [];
    byClass[cls].push(s);
  }

  async function handleApprove(tradeId: string) {
    setActing(tradeId);
    try {
      const res = await fetch("/api/agents/trader", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve", proposal_id: parseInt(tradeId, 10) }),
      });
      const d = await res.json();
      setActionResult(d.message ?? (d.error ? `Error: ${d.error}` : "Approved"));
      router.refresh();
    } catch (e: any) {
      setActionResult("Error: " + e.message);
    }
    setActing(null);
  }

  // Execution Gateway (spec Part A) — sends an APPROVED proposal to Alpaca
  // paper trading. Live-env sending is gated server-side by trading_enabled;
  // this UI only ever fires the "paper" env (real-money live orders are a
  // separate, explicitly-confirmed flow, not wired here).
  async function handleSendToAlpaca(proposalId: string) {
    if (!window.confirm(`Send this order to Alpaca (paper account)?`)) return;
    setSendingToAlpaca(proposalId);
    try {
      const res = await fetch("/api/broker/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposal_id: parseInt(proposalId, 10), env: "paper" }),
      });
      const d = await res.json();
      setActionResult(d.error ? `Error: ${d.error}` : `Sent to Alpaca — order ${d.broker_order_id ?? d.order_id}`);
      router.refresh();
    } catch (e: any) {
      setActionResult("Error: " + e.message);
    }
    setSendingToAlpaca(null);
  }

  // REAL-MONEY live send. Double-confirm; routes through the Execution Gateway
  // with env:live, which enforces every gate (kill switches, notional cap,
  // drift, sell-if-held, allowlist, robinhood_mcp_enabled). Broker is whatever
  // active_broker_us resolves to (Robinhood MCP once selected).
  async function handleSendLive(t: any) {
    const acct = t.account_number ?? "605420660";
    const side = t.side ?? t.order_side ?? "?";
    if (!window.confirm(`⚠️ REAL-MONEY LIVE ORDER\n\n${String(side).toUpperCase()} ${t.qty} ${t.symbol}  (market)\nAccount: ${acct}\n\nThis places an ACTUAL order with real money. Continue?`)) return;
    if (!window.confirm(`Final confirmation — place LIVE ${String(side).toUpperCase()} ${t.qty} ${t.symbol} now?`)) return;
    setSendingLive(t.id);
    try {
      const res = await fetch("/api/broker/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposal_id: parseInt(t.id, 10), env: "live" }),
      });
      const d = await res.json();
      setActionResult(
        d.error && d.needs_reconcile ? `LIVE ambiguous — reconcile before retry: ${d.error}`
        : d.error ? `LIVE error: ${d.error}`
        : `LIVE order placed — broker order ${d.broker_order_id ?? d.order_id}`
      );
      router.refresh();
    } catch (e: any) {
      setActionResult("LIVE error: " + e.message);
    }
    setSendingLive(null);
  }

  async function handleReject(tradeId: string) {
    setActing(tradeId);
    try {
      const res = await fetch("/api/agents/trader", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject", proposal_id: parseInt(tradeId, 10), reason: "Rejected via Smart Money dashboard" }),
      });
      const d = await res.json();
      setActionResult(d.message ?? (d.error ? `Error: ${d.error}` : "Rejected"));
      router.refresh();
    } catch (e: any) {
      setActionResult("Error: " + e.message);
    }
    setActing(null);
  }

  return (
    <div style={{ color: T.text, fontFamily: "'Inter', sans-serif" }}>
      {!embedded && (
        <PageHeader
          title="Smart Money"
          subtitle="Trade queue · insider flow · multi-asset signals"
          cadence="as-needed"
          whatItDoes="Consolidates agent trade proposals for approval, insider transaction signals, and signal breakdown by asset class (US equity, ETFs, metals)."
          whatToLookFor={[
            "Pending trade queue shows AI proposals awaiting your approval — review rationale before approving.",
            "Insider flow highlights symbols where agent scored insider_score ≥ 55 recently.",
            "Asset class breakdown shows how signals distribute across equities, ETFs, and metals.",
          ]}
          actions={[]}
        />
      )}

      <div style={{ padding: "clamp(12px, 4vw, 28px) clamp(12px, 4vw, 28px) 32px" }}>

        {/* Hero stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "12px", marginBottom: "20px" }}>
          {([
            {
              label: "Pending Approval", value: pending.length, color: pending.length > 0 ? T.amber : T.muted, icon: "⏳",
              tip: { title: "Pending Approval", body: "Trade proposals generated by the ResearchAgent that are awaiting your Approve or Reject decision.", bullets: ["Proposals expire 30 min after creation", "Price is re-checked at submission time", "Only account ••••0660 can receive orders"] },
            },
            {
              label: isIndia ? "Insider Signals (US only)" : "Insider Signals",
              value: isIndia ? "—" : highInsider.length,
              color: isIndia ? T.muted : highInsider.length > 0 ? T.green : T.muted, icon: "🏦",
              tip: { title: "Insider Signals", body: isIndia ? "Insider signals come from SEC Form 4 / Alpha Vantage, which are US-only. No free India insider feed exists, so this tile is blank while India is selected." : "Symbols where the ResearchAgent scored insider_score ≥ 55 in the past 30 days, based on SEC Form 4 filings and Alpha Vantage insider transaction data.", bullets: isIndia ? ["Switch the market toggle to US to view", "No free NSE/BSE insider-transaction feed"] : ["Buy clusters > 3 executives = stronger signal", "Excludes routine stock plan / option exercise buys", "Form 4 tab shows raw SEC EDGAR data"] },
            },
            {
              label: "Total Signals (30d)", value: signals.length, color: T.accent, icon: "◆",
              tip: { title: "Total Signals", body: "All ResearchAgent signals generated in the last 30 days across all asset classes.", bullets: ["Each signal = one symbol scored across 5 dimensions", "Only long signals are shown (no short selling)", "Score ≥ threshold triggers a trade proposal"] },
            },
            {
              label: "Asset Classes", value: Object.keys(byClass).length, color: T.text, icon: "⬡",
              tip: { title: "Asset Classes", body: "Number of distinct asset classes represented in the 30-day signal set.", bullets: ["us_equity: individual US stocks", "etf: region or sector ETFs (added by market_focus)", "metal: GLD, SLV, GDX macro hedges"] },
            },
          ] as const).map(s => (
            <div key={s.label} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "16px" }}>
              <div style={{ fontSize: "20px", marginBottom: "6px" }}>{s.icon}</div>
              <div style={{ fontSize: "24px", fontWeight: 700, color: s.color }}>{s.value}</div>
              <div style={{ display: "flex", alignItems: "center", gap: "5px", marginTop: "3px" }}>
                <div style={{ fontSize: "11px", color: T.muted }}>{s.label}</div>
                <InfoTooltip title={s.tip.title} body={s.tip.body} bullets={s.tip.bullets as unknown as string[]} placement="bottom" />
              </div>
            </div>
          ))}
        </div>

        {/* Action result */}
        {actionResult && (
          <div style={{ marginBottom: "14px", background: T.surface, border: `1px solid ${actionResult.startsWith("Error") ? T.red : T.green}40`, borderRadius: "8px", padding: "10px 14px", fontSize: "12px", color: actionResult.startsWith("Error") ? T.red : T.green }}>
            {actionResult}
          </div>
        )}

        {/* Tabs */}
        <div style={{ display: "flex", gap: "4px", marginBottom: "16px", background: T.surface, padding: "4px", borderRadius: "10px", overflowX: "auto", flexWrap: "nowrap", WebkitOverflowScrolling: "touch" }}>
          {([
            { key: "queue", label: `Trade Queue${pending.length ? ` (${pending.length})` : ""}` },
            { key: "insider", label: "Insider Flow" },
            { key: "form4", label: "Form 4 (EDGAR)" },
            { key: "signals", label: "All Signals" },
            { key: "classes", label: "Asset Classes" },
          ] as const).map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{ padding: "7px 16px", borderRadius: "7px", border: "none", cursor: "pointer", fontSize: "12px", fontWeight: 500, flexShrink: 0, whiteSpace: "nowrap", background: tab === t.key ? T.card : "transparent", color: tab === t.key ? T.text : T.muted }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* TRADE QUEUE */}
        {tab === "queue" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {pending.length > 0 && (
              <div style={{ background: T.card, border: `1px solid ${T.amber}40`, borderRadius: "12px", padding: "20px" }}>
                <div style={{ fontWeight: 700, fontSize: "14px", marginBottom: "14px", color: T.amber }}>⏳ Pending Approval ({pending.length})</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                  {pending.map(t => (
                    <div key={t.id} style={{ background: T.surface, borderRadius: "10px", padding: "14px 16px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px", flexWrap: "wrap", gap: "8px" }}>
                        <div>
                          <span style={{ fontWeight: 700, fontSize: "15px" }}>{t.symbol}</span>
                          <span style={{ marginLeft: "8px", fontSize: "11px", fontWeight: 600, padding: "2px 8px", borderRadius: "4px", background: T.greenBg, color: T.green }}>{t.order_side?.toUpperCase()}</span>
                          <span style={{ marginLeft: "6px", fontSize: "12px", color: T.textSub }}>{t.qty} shares @ ${t.limit_price?.toFixed(2)}</span>
                          <span style={{ marginLeft: "8px", fontSize: "11px", color: T.muted, display: "inline-flex", alignItems: "center", gap: "4px" }}>
                            Score {t.analyst_score}
                            <InfoTooltip title="Analyst Score" body="Composite 0–100 score computed from 5 weighted dimensions: momentum, technical, sentiment, insider, and value. Threshold for a trade proposal is set in Settings → Strategy." bullets={["≥ 70: strong signal", "50–69: moderate — review thesis", "< 50: not proposed"]} placement="top" />
                          </span>
                        </div>
                        <div style={{ display: "flex", gap: "8px" }}>
                          <button
                            onClick={() => handleApprove(t.id)}
                            disabled={acting === t.id}
                            style={{ padding: "6px 16px", background: T.greenBg, border: `1px solid ${T.green}`, borderRadius: "7px", color: T.green, fontSize: "12px", fontWeight: 600, cursor: acting ? "default" : "pointer", opacity: acting === t.id ? 0.5 : 1 }}>
                            {acting === t.id ? "…" : "✓ Approve"}
                          </button>
                          <button
                            onClick={() => handleReject(t.id)}
                            disabled={acting === t.id}
                            style={{ padding: "6px 16px", background: T.redBg, border: `1px solid ${T.red}`, borderRadius: "7px", color: T.red, fontSize: "12px", fontWeight: 600, cursor: acting ? "default" : "pointer", opacity: acting === t.id ? 0.5 : 1 }}>
                            ✕ Reject
                          </button>
                        </div>
                      </div>
                      {t.rationale && <div style={{ fontSize: "12px", color: T.textSub, lineHeight: "1.6" }}>{String(t.rationale).slice(0, 300)}</div>}
                      <div style={{ fontSize: "10px", color: T.muted, marginTop: "6px" }}>Account: ••••{String(t.account_number ?? "").slice(-4)} · {timeAgo(t.created_at)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {decided.length > 0 && (
              <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
                <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "14px" }}>History</div>
                <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                  <thead>
                    <tr style={{ color: T.muted }}>
                      {["Symbol","Side","Qty","Price","Score","Status","Date"].map(h => (
                        <th key={h} style={{ padding: "4px 12px 8px 0", fontWeight: 500, fontSize: "11px", textTransform: "uppercase", textAlign: "left" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {decided.map(t => (
                      <tr key={t.id} style={{ borderTop: `1px solid ${T.border}` }}>
                        <td style={{ padding: "8px 12px 8px 0", fontWeight: 700 }}>{t.symbol}</td>
                        <td style={{ padding: "8px 12px 8px 0" }}><span style={{ fontSize: "11px", fontWeight: 600, padding: "2px 6px", borderRadius: "4px", background: T.greenBg, color: T.green }}>{t.order_side?.toUpperCase()}</span></td>
                        <td style={{ padding: "8px 12px 8px 0" }}>{t.qty}</td>
                        <td style={{ padding: "8px 12px 8px 0" }}>${t.limit_price?.toFixed(2)}</td>
                        <td style={{ padding: "8px 12px 8px 0", fontWeight: 600, color: (t.analyst_score ?? 0) >= 70 ? T.green : T.amber }}>{t.analyst_score}</td>
                        <td style={{ padding: "8px 12px 8px 0" }}>
                          <span style={{ fontSize: "11px", fontWeight: 600, padding: "2px 8px", borderRadius: "4px", background: t.status === "executed" ? T.greenBg : t.status === "rejected" ? T.redBg : T.amberBg, color: t.status === "executed" ? T.green : t.status === "rejected" ? T.red : T.amber }}>
                            {t.status}
                          </span>
                        </td>
                        <td style={{ padding: "8px 0", color: T.muted, fontSize: "11px" }}>
                          {timeAgo(t.created_at)}
                          {/* Execution Gateway: paper-only send button for approved-not-yet-executed proposals. */}
                          {t.status === "approved" && (
                            <button
                              onClick={() => handleSendToAlpaca(t.id)}
                              disabled={sendingToAlpaca === t.id}
                              title="Sends this order to your Alpaca PAPER account via the Execution Gateway"
                              style={{ marginLeft: "8px", padding: "3px 10px", background: T.accent + "18", border: `1px solid ${T.accent}40`, borderRadius: "6px", color: T.accent, fontSize: "10px", fontWeight: 600, cursor: sendingToAlpaca === t.id ? "default" : "pointer" }}>
                              {sendingToAlpaca === t.id ? "Sending…" : "→ Alpaca (paper)"}
                            </button>
                          )}
                          {t.status === "approved" && (
                            <button
                              onClick={() => handleSendLive(t)}
                              disabled={sendingLive === t.id}
                              title="Places a REAL live order (real money) via the active US broker (Robinhood MCP). Double-confirmed."
                              style={{ marginLeft: "6px", padding: "3px 10px", background: "#F8717118", border: "1px solid #F8717155", borderRadius: "6px", color: "#F87171", fontSize: "10px", fontWeight: 700, cursor: sendingLive === t.id ? "default" : "pointer" }}>
                              {sendingLive === t.id ? "Placing…" : "⚠ Send LIVE"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )}

            {pending.length === 0 && decided.length === 0 && (
              <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "40px 20px", textAlign: "center" }}>
                <div style={{ fontSize: "32px", marginBottom: "12px" }}>⚡</div>
                <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "6px" }}>No trade queue entries</div>
                <div style={{ fontSize: "13px", color: T.muted }}>Run TraderAgent from the Agents page to generate proposals.</div>
              </div>
            )}
          </div>
        )}

        {/* INSIDER FLOW — INDIA (live NSE PIT disclosures) */}
        {tab === "insider" && isIndia && (
          nseInsiderLoading ? (
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "40px 20px", textAlign: "center" }}>
              <div style={{ fontSize: "24px", marginBottom: "10px" }}>⏳</div>
              <div style={{ fontSize: "13px", color: T.muted }}>Fetching insider disclosures from NSE…</div>
            </div>
          ) : nseInsider && nseInsider.available ? (
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
              <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "4px" }}>NSE Insider Disclosures (SEBI PIT)</div>
              <div style={{ fontSize: "11px", color: T.muted, marginBottom: "14px" }}>Live from NSE (free, may be rate-limited)</div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", minWidth: "640px" }}>
                  <thead>
                    <tr style={{ color: T.muted }}>
                      {["Symbol","Person","Type","Qty","₹ Value","Date"].map(h => (
                        <th key={h} style={{ padding: "4px 10px 8px 0", fontWeight: 500, fontSize: "11px", textTransform: "uppercase", textAlign: "left", whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {nseInsider.trades.map((t: any, i: number) => {
                      const isBuy = String(t.type).toUpperCase().includes("BUY");
                      const isSell = String(t.type).toUpperCase().includes("SELL");
                      return (
                        <tr key={i} style={{ borderTop: `1px solid ${T.border}` }}>
                          <td style={{ padding: "8px 10px 8px 0", fontWeight: 700 }}>{t.symbol || "—"}</td>
                          <td style={{ padding: "8px 10px 8px 0", maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.person}>{t.person}</td>
                          <td style={{ padding: "8px 10px 8px 0" }}>
                            <span style={{ fontSize: "11px", fontWeight: 600, padding: "2px 8px", borderRadius: "4px", background: isBuy ? T.greenBg : isSell ? T.redBg : T.amberBg, color: isBuy ? T.green : isSell ? T.red : T.amber }}>
                              {String(t.type).toUpperCase()}
                            </span>
                          </td>
                          <td style={{ padding: "8px 10px 8px 0", fontFamily: "monospace" }}>{t.qty != null ? Number(t.qty).toLocaleString("en-IN") : "—"}</td>
                          <td style={{ padding: "8px 10px 8px 0", fontFamily: "monospace" }}>{t.value != null ? `₹${Number(t.value).toLocaleString("en-IN")}` : "—"}</td>
                          <td style={{ padding: "8px 0", color: T.muted, fontSize: "11px", whiteSpace: "nowrap" }}>{t.date ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <IndiaUnavailable what="insider" />
          )
        )}
        {tab === "insider" && !isIndia && (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
            <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "4px" }}>High Insider Score Signals (Last 7 Days)</div>
            <div style={{ fontSize: "11px", color: T.muted, marginBottom: "14px" }}>Signals where ResearchAgent scored insider_score ≥ 55 — indicates net insider buying detected via Alpha Vantage data.</div>
            {highInsider.length === 0 ? (
              <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "30px 0" }}>No high-insider signals in the past 7 days.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {highInsider.map((s, i) => {
                  const cls = CLASS_META[s.asset_class ?? "us_equity"] ?? CLASS_META.us_equity;
                  return (
                    <div key={i} style={{ background: T.surface, borderRadius: "10px", padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
                      <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                        <span style={{ fontWeight: 700, fontSize: "14px" }}>{s.symbol}</span>
                        <span style={{ fontSize: "10px", color: cls.color, border: `1px solid ${cls.color}30`, borderRadius: "4px", padding: "1px 5px" }}>{cls.icon} {cls.label}</span>
                        <span style={{ fontSize: "11px", fontWeight: 600, padding: "2px 8px", borderRadius: "4px", background: s.direction === "long" ? T.greenBg : s.direction === "short" ? T.redBg : T.amberBg, color: s.direction === "long" ? T.green : s.direction === "short" ? T.red : T.amber }}>{s.direction?.toUpperCase()}</span>
                      </div>
                      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                        <ScorePill score={s.insider_score ?? 0} dim="insider" />
                        <ScorePill score={s.analyst_score ?? 0} dim="analyst" />
                        <span style={{ fontSize: "11px", color: T.muted }}>{timeAgo(s.created_at)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* FORM 4 → OPTIONS FLOW — INDIA (live NSE option chain) */}
        {tab === "form4" && isIndia && (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "4px", gap: "12px", flexWrap: "wrap" }}>
              <div style={{ fontWeight: 700, fontSize: "14px" }}>NSE Options Flow — {nseOptSymbol}</div>
              <div style={{ display: "flex", gap: "4px", background: T.surface, padding: "3px", borderRadius: "8px" }}>
                {(["NIFTY", "BANKNIFTY"] as const).map(s => (
                  <button key={s} onClick={() => setNseOptSymbol(s)}
                    style={{ padding: "5px 12px", borderRadius: "6px", border: "none", cursor: "pointer", fontSize: "11px", fontWeight: 600, background: nseOptSymbol === s ? T.card : "transparent", color: nseOptSymbol === s ? T.text : T.muted }}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ fontSize: "11px", color: T.muted, marginBottom: "16px" }}>Live from NSE (free, may be rate-limited)</div>

            {nseOptionsLoading && (
              <div style={{ textAlign: "center", padding: "40px 20px" }}>
                <div style={{ fontSize: "24px", marginBottom: "10px" }}>⏳</div>
                <div style={{ fontSize: "13px", color: T.muted }}>Fetching option chain from NSE…</div>
              </div>
            )}

            {!nseOptionsLoading && nseOptions && !nseOptions.available && <IndiaUnavailable what="options / Form 4" />}

            {!nseOptionsLoading && nseOptions && nseOptions.available && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: "10px", marginBottom: "18px" }}>
                  {[
                    { label: "Underlying", value: nseOptions.underlying != null ? `₹${Number(nseOptions.underlying).toLocaleString("en-IN")}` : "—", color: T.text },
                    { label: "PCR (Put/Call OI)", value: nseOptions.pcr != null ? nseOptions.pcr : "—", color: nseOptions.pcr != null ? (nseOptions.pcr > 1 ? T.green : T.red) : T.muted },
                    { label: "Total Call OI", value: Number(nseOptions.totalCallOI ?? 0).toLocaleString("en-IN"), color: T.red },
                    { label: "Total Put OI", value: Number(nseOptions.totalPutOI ?? 0).toLocaleString("en-IN"), color: T.green },
                  ].map(m => (
                    <div key={m.label} style={{ background: T.surface, borderRadius: "10px", padding: "12px 14px" }}>
                      <div style={{ fontSize: "18px", fontWeight: 700, color: m.color, fontFamily: "monospace" }}>{m.value}</div>
                      <div style={{ fontSize: "11px", color: T.muted, marginTop: "3px" }}>{m.label}</div>
                    </div>
                  ))}
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", minWidth: "440px" }}>
                    <thead>
                      <tr style={{ color: T.muted }}>
                        {["Strike","Call OI","Put OI"].map(h => (
                          <th key={h} style={{ padding: "4px 10px 8px 0", fontWeight: 500, fontSize: "11px", textTransform: "uppercase", textAlign: "left", whiteSpace: "nowrap" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(nseOptions.topStrikes ?? []).map((s: any, i: number) => (
                        <tr key={i} style={{ borderTop: `1px solid ${T.border}` }}>
                          <td style={{ padding: "8px 10px 8px 0", fontWeight: 700, fontFamily: "monospace" }}>₹{Number(s.strike).toLocaleString("en-IN")}</td>
                          <td style={{ padding: "8px 10px 8px 0", fontFamily: "monospace", color: T.red }}>{Number(s.callOI).toLocaleString("en-IN")}</td>
                          <td style={{ padding: "8px 10px 8px 0", fontFamily: "monospace", color: T.green }}>{Number(s.putOI).toLocaleString("en-IN")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
        {tab === "form4" && !isIndia && (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "4px", flexWrap: "wrap", gap: "8px" }}>
              <div style={{ fontWeight: 700, fontSize: "14px" }}>SEC Form 4 — Insider Transactions</div>
              {edgarData && (
                <div style={{ display: "flex", gap: "12px", fontSize: "11px" }}>
                  <span style={{ color: T.green }}>▲ {edgarData.buys} buy{edgarData.buys !== 1 ? "s" : ""}</span>
                  <span style={{ color: T.red }}>▼ {edgarData.sells} sell{edgarData.sells !== 1 ? "s" : ""}</span>
                  <span style={{ color: T.muted }}>{edgarData.symbols?.join(", ")}</span>
                </div>
              )}
            </div>
            <div style={{ fontSize: "11px", color: T.muted, marginBottom: "16px" }}>
              Direct from SEC EDGAR — Form 4 filings for held + watchlist symbols. Last 90 days.
              {edgarData && <span> · Fetched {new Date(edgarData.fetchedAt).toLocaleTimeString()}</span>}
            </div>

            {edgarLoading && (
              <div style={{ textAlign: "center", padding: "40px 20px" }}>
                <div style={{ fontSize: "24px", marginBottom: "10px" }}>⏳</div>
                <div style={{ fontSize: "13px", color: T.muted }}>Fetching Form 4 data from SEC EDGAR…</div>
                <div style={{ fontSize: "11px", color: T.muted, marginTop: "6px" }}>SEC rate-limits to 10 req/s — may take 15–30s for multiple symbols</div>
              </div>
            )}

            {edgarError && (
              <div style={{ background: T.redBg, border: `1px solid ${T.red}40`, borderRadius: "8px", padding: "12px 14px", fontSize: "12px", color: T.red }}>
                EDGAR fetch error: {edgarError}
              </div>
            )}

            {!edgarLoading && edgarData && edgarData.transactions.length === 0 && (
              <div style={{ textAlign: "center", padding: "30px 20px", color: T.muted, fontSize: "13px" }}>
                No Form 4 filings found in last 90 days for tracked symbols.
              </div>
            )}

            {!edgarLoading && edgarData && edgarData.transactions.length > 0 && (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", minWidth: "760px" }}>
                  <thead>
                    <tr style={{ color: T.muted }}>
                      {["Symbol","Insider","Role","Type","Security","Shares","Price","Value","Date"].map(h => (
                        <th key={h} style={{ padding: "4px 10px 8px 0", fontWeight: 500, fontSize: "11px", textTransform: "uppercase", textAlign: "left", whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {edgarData.transactions.map((t: any, i: number) => (
                      <tr key={i} style={{ borderTop: `1px solid ${T.border}` }}>
                        <td style={{ padding: "8px 10px 8px 0", fontWeight: 700 }}>{t.symbol}</td>
                        <td style={{ padding: "8px 10px 8px 0", maxWidth: "140px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.name}>{t.name}</td>
                        <td style={{ padding: "8px 10px 8px 0", color: T.muted, fontSize: "11px" }}>{t.role}</td>
                        <td style={{ padding: "8px 10px 8px 0" }}>
                          <span style={{ fontSize: "11px", fontWeight: 600, padding: "2px 8px", borderRadius: "4px", background: t.transactionType === "buy" ? T.greenBg : t.transactionType === "sell" ? T.redBg : T.amberBg, color: t.transactionType === "buy" ? T.green : t.transactionType === "sell" ? T.red : T.amber }}>
                            {t.transactionType.toUpperCase()}
                          </span>
                        </td>
                        <td style={{ padding: "8px 10px 8px 0", color: T.muted, fontSize: "11px", maxWidth: "100px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.securityTitle}</td>
                        <td style={{ padding: "8px 10px 8px 0", fontFamily: "monospace" }}>{t.shares.toLocaleString()}</td>
                        <td style={{ padding: "8px 10px 8px 0", fontFamily: "monospace" }}>{t.price > 0 ? `$${t.price.toFixed(2)}` : "—"}</td>
                        <td style={{ padding: "8px 10px 8px 0", fontWeight: 600, color: t.transactionType === "buy" ? T.green : t.transactionType === "sell" ? T.red : T.text, fontFamily: "monospace" }}>
                          {t.value > 0 ? `$${(t.value / 1000).toFixed(0)}k` : "—"}
                        </td>
                        <td style={{ padding: "8px 0", color: T.muted, fontSize: "11px", whiteSpace: "nowrap" }}>{t.date}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {!edgarLoading && !edgarData && !edgarError && (
              <div style={{ textAlign: "center", padding: "30px 20px" }}>
                <button
                  onClick={() => { setEdgarFetched(false); }}
                  style={{ padding: "10px 24px", background: T.accent, border: "none", borderRadius: "8px", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
                  Load Form 4 Data
                </button>
              </div>
            )}
          </div>
        )}

        {/* ALL SIGNALS */}
        {tab === "signals" && (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px" }}>
              <div style={{ fontWeight: 600, fontSize: "14px" }}>All Signals — Last 30 Days ({signals.length})</div>
              <InfoTooltip
                title="Score Columns"
                body="Each signal is scored 0–100 across 5 dimensions. Color: green ≥ 70, amber 50–69, red < 50."
                bullets={[
                  "Analyst: composite weighted score (what triggers a proposal)",
                  "Fund: fundamentals — P/E vs sector, FCF yield, revenue growth",
                  "Tech: technicals — RSI(14), EMA crossover, price vs 50-day MA",
                  "Sent: sentiment — news tone + StockTwits bullish ratio",
                  "Insider: insider buying — Form 4 cluster score via Alpha Vantage",
                ]}
                placement="bottom"
              />
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", minWidth: "700px" }}>
                <thead>
                  <tr style={{ color: T.muted }}>
                    {["Symbol","Class","Direction","Analyst","Fund","Tech","Sent","Macro","Insider","Date"].map(h => (
                      <th key={h} style={{ padding: "4px 10px 8px 0", fontWeight: 500, fontSize: "11px", textTransform: "uppercase", textAlign: "left", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {signals.map((s, i) => {
                    const cls = CLASS_META[s.asset_class ?? "us_equity"] ?? CLASS_META.us_equity;
                    return (
                      <tr key={i} style={{ borderTop: `1px solid ${T.border}` }}>
                        <td style={{ padding: "8px 10px 8px 0", fontWeight: 700 }}>{s.symbol}</td>
                        <td style={{ padding: "8px 10px 8px 0" }}><span style={{ fontSize: "10px", color: cls.color }}>{cls.icon}</span></td>
                        <td style={{ padding: "8px 10px 8px 0" }}>
                          <span style={{ fontSize: "11px", fontWeight: 600, padding: "1px 6px", borderRadius: "3px", background: s.direction === "long" ? T.greenBg : s.direction === "short" ? T.redBg : T.amberBg, color: s.direction === "long" ? T.green : s.direction === "short" ? T.red : T.amber }}>
                            {s.direction?.toUpperCase()}
                          </span>
                        </td>
                        {[s.analyst_score, s.fundamental_score, s.technical_score, s.sentiment_score, s.macro_score, s.insider_score].map((v, j) => (
                          <td
                            key={j}
                            style={{ padding: "8px 10px 8px 0", fontWeight: v != null ? 600 : 400, fontSize: v != null ? undefined : "10px", color: v == null ? T.muted : v >= 70 ? T.green : v >= 50 ? T.amber : T.red, fontFamily: v != null ? "monospace" : undefined }}
                            title={v == null ? "Not scored — this signal predates per-dimension scoring, or the scorer fell back to composite-only for this symbol" : undefined}
                          >
                            {v != null ? v : "not scored"}
                          </td>
                        ))}
                        <td style={{ padding: "8px 0", color: T.muted, fontSize: "11px", whiteSpace: "nowrap" }}>{timeAgo(s.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ASSET CLASSES */}
        {tab === "classes" && isIndia && <IndiaUnavailable what="multi-asset (ETF / metals)" />}
        {tab === "classes" && !isIndia && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {Object.entries(byClass).map(([cls, sigs]) => {
              const meta = CLASS_META[cls] ?? { label: cls, color: T.muted, icon: "◆" };
              const longs = sigs.filter(s => s.direction === "long").length;
              const shorts = sigs.filter(s => s.direction === "short").length;
              const avgScore = sigs.length ? Math.round(sigs.reduce((a, s) => a + (s.analyst_score ?? 0), 0) / sigs.length) : 0;
              return (
                <div key={cls} style={{ background: T.card, border: `1px solid ${meta.color}30`, borderRadius: "12px", padding: "20px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
                    <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                      <span style={{ fontSize: "20px" }}>{meta.icon}</span>
                      <span style={{ fontWeight: 700, fontSize: "15px", color: meta.color }}>{meta.label}</span>
                      <span style={{ fontSize: "12px", color: T.muted }}>{sigs.length} signal{sigs.length !== 1 ? "s" : ""}</span>
                    </div>
                    <div style={{ display: "flex", gap: "16px", fontSize: "13px" }}>
                      <span style={{ color: T.green }}>{longs} long</span>
                      <span style={{ color: T.red }}>{shorts} short</span>
                      <span style={{ color: T.accent }}>avg {avgScore}</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                    {sigs.map((s, i) => (
                      <div key={i} style={{ background: T.surface, borderRadius: "8px", padding: "8px 12px", display: "flex", gap: "8px", alignItems: "center" }}>
                        <span style={{ fontWeight: 700, fontSize: "13px" }}>{s.symbol}</span>
                        <span style={{ fontSize: "11px", fontWeight: 600, padding: "1px 6px", borderRadius: "3px", background: s.direction === "long" ? T.greenBg : T.amberBg, color: s.direction === "long" ? T.green : T.amber }}>{s.direction?.toUpperCase()}</span>
                        <span style={{ fontSize: "11px", color: (s.analyst_score ?? 0) >= 70 ? T.green : T.muted, fontFamily: "monospace" }}>{s.analyst_score}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            {Object.keys(byClass).length === 0 && (
              <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "40px 20px", textAlign: "center" }}>
                <div style={{ fontSize: "13px", color: T.muted }}>No signals yet. Run ResearchAgent to generate signals across asset classes.</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
