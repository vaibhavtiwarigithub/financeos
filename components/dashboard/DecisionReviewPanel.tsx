"use client";
import { useState, useEffect } from "react";
import { useMarket } from "@/lib/market-context";

// ── Decision Review panel — READ-ONLY counterfactual surfacing ────────────────
// "We scored X on date D; the stock then did Y." Renders the matured forward
// returns from the ledger against the score/direction we recorded. It writes
// nothing and proposes nothing.
//
// Locked owner decision honored here:
//  - Per-symbol attribution is DECORATIVE and always carries an "n=1, illustrative"
//    tag. The actionable layer is the aggregate cohort section, which only shows a
//    hit-rate / avg return once a cohort clears the matured-sample floor (>=20).
//    Below the floor it shows the count and "insufficient matured sample".

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836", dim: "#1C1F26",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", accentBg: "#1E1F3A",
  green: "#34D399", red: "#F87171", amber: "#FBBF24", blue: "#60A5FA",
};

type Horizon = {
  horizon_days: number;
  matured: boolean;
  fwd_return?: number | null;
  benchmark_neutral_return?: number | null;
  max_adverse_excursion?: number | null;
  max_favorable_excursion?: number | null;
  directional_hit?: boolean | null;
  delta?: number | null;
  plan_outcome?: {
    objectiveReached: boolean;
    stopBreached: boolean;
    objectiveReachRatio: number;
  } | null;
};
type Attribution = {
  horizon_days: number;
  realized_alpha: number;
  most_wrong: { dim: string; contribution: number } | null;
  most_right: { dim: string; contribution: number } | null;
  illustrative: boolean;
};
type Decision = {
  id: number;
  ts: string;
  symbol: string;
  currency: string;
  analyst_score: number | null;
  score_threshold: number | null;
  direction: string | null;
  entry_eligible: boolean | null;
  confidence_band: string | null;
  price_at_decision: number | null;
  trade_plan: {
    status: string | null;
    reference_price: number | null;
    initial_risk_floor: number | null;
    profit_objective: number | null;
    stop_loss_pct: number | null;
    target_pct: number | null;
    horizon_sessions: number | null;
    reference_as_of: string | null;
  } | null;
  horizons: Horizon[];
  attribution: Attribution | null;
};
type CohortHorizon = {
  horizon_days: number;
  matured_count: number;
  actionable: boolean;
  staked_count?: number;
  hit_rate?: number | null;
  avg_forward_return?: number | null;
  avg_alpha?: number | null;
};
type Cohort = { key: string; label: string; total_decisions: number; horizons: CohortHorizon[] };
type PlanCalibration = {
  horizonDays: number;
  n: number;
  adjustmentFloor: number;
  reviewable: boolean;
  adjustmentReady: boolean;
  objectiveHitRate: number | null;
  stopBreachRate: number | null;
  averageObjectiveReachRatio: number | null;
};
type Resp = {
  market: string;
  currency_symbol: string;
  horizons: number[];
  matured_floor: number;
  counts: { observations_in_scope: number; observations_returned: number; matured_labels: number };
  recent: Decision[];
  aggregates: {
    floor: number;
    byDirection: Cohort[];
    byScoreBand: Cohort[];
    planCalibration: PlanCalibration[];
  };
};

