"use client";

// A user's OWN risk analytics, computed from their own broker holdings.
//
// PATH NOTE: this is `/dashboard/my-risk`, deliberately NOT `/dashboard/risk`.
// That path is the OWNER's Daily Per-Holding Risk dashboard (PortfolioRiskPage),
// which reads the owner's live account book. Putting this page there would have
// replaced it — and, because this page is viewer-reachable, would have exposed
// the owner's book to every guest. Two different audiences, two paths.
//
// Two things this page must never do, both following from the feature's purpose
// rather than from taste:
//
//   1. Present a figure as current when it is not. The owner accepted the daily
//      Zerodha login (2026-09-14) on the condition that staleness is LOUD, so a
//      skipped run says why in a banner instead of rendering an empty state
//      that reads like "no risk found".
//   2. Recommend anything. This describes what the user already holds. It does
//      not suggest buying, selling or sizing — that is the line between a risk
//      report and advice, and it is deliberate.

import React, { useCallback, useEffect, useState } from "react";

const T = {
  card: "#12141F", border: "#1E2030", text: "#E2E8F0", textSub: "#9B9EA8",
  muted: "#64748B", accent: "#6366F1", red: "#EF4444",
  amber: "#EAB308", amberBg: "#2D1B00",
};

type Payload = {
  market: string;
  run: null | {
    status: "ok" | "skipped" | "error";
    skipReason: string | null;
    asOfDate: string | null;
    startedAt: string;
    completedAt: string | null;
    summary: any;
  };
  holdings: Array<{ symbol: string; as_of_date: string | null; metrics: any }>;
};

/** Plain-English reasons. A user should never have to read a database enum. */
const SKIP_COPY: Record<string, string> = {
  stale: "Your Zerodha session expired — Zerodha requires a fresh login each trading day. Reconnect to refresh these figures.",
  not_connected: "No broker is connected yet. Connect one to see risk analytics on your own holdings.",
  access_revoked: "Your access has been revoked, so nothing is being computed.",
  undecryptable: "Your stored session could not be read. Please reconnect.",
  unsupported: "This broker is not supported yet.",
  no_holdings: "Your account had no holdings at the last check, so there is nothing to analyse.",
};

