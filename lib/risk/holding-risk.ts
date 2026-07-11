// Daily Per-Holding Risk Analytics — pure, versioned per-holding risk engine.
//
// Spec: features/holding-risk-daily/FEATURE_ARCHITECTURE.md ("Compute path").
//
// `computeHoldingRisk(holding, ctx)` is a PURE function: no I/O, no clock, no
// randomness — same inputs always yield the same score/posture. The cron builds
// `ctx` from broker snapshots + computed correlations + owner-approved limits and
// calls this; the LLM prose pass runs AFTER this and can never change what this
// returns. This is the deterministic half of the Hybrid decision.
//
// V1 score ("hr-v1") is a LIMIT-UTILIZATION pressure index in [0,100], NOT a
// probability of loss and NOT a return forecast. Each component is scaled against
// an owner-approved risk limit and clamped to its own cap:
//
//   name concentration    30  vs limits.maxNameExposurePct
//   sector concentration  20  vs limits.maxSectorExposurePct
//   volatility / beta      15  vs a name-vol reference + beta baseline (real price evidence only)
//   correlated cluster     15  vs limits.maxAvgPairwiseCorr (COMPUTED corr, never KNOWN_CORR alone)
//   drawdown / stop        10  drawdown alone can never trigger an exit
//   liquidity / event      10  only when a fresh event/liquidity feed was queried
//
// Missing structural fields → `insufficient_data` with NO numeric score. Missing
// optional dimensions lower `data_confidence` and are excluded from the numerator
// (the score is NOT renormalized to look fully confident on partial data).

export const HOLDING_RISK_FORMULA_VERSION = "hr-v1";

// Component caps (sum = 100).
const CAP_NAME = 30;
const CAP_SECTOR = 20;
const CAP_VOLBETA = 15;
const CAP_CLUSTER = 15;
const CAP_DRAWDOWN = 10;
const CAP_LIQUIDITY = 10;

// Reference constants. A single name's daily realized vol commonly runs 2–4%; the
// portfolio vol budget (~2%/day) is not the right yardstick for one name, so vol
// pressure is scaled against a name reference instead.
const NAME_VOL_REF_PCT = 4.0;   // daily % at which single-name vol pressure saturates
const DRAWDOWN_REF = 0.25;      // 25% drawdown from cost = full drawdown pressure
const STOP_NEAR_REF = 0.15;     // ≥15% above the protective stop = no stop pressure
const CONF_REVIEW_FLOOR = 0.5;  // below this data_confidence the posture degrades to `review`

// Confidence weights per optional dimension (structural base fills the rest to 1.0).
const CONF_BASE = 0.2;
const CONF_W = {
  sector: 0.15,
  volbeta: 0.2,
  correlation: 0.2,
  drawdown: 0.1,
  liquidity: 0.15,
} as const;

export interface HoldingRiskLimits {
  maxNameExposurePct: number;    // percent (e.g. 12)
  maxSectorExposurePct: number;  // percent (e.g. 30)
  maxPortfolioVolPct: number;    // daily percent (e.g. 2.0)
  maxAvgPairwiseCorr: number;    // 0–1 (e.g. 0.7)
  maxGrossExposurePct: number;   // percent (e.g. 80)
}

export interface HoldingRiskInput {
  symbol: string;
  qty: number | null;
  currentPrice: number | null;
  marketValue: number | null;
  averageCost?: number | null;
  unrealizedPnlPct?: number | null; // fraction; negative = down from cost
  sector?: string | null;           // null / "Other" => sector evidence missing
  beta?: number | null;
  realizedVolPct?: number | null;   // daily %, from real price history
}

export interface HoldingRiskContext {
  accountTotalValue: number | null; // required structural
  currency: "USD" | "INR" | null;   // required structural
  limits: HoldingRiskLimits;
  quoteFresh?: boolean;             // false => stale => insufficient_data

  sectorWeightPct?: number | null;  // fraction [0,1] of this holding's SECTOR total; null => missing
  grossExposurePct?: number | null; // fraction [0,1] invested (gross); null => unknown

  // Correlation evidence — COMPUTED aligned-return correlations, never KNOWN_CORR alone.
  clusterAvgCorr?: number | null;   // 0–1 avg corr of this holding to its co-held cluster; null => no computed corr
  clusterPeers?: string[];          // co-held symbols in the correlated cluster
  clusterWeightPct?: number | null; // fraction [0,1] combined weight of the cluster incl. this holding

