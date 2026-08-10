"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";

const T = {
  bg: "#0D0F1A", card: "#12141F", border: "#1E2030",
  text: "#E2E8F0", muted: "#64748B", accent: "#6366F1",
  green: "#22C55E", yellow: "#EAB308",
};

interface RecentSymbol {
  symbol: string;
  market: string;
  last_researched_at: string;
  analyst_score: number | null;
}

export default function FundamentalsLandingPage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<RecentSymbol[]>([]);

  useEffect(() => {
    const sb = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    sb.from("research_signals")
      .select("symbol, market, last_researched_at, analyst_score")
      .order("last_researched_at", { ascending: false })
      .limit(20)
      .then(({ data }) => {
        if (!data) return;
        // dedupe by symbol
        const seen = new Set<string>();
        const deduped: RecentSymbol[] = [];
        for (const row of data) {
          if (!seen.has(row.symbol)) { seen.add(row.symbol); deduped.push(row); }
        }
        setRecent(deduped.slice(0, 12));
      });
  }, []);

  function go(symbol: string) {
    if (!symbol.trim()) return;
    router.push(`/dashboard/research/${symbol.trim().toUpperCase()}`);
  }

  const filtered = query
    ? recent.filter(r => r.symbol.toLowerCase().includes(query.toLowerCase()))
    : recent;

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, padding: "24px 20px" }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Fundamentals</h1>
          <p style={{ color: T.muted, marginTop: 6, fontSize: 14 }}>
            Price charts · Technical indicators · Fundamental metrics · Score history · Trade markers
          </p>
        </div>

        {/* Search */}
        <div style={{ display: "flex", gap: 8, marginBottom: 32 }}>
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") go(query); }}
            placeholder="Enter symbol — e.g. NVDA, RELIANCE.NS"
            style={{
              flex: 1, background: T.card, border: `1px solid ${T.border}`,
              borderRadius: 8, padding: "12px 16px", color: T.text,
              fontSize: 15, outline: "none",
            }}
          />
          <button
            onClick={() => go(query)}
            style={{
              background: T.accent, border: "none", borderRadius: 8,
              color: "#fff", padding: "12px 20px", fontWeight: 600,
              fontSize: 14, cursor: "pointer",
            }}
          >
            Go →
          </button>
        </div>

        {/* Recent symbols */}
        {recent.length > 0 && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>
              Recently researched
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
              {filtered.map(r => (
                <button
                  key={r.symbol}
                  onClick={() => go(r.symbol)}
                  style={{
                    background: T.card, border: `1px solid ${T.border}`,
                    borderRadius: 8, padding: "12px 14px", textAlign: "left",
                    cursor: "pointer", color: T.text,
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{r.symbol}</div>
                  <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>
                    {r.market?.toUpperCase() ?? "US"}
                    {r.analyst_score != null && (
                      <span style={{ marginLeft: 6, color: r.analyst_score >= 60 ? T.green : r.analyst_score >= 40 ? T.yellow : T.muted }}>
                        {r.analyst_score}
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {recent.length === 0 && (
          <div style={{ color: T.muted, fontSize: 14, textAlign: "center", marginTop: 60 }}>
            No recent research yet. Type a symbol above to start.
          </div>
        )}
      </div>
    </div>
  );
}
