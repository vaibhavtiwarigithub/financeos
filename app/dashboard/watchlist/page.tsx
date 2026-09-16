"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/dashboard/PageHeader";
import { useRole } from "@/lib/auth/use-role";
import { useMarket } from "@/lib/market-context";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", yellow: "#FBBF24",
};

type WatchItem = {
  id: string;
  symbol: string;
  market: string;
  added_at: string;
  last_score: number | null;
  last_researched_at: string | null;
};

function scoreColor(s: number | null) {
  if (s == null) return T.muted;
  if (s >= 70) return T.green;
  if (s >= 50) return T.yellow;
  return T.red;
}

export default function WatchlistPage() {
  const role = useRole();
  const router = useRouter();
  const { market } = useMarket();

  const [items, setItems] = useState<WatchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newSymbol, setNewSymbol] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    if (role === null) { router.replace("/login"); return; }
    if (role === undefined) return;
    load();
  }, [role, router]);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/user-watchlist");
    if (res.ok) {
      const data = await res.json();
      setItems(data.items ?? []);
    }
    setLoading(false);
  }

  async function addSymbol() {
    const sym = newSymbol.trim().toUpperCase();
    if (!sym) return;
    setAdding(true); setAddError(null);
    const res = await fetch("/api/user-watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: sym, market }),
    });
    setAdding(false);
    if (res.ok) { setNewSymbol(""); await load(); }
    else { const d = await res.json(); setAddError(d.error ?? "Could not add symbol"); }
  }

  async function removeSymbol(symbol: string, mkt: string) {
    const res = await fetch(`/api/user-watchlist?symbol=${symbol}&market=${mkt}`, { method: "DELETE" });
    if (res.ok) await load();
  }

  const filtered = items.filter(i => i.market === market);

  if (role === undefined) {
    return (
      <div style={{ minHeight: "100vh", background: T.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: T.muted, fontSize: "14px" }}>Loading…</div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "Inter, sans-serif" }}>
      <PageHeader title="My Watchlist" />
      <div style={{ maxWidth: "900px", margin: "0 auto", padding: "32px 16px" }}>

        {/* Add symbol */}
        <div style={{ display: "flex", gap: "8px", marginBottom: "24px", flexWrap: "wrap" }}>
          <input
            value={newSymbol}
            onChange={e => setNewSymbol(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === "Enter" && addSymbol()}
            placeholder={market === "india" ? "Add symbol (e.g. RELIANCE.NS)" : "Add symbol (e.g. NVDA)"}
            style={{
              flex: "1 1 220px", minWidth: 0, background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: "8px", color: T.text, padding: "10px 14px", fontSize: "14px",
            }}
          />
          <button
            onClick={addSymbol}
            disabled={adding || !newSymbol.trim()}
            style={{
              background: T.accent, color: T.text, border: "none", borderRadius: "8px",
              padding: "10px 20px", fontSize: "14px", fontWeight: 500,
              cursor: adding || !newSymbol.trim() ? "not-allowed" : "pointer",
              opacity: adding || !newSymbol.trim() ? 0.6 : 1,
            }}
          >
            {adding ? "Adding…" : "Add"}
          </button>
        </div>
        {addError && <div style={{ fontSize: "13px", color: T.red, marginBottom: "16px" }}>{addError}</div>}

        {loading ? (
          <div style={{ color: T.muted, fontSize: "14px" }}>Loading watchlist…</div>
        ) : filtered.length === 0 ? (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "40px", textAlign: "center" }}>
            <div style={{ fontSize: "15px", color: T.textSub, marginBottom: "8px" }}>No symbols in your watchlist yet</div>
            <div style={{ fontSize: "13px", color: T.muted }}>Add a symbol above to track its research and score history</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {filtered.map(item => (
              <div
                key={item.id}
                style={{
                  background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px",
                  padding: "16px 20px", display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap",
                }}
              >
                {/* Symbol + score */}
                <div style={{ flex: "0 0 auto", minWidth: "100px" }}>
                  <div style={{ fontWeight: 700, fontSize: "15px", letterSpacing: "0.03em" }}>{item.symbol}</div>
                  <div style={{ fontSize: "11px", color: T.muted, marginTop: "2px" }}>{item.market.toUpperCase()}</div>
                </div>

                {/* Score */}
                <div style={{ flex: "0 0 auto" }}>
                  {item.last_score != null ? (
                    <div style={{
                      background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px",
                      padding: "6px 12px", textAlign: "center",
                    }}>
                      <div style={{ fontSize: "11px", color: T.muted }}>Score</div>
                      <div style={{ fontSize: "18px", fontWeight: 700, color: scoreColor(item.last_score) }}>
                        {item.last_score}
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: "13px", color: T.muted }}>Not researched yet</div>
                  )}
                </div>

                {/* Last researched */}
                <div style={{ flex: "1 1 140px" }}>
                  {item.last_researched_at ? (
                    <div style={{ fontSize: "13px", color: T.textSub }}>
                      Last researched<br />
                      <span style={{ color: T.text }}>
                        {new Date(item.last_researched_at).toLocaleDateString()}
                      </span>
                    </div>
                  ) : (
                    <div style={{ fontSize: "13px", color: T.muted }}>Research pending</div>
                  )}
                </div>

                {/* Actions */}
                <div style={{ flex: "0 0 auto", display: "flex", gap: "8px" }}>
                  <button
                    onClick={() => router.push(`/dashboard/research/${item.symbol}?market=${item.market}`)}
                    style={{
                      background: T.surface, border: `1px solid ${T.border}`, color: T.accent,
                      borderRadius: "6px", padding: "6px 12px", fontSize: "12px", cursor: "pointer",
                    }}
                  >
                    Deep Dive →
                  </button>
                  <button
                    onClick={() => removeSymbol(item.symbol, item.market)}
                    style={{
                      background: "transparent", border: `1px solid ${T.border}`, color: T.muted,
                      borderRadius: "6px", padding: "6px 12px", fontSize: "12px", cursor: "pointer",
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {items.length > 0 && filtered.length === 0 && (
          <div style={{ fontSize: "13px", color: T.muted, textAlign: "center", padding: "24px" }}>
            No {market} symbols — switch market or add symbols above
          </div>
        )}
      </div>
    </div>
  );
}