  // Drawdown / protective-stop evidence.
  stopDistancePct?: number | null;  // fraction: (price - stop) / price; smaller => closer to stop
  protectiveStopHit?: boolean;      // VERIFIED deterministic protective-stop breach
  thesisBreak?: boolean;            // VERIFIED deterministic thesis break

  // Liquidity / event evidence — only trusted when a fresh feed was queried.
  hasFreshEventData?: boolean;
  eventFlag?: { kind: string; detail: string } | null;
  liquidityFlag?: { kind: string; detail: string } | null;
}

export type RiskComponent =
  | "name_concentration"
  | "sector_concentration"
  | "volatility_beta"
  | "correlated_cluster"
  | "drawdown_stop"
  | "liquidity_event";

export interface HoldingRiskDriver {
  component: RiskComponent;
  points: number;               // contribution to the score
  cap: number;                  // component maximum
  utilization: number | null;   // fraction of the limit consumed (null when the dim is missing)
  detail: string;
}

export type RiskPosture = "hold" | "review" | "trim" | "exit_review" | "insufficient_data";
export type RiskLabel = "Low" | "Moderate" | "Elevated" | "High" | "insufficient_data";

export interface HoldingRiskResult {
  score: number | null;
  label: RiskLabel;
  drivers: HoldingRiskDriver[];
  riskPosture: RiskPosture;
  actionReason: string;
  addCapacity: boolean;
  dataConfidence: number;       // 0–1
  missingInputs: string[];
  formulaVersion: string;
}

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

function insufficient(missing: string[]): HoldingRiskResult {
  return {
    score: null,
    label: "insufficient_data",
    drivers: [],
    riskPosture: "insufficient_data",
    actionReason: `Insufficient data to score: ${missing.join(", ")}.`,
    addCapacity: false,
    dataConfidence: 0,
    missingInputs: missing,
    formulaVersion: HOLDING_RISK_FORMULA_VERSION,
  };
}

/**
 * Deterministic per-holding risk. Pure — the LLM prose pass runs afterwards and
 * cannot alter any field returned here.
 */
