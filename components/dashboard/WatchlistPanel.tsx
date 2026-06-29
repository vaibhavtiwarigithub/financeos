"use client";
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";

const T = {
  card: "#1A1D27", border: "#252836", text: "#ECEDEF", textSub: "#9B9EA8",
  muted: "#6B7280", dim: "#13151C", accent: "#6366F1", accentBg: "#1E1F3A",
  green: "#34D399", red: "#F87171", amber: "#FBBF24", blue: "#60A5FA",
  purple: "#A78BFA",
};

const SOURCE_META: Record<string, { label: string; color: string }> = {
  llm_theme:         { label: "AI Scout",    color: T.purple },
  manual:            { label: "Manual",      color: T.muted },
  tradingview_import:{ label: "TradingView", color: T.blue },
  robinhood_sync:    { label: "Robinhood",   color: T.green },
};

type WatchlistItem = {
  id: string;
  symbol: string;
  source: string;
  theme?: string;
  reason?: string;
  notes?: string;
  auto_added: boolean;
  expires_at?: string;
  created_at: string;
};

export default function WatchlistPanel() {
  const router = useRouter();
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newSymbol, setNewSymbol] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/watchlist")
      .then(r => r.json())
      .then(d => setItems(d.items ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function removeItem(symbol: string) {
    setItems(i => i.filter(x => x.symbol !== symbol));
    await fetch(`/api/watchlist?symbol=${symbol}`, { method: "DELETE" }).catch(() => {});
  }

  async function addManual() {
    const sym = newSymbol.trim().toUpperCase();
    if (!sym) return;
    setAdding(true);
    await fetch("/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: sym, source: "manual" }),
    });
    setNewSymbol("");
    setAdding(false);
    load();
  }

  // Group by theme/source
  const themed = items.filter(i => i.theme);
  const manual = items.filter(i => !i.theme);
  const themeGroups = new Map<string, WatchlistItem[]>();
  for (const item of themed) {
    const key = item.theme!;
    if (!themeGroups.has(key)) themeGroups.set(key, []);
    themeGroups.get(key)!.push(item);
  }

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <div>
          <div style={{ fontSize: "10px", fontWeight: 700, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
            Watchlist
          </div>
          <div style={{ fontSize: "11px", color: T.muted, marginTop: "2px" }}>
            {items.length} tracked · AI Scout refreshes daily
          </div>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            value={newSymbol}
            onChange={e => setNewSymbol(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === "Enter" && addManual()}
            placeholder="Add ticker…"
            style={{ background: T.dim, border: `1px solid ${T.border}`, borderRadius: "6px", color: T.text, padding: "5px 10px", fontSize: "12px", width: "100px", outline: "none" }}
          />
          <button
            onClick={addManual}
            disabled={adding || !newSymbol}
            style={{ background: T.accentBg, border: `1px solid ${T.accent}44`, color: T.accent, borderRadius: "6px", padding: "5px 10px", fontSize: "12px", cursor: "pointer", fontWeight: 600 }}
          >
            Add
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ color: T.muted, fontSize: "12px", textAlign: "center", padding: "20px" }}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ color: T.muted, fontSize: "12px", textAlign: "center", padding: "20px" }}>
          No items yet — AI Scout adds stocks daily based on market themes.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>

          {/* Theme groups (AI Scout) */}
          {[...themeGroups.entries()].map(([theme, stocks]) => (
            <div key={theme} style={{ background: T.dim, borderRadius: "8px", overflow: "hidden", border: `1px solid ${T.border}33` }}>
              <div style={{ padding: "8px 12px", background: `${T.purple}12`, borderBottom: `1px solid ${T.border}33`, display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "10px", fontWeight: 700, color: T.purple, background: `${T.purple}22`, padding: "1px 6px", borderRadius: "3px" }}>AI SCOUT</span>
                <span style={{ fontSize: "12px", fontWeight: 600, color: T.text }}>{theme}</span>
                <span style={{ fontSize: "10px", color: T.muted, marginLeft: "auto" }}>
                  {stocks[0]?.expires_at ? `expires ${new Date(stocks[0].expires_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
                </span>
              </div>
              {stocks[0]?.reason && (
                <div style={{ padding: "6px 12px 2px", fontSize: "11px", color: T.textSub, fontStyle: "italic" }}>
                  {stocks[0].reason}
                </div>
              )}
              {stocks.map(item => (
                <div
                  key={item.id}
                  style={{ display: "flex", alignItems: "center", padding: "7px 12px", borderBottom: `1px solid ${T.border}22`, cursor: "pointer" }}
                  onClick={() => router.push(`/dashboard/symbol/${item.symbol}`)}
                >
                  <span style={{ fontSize: "13px", fontWeight: 700, color: T.text, flex: 1 }}>{item.symbol}</span>
                  <span style={{ fontSize: "10px", color: T.muted, marginRight: "12px" }}>
                    {new Date(item.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </span>
                  <button
                    onClick={e => { e.stopPropagation(); removeItem(item.symbol); }}
                    style={{ background: "none", border: "none", color: T.muted, cursor: "pointer", fontSize: "14px", padding: "0 4px" }}
                    title="Remove from watchlist"
                  >×</button>
                </div>
              ))}
            </div>
          ))}

          {/* Manual items */}
          {manual.length > 0 && (
            <div style={{ background: T.dim, borderRadius: "8px", overflow: "hidden", border: `1px solid ${T.border}33` }}>
              <div style={{ padding: "8px 12px", borderBottom: `1px solid ${T.border}33` }}>
                <span style={{ fontSize: "10px", fontWeight: 700, color: T.muted }}>MANUALLY ADDED</span>
              </div>
              {manual.map(item => {
                const sm = SOURCE_META[item.source] ?? SOURCE_META.manual;
                return (
                  <div
                    key={item.id}
                    style={{ display: "flex", alignItems: "center", padding: "7px 12px", borderBottom: `1px solid ${T.border}22`, cursor: "pointer" }}
                    onClick={() => router.push(`/dashboard/symbol/${item.symbol}`)}
                  >
                    <span style={{ fontSize: "13px", fontWeight: 700, color: T.text, flex: 1 }}>{item.symbol}</span>
                    <span style={{ fontSize: "10px", color: sm.color, marginRight: "8px" }}>{sm.label}</span>
                    <span style={{ fontSize: "10px", color: T.muted, marginRight: "12px" }}>
                      {new Date(item.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </span>
                    {item.notes && (
                      <span
                        style={{ fontSize: "11px", color: T.textSub, marginRight: "8px", cursor: "pointer" }}
                        title={item.notes}
                        onClick={e => { e.stopPropagation(); setExpandedId(expandedId === item.id ? null : item.id); }}
                      >💬</span>
                    )}
                    <button
                      onClick={e => { e.stopPropagation(); removeItem(item.symbol); }}
                      style={{ background: "none", border: "none", color: T.muted, cursor: "pointer", fontSize: "14px", padding: "0 4px" }}
                    >×</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
