"use client";
import { useState, useEffect } from "react";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24",
  greenBg: "#052E16", redBg: "#3B0000", amberBg: "#2D1B00",
};

interface PeerRow {
  symbol: string;
  name: string;
  sector: string;
  marketCap: number | null;
  peRatio: number | null;
  forwardPE: number | null;
  eps: number | null;
  revenueGrowth: number | null;
  grossMargin: number | null;
  beta: number | null;
  dividendYield: number | null;
  analystTarget: number | null;
  week52High: number | null;
  week52Low: number | null;
}

interface PeersResponse {
  symbol: string;
  sector: string;
  industry: string;
  peers: PeerRow[];
  error?: string;
}

function relColor(value: number | null, target: number | null, higherIsBetter: boolean): string {
  if (value === null || target === null) return T.muted;
  const better = higherIsBetter ? value > target * 1.1 : value < target * 0.9;
  const worse = higherIsBetter ? value < target * 0.9 : value > target * 1.1;
  if (better) return T.green;
  if (worse) return T.red;
  return T.text;
}

function fmtCap(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toLocaleString()}`;
}

function fmtX(n: number | null): string {
  if (n === null) return "—";
  return `${n.toFixed(1)}x`;
}

function fmtPct(n: number | null): string {
  if (n === null) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function fmtEps(n: number | null): string {
  if (n === null) return "—";
  return `${n >= 0 ? "+$" : "-$"}${Math.abs(n).toFixed(2)}`;
}

function SkeletonRow() {
  return (
    <tr style={{ borderBottom: `1px solid ${T.border}22` }}>
      {Array.from({ length: 10 }).map((_, i) => (
        <td key={i} style={{ padding: "10px 12px" }}>
          <div style={{ height: "12px", borderRadius: "4px", background: T.border, opacity: 0.5, width: i === 1 ? "120px" : "50px" }} />
        </td>
      ))}
    </tr>
  );
}

export default function SymbolPeers({ symbol }: { symbol: string }) {
  const [data, setData] = useState<PeersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/charts/symbol-peers?symbol=${symbol}`)
      .then(r => r.json())
      .then((d: PeersResponse) => {
        if (d.error && !d.peers?.length) {
          setError(d.error);
        } else {
          setData(d);
        }
      })
      .catch(() => setError("Failed to load peer data"))
      .finally(() => setLoading(false));
  }, [symbol]);

  // Find the target row for relative coloring
  const target = data?.peers?.find(p => p.symbol === symbol) ?? null;

  // Sort peers by market cap desc; target stays in its natural position
  const sorted = data?.peers
    ? [...data.peers].sort((a, b) => {
        if (a.symbol === symbol) return -1;
        if (b.symbol === symbol) return 1;
        return (b.marketCap ?? 0) - (a.marketCap ?? 0);
      })
    : [];

  const headers = [
    { label: "Symbol", align: "left" as const },
    { label: "Name", align: "left" as const },
    { label: "Mkt Cap", align: "right" as const },
    { label: "P/E", align: "right" as const },
    { label: "Fwd P/E", align: "right" as const },
    { label: "EPS", align: "right" as const },
    { label: "Rev Growth", align: "right" as const },
    { label: "Gross Margin", align: "right" as const },
    { label: "Beta", align: "right" as const },
    { label: "Div Yield", align: "right" as const },
  ];

  if (error) {
    return (
      <div style={{ color: T.muted, fontSize: "13px", padding: "20px 0" }}>
        Peer data unavailable — {error}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <span style={{ fontSize: "11px", fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Peer Comparison
        </span>
        {data?.sector && (
          <>
            <span style={{ fontSize: "11px", color: T.border }}>·</span>
            <span style={{ fontSize: "11px", color: T.textSub }}>{data.sector}</span>
          </>
        )}
        {data?.industry && (
          <>
            <span style={{ fontSize: "11px", color: T.border }}>·</span>
            <span style={{ fontSize: "11px", color: T.muted }}>{data.industry}</span>
          </>
        )}
      </div>

      {/* Table */}
      <div style={{ overflowX: "auto", borderRadius: "10px", border: `1px solid ${T.border}` }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", minWidth: "760px" }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${T.border}`, background: T.surface }}>
              {headers.map(h => (
                <th
                  key={h.label}
                  style={{
                    padding: "10px 12px",
                    textAlign: h.align,
                    color: T.muted,
                    fontWeight: 600,
                    fontSize: "10px",
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                    whiteSpace: "nowrap",
                  }}
                >
                  {h.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} />)
              : sorted.map(peer => {
                  const isTarget = peer.symbol === symbol;
                  return (
                    <tr
                      key={peer.symbol}
                      style={{
                        borderBottom: `1px solid ${T.border}22`,
                        background: isTarget ? "#1E1F3A" : "transparent",
                        borderLeft: isTarget ? `3px solid ${T.accent}` : "3px solid transparent",
                        transition: "background 0.15s",
                      }}
                    >
                      {/* Symbol */}
                      <td style={{ padding: "10px 12px", textAlign: "left" }}>
                        <span style={{
                          fontWeight: isTarget ? 800 : 600,
                          color: isTarget ? T.accent : T.text,
                          fontFamily: "monospace",
                          fontSize: "12px",
                          letterSpacing: "0.02em",
                        }}>
                          {peer.symbol}
                          {isTarget && (
                            <span style={{ fontSize: "9px", color: T.accent, marginLeft: "4px", fontFamily: "sans-serif", fontWeight: 700 }}>
                              YOU
                            </span>
                          )}
                        </span>
                      </td>

                      {/* Name */}
                      <td style={{ padding: "10px 12px", textAlign: "left", color: T.textSub, maxWidth: "180px" }}>
                        <span style={{ display: "block", wordBreak: "break-word" }} title={peer.name ?? ""}>
                          {peer.name ?? "—"}
                        </span>
                      </td>

                      {/* Market Cap — no relative color */}
                      <td style={{ padding: "10px 12px", textAlign: "right", color: T.text, fontVariantNumeric: "tabular-nums" }}>
                        {fmtCap(peer.marketCap)}
                      </td>

                      {/* P/E — lower is better (value) */}
                      <td style={{ padding: "10px 12px", textAlign: "right", color: isTarget ? T.text : relColor(peer.peRatio, target?.peRatio ?? null, false), fontVariantNumeric: "tabular-nums" }}>
                        {fmtX(peer.peRatio)}
                      </td>

                      {/* Fwd P/E — lower is better */}
                      <td style={{ padding: "10px 12px", textAlign: "right", color: isTarget ? T.text : relColor(peer.forwardPE, target?.forwardPE ?? null, false), fontVariantNumeric: "tabular-nums" }}>
                        {fmtX(peer.forwardPE)}
                      </td>

                      {/* EPS — higher is better */}
                      <td style={{ padding: "10px 12px", textAlign: "right", color: isTarget ? T.text : relColor(peer.eps, target?.eps ?? null, true), fontVariantNumeric: "tabular-nums" }}>
                        {fmtEps(peer.eps)}
                      </td>

                      {/* Revenue Growth — higher is better */}
                      <td style={{ padding: "10px 12px", textAlign: "right", color: isTarget ? T.text : relColor(peer.revenueGrowth, target?.revenueGrowth ?? null, true), fontVariantNumeric: "tabular-nums" }}>
                        {fmtPct(peer.revenueGrowth)}
                      </td>

                      {/* Gross Margin — higher is better */}
                      <td style={{ padding: "10px 12px", textAlign: "right", color: isTarget ? T.text : relColor(peer.grossMargin, target?.grossMargin ?? null, true), fontVariantNumeric: "tabular-nums" }}>
                        {fmtPct(peer.grossMargin)}
                      </td>

                      {/* Beta — neutral */}
                      <td style={{ padding: "10px 12px", textAlign: "right", color: T.textSub, fontVariantNumeric: "tabular-nums" }}>
                        {peer.beta !== null ? peer.beta.toFixed(2) : "—"}
                      </td>

                      {/* Div Yield — neutral */}
                      <td style={{ padding: "10px 12px", textAlign: "right", color: T.textSub, fontVariantNumeric: "tabular-nums" }}>
                        {fmtPct(peer.dividendYield)}
                      </td>
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>

      {/* Footnote */}
      <div style={{ fontSize: "10px", color: T.muted, paddingTop: "2px" }}>
        Fundamentals via Alpha Vantage · 6h cache · Green/red cells are relative to {symbol}
      </div>
    </div>
  );
}