export function computeHoldingRisk(h: HoldingRiskInput, ctx: HoldingRiskContext): HoldingRiskResult {
  // ── Structural gate: no numeric score without these ─────────────────────────
  const structuralMissing: string[] = [];
  if (!isFiniteNum(h.qty) || (h.qty as number) < 0) structuralMissing.push("qty");
  if (!isFiniteNum(h.currentPrice) || (h.currentPrice as number) < 0) structuralMissing.push("current_price");
  if (!isFiniteNum(h.marketValue) || (h.marketValue as number) < 0) structuralMissing.push("market_value");
  if (!isFiniteNum(ctx.accountTotalValue) || (ctx.accountTotalValue as number) <= 0) structuralMissing.push("account_total_value");
  if (ctx.currency !== "USD" && ctx.currency !== "INR") structuralMissing.push("currency");
  if (ctx.quoteFresh === false) structuralMissing.push("stale_quote");
  if (structuralMissing.length) return insufficient(structuralMissing);

  const { limits } = ctx;
  const marketValue = h.marketValue as number;
  const accountTotal = ctx.accountTotalValue as number;
  const weightFrac = marketValue / accountTotal;          // [0,1]
  const weightPct = weightFrac * 100;

  const drivers: HoldingRiskDriver[] = [];
  const missingInputs: string[] = [];
  let confidence = CONF_BASE;

  // ── Name concentration (30) ─────────────────────────────────────────────────
  const nameLimit = isFiniteNum(limits.maxNameExposurePct) && limits.maxNameExposurePct > 0 ? limits.maxNameExposurePct : 12;
  const nameUtil = weightPct / nameLimit;
  const namePoints = clamp01(nameUtil) * CAP_NAME;
  drivers.push({
    component: "name_concentration",
    points: namePoints,
    cap: CAP_NAME,
    utilization: nameUtil,
    detail: `${weightPct.toFixed(1)}% of account vs ${nameLimit}% name cap (${(nameUtil * 100).toFixed(0)}% of limit)`,
  });

  // ── Sector concentration (20) ───────────────────────────────────────────────
  let sectorUtil: number | null = null;
  const sectorKnown = isFiniteNum(ctx.sectorWeightPct) && (h.sector ?? "Other") !== "Other";
  if (sectorKnown) {
    const sectorLimit = isFiniteNum(limits.maxSectorExposurePct) && limits.maxSectorExposurePct > 0 ? limits.maxSectorExposurePct : 30;
    const sectorPct = (ctx.sectorWeightPct as number) * 100;
    sectorUtil = sectorPct / sectorLimit;
    confidence += CONF_W.sector;
    drivers.push({
      component: "sector_concentration",
      points: clamp01(sectorUtil) * CAP_SECTOR,
      cap: CAP_SECTOR,
      utilization: sectorUtil,
      detail: `${h.sector} sector ${sectorPct.toFixed(1)}% vs ${sectorLimit}% cap (${(sectorUtil * 100).toFixed(0)}% of limit)`,
    });
  } else {
    missingInputs.push("sector_exposure");
    drivers.push({ component: "sector_concentration", points: 0, cap: CAP_SECTOR, utilization: null, detail: "sector unknown — excluded" });
  }

  // ── Volatility / beta (15) — real price evidence only ───────────────────────
  const hasVol = isFiniteNum(h.realizedVolPct);
  const hasBeta = isFiniteNum(h.beta);
  if (hasVol || hasBeta) {
    const volUtil = hasVol ? clamp01((h.realizedVolPct as number) / NAME_VOL_REF_PCT) : 0;
    const betaExcess = hasBeta ? clamp01(((h.beta as number) - 1) / 1.0) : 0; // beta 2.0 → full
    const u = Math.max(volUtil, betaExcess);
    confidence += CONF_W.volbeta;
    drivers.push({
      component: "volatility_beta",
      points: u * CAP_VOLBETA,
      cap: CAP_VOLBETA,
      utilization: u,
      detail: [
        hasVol ? `daily vol ${(h.realizedVolPct as number).toFixed(1)}% vs ${NAME_VOL_REF_PCT}% ref` : null,
        hasBeta ? `beta ${(h.beta as number).toFixed(2)}` : null,
      ].filter(Boolean).join(", "),
    });
  } else {
    missingInputs.push("volatility_beta");
    drivers.push({ component: "volatility_beta", points: 0, cap: CAP_VOLBETA, utilization: null, detail: "no price-history vol/beta — excluded" });
  }

  // ── Correlated cluster (15) — computed correlations only ────────────────────
  let clusterBreach = false;
  if (isFiniteNum(ctx.clusterAvgCorr)) {
    const corrLimit = isFiniteNum(limits.maxAvgPairwiseCorr) && limits.maxAvgPairwiseCorr > 0 ? limits.maxAvgPairwiseCorr : 0.7;
    const corrUtil = clamp01((ctx.clusterAvgCorr as number) / corrLimit);
    // Materiality: a high correlation only matters if the cluster carries weight.
    const sectorLimitFrac = ((isFiniteNum(limits.maxSectorExposurePct) ? limits.maxSectorExposurePct : 30) / 100);
    const mat = isFiniteNum(ctx.clusterWeightPct) ? clamp01((ctx.clusterWeightPct as number) / sectorLimitFrac) : 1;
    const u = corrUtil * mat;
    confidence += CONF_W.correlation;
    clusterBreach = corrUtil >= 1 && mat >= 0.5;
    const peers = (ctx.clusterPeers ?? []).slice(0, 4).join(", ");
    drivers.push({
      component: "correlated_cluster",
      points: u * CAP_CLUSTER,
      cap: CAP_CLUSTER,
      utilization: u,
      detail: `avg corr ${(ctx.clusterAvgCorr as number).toFixed(2)} vs ${corrLimit} cap${peers ? ` with ${peers}` : ""}${isFiniteNum(ctx.clusterWeightPct) ? `, cluster ${((ctx.clusterWeightPct as number) * 100).toFixed(0)}% of account` : ""}`,
    });
  } else {
    missingInputs.push("correlation");
    drivers.push({ component: "correlated_cluster", points: 0, cap: CAP_CLUSTER, utilization: null, detail: "no computed correlations — excluded" });
  }

  // ── Drawdown / stop-distance (10) — never an exit trigger on its own ─────────
  const hasStop = isFiniteNum(ctx.stopDistancePct);
  const hasDD = isFiniteNum(h.unrealizedPnlPct);
  if (hasStop || hasDD) {
    let u = 0;
    const parts: string[] = [];
    if (hasStop) {
      const stopU = clamp01(1 - (ctx.stopDistancePct as number) / STOP_NEAR_REF);
      u = Math.max(u, stopU);
      parts.push(`${((ctx.stopDistancePct as number) * 100).toFixed(1)}% above stop`);
    }
    if (hasDD) {
      const dd = Math.max(0, -(h.unrealizedPnlPct as number));
      u = Math.max(u, clamp01(dd / DRAWDOWN_REF));
      parts.push(`${(((h.unrealizedPnlPct as number)) * 100).toFixed(1)}% vs cost`);
    }
    confidence += CONF_W.drawdown;
    drivers.push({
      component: "drawdown_stop",
      points: u * CAP_DRAWDOWN,
      cap: CAP_DRAWDOWN,
      utilization: u,
      detail: parts.join(", "),
    });
  } else {
    missingInputs.push("drawdown_stop");
    drivers.push({ component: "drawdown_stop", points: 0, cap: CAP_DRAWDOWN, utilization: null, detail: "no cost basis / stop — excluded" });
  }

  // ── Liquidity / event (10) — fresh feed required ────────────────────────────
  if (ctx.hasFreshEventData) {
    let pts = 0;
    const parts: string[] = [];
    if (ctx.eventFlag) { pts += 6; parts.push(`event: ${ctx.eventFlag.kind} (${ctx.eventFlag.detail})`); }
    if (ctx.liquidityFlag) { pts += 4; parts.push(`liquidity: ${ctx.liquidityFlag.kind} (${ctx.liquidityFlag.detail})`); }
    pts = Math.min(CAP_LIQUIDITY, pts);
    confidence += CONF_W.liquidity;
    drivers.push({
      component: "liquidity_event",
      points: pts,
      cap: CAP_LIQUIDITY,
      utilization: pts / CAP_LIQUIDITY,
      detail: parts.length ? parts.join(", ") : "no active event/liquidity flags",
    });
  } else {
    missingInputs.push("liquidity_event");
    drivers.push({ component: "liquidity_event", points: 0, cap: CAP_LIQUIDITY, utilization: null, detail: "no fresh event/liquidity feed — excluded" });
  }

  // ── Score ───────────────────────────────────────────────────────────────────
  const rawScore = drivers.reduce((s, d) => s + d.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));
  const dataConfidence = clamp01(confidence);

  const label: RiskLabel = score < 25 ? "Low" : score < 50 ? "Moderate" : score < 70 ? "Elevated" : "High";

  // ── Posture precedence (deterministic) ──────────────────────────────────────
  // 1. verified protective-stop/thesis-break → exit_review (drawdown alone NEVER)
  // 2. hard concentration/cluster breach → trim
  // 3. incomplete / low-confidence evidence → review
  // 4. otherwise hold
  const nameBreach = nameUtil >= 1;
  const sectorBreach = sectorUtil !== null && sectorUtil >= 1;

  let riskPosture: RiskPosture;
  let actionReason: string;
  if (ctx.protectiveStopHit === true || ctx.thesisBreak === true) {
    riskPosture = "exit_review";
    const why = [
      ctx.protectiveStopHit ? "protective stop breached" : null,
      ctx.thesisBreak ? "thesis break confirmed" : null,
    ].filter(Boolean).join(" + ");
    actionReason = `Exit review: ${why}. Advisory only — no order is placed by this feature.`;
  } else if (nameBreach || sectorBreach || clusterBreach) {
    riskPosture = "trim";
    const breaches = [
      nameBreach ? `name ${weightPct.toFixed(1)}% > ${nameLimit}% cap` : null,
      sectorBreach ? `sector ${((ctx.sectorWeightPct as number) * 100).toFixed(1)}% > ${limits.maxSectorExposurePct}% cap` : null,
      clusterBreach ? `correlated cluster over ${limits.maxAvgPairwiseCorr} corr cap with material weight` : null,
    ].filter(Boolean).join("; ");
    actionReason = `Trim: ${breaches}.`;
  } else if (dataConfidence < CONF_REVIEW_FLOOR) {
    riskPosture = "review";
    actionReason = `Review: partial data (confidence ${(dataConfidence * 100).toFixed(0)}%; missing ${missingInputs.join(", ") || "none"}).`;
  } else {
    riskPosture = "hold";
    actionReason = `Hold: within owner-approved risk limits (score ${score}/100).`;
  }

  // add_capacity = risk limits have room. NEVER an order signal — it means only that
  // name/sector/gross caps are not yet consumed; an actual BUY needs a separate alpha
  // signal plus the existing portfolio/execution gates.
  const grossRoom = !isFiniteNum(ctx.grossExposurePct)
    ? true
    : (ctx.grossExposurePct as number) * 100 < (isFiniteNum(limits.maxGrossExposurePct) ? limits.maxGrossExposurePct : 80);
  const addCapacity = riskPosture === "hold" && nameUtil < 1 && (sectorUtil === null || sectorUtil < 1) && grossRoom;

  return {
    score,
    label,
    drivers,
    riskPosture,
    actionReason,
    addCapacity,
    dataConfidence,
    missingInputs,
    formulaVersion: HOLDING_RISK_FORMULA_VERSION,
  };
}
