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
  const [catalogRes, recentRes, uniRes, icRes, marketStatusRes, readinessRes] = await Promise.all([
    svc.from("edge_catalog").select("*").order("category").order("edge_id"),
    svc.from("edge_signals").select("symbol, edge_id, market, raw_value, z_value, date").order("date", { ascending: false }).limit(500),
    svc.from("edge_universe_members").select("universe_id, market, symbol"),
    svc.from("edge_ic_history").select("edge_id, market, window_end, horizon, ic, ic_ir, t_stat, status_after, n_obs, universe_size, evidence_quality").order("window_end", { ascending: false }).limit(1000),
    svc.from("edge_market_status").select("edge_id, market, status, latest_window_end, n_obs_min, evidence_quality"),
    svc.from("edge_readiness_status").select("edge_id,market,horizon,policy_version,stage,windows_observed,windows_required,positive_windows,median_ic,median_t_stat,min_n_obs,latest_window_end,validation_windows_observed,validation_windows_required,median_net_of_fee_ic,next_action,evaluated_at").order("market").order("edge_id").order("horizon"),
  ]);
  const catalog = (catalogRes.data ?? []) as any[];
  const recent = (recentRes.data ?? []) as any[];
  const universe = (uniRes.data ?? []) as any[];
  const marketStatuses = (marketStatusRes.data ?? []) as any[];
  const readiness = (readinessRes.data ?? []) as any[];
  const readinessUnavailable = !!readinessRes.error;
  const marketStatusByKey = new Map(marketStatuses.map(r => [`${r.edge_id}|${r.market}`, r]));
  // Latest IC window per market. A newer US run must not hide India's latest
  // independent window (or vice versa).
  const icAll = (icRes.data ?? []) as any[];
  const latestWindowByMarket = new Map<string, string>();
  for (const r of icAll) {
    const previous = latestWindowByMarket.get(r.market) ?? "";
    if (r.window_end > previous) latestWindowByMarket.set(r.market, r.window_end);
  }
  const icByKey = new Map<string, any>();
  for (const r of icAll) if (r.window_end === latestWindowByMarket.get(r.market)) icByKey.set(`${r.edge_id}|${r.market}|${r.horizon}`, r);
  const IC_HORIZONS = [5, 10, 20];
  const statusColor = (s: string) => s === "shadow_eligible" ? T.green : s === "benched_negative" ? T.amber : T.muted;
  const readinessColor = (stage: string) => stage === "ready_for_shadow_review" || stage === "ready_for_validation_build"
    ? T.green : stage === "needs_stability" ? T.amber : T.muted;
  const readinessLabel = (stage: string) => ({
    collecting: "Collecting",
    needs_stability: "Needs stability",
    ready_for_validation_build: "Validation build ready",
    ready_for_shadow_review: "Shadow review ready",
  }[stage] ?? "Unavailable");
  const fmt3 = (v: any) => (v == null || !Number.isFinite(Number(v)) ? "—" : Number(v).toFixed(3));
  const fmt2 = (v: any) => (v == null || !Number.isFinite(Number(v)) ? "—" : Number(v).toFixed(2));
  const icScorecard: { edgeId: string; name: string; market: string; cells: any[]; status: string }[] = [];
  for (const market of ["us", "india"]) {
    for (const e of catalog) {
      const cells = IC_HORIZONS.map(h => icByKey.get(`${e.edge_id}|${market}|${h}`) ?? null);
      if (cells.every(c => !c)) continue;
      const status = marketStatusByKey.get(`${e.edge_id}|${market}`)?.status
        ?? (cells.find(c => c?.status_after === "shadow_eligible") ? "shadow_eligible"
          : cells.find(c => c?.status_after === "benched_negative") ? "benched_negative" : "measure_only");
      icScorecard.push({ edgeId: e.edge_id, name: e.name, market, cells, status });
    }
  }

  const latestDate = recent.reduce((mx, r) => (r.date > mx ? r.date : mx), "");
  const namesByEdgeMarket = new Map<string, Set<string>>();
  for (const r of recent) {
    const k = `${r.edge_id}|${r.market}`;
    if (!namesByEdgeMarket.has(k)) namesByEdgeMarket.set(k, new Set());
    namesByEdgeMarket.get(k)!.add(r.symbol);
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
                  <td style={td}>
                    {(["us", "india"] as const).map(market => {
                      const status = marketStatusByKey.get(`${e.edge_id}|${market}`)?.status ?? "no evidence";
                      return <div key={market} style={{ fontSize: "11px", color: statusColor(status) }}>{market.toUpperCase()}: {status}</div>;
                    })}
                  </td>
                  <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{namesByEdgeMarket.get(`${e.edge_id}|us`)?.size ?? 0} / {namesByEdgeMarket.get(`${e.edge_id}|india`)?.size ?? 0}</td>
                  <td style={{ ...td, color: T.muted, fontSize: "12px", maxWidth: "320px" }}>{e.rationale}</td>
                </tr>
              ))}
              {catalog.length === 0 && (
                <tr><td style={{ ...td, color: T.muted, textAlign: "center", padding: "24px" }} colSpan={7}>No edges yet — run EdgeScout (POST /api/agents/edge-scout) to seed the catalog + compute values.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Readiness monitor: governance progress, never trade permission. */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "16px", marginBottom: "16px", overflowX: "auto" }}>
          <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "2px" }}>Calibration Readiness</div>
          <div style={{ fontSize: "12px", color: T.muted, marginBottom: "12px" }}>
            Six stable weekly windows can request a cost-adjusted validation build. Shadow review additionally requires four point-in-time walk-forward cost/FDR windows. Neither milestone changes scoring or trading.
          </div>
          {readinessUnavailable ? (
            <div style={{ color: T.amber, fontSize: "13px", textAlign: "center", padding: "20px 0" }}>Readiness is unavailable. No zero or ready state is inferred; check System Health.</div>
          ) : readiness.length === 0 ? (
            <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "20px 0" }}>Readiness has not been evaluated yet. The daily monitor checks progress after weekly EdgeIC.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "900px" }}>
              <thead><tr>
                <th style={th}>Edge</th><th style={th}>Mkt</th><th style={th}>Horizon</th>
                <th style={th}>Weekly windows</th><th style={th}>Positive</th><th style={th}>Median IC / t</th>
                <th style={th}>Cost validation</th><th style={th}>Stage</th><th style={th}>Next</th>
              </tr></thead>
              <tbody>
                {readiness.map((row) => {
                  const progress = Math.min(100, Math.round(100 * Number(row.windows_observed ?? 0) / Math.max(1, Number(row.windows_required ?? 6))));
                  return (
                    <tr key={`${row.edge_id}|${row.market}|${row.horizon}`} style={{ borderTop: `1px solid ${T.border}` }}>
                      <td style={{ ...td, fontWeight: 600 }}>{row.edge_id}</td>
                      <td style={td}>{String(row.market).toUpperCase()}</td>
                      <td style={td}>{row.horizon}d</td>
                      <td style={{ ...td, minWidth: "120px" }}>
                        <div style={{ fontVariantNumeric: "tabular-nums", marginBottom: "4px" }}>{row.windows_observed}/{row.windows_required}</div>
                        <div style={{ width: "96px", height: "4px", background: T.surface, borderRadius: "2px", overflow: "hidden" }}>
                          <div style={{ width: `${progress}%`, height: "100%", background: readinessColor(row.stage) }} />
                        </div>
                      </td>
                      <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{row.positive_windows}/{row.windows_observed}</td>
                      <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{fmt3(row.median_ic)} / {fmt2(row.median_t_stat)}<div style={{ fontSize: "10px", color: T.muted }}>min N {row.min_n_obs ?? "-"}</div></td>
                      <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{row.validation_windows_observed}/{row.validation_windows_required}</td>
                      <td style={td}><span style={{ fontSize: "11px", color: readinessColor(row.stage) }}>{readinessLabel(row.stage)}</span></td>
                      <td style={{ ...td, color: T.muted, fontSize: "11px", maxWidth: "260px" }}>{row.next_action}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* IC scorecard (P1) — does an edge actually predict forward returns? */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "16px", marginBottom: "16px", overflowX: "auto" }}>
          <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "2px" }}>IC Scorecard <span style={{ fontSize: "11px", color: T.muted, fontWeight: 400 }}>· US {latestWindowByMarket.get("us") ?? "none"} · India {latestWindowByMarket.get("india") ?? "none"}</span></div>
          <div style={{ fontSize: "12px", color: T.muted, marginBottom: "12px" }}>
            Rank IC (Spearman) of each edge value vs its forward return, with a Newey-West t (corrects for overlapping windows). Positive IC = the edge ranks winners above losers. <b>Status is advisory</b> — “shadow_eligible” (IC ≥ 0.02 &amp; |t| ≥ 2) means it MAY enter shadow later; it grants no trade permission.
          </div>
          {icScorecard.length === 0 ? (
            <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "20px 0" }}>No IC computed yet — run EdgeIC (POST /api/agents/edge-ic).</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "720px" }}>
              <thead><tr>
                <th style={th}>Edge</th><th style={th}>Mkt</th>
                <th style={th}>IC 5d (t / N)</th><th style={th}>IC 10d (t / N)</th><th style={th}>IC 20d (t / N)</th><th style={th}>Status</th>
              </tr></thead>
              <tbody>
                {icScorecard.map((r) => (
                  <tr key={`${r.edgeId}|${r.market}`} style={{ borderTop: `1px solid ${T.border}` }}>
                    <td style={{ ...td, fontWeight: 600 }}>{r.name}</td>
                    <td style={td}>{r.market}</td>
                    {r.cells.map((c: any, i: number) => (
                      <td key={i} style={{ ...td, fontVariantNumeric: "tabular-nums", color: c && Number(c.ic) > 0 ? T.green : c ? T.muted : T.muted }}>
                        {c ? `${fmt3(c.ic)} (${fmt2(c.t_stat)} / ${c.n_obs ?? "?"})` : "—"}
                      </td>
                    ))}
                    <td style={td}><span style={{ fontSize: "11px", padding: "2px 7px", borderRadius: "4px", background: T.surface, color: statusColor(r.status) }}>{r.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ fontSize: "11px", color: T.muted }}>
          Run: <code style={{ background: T.surface, padding: "1px 5px", borderRadius: "4px" }}>POST /api/agents/edge-scout?market=both&amp;maxSymbols=40</code> then <code style={{ background: T.surface, padding: "1px 5px", borderRadius: "4px" }}>POST /api/agents/edge-ic?market=us&amp;maxSymbols=40</code> (owner or cron).
        </div>
      </div>
    </div>
  );
}
