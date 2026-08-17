"use client";
import { useState, useEffect } from "react";
import PageHeader from "@/components/dashboard/PageHeader";
import ResearchFunnel from "@/components/dashboard/ResearchFunnel";
import ScoreTrackerPanel from "@/components/dashboard/ScoreTrackerPanel";
import DecisionReviewPanel from "@/components/dashboard/DecisionReviewPanel";
import PipelineHealthTab from "@/components/dashboard/PipelineHealthTab";
import { useMarket, type Market } from "@/lib/market-context";
import { useSearchParams } from "next/navigation";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", accentBg: "#1E1F3A",
  green: "#34D399", red: "#F87171", amber: "#FBBF24", blue: "#60A5FA",
};

// NOTE: a local `FunnelTab` used to live here — a full second copy of the
// funnel UI that was never rendered (the page has always used the shared
// <ResearchFunnel/> below). It was dead the day it was written, and it is
// removed rather than deep-linked: it drifted from the real component and
// was the reason this feature's spec described an expander that production
// never ran. Deep-link support lives in ResearchFunnel.tsx.

function EvolutionTab() {
  const { market } = useMarket();
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    fetch(`/api/agents/research-journal/evolution?market=${market}&days=90`).then(r => r.json()).then(setData).catch(() => {});
  }, [market]);

  if (!data) return <div style={{ fontSize: "13px", color: T.muted }}>Loading…</div>;

  const Card = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px 18px", marginBottom: "12px" }}>
      <div style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "0.08em", color: T.muted, textTransform: "uppercase" as const, marginBottom: "10px" }}>{title}</div>
      {children}
    </div>
  );

  const g = data.genome;
  const DIM_COLORS: Record<string, string> = {
    fundamental: "#34D399", technical: "#60A5FA", sentiment: "#FBBF24", macro: "#A78BFA", insider: "#F87171",
  };

  return (
    <div>
      {g && (
        <Card title={`Current Genome — ${market === "india" ? "🇮🇳 India" : "🇺🇸 US"} champion`}>
          {/* Phase gate — why the learner has (or hasn't) changed weights */}
          <div style={{ marginBottom: "14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
              <span style={{ fontSize: "12px", fontWeight: 700, color: g.phase === "adapting" ? T.green : T.amber }}>
                {g.phase === "adapting" ? "Phase 1 — adapting weights on outcomes" : "Phase 0 — gathering outcomes"}
              </span>
              <span style={{ fontSize: "11px", color: T.muted, fontVariantNumeric: "tabular-nums" as const }}>
                {g.closedTrades}/{g.phase1Threshold} closed trades
              </span>
            </div>
            <div style={{ height: "6px", background: T.border, borderRadius: "3px", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${Math.min(100, (g.closedTrades / g.phase1Threshold) * 100)}%`, background: g.phase === "adapting" ? T.green : T.amber }} />
            </div>
            <div style={{ fontSize: "11px", color: T.muted, marginTop: "6px", lineHeight: 1.5 }}>
              {g.phase === "adapting"
                ? "The learner has enough closed trades to mutate weights on evidence. Changes appear in the timeline below."
                : `The learner does NOT change weights until ${g.phase1Threshold} trades close for this market — ${g.tradesToUnlock} more to go. Until then it only records outcomes (this is deliberate: mutating on <10 trades would overfit to noise).`}
            </div>
          </div>

          {/* Current per-dimension weights (the REAL champion snapshot scoring uses) */}
          {g.weights ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {Object.entries(g.weights as Record<string, number | null>).map(([dim, w]) => (
                <div key={dim} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <span style={{ fontSize: "11px", color: T.textSub, width: "82px", textTransform: "capitalize" as const }}>{dim}</span>
                  <div style={{ flex: 1, height: "6px", background: T.border, borderRadius: "3px", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.round((w ?? 0) * 100)}%`, background: DIM_COLORS[dim] ?? T.accent }} />
                  </div>
                  <span style={{ fontSize: "11px", fontWeight: 600, color: T.text, width: "38px", textAlign: "right" as const, fontVariantNumeric: "tabular-nums" as const }}>
                    {w != null ? `${Math.round(w * 100)}%` : "—"}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: "12px", color: T.muted }}>No champion promoted for this market yet — scoring uses the risk-profile default weights.</div>
          )}
          <div style={{ fontSize: "10px", color: T.muted, marginTop: "10px" }}>
            {g.version ? `Champion v${g.version}` : "Seed genome"}
            {g.promotedAt ? ` · promoted ${new Date(g.promotedAt).toLocaleDateString()}` : ""}
            {` · ${g.challengers} active challenger${g.challengers === 1 ? "" : "s"}`}
            {" · US and India each carry their own champion — these weights are this market's alone."}
          </div>
        </Card>
      )}

      <Card title="LearnerAgent weight changes">
        {!data.learner.enoughHistory ? (
          <div style={{ fontSize: "12px", color: T.muted }}>Only {data.learner.runsCount} learner run(s) in the last 90 days — not enough history to show a trend yet.</div>
        ) : (
          <div style={{ display: "grid", gap: "4px" }}>
            {data.learner.weightSeries.map((w: any, i: number) => (
              <div key={i} style={{ fontSize: "12px", color: T.textSub }}>{w.date}: win rate {w.win_rate != null ? `${w.win_rate}%` : "—"}, mutations: {JSON.stringify(w.mutations)}</div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Feature registry timeline">
        {!data.featureRegistry.enoughHistory ? (
          <div style={{ fontSize: "12px", color: T.muted }}>Only {data.featureRegistry.events.length} status change(s) in the last 90 days — not enough history yet.</div>
        ) : (
          <div style={{ display: "grid", gap: "4px" }}>
            {data.featureRegistry.events.map((f: any, i: number) => (
              <div key={i} style={{ fontSize: "12px", color: T.textSub }}>{new Date(f.date).toLocaleDateString()}: feature #{f.feature_id} {f.from ?? "new"} → <b>{f.to}</b>{f.reason ? ` (${f.reason})` : ""}</div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Calibration drift">
        {!data.calibration.enoughHistory ? (
          <div style={{ fontSize: "12px", color: T.muted }}>Only {data.calibration.series.length} calibration fit(s) in the last 90 days — not enough history yet.</div>
        ) : (
          <div style={{ display: "grid", gap: "4px" }}>
            {data.calibration.series.map((c: any, i: number) => (
              <div key={i} style={{ fontSize: "12px", color: T.textSub }}>{new Date(c.date).toLocaleDateString()}: n={c.n_observations}, brier={c.brier ?? "—"}</div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Shadow decisions (challenger vs champion)">
        {!data.shadow.enoughHistory ? (
          <div style={{ fontSize: "12px", color: T.muted }}>Only {data.shadow.decisionsCount} shadow decision(s) in the last 90 days — not enough history yet.</div>
        ) : (
          <div style={{ fontSize: "12px", color: T.textSub }}>{data.shadow.decisionsCount} shadow decisions, {data.shadow.wouldEnterPct}% would-enter rate (not champion agreement — no such comparison is computed yet).</div>
        )}
      </Card>
    </div>
  );
}

export default function ResearchJournalPage() {
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const [tab, setTab] = useState<"funnel" | "evolution" | "scores" | "review" | "pipeline">(
    requestedTab === "evolution" || requestedTab === "scores" || requestedTab === "review" || requestedTab === "pipeline" ? requestedTab : "funnel"
  );

  // ── Deep link: /dashboard/research-journal?symbol=<SYM>&market=<us|india> ────
  // Entry point from the Risk Analytics research annotation — "this score is 4
  // days old" is only actionable if the owner can reach the entry behind it.
  //
  // The market half is load-bearing: US and India books must never cross-link,
  // so a deep link that names a market switches to it rather than rendering the
  // symbol against whichever book happened to be selected.
  const focusSymbol = searchParams.get("symbol");
  const rawMarket = searchParams.get("market");
  const deepLinkMarket: Market | null = rawMarket === "us" || rawMarket === "india" ? rawMarket : null;

  const { market, setMarket } = useMarket();
  const [marketSynced, setMarketSynced] = useState(false);

  // Converge on the deep-linked market, then stop.
  //
  // Ordering matters and is the reason this is not a one-shot mount effect:
  // MarketProvider restores the persisted market in its OWN mount effect, and
  // React fires child effects BEFORE parent effects — so a mount-only sync here
  // would be silently clobbered by localStorage a moment later. Depending on
  // `market` lets this re-assert once the provider has settled. `marketSynced`
  // then latches it off, so the owner's manual switch afterwards is never fought.
  //
  // setMarket ignores "india" when India is disabled; that guard stays authoritative.
  useEffect(() => {
    if (!deepLinkMarket || marketSynced) return;
    if (market !== deepLinkMarket) { setMarket(deepLinkMarket); return; }
    setMarketSynced(true);
  }, [deepLinkMarket, market, marketSynced, setMarket]);

  // A symbol deep link is a request to see that entry — the funnel is the only
  // tab that renders one, so honor it over a stale `tab` param.
  useEffect(() => { if (focusSymbol) setTab("funnel"); }, [focusSymbol]);

  return (
    <div style={{ color: T.text, fontFamily: "'Inter', sans-serif" }}>
      <PageHeader
        title="Research Journal"
        subtitle="Why the agent did (or didn't) act, and how the learning loop is evolving"
        whatItDoes="Three tabs explaining the agent's decisions and how it learns: Daily Funnel (why each symbol passed or failed each stage today), Evolution (how the learning loop is changing over time), and Score Tracker (one stock's AI score history with a drill-down)."
        whatToLookFor={[
          "Daily Funnel: every symbol scored today with its score breakdown, screener bucket, and pass/reject reason at each pipeline stage (research → portfolio constructor → execution) — a rejected symbol always has a reason.",
          "Evolution: longer-horizon trends — learner weight changes, feature-registry promotions, calibration drift, shadow-decision agreement — and it's honest about thin history (no trend from 1-2 points).",
          "Score Tracker: pick a stock to see its AI score move over time, then drill down into what drove each change.",
          "Decision Review: the counterfactual — what we scored vs how the stock actually moved afterward. Per-symbol rows are illustrative (n=1); the aggregate cohorts are actionable only above the 20-matured-outcome floor.",
        ]}
      />
      <div style={{ padding: "0 28px 32px" }}>
        <div style={{ display: "flex", gap: "8px", marginBottom: "20px", flexWrap: "wrap" }}>
          {(["funnel", "evolution", "scores", "review", "pipeline"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: "8px 18px", borderRadius: "8px", cursor: "pointer", fontSize: "13px", fontWeight: 600,
              background: tab === t ? T.accentBg : T.surface, border: `1px solid ${tab === t ? T.accent : T.border}`,
              color: tab === t ? T.accent : T.textSub,
            }}>
              {t === "funnel" ? "Daily Funnel" : t === "evolution" ? "Evolution" : t === "scores" ? "Score Tracker" : t === "review" ? "Decision Review" : "Pipeline Health"}
            </button>
          ))}
        </div>
        {tab === "funnel" ? <ResearchFunnel focusSymbol={focusSymbol} /> : tab === "evolution" ? <EvolutionTab /> : tab === "scores" ? <ScoreTrackerPanel embedded /> : tab === "review" ? <DecisionReviewPanel /> : <PipelineHealthTab />}
      </div>
    </div>
  );
}
