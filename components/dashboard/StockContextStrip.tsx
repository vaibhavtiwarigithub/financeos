"use client";
import { useState, useEffect } from "react";

// Stock Context strip (features/stock-context). Mobile-first, responsive by
// default. Shows name · one-liner · sector · exchange · mkt-cap tier · next
// earnings · up to 3 peer chips (peers are INERT context, never clickable
// trades) · a "why revisit" reason. DISPLAY-ONLY.
//
// Renders nothing while loading or when no profile is cached — it's a secondary,
// non-blocking strip, so it never blocks or jitters the page.

const T = {
  surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", amber: "#FBBF24", red: "#F87171",
};

const TIER_LABEL: Record<string, string> = {
  mega: "Mega cap", large: "Large cap", mid: "Mid cap", small: "Small cap", micro: "Micro cap",
};

interface SymbolProfile {
  symbol: string;
  market: "us" | "india";
  company_name: string | null;
  one_liner: string | null;
  sector: string | null;
  industry: string | null;
  exchange: string | null;
  market_cap_tier: string | null;
  next_earnings_date: string | null;
  peers: string[] | null;
  source: string | null;
  updated_at: string | null;
}

interface RevisitReason {
  reason: string;
  urgency: "high" | "medium" | "low" | "none";
}

// Peer-move attention (features/stock-context). ATTENTION-ONLY — related names
// that moved, NOT trade recommendations. Off the money path.
interface PeerMove {
  symbol: string;
  changePct: number;
  material: boolean;
}

function urgencyColor(u: string) {
  if (u === "high") return T.red;
  if (u === "medium") return T.amber;
  return T.muted;
}

function Datum({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: "5px", fontSize: "12px", whiteSpace: "nowrap" }}>
      <span style={{ color: T.muted, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
      <span style={{ color: valueColor ?? T.text, fontWeight: 600 }}>{value}</span>
    </span>
  );
}

export default function StockContextStrip({ symbol, market }: { symbol: string; market?: "us" | "india" }) {
  const [profile, setProfile] = useState<SymbolProfile | null>(null);
  const [revisit, setRevisit] = useState<RevisitReason | null>(null);
  const [peerMoves, setPeerMoves] = useState<PeerMove[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    const q = new URLSearchParams({ symbol });
    if (market) q.set("market", market);
    fetch(`/api/symbol-profile?${q.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setProfile(d?.profile ?? null);
        setRevisit(d?.revisit ?? null);
      })
      .catch(() => {})
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, [symbol, market]);

  // Peer moves load separately — a slower, optional attention line that must
  // never block or delay the main strip. Failure just shows nothing.
  useEffect(() => {
    let alive = true;
    const q = new URLSearchParams({ symbol });
    if (market) q.set("market", market);
    fetch(`/api/peer-moves?${q.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        const moves: PeerMove[] = Array.isArray(d?.moves) ? d.moves : [];
        // Attention-only: surface just the material movers.
        setPeerMoves(moves.filter((m) => m?.material));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [symbol, market]);

  // Non-blocking: render nothing until loaded, and nothing if there's no profile.
  if (!loaded || !profile) return null;

  const hasAnything =
    profile.company_name || profile.one_liner || profile.sector ||
    profile.exchange || profile.market_cap_tier || profile.next_earnings_date ||
    (profile.peers && profile.peers.length > 0) || revisit;
  if (!hasAnything) return null;

  const peers = (profile.peers ?? []).slice(0, 3);
  const earnings = profile.next_earnings_date
    ? new Date(profile.next_earnings_date + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
    : null;

  return (
    <div
      style={{
        background: T.surface, border: `1px solid ${T.border}`, borderRadius: "12px",
        padding: "clamp(12px, 3vw, 16px)", display: "flex", flexDirection: "column", gap: "10px",
      }}
    >
      {/* One-liner (what it does) */}
      {(profile.one_liner || profile.company_name) && (
        <div style={{ fontSize: "clamp(13px, 3.5vw, 14px)", color: T.text, fontWeight: 600, lineHeight: 1.4 }}>
          {profile.one_liner ?? profile.company_name}
        </div>
      )}

      {/* Facts row — wraps on mobile */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "12px 18px", alignItems: "baseline" }}>
        {profile.sector && <Datum label="Sector" value={profile.sector} />}
        {profile.exchange && <Datum label="Exchange" value={profile.exchange} />}
        {profile.market_cap_tier && (
          <Datum label="Size" value={TIER_LABEL[profile.market_cap_tier] ?? profile.market_cap_tier} valueColor={T.accent} />
        )}
        {earnings && <Datum label="Next earnings" value={earnings} valueColor={T.amber} />}
      </div>

      {/* Peers — INERT context chips, never clickable trades */}
      {peers.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
          <span style={{ color: T.muted, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.06em", marginRight: "2px" }}>
            Peers (context)
          </span>
          {peers.map((p) => (
            <span
              key={p}
              // Intentionally NOT a link/button — peers are context only.
              style={{
                fontSize: "11px", fontWeight: 600, color: T.textSub, background: T.card,
                border: `1px solid ${T.border}`, borderRadius: "6px", padding: "2px 8px",
                fontFamily: "monospace",
              }}
            >
              {p}
            </span>
          ))}
        </div>
      )}

      {/* Peers today — ATTENTION-ONLY. Related names that moved materially, so
          the user notices them. NOT recommendations, NOT trade signals — these
          are context, never clickable trades. Renders nothing when no peer moved
          (and always empty for India, which has no peers). Mobile-first: wraps. */}
      {peerMoves.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 10px", alignItems: "center" }}>
          <span style={{ color: T.muted, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.06em", marginRight: "2px" }}>
            Peers today
          </span>
          {peerMoves.map((m) => {
            const up = m.changePct >= 0;
            const color = up ? T.green : T.red;
            const arrow = up ? "▲" : "▼"; // ▲ / ▼
            return (
              <span
                key={m.symbol}
                // Context only — deliberately NOT a link/button.
                style={{ display: "inline-flex", alignItems: "baseline", gap: "4px", fontSize: "11px", whiteSpace: "nowrap" }}
              >
                <span style={{ fontFamily: "monospace", fontWeight: 600, color: T.textSub }}>{m.symbol}</span>
                <span style={{ color, fontWeight: 700 }}>
                  {up ? "+" : ""}{m.changePct.toFixed(1)}% {arrow}
                </span>
              </span>
            );
          })}
          <span style={{ color: T.muted, fontSize: "10px", fontStyle: "italic" }}>
            related names that moved — not recommendations
          </span>
        </div>
      )}

      {/* Revisit reason */}
      {revisit && (
        <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
          <span
            style={{
              width: "6px", height: "6px", borderRadius: "50%",
              background: urgencyColor(revisit.urgency), flexShrink: 0,
            }}
          />
          <span style={{ fontSize: "12px", color: T.textSub }}>{revisit.reason}</span>
        </div>
      )}
    </div>
  );
}
