import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// Edge/Factor Discovery P0 — READ-ONLY Edge Catalog. Measure-only: these are
// deterministic price/volume edge values, NOT trade signals. Nothing here sizes
// or places anything. IC scorecards arrive in P1.
const T = {
  bg: "#0B0D12", card: "#1A1D27", surface: "#13151C", border: "#252836",
  text: "#ECEDEF", muted: "#6B7280", accent: "#6366F1", green: "#34D399",
  amber: "#FBBF24", amberBg: "#3B2F0B",
};

export default async function EdgesPage() {
  const svc = createServiceClient();
  const [catalogRes, recentRes, uniRes] = await Promise.all([
    svc.from("edge_catalog").select("*").order("category").order("edge_id"),
    svc.from("edge_signals").select("symbol, edge_id, market, raw_value, z_value, date").order("date", { ascending: false }).limit(500),
    svc.from("edge_universe_members").select("universe_id, market, symbol"),
  ]);
  const catalog = (catalogRes.data ?? []) as any[];
  const recent = (recentRes.data ?? []) as any[];
  const universe = (uniRes.data ?? []) as any[];

  const latestDate = recent.reduce((mx, r) => (r.date > mx ? r.date : mx), "");
  const countByEdgeMarket = new Map<string, number>();
  for (const r of recent) {
    const k = `${r.edge_id}|${r.market}`;
    countByEdgeMarket.set(k, (countByEdgeMarket.get(k) ?? 0) + 1);
  }
  const uniByMarket = universe.reduce((m: Record<string, number>, r: any) => { m[r.market] = (m[r.market] ?? 0) + 1; return m; }, {});

  const th: React.CSSProperties = { textAlign: "left", padding: "8px 12px 8px 0", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", color: T.muted, fontWeight: 500 };
  const td: React.CSSProperties = { padding: "10px 12px 10px 0", fontSize: "13px", color: T.text, verticalAlign: "top" };

  return (
    <div style={{ color: T.text, fontFamily: "'Inter', sans-serif", minHeight: "100vh", background: T.bg, padding: "24px" }}>
      <div style={{ maxWidth: "1080px" }}>
        <div style={{ fontSize: "12px", color: T.accent, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>Edge / Factor Discovery · P0</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "6px 0 4px" }}>Edge Catalog</h1>
        <div style={{ fontSize: "13px", color: T.muted, marginBottom: "16px" }}>
          Deterministic price/volume edges, computed from candles. {catalog.length} edges ·
          {" "}latest values {latestDate || "—"} · universe: US {uniByMarket["us"] ?? 0} · India {uniByMarket["india"] ?? 0} names.
        </div>

        {/* Honesty banner — measure-only + survivorship */}
        <div style={{ background: T.amberBg, border: `1px solid ${T.amber}44`, borderRadius: "10px", padding: "12px 14px", marginBottom: "18px", fontSize: "12.5px", color: T.amber, display: "flex", gap: "10px", alignItems: "flex-start" }}>
          <span>⚠️</span>
          <span style={{ color: T.text }}>
            <b style={{ color: T.amber }}>Measure-only.</b> These are raw + cross-sectionally z-scored edge values, NOT trade signals — they do not affect analyst_score, paper fills, sizing, or any live order. Information Coefficient (IC) scorecards — which decide whether any edge actually predicts returns — arrive in P1. The P0 universe is a <b>current-liquid snapshot</b>, not point-in-time index membership, so any downstream backtest carries survivorship bias until PIT membership is wired.
          </span>
        </div>

        {/* Catalog */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "16px", marginBottom: "16px", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "760px" }}>
            <thead><tr>
              <th style={th}>Edge</th><th style={th}>Category</th><th style={th}>Sign</th>
              <th style={th}>Horizon</th><th style={th}>Status</th>
              <th style={th}>Latest values (US / India)</th><th style={th}>Rationale</th>
            </tr></thead>
            <tbody>
              {catalog.map((e) => (
                <tr key={e.edge_id} style={{ borderTop: `1px solid ${T.border}` }}>
                  <td style={{ ...td, fontWeight: 600 }}>{e.name}<div style={{ fontSize: "11px", color: T.muted }}>{e.edge_id}</div></td>
                  <td style={td}>{e.category}</td>
                  <td style={{ ...td, color: e.expected_sign < 0 ? T.amber : T.green }}>{e.expected_sign < 0 ? "lower ✓" : "higher ✓"}</td>
                  <td style={td}>{e.horizon_days}d</td>
                  <td style={td}><span style={{ fontSize: "11px", padding: "2px 7px", borderRadius: "4px", background: T.surface, color: T.muted }}>{e.status}</span></td>
                  <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{countByEdgeMarket.get(`${e.edge_id}|us`) ?? 0} / {countByEdgeMarket.get(`${e.edge_id}|india`) ?? 0}</td>
                  <td style={{ ...td, color: T.muted, fontSize: "12px", maxWidth: "320px" }}>{e.rationale}</td>
                </tr>
              ))}
              {catalog.length === 0 && (
                <tr><td style={{ ...td, color: T.muted, textAlign: "center", padding: "24px" }} colSpan={7}>No edges yet — run EdgeScout (POST /api/agents/edge-scout) to seed the catalog + compute values.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div style={{ fontSize: "11px", color: T.muted }}>
          Run: <code style={{ background: T.surface, padding: "1px 5px", borderRadius: "4px" }}>POST /api/agents/edge-scout?market=both&amp;maxSymbols=40</code> (owner or cron). Backfill: add <code style={{ background: T.surface, padding: "1px 5px", borderRadius: "4px" }}>&amp;from=YYYY-MM-DD&amp;to=YYYY-MM-DD&amp;maxDays=10</code>.
        </div>
      </div>
    </div>
  );
}