export default function MyRiskPage() {
  const [market, setMarket] = useState<"india" | "us">("india");
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (m: string) => {
    try {
      const res = await fetch(`/api/user-risk?market=${m}`, { cache: "no-store" });
      if (!res.ok) { setError(`Could not load your risk analytics (${res.status})`); return; }
      setData(await res.json());
      setError(null);
    } catch (e: any) { setError(String(e?.message ?? e)); }
  }, []);

  useEffect(() => { void load(market); }, [load, market]);

  const card: React.CSSProperties = {
    background: T.card, border: `1px solid ${T.border}`,
    borderRadius: "12px", padding: "18px 20px", marginBottom: "14px",
  };

  const run = data?.run ?? null;
  const s = run?.summary ?? null;
  const money = (n: number) => `${s?.currency ?? ""}${Math.round(Number(n ?? 0)).toLocaleString()}`;
  const pct = (n: number) => `${(Number(n ?? 0) * 100).toFixed(1)}%`;

  return (
    <div style={{ padding: "24px", color: T.text, maxWidth: "980px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
        <h1 style={{ fontSize: "20px", fontWeight: 700 }}>Your Risk Analytics</h1>
        <div style={{ display: "flex", gap: "6px" }}>
          {(["india", "us"] as const).map((m) => (
            <button key={m} onClick={() => setMarket(m)} style={{
              background: market === m ? T.accent : "transparent",
              border: `1px solid ${market === m ? T.accent : T.border}`,
              color: market === m ? "#fff" : T.textSub,
              borderRadius: "6px", padding: "6px 14px", fontSize: "12px", fontWeight: 600, cursor: "pointer",
            }}>{m === "india" ? "India" : "US"}</button>
          ))}
        </div>
      </div>

      <p style={{ fontSize: "12px", color: T.muted, margin: "6px 0 18px", lineHeight: 1.6 }}>
        Computed from the holdings in <strong>your own</strong> brokerage account, which only you can see.
        This describes what you already hold — it is <strong>not</strong> advice, and suggests nothing to buy or sell.
      </p>

      {error && <div style={{ ...card, borderColor: T.red, color: T.red, fontSize: "12px" }}>{error}</div>}

      {data && !run && (
        <div style={{ ...card, fontSize: "12px", color: T.textSub }}>
          Nothing has been computed yet. Once a broker is connected, your figures appear here after the next daily run.
        </div>
      )}

      {run && run.status !== "ok" && (
        <div style={{ ...card, borderColor: T.amber, background: T.amberBg, fontSize: "12px", lineHeight: 1.6 }}>
          <strong style={{ color: T.amber }}>These figures are not current. </strong>
          {SKIP_COPY[String(run.skipReason ?? "")] ?? `The last run did not complete (${run.skipReason ?? run.status}).`}
          {" "}
          <a href="/dashboard/connections" style={{ color: T.accent }}>Manage connections</a>
        </div>
      )}

      {run && run.status === "ok" && s && (
        <>
          <div style={{ fontSize: "11px", color: T.muted, marginBottom: "10px" }}>
            As of {run.asOfDate ?? "—"} · {s.holdingCount} holdings · {money(s.totalValue)} total
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px", marginBottom: "14px" }}>
            {[
              { label: "Risk score", value: `${Math.round(s.riskScore)} · ${s.riskLabel}` },
              { label: "Portfolio beta", value: Number(s.portfolioBeta ?? 0).toFixed(2) },
              { label: "1-day 95% VaR", value: `${money(s.var95_dollar)} (${pct(s.var95_pct)})` },
              { label: "Est. max drawdown", value: pct(s.maxDrawdownEst) },
            ].map((tile) => (
              <div key={tile.label} style={{ ...card, marginBottom: 0 }}>
                <div style={{ fontSize: "11px", color: T.muted }}>{tile.label}</div>
                <div style={{ fontSize: "18px", fontWeight: 700, marginTop: "4px" }}>{tile.value}</div>
              </div>
            ))}
          </div>

          {Array.isArray(s.warnings) && s.warnings.length > 0 && (
            <div style={card}>
              <div style={{ fontSize: "12px", fontWeight: 600, marginBottom: "8px" }}>What stands out</div>
              {s.warnings.map((w: any, i: number) => (
                <div key={i} style={{ fontSize: "12px", color: T.textSub, marginBottom: "6px", lineHeight: 1.5 }}>
                  • {w.message ?? w.title ?? String(w)}
                </div>
              ))}
            </div>
          )}

          {/* Coverage is stated, not hidden. A symbol with no usable price history
              has MISSING correlation evidence — which is not the same as being
              uncorrelated, and the difference matters to anyone reading this. */}
          {s.coverage && ((s.coverage.uncovered?.length ?? 0) > 0 || (s.coverage.unpriced?.length ?? 0) > 0) && (
            <div style={{ ...card, fontSize: "11px", color: T.textSub, lineHeight: 1.6 }}>
              {(s.coverage.uncovered?.length ?? 0) > 0 && (
                <div>
                  No usable price history for {s.coverage.uncovered.join(", ")} — their correlation is
                  reported as <strong>unknown</strong>, not as zero.
                </div>
              )}
              {(s.coverage.unpriced?.length ?? 0) > 0 && (
                <div style={{ marginTop: "6px" }}>
                  Your broker returned no price for {s.coverage.unpriced.join(", ")}, so they are excluded from the totals above.
                </div>
              )}
            </div>
          )}

          {(data?.holdings.length ?? 0) > 0 && (
            <div style={{ ...card, overflowX: "auto" }}>
              <div style={{ fontSize: "12px", fontWeight: 600, marginBottom: "10px" }}>Your holdings</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", minWidth: "560px" }}>
                <thead>
                  <tr style={{ color: T.muted, textAlign: "left" }}>
                    {["Symbol", "Weight", "Value", "Sector", "Beta", "Correlated with"].map((h) => (
                      <th key={h} style={{ padding: "6px 8px", fontWeight: 500, borderBottom: `1px solid ${T.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(data?.holdings ?? []).map((h) => {
                    const m = h.metrics ?? {};
                    const corr = m.correlation;
                    return (
                      <tr key={h.symbol}>
                        <td style={{ padding: "7px 8px", fontWeight: 600 }}>{h.symbol}</td>
                        <td style={{ padding: "7px 8px" }}>{pct(m.weightPct)}</td>
                        <td style={{ padding: "7px 8px" }}>{money(m.marketValue)}</td>
                        <td style={{ padding: "7px 8px", color: T.textSub }}>{m.sector ?? "—"}</td>
                        <td style={{ padding: "7px 8px" }}>{Number(m.beta ?? 0).toFixed(2)}</td>
                        <td style={{ padding: "7px 8px", color: T.textSub }}>
                          {corr == null || corr.computable === false
                            ? "unknown"
                            : corr.peers?.length
                              ? corr.peers.join(", ")
                              : "none above threshold"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
