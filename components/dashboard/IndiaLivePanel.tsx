"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import PageHeader from "@/components/dashboard/PageHeader";
import { fmtMoney } from "@/lib/format-money";
import { useRevealToggle, maskText, EyeToggle } from "@/components/dashboard/PrivacyMask";
import LiveStatCards from "@/components/dashboard/LiveStatCards";
import LivePerformanceChart from "@/components/dashboard/LivePerformanceChart";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280", dim: "#1C1F26",
  accent: "#6366F1", accentBg: "#1E1F3A",
  green: "#34D399", greenBg: "#052E16",
  red: "#F87171", redBg: "#3B0000",
  amber: "#FBBF24", amberBg: "#2D1B00",
  blue: "#60A5FA", blueBg: "#0F1A2E",
};

// Mirror of lib/india-universe.ts NIFTY_50 (first 15 — keeps the score-history URL reasonable).
const NIFTY_15 = [
  "RELIANCE.NS", "HDFCBANK.NS", "ICICIBANK.NS", "INFY.NS", "TCS.NS",
  "ITC.NS", "LT.NS", "AXISBANK.NS", "SBIN.NS", "BHARTIARTL.NS",
  "KOTAKBANK.NS", "HINDUNILVR.NS", "BAJFINANCE.NS", "ASIANPAINT.NS", "MARUTI.NS",
];

type KiteStatus = {
  has_key: boolean;
  has_secret: boolean;
  token_fresh: boolean;
  connected: boolean;
  profile?: { user_name?: string; email?: string };
  live_error?: string | null;
};

type Holding = {
  symbol: string;
  tradingsymbol: string;
  exchange: string;
  qty: number;
  avg_price: number;
  last_price: number;
  pnl: number;
  value: number;
};

type Portfolio = {
  holdings: Holding[];
  connected: boolean;
  currency?: string;
  cash?: number | null;
  nav?: number | null;
  error?: string;
};

type ScoreRow = {
  symbol: string;
  analyst_score: number;
  direction: string;
  rationale: string;
  created_at: string;
};

type Signal = { symbol: string; score: number; direction: string; rationale: string; created_at: string };

// ₹ full amount with Indian lakh/crore grouping (₹12,34,567.00) via the shared
// market-aware helper. Keeps the "₹—" empty display for null/non-finite inputs.
function inr(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "₹—";
  return fmtMoney(v, "india", digits);
}

function scoreColor(s: number): string {
  return s >= 70 ? T.green : s >= 50 ? T.amber : T.red;
}