function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;
}
function retColor(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return T.muted;
  return v > 0 ? T.green : v < 0 ? T.red : T.muted;
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function dirBadge(dir: string | null) {
  if (dir === "long") return { label: "LONG", color: T.green };
  if (dir === "short") return { label: "SHORT", color: T.red };
  return { label: (dir ?? "—").toUpperCase(), color: T.muted };
}

export default function DecisionReviewPanel() {
  const { market } = useMarket();
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [symbol, setSymbol] = useState("");
  const [applied, setApplied] = useState("");

  useEffect(() => {
    setLoading(true);
    const qs = new URLSearchParams({ market });
    if (applied) qs.set("symbol", applied);
    fetch(`/api/decision-review?${qs.toString()}`)
      .then(r => r.json())
      .then((d: Resp) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [market, applied]);

  const horizons = data?.horizons ?? [];
  const cur = data?.currency_symbol ?? "$";

  const Card = ({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) => (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "14px", padding: "clamp(14px,3vw,20px)", marginBottom: "16px" }}>
      <div style={{ fontSize: "11px", fontWeight: 700, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: sub ? "4px" : "12px" }}>{title}</div>
      {sub && <div style={{ fontSize: "12px", color: T.textSub, marginBottom: "12px", lineHeight: 1.5 }}>{sub}</div>}
      {children}
    </div>
  );

  function CohortSection({ title, cohorts }: { title: string; cohorts: Cohort[] }) {
    return (
      <div style={{ marginBottom: "18px" }}>
        <div style={{ fontSize: "12px", fontWeight: 700, color: T.textSub, marginBottom: "10px" }}>{title}</div>
        <div style={{ display: "grid", gap: "10px" }}>
          {cohorts.map(c => (
            <div key={c.key} style={{ background: T.dim, borderRadius: "10px", padding: "12px 14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
                <span style={{ fontSize: "13px", fontWeight: 700, color: T.text }}>{c.label}</span>
                <span style={{ fontSize: "11px", color: T.muted }}>{c.total_decisions} decision{c.total_decisions === 1 ? "" : "s"} scored</span>
              </div>
              <div style={{ display: "grid", gap: "8px" }}>
                {c.horizons.map(h => (
                  <div key={h.horizon_days} style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", fontSize: "12px" }}>
                    <span style={{ width: "44px", color: T.muted, fontWeight: 600, flexShrink: 0 }}>{h.horizon_days}d</span>
                    {h.actionable ? (
                      <>
                        <span style={{ color: T.textSub }}>
                          hit-rate <b style={{ color: T.text }}>{h.hit_rate != null ? `${Math.round(h.hit_rate * 100)}%` : "—"}</b>
                          <span style={{ color: T.muted }}> ({h.staked_count} directional)</span>
                        </span>
                        <span style={{ color: T.textSub }}>avg fwd <b style={{ color: retColor(h.avg_forward_return) }}>{pct(h.avg_forward_return)}</b></span>
                        <span style={{ color: T.textSub }}>avg alpha <b style={{ color: retColor(h.avg_alpha) }}>{pct(h.avg_alpha)}</b></span>
                        <span style={{ fontSize: "10px", color: T.muted }}>· n={h.matured_count} matured</span>
                      </>
                    ) : (
                      <span style={{ color: T.amber, fontSize: "11px" }}>
                        {h.matured_count}/{data?.matured_floor} matured — insufficient sample, not yet actionable
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ color: T.text, fontFamily: "'Inter', sans-serif" }}>
      {/* Intent / boundary banner — detail over cryptic. */}
      <div style={{ background: T.accentBg, border: `1px solid ${T.accent}44`, borderRadius: "12px", padding: "12px 16px", marginBottom: "16px", fontSize: "12px", color: T.textSub, lineHeight: 1.6 }}>
        <b style={{ color: T.accent }}>Counterfactual, read-only.</b> For each past decision: what we scored vs how the stock actually moved over the next few trading days
        (benchmark-neutral, {market === "india" ? "vs ^NSEI, ₹" : "vs SPY, $"}). It changes no weights, positions, or trades. Per-symbol attribution below is
        <b style={{ color: T.amber }}> illustrative (n=1)</b>; the actionable read is the aggregate cohort section, shown only once a cohort clears {data?.matured_floor ?? 20} matured outcomes.
      </div>

      {/* Symbol filter */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap" }}>
        <input
          value={symbol}
          onChange={e => setSymbol(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") setApplied(symbol.trim().toUpperCase()); }}
          placeholder="Filter by symbol…"
          style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "7px", color: T.text, padding: "8px 12px", fontSize: "13px", flex: "1 1 160px", maxWidth: "220px" }}
        />
        <button onClick={() => setApplied(symbol.trim().toUpperCase())}
          style={{ background: T.accentBg, border: `1px solid ${T.accent}44`, color: T.accent, borderRadius: "7px", padding: "8px 16px", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
          Apply
        </button>
        {applied && (
          <button onClick={() => { setSymbol(""); setApplied(""); }}
            style={{ background: "none", border: `1px solid ${T.border}`, color: T.textSub, borderRadius: "7px", padding: "8px 14px", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
            Clear
          </button>
        )}
      </div>

      {loading ? (
        <div style={{ fontSize: "13px", color: T.muted }}>Loading…</div>
      ) : !data || !data.recent ? (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "24px", fontSize: "13px", color: T.muted, textAlign: "center" }}>
          Could not load decision review.
        </div>
      ) : (
        <>
          {/* ── Aggregate cohorts (the honest, actionable layer) ── */}
          <Card
            title={`Aggregate cohorts — ${market === "india" ? "🇮🇳 India" : "🇺🇸 US"}`}
            sub={`Grouped within this market only (never cross-summed with the other market). Actionable edge shows only once a cohort has ≥ ${data.matured_floor} matured outcomes at a horizon — this mirrors the 20-trade Performance-Truth floor, so a thin sample never masquerades as a confident edge.`}
          >
            {horizons.length === 0 ? (
              <div style={{ fontSize: "12px", color: T.muted }}>No matured forward outcomes yet — labels appear only after each horizon has fully elapsed.</div>
            ) : (
              <>
                <CohortSection title="By scored direction" cohorts={data.aggregates.byDirection} />
                <CohortSection title="By score band" cohorts={data.aggregates.byScoreBand} />
              </>
            )}
          </Card>

          {/* ── Recent decisions (per-symbol; attribution is decorative n=1) ── */}
          <Card
            title="Entry-plan calibration"
            sub="The profit objective is an exit-policy level, not a predicted terminal price. This compares the original stop/objective/horizon with the realized path. Review begins at 20 matured plans; automatic risk-policy readiness keeps the stricter 60-plan floor."
          >
            <div style={{ display: "grid", gap: "9px" }}>
              {(data.aggregates.planCalibration ?? []).map(row => (
                <div key={row.horizonDays} style={{ background: T.dim, borderRadius: "8px", padding: "10px 12px", display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "baseline" }}>
                  <span style={{ color: T.text, fontWeight: 700, width: "30px" }}>{row.horizonDays}d</span>
                  <span style={{ color: row.reviewable ? T.textSub : T.amber }}>n={row.n}</span>
                  {row.n > 0 && (
                    <>
                      <span style={{ color: T.textSub }}>objective reached <b style={{ color: T.text }}>{row.objectiveHitRate == null ? "-" : `${Math.round(row.objectiveHitRate * 100)}%`}</b></span>
                      <span style={{ color: T.textSub }}>stop touched <b style={{ color: T.text }}>{row.stopBreachRate == null ? "-" : `${Math.round(row.stopBreachRate * 100)}%`}</b></span>
                      <span style={{ color: T.textSub }}>avg objective reached <b style={{ color: T.text }}>{row.averageObjectiveReachRatio == null ? "-" : `${Math.round(row.averageObjectiveReachRatio * 100)}%`}</b></span>
                    </>
                  )}
                  <span style={{ color: row.adjustmentReady ? T.green : T.muted, fontSize: "10px", marginLeft: "auto" }}>
                    {row.adjustmentReady ? "risk-policy sample ready" : `${row.n}/${row.adjustmentFloor} adjustment floor`}
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card
            title="Recent decisions vs actual move"
            sub={`${data.counts.observations_returned} most recent scored decisions in this market. "Actual" is the matured forward return from the ledger; a horizon that hasn't elapsed shows "maturing". Δ = our directional call × realized alpha (positive means the move agreed with us).`}
          >
            {data.recent.length === 0 ? (
              <div style={{ fontSize: "12px", color: T.muted }}>No scored decisions found{applied ? ` for ${applied}` : ""} in this market.</div>
            ) : (
              <div style={{ display: "grid", gap: "10px" }}>
                {data.recent.map(d => {
                  const badge = dirBadge(d.direction);
                  return (
                    <div key={d.id} style={{ background: T.dim, borderRadius: "10px", padding: "12px 14px" }}>
                      {/* Header line */}
                      <div style={{ display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap", marginBottom: "10px" }}>
                        <span style={{ fontSize: "15px", fontWeight: 800, color: T.text }}>{d.symbol}</span>
                        <span style={{ fontSize: "11px", fontWeight: 700, padding: "2px 8px", borderRadius: "5px", background: `${badge.color}22`, color: badge.color, border: `1px solid ${badge.color}44` }}>{badge.label}</span>
                        <span style={{ fontSize: "12px", color: T.textSub }}>score <b style={{ color: T.text }}>{d.analyst_score ?? "—"}</b>{d.score_threshold != null ? <span style={{ color: T.muted }}> / thresh {d.score_threshold}</span> : null}</span>
                        {d.price_at_decision != null && <span style={{ fontSize: "11px", color: T.muted }}>@ {cur}{d.price_at_decision}</span>}
                        {d.confidence_band && <span style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>conf: {d.confidence_band}</span>}
                        <span style={{ flex: 1 }} />
                        <span style={{ fontSize: "11px", color: T.muted }}>{fmtDate(d.ts)}</span>
                      </div>

                      {d.trade_plan && (
                        <div style={{ fontSize: "11px", color: T.textSub, marginBottom: "9px", lineHeight: 1.5 }}>
                          Original plan: {d.trade_plan.horizon_sessions ?? "-"} sessions
                          {" / "}floor {d.trade_plan.initial_risk_floor == null ? "-" : `${cur}${d.trade_plan.initial_risk_floor}`}
                          {" / "}objective {d.trade_plan.profit_objective == null ? "-" : `${cur}${d.trade_plan.profit_objective}`}
                          <span style={{ color: T.muted }}> (policy bounds, not a terminal-price prediction)</span>
                        </div>
                      )}

                      {/* Per-horizon outcome grid */}
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", minWidth: "560px", borderCollapse: "collapse", fontSize: "12px" }}>
                          <thead>
                            <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                              {["Horizon", "Forward", "Alpha", "MAE / MFE", "Plan path", "Δ vs call"].map((h, i) => (
                                <th key={h} style={{ padding: "5px 8px", textAlign: i === 0 ? "left" : "right", fontSize: "9px", color: T.muted, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {d.horizons.map(h => (
                              <tr key={h.horizon_days} style={{ borderBottom: `1px solid ${T.border}33` }}>
                                <td style={{ padding: "6px 8px", color: T.textSub, fontWeight: 600 }}>{h.horizon_days}d</td>
                                {h.matured ? (
                                  <>
                                    <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, color: retColor(h.fwd_return) }}>{pct(h.fwd_return)}</td>
                                    <td style={{ padding: "6px 8px", textAlign: "right", color: retColor(h.benchmark_neutral_return) }}>{pct(h.benchmark_neutral_return)}</td>
                                    <td style={{ padding: "6px 8px", textAlign: "right", color: T.muted }}>{pct(h.max_adverse_excursion)} / {pct(h.max_favorable_excursion)}</td>
                                    <td style={{ padding: "6px 8px", textAlign: "right", color: T.textSub }}>
                                      {h.plan_outcome
                                        ? `${h.plan_outcome.objectiveReached ? "objective reached" : `${Math.round(h.plan_outcome.objectiveReachRatio * 100)}% of objective`}${h.plan_outcome.stopBreached ? " · stop touched" : ""}`
                                        : "—"}
                                    </td>
                                    <td style={{ padding: "6px 8px", textAlign: "right" }}>
                                      {h.delta == null ? <span style={{ color: T.muted }}>—</span> : (
                                        <span style={{ color: h.directional_hit ? T.green : T.red, fontWeight: 700 }}>
                                          {h.directional_hit ? "✓ hit" : "✗ miss"}
                                        </span>
                                      )}
                                    </td>
                                  </>
                                ) : (
                                  <td colSpan={5} style={{ padding: "6px 8px", textAlign: "right", color: T.amber, fontSize: "11px" }}>maturing — horizon not yet elapsed</td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {/* Decorative n=1 attribution */}
                      {d.attribution && (d.attribution.most_wrong || d.attribution.most_right) && (
                        <div style={{ marginTop: "10px", padding: "8px 10px", borderRadius: "8px", background: T.card, border: `1px dashed ${T.border}` }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", fontSize: "11px" }}>
                            <span style={{ fontSize: "9px", fontWeight: 700, padding: "2px 7px", borderRadius: "4px", background: `${T.amber}22`, color: T.amber, border: `1px solid ${T.amber}44`, letterSpacing: "0.05em" }}>n=1 · ILLUSTRATIVE</span>
                            {d.attribution.most_wrong && (
                              <span style={{ color: T.textSub }}>most opposed the {d.attribution.horizon_days}d move: <b style={{ color: T.red, textTransform: "capitalize" }}>{d.attribution.most_wrong.dim}</b></span>
                            )}
                            {d.attribution.most_right && (
                              <span style={{ color: T.textSub }}>· most aligned: <b style={{ color: T.green, textTransform: "capitalize" }}>{d.attribution.most_right.dim}</b></span>
                            )}
                          </div>
                          <div style={{ fontSize: "10px", color: T.muted, marginTop: "5px", lineHeight: 1.5 }}>
                            Single realized path — this is an anecdote, not evidence. Never a reason to change weights; only the aggregate cohorts above (above the {data.matured_floor}-sample floor) are actionable.
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