export default function IndiaLivePanel() {
  // ── Connection status ──────────────────────────────────────────────────────
  const [status, setStatus] = useState<KiteStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  // ── Holdings ───────────────────────────────────────────────────────────────
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [portfolioLoading, setPortfolioLoading] = useState(true);

  // ── Scored India signals ───────────────────────────────────────────────────
  const [signals, setSignals] = useState<Signal[]>([]);
  const [signalsLoading, setSignalsLoading] = useState(true);

  // ── Order flow (per-symbol inline confirm) ─────────────────────────────────
  const [orderFor, setOrderFor] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT">("MARKET");
  const [limitPrice, setLimitPrice] = useState("");
  const [placing, setPlacing] = useState(false);
  const [orderResult, setOrderResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const connected = !!status?.connected;
  const { masked, setRevealed } = useRevealToggle();

  useEffect(() => {
    fetch("/api/kite/status")
      .then(r => r.json())
      .then((d: KiteStatus) => setStatus(d))
      .catch(() => setStatus(null))
      .finally(() => setStatusLoading(false));

    fetch("/api/kite/portfolio")
      .then(r => r.json())
      .then((d: Portfolio) => setPortfolio(d))
      .catch(() => setPortfolio({ holdings: [], connected: false, error: "Failed to load portfolio" }))
      .finally(() => setPortfolioLoading(false));

    fetch(`/api/charts/score-history?symbols=${NIFTY_15.join(",")}&period=ALL`)
      .then(r => r.json())
      .then((d: { bySymbol?: Record<string, ScoreRow[]> }) => {
        const bySymbol = d.bySymbol ?? {};
        const latest: Signal[] = [];
        for (const sym of Object.keys(bySymbol)) {
          const rows = bySymbol[sym] ?? [];
          if (rows.length === 0) continue;
          const row = rows[rows.length - 1]; // latest scored point
          latest.push({
            symbol: sym,
            score: row.analyst_score,
            direction: row.direction,
            rationale: row.rationale,
            created_at: row.created_at,
          });
        }
        latest.sort((a, b) => b.score - a.score);
        setSignals(latest);
      })
      .catch(() => setSignals([]))
      .finally(() => setSignalsLoading(false));
  }, []);

  // One stable idempotency key per order intent — reused across retries of the same
  // order so the server dedupes a double-submit; regenerated for each new order.
  const orderKeyRef = useRef<string>("");
  function openOrder(symbol: string) {
    setOrderFor(symbol);
    setQty(1);
    setSide("BUY");
    setOrderType("MARKET");
    setLimitPrice("");
    setOrderResult(null);
    orderKeyRef.current = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  const submitOrder = useCallback(async () => {
    if (!orderFor || !connected) return;
    setPlacing(true);
    setOrderResult(null);
    try {
      const body: Record<string, unknown> = {
        symbol: orderFor,
        transaction_type: side,
        quantity: qty,
        order_type: orderType,
        confirm: true,
        client_order_key: orderKeyRef.current,
        // Dashboard India buys are manual by nature (no research signal linked) — mark as
        // an audited manual override so the G1-parity gate lets them through and logs them.
        ...(side === "BUY" ? { manualOverride: true, overrideReason: "Manual India order placed from the India dashboard" } : {}),
      };
      if (orderType === "LIMIT") body.price = Number(limitPrice);
      const res = await fetch("/api/kite/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (d.success) {
        setOrderResult({ ok: true, msg: `Order placed — ID ${d.order_id}` });
      } else {
        setOrderResult({ ok: false, msg: d.error || "Order failed" });
      }
    } catch (e: any) {
      setOrderResult({ ok: false, msg: e?.message || "Network error" });
    } finally {
      setPlacing(false);
    }
  }, [orderFor, connected, side, qty, orderType, limitPrice]);

  const holdings = portfolio?.holdings ?? [];
  const holdingsConnected = portfolio?.connected ?? false;
  const totalValue = holdings.reduce((a, h) => a + (h.value ?? 0), 0);

  // Stat-card aggregates (parity with the US Live view) — all INR.
  const invested = holdings.reduce((a, h) => a + (h.avg_price ?? 0) * (h.qty ?? 0), 0);
  const totalPnl = holdings.reduce((a, h) => a + (h.pnl ?? 0), 0);
  const totalPnlPct = invested > 0 ? (totalPnl / invested) * 100 : 0;
  const cash = portfolio?.cash ?? null;
  const nav = portfolio?.nav ?? (cash != null ? cash + totalValue : totalValue);

  // ── Status bar content ──────────────────────────────────────────────────────
  function StatusBar() {
    if (statusLoading) {
      return <div style={{ fontSize: "12px", color: T.muted }}>Checking Kite connection…</div>;
    }
    if (!status?.has_key) {
      return (
        <div style={{ fontSize: "13px", color: T.red, display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: T.red, flexShrink: 0 }} />
          Add <strong style={{ color: T.text }}>KITE_API_KEY</strong> / <strong style={{ color: T.text }}>KITE_API_SECRET</strong> in Admin → API Vault to connect Zerodha.
        </div>
      );
    }
    if (connected) {
      return (
        <div style={{ fontSize: "13px", color: T.green, display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: T.green, flexShrink: 0 }} />
          Connected — <strong style={{ color: T.text }}>{status.profile?.user_name || "Zerodha user"}</strong> (token valid today)
        </div>
      );
    }
    // has_key but token stale — the graceful daily-token reminder.
    return (
      <div style={{ fontSize: "13px", color: T.amber, display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: T.amber, flexShrink: 0 }} />
        Kite token expired — reconnect to trade or read holdings.
        <a href="/api/kite/login" style={{ color: T.accent, fontWeight: 600, textDecoration: "none", border: `1px solid ${T.accent}44`, borderRadius: "6px", padding: "3px 10px", background: T.accentBg }}>
          Reconnect →
        </a>
        {status.live_error && <span style={{ fontSize: "11px", color: T.muted }}>· {status.live_error}</span>}
      </div>
    );
  }

  return (
    <div style={{ color: T.text, fontFamily: "'Inter', sans-serif", minHeight: "100vh", background: T.bg }}>
      <PageHeader
        title="India · Zerodha Kite"
        subtitle="NSE stocks scored on free data · real orders via Kite"
        cadence="daily"
        whatItDoes="Live NSE holdings from your Zerodha Kite account, plus AI-scored Indian stocks (NIFTY names) you can buy or sell with real orders. Kite issues a fresh access token each day — reconnect when it expires."
        whatToLookFor={[
          "Live NAV comes straight from your broker — your Zerodha Kite holdings value + cash (India, ₹). It updates on each sync, not live-by-the-second.",
          "Green status = token valid today; amber = reconnect before trading or reading holdings.",
          "Scored signals: score ≥ 70 green (strong), 50–69 amber (moderate), < 50 red.",
          "Only LONG, entry-eligible signals can open the Kite order panel; a second explicit confirmation is still required.",
          "Total value row sums your live NSE holdings in ₹.",
        ]}
      />

      <div style={{ padding: "16px clamp(12px,4vw,28px) 40px", maxWidth: "1200px" }}>

        {/* ── a) Connection status bar ── */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "14px", padding: "14px 18px", marginBottom: "16px" }}>
          <div style={{ fontSize: "10px", fontWeight: 700, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "8px" }}>
            Zerodha Connection
          </div>
          <StatusBar />
        </div>

        {/* ── Privacy toggle (parity with US Live) ── */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "12px" }}>
          <EyeToggle masked={masked} onToggle={() => setRevealed(r => !r)} />
        </div>

        {/* ── Stat cards (shared with US Live) ── */}
        {holdingsConnected && (
          <LiveStatCards
            market="india"
            equity={nav}
            buyingPower={cash}
            positions={holdings.length}
            invested={invested}
            totalPnl={totalPnl}
            totalPnlPct={totalPnlPct}
            dayPnl={null}
            brokerLabel="Zerodha Kite"
            masked={masked}
          />
        )}

        {/* ── Performance vs NIFTY 50 (shared, market-aware) ── */}
        <LivePerformanceChart market="india" />

        {/* ── b) Real holdings table ── */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "14px", padding: "20px", marginBottom: "16px" }}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "14px" }}>
            NSE Holdings {portfolio?.currency && <span style={{ color: T.textSub, fontWeight: 400 }}>({portfolio.currency})</span>}
          </div>

          {portfolioLoading ? (
            <div style={{ color: T.muted, fontSize: "13px", padding: "8px 0" }}>Loading holdings…</div>
          ) : !holdingsConnected ? (
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", padding: "10px 0" }}>
              <span style={{ color: T.muted, fontSize: "13px" }}>Connect Kite to see your NSE holdings.</span>
              <a href="/api/kite/login" style={{ color: T.accent, fontWeight: 600, textDecoration: "none", border: `1px solid ${T.accent}44`, borderRadius: "6px", padding: "4px 12px", fontSize: "12px", background: T.accentBg }}>
                Reconnect →
              </a>
              {portfolio?.error && <span style={{ fontSize: "11px", color: T.muted }}>· {portfolio.error}</span>}
            </div>
          ) : holdings.length === 0 ? (
            <div style={{ color: T.muted, fontSize: "13px", padding: "8px 0" }}>No NSE holdings in this Kite account.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", minWidth: "620px" }}>
                <thead>
                  <tr style={{ color: T.muted }}>
                    {["Symbol", "Qty", "Avg ₹", "LTP ₹", "P&L ₹", "Value ₹"].map((h, i) => (
                      <th key={h} style={{ padding: "4px 12px 8px 0", fontWeight: 500, fontSize: "11px", textTransform: "uppercase", textAlign: i === 0 ? "left" : "right", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {holdings.map((h, i) => (
                    <tr key={h.symbol + i} style={{ borderTop: `1px solid ${T.border}` }}>
                      <td style={{ padding: "9px 12px 9px 0", fontWeight: 700 }}>
                        {h.tradingsymbol || h.symbol}
                        <span style={{ marginLeft: "7px", fontSize: "9px", color: T.muted, fontWeight: 400 }}>{h.exchange}</span>
                      </td>
                      <td style={{ padding: "9px 12px 9px 0", textAlign: "right", fontFamily: "monospace" }}>{maskText(String(h.qty), masked)}</td>
                      <td style={{ padding: "9px 12px 9px 0", textAlign: "right", fontFamily: "monospace", color: T.textSub }}>{maskText(inr(h.avg_price), masked)}</td>
                      <td style={{ padding: "9px 12px 9px 0", textAlign: "right", fontFamily: "monospace" }}>{maskText(inr(h.last_price), masked)}</td>
                      <td style={{ padding: "9px 12px 9px 0", textAlign: "right", fontFamily: "monospace", fontWeight: 600, color: (h.pnl ?? 0) >= 0 ? T.green : T.red }}>
                        {maskText(((h.pnl ?? 0) >= 0 ? "+" : "") + inr(h.pnl), masked)}
                      </td>
                      <td style={{ padding: "9px 12px 9px 0", textAlign: "right", fontFamily: "monospace", fontWeight: 600 }}>{maskText(inr(h.value), masked)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: `2px solid ${T.border}` }}>
                    <td colSpan={5} style={{ padding: "10px 12px 4px 0", textAlign: "right", fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700 }}>Total Value</td>
                    <td style={{ padding: "10px 12px 4px 0", textAlign: "right", fontFamily: "monospace", fontWeight: 700, color: T.text }}>{maskText(inr(totalValue), masked)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>

        {/* ── c) Scored India signals ── */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "14px", padding: "20px" }}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "4px" }}>
            Scored India Signals
          </div>
          <div style={{ fontSize: "11px", color: T.muted, marginBottom: "16px" }}>
            Latest analyst_score per NIFTY name from the research agent. Sorted by score.
          </div>

          {signalsLoading ? (
            <div style={{ color: T.muted, fontSize: "13px", padding: "8px 0" }}>Loading scored signals…</div>
          ) : signals.length === 0 ? (
            <div style={{ color: T.muted, fontSize: "13px", padding: "8px 0", lineHeight: "1.6" }}>
              No scored Indian stocks yet — the research agent writes a point per symbol each run. Once NSE names are scored they&apos;ll appear here.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {signals.map(s => {
                const c = scoreColor(s.score);
                const isOpen = orderFor === s.symbol;
                const entryEligible = s.direction === "long";
                const canOpenOrder = entryEligible && connected;
                const rationale = s.rationale && !/^Analyst score \d+, direction neutral\.?$/i.test(s.rationale.trim())
                  ? s.rationale
                  : entryEligible
                    ? "Entry score passed; open Research Journal for the full evidence, catalysts, and risks."
                    : `No entry: direction is ${s.direction || "neutral"}. A high score alone cannot authorize a new position; see Research Journal for the failed evidence gate.`;
                return (
                  <div key={s.symbol} style={{ background: T.surface, borderRadius: "10px", padding: "14px 16px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", flexWrap: "wrap" }}>
                      <div style={{ flex: 1, minWidth: "200px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px", flexWrap: "wrap" }}>
                          <span style={{ fontWeight: 700, fontSize: "15px" }}>{s.symbol.replace(".NS", "")}</span>
                          <span style={{ fontSize: "12px", fontWeight: 700, padding: "2px 9px", borderRadius: "5px", background: c + "18", color: c, border: `1px solid ${c}30` }}>
                            {s.score}
                          </span>
                          {s.direction && (
                            <span style={{ fontSize: "11px", fontWeight: 600, padding: "2px 8px", borderRadius: "4px", background: s.direction === "long" ? T.greenBg : s.direction === "short" ? T.redBg : T.amberBg, color: s.direction === "long" ? T.green : s.direction === "short" ? T.red : T.amber }}>
                              {s.direction.toUpperCase()}
                            </span>
                          )}
                        </div>
                        {rationale && (
                          <div style={{ fontSize: "12px", color: T.textSub, lineHeight: "1.6" }}>
                            {String(rationale).slice(0, 260)}{String(rationale).length > 260 ? "…" : ""}
                          </div>
                        )}
                      </div>
                      <button
                        disabled={!canOpenOrder}
                        title={!entryEligible ? "Neutral signals cannot open a new BUY" : !connected ? "Reconnect Kite before opening an order" : "Open explicit real-money confirmation"}
                        onClick={() => { if (canOpenOrder) openOrder(s.symbol); }}
                        style={{
                          padding: "7px 16px", borderRadius: "7px", fontSize: "12px", fontWeight: 600, cursor: canOpenOrder ? "pointer" : "not-allowed",
                          background: !canOpenOrder ? T.dim : isOpen ? T.accentBg : T.accent, color: !canOpenOrder ? T.muted : isOpen ? T.accent : "#fff",
                          border: isOpen ? `1px solid ${T.accent}44` : "none", flexShrink: 0, whiteSpace: "nowrap",
                          opacity: canOpenOrder ? 1 : 0.7,
                        }}
                      >
                        {!entryEligible ? "Not entry-eligible" : !connected ? "Reconnect Kite" : isOpen ? "Order below ↓" : "Buy via Kite"}
                      </button>
                    </div>

                    {/* ── d) Inline real-order confirm panel ── */}
                    {isOpen && (
                      <div style={{ marginTop: "14px", background: T.bg, border: `2px solid ${T.amber}66`, borderRadius: "10px", padding: "14px 16px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
                          <span style={{ fontSize: "15px" }}>⚠</span>
                          <span style={{ fontSize: "12px", fontWeight: 700, color: T.amber, letterSpacing: "0.04em" }}>REAL MONEY ORDER</span>
                        </div>

                        {/* Controls */}
                        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "flex-end", marginBottom: "12px" }}>
                          {/* Qty */}
                          <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                            <span style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>Quantity</span>
                            <input
                              type="number" min={1} value={qty}
                              onChange={e => setQty(Math.max(1, parseInt(e.target.value, 10) || 1))}
                              style={{ background: T.dim, border: `1px solid ${T.border}`, borderRadius: "6px", color: T.text, fontSize: "13px", padding: "6px 10px", width: "90px", outline: "none", fontFamily: "inherit" }}
                            />
                          </label>

                          {/* Side toggle */}
                          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                            <span style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>Side</span>
                            <div style={{ display: "flex", gap: "4px" }}>
                              {(["BUY", "SELL"] as const).map(sd => (
                                <button key={sd} onClick={() => setSide(sd)}
                                  style={{
                                    padding: "6px 14px", borderRadius: "6px", fontSize: "12px", fontWeight: 600, cursor: "pointer",
                                    background: side === sd ? (sd === "BUY" ? T.greenBg : T.redBg) : "none",
                                    color: side === sd ? (sd === "BUY" ? T.green : T.red) : T.muted,
                                    border: `1px solid ${side === sd ? (sd === "BUY" ? T.green : T.red) + "88" : T.border}`,
                                  }}>
                                  {sd}
                                </button>
                              ))}
                            </div>
                          </div>

                          {/* Order type toggle */}
                          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                            <span style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>Type</span>
                            <div style={{ display: "flex", gap: "4px" }}>
                              {(["MARKET", "LIMIT"] as const).map(ot => (
                                <button key={ot} onClick={() => setOrderType(ot)}
                                  style={{
                                    padding: "6px 14px", borderRadius: "6px", fontSize: "12px", fontWeight: 600, cursor: "pointer",
                                    background: orderType === ot ? T.accentBg : "none",
                                    color: orderType === ot ? T.accent : T.muted,
                                    border: `1px solid ${orderType === ot ? T.accent + "88" : T.border}`,
                                  }}>
                                  {ot}
                                </button>
                              ))}
                            </div>
                          </div>

                          {/* Limit price (conditional) */}
                          {orderType === "LIMIT" && (
                            <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                              <span style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>Limit ₹</span>
                              <input
                                type="number" min={0} step="0.05" value={limitPrice}
                                onChange={e => setLimitPrice(e.target.value)}
                                placeholder="0.00"
                                style={{ background: T.dim, border: `1px solid ${T.border}`, borderRadius: "6px", color: T.text, fontSize: "13px", padding: "6px 10px", width: "110px", outline: "none", fontFamily: "inherit" }}
                              />
                            </label>
                          )}
                        </div>

                        {/* Warning sentence */}
                        <div style={{ fontSize: "12px", color: T.textSub, lineHeight: "1.6", marginBottom: "12px" }}>
                          Place a <strong style={{ color: side === "BUY" ? T.green : T.red }}>REAL {orderType} {side}</strong> order for{" "}
                          <strong style={{ color: T.text }}>{qty}</strong> share{qty !== 1 ? "s" : ""} of{" "}
                          <strong style={{ color: T.text }}>{s.symbol.replace(".NS", "")}</strong> on Zerodha
                          {orderType === "LIMIT" && limitPrice ? <> at <strong style={{ color: T.text }}>{inr(Number(limitPrice))}</strong></> : null}?
                          {" "}This uses <strong style={{ color: T.amber }}>real money</strong>.
                        </div>

                        {/* Confirm / cancel */}
                        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                          <button
                            onClick={submitOrder}
                            disabled={!connected || placing || (orderType === "LIMIT" && !limitPrice)}
                            title={!connected ? "Reconnect Kite to place orders" : undefined}
                            style={{
                              padding: "8px 18px", borderRadius: "8px", fontSize: "13px", fontWeight: 700,
                              cursor: (!connected || placing || (orderType === "LIMIT" && !limitPrice)) ? "not-allowed" : "pointer",
                              background: (!connected || placing || (orderType === "LIMIT" && !limitPrice)) ? T.dim : T.red,
                              color: (!connected || placing || (orderType === "LIMIT" && !limitPrice)) ? T.muted : "#fff",
                              border: `1px solid ${T.red}${(!connected || placing) ? "44" : ""}`,
                            }}
                          >
                            {placing ? "Placing…" : "Confirm real order"}
                          </button>
                          <button
                            onClick={() => { setOrderFor(null); setOrderResult(null); }}
                            style={{ padding: "8px 16px", borderRadius: "8px", fontSize: "13px", fontWeight: 600, cursor: "pointer", background: "none", color: T.muted, border: `1px solid ${T.border}` }}
                          >
                            Cancel
                          </button>
                          {!connected && (
                            <span style={{ fontSize: "11px", color: T.amber }}>Kite not connected — reconnect to enable ordering.</span>
                          )}
                        </div>

                        {/* Result */}
                        {orderResult && (
                          <div style={{ marginTop: "12px", background: orderResult.ok ? T.greenBg : T.redBg, border: `1px solid ${(orderResult.ok ? T.green : T.red)}40`, borderRadius: "8px", padding: "10px 14px", fontSize: "12px", color: orderResult.ok ? T.green : T.red }}>
                            {orderResult.ok ? "✓ " : "✕ "}{orderResult.msg}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
