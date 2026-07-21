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
//
// hr-v2 (2026-07-16) — SECTOR BREACH IS NO LONGER A BLANKET PER-NAME VERDICT.
// A sector-cap breach is a property of the SECTOR: `sectorUtil >= 1` is the same
// number for every holding in it, so hr-v1 gave EVERY name in the sector the
// identical `trim` without ever deciding which names absorb the breach or how
// much each gives up. hr-v2 consults the deterministic, risk-internal allocator
// (`lib/risk/sector-breach.ts`): the sector breach makes THIS name a trim only
// when the allocator selected it to absorb. See
// features/risk-sector-breach-allocation/FEATURE_ARCHITECTURE.md.
// hr-v3 (2026-07-21): CONCENTRATION IS REVIEW-ONLY. The available limits are
// global trading references, not account-specific objectives or sell mandates.
// Name, allocated sector, and correlated-cluster breaches therefore surface the
// measured exposure under `review`; they never tell the owner to trim. A future
// trim posture requires an explicit per-account mandate and deterministic share
// quantity plan. Protective-stop/thesis-break `exit_review` remains first.
//
// The score, the six components, their caps, the confidence weights, and
// `add_capacity` are UNCHANGED — only the sector→posture step moved.

import type { SectorBreachAllocation } from "@/lib/risk/sector-breach";

export const HOLDING_RISK_FORMULA_VERSION = "hr-v3";

// These are asset classes/exposure sleeves, not equity sectors. Applying a
// max_sector_exposure cap to IVV/SGOV/GLD/IBIT is a category error: an ETF book
// can legitimately be mostly diversified equity, and a bond sleeve is not a
// "Fixed Income sector" in the mandate's sense.
const NON_SECTOR_EXPOSURES = new Set([
  "Diversified Equity",
  "International Equity",
  "Fixed Income",
  "Commodities",
  "Digital Assets",
  "Other",
]);

export function isSectorCapEligible(sector: string | null | undefined): sector is string {
  return typeof sector === "string" && sector.length > 0 && !NON_SECTOR_EXPOSURES.has(sector);
}

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

  // Fraction [0,1] of NAV held in this holding's SECTOR; null => missing. MUST be
  // NAV-relative (same basis as accountTotalValue and as the owner's cap in
  // lib/risk/live-portfolio-gate.ts), or it will disagree with the allocation below.
  sectorWeightPct?: number | null;
  grossExposurePct?: number | null; // fraction [0,1] invested (gross); null => unknown

  // Deterministic sector-cap breach allocation for THIS holding, from
  // `allocateSectorBreach()`. Absent/null => not computed: a sector breach then
  // yields `review` (we cannot say whether THIS name should absorb it), never a
  // blanket `trim`. Defaulting to the old blanket-trim would be defaulting to the bug.
  sectorBreachAllocation?: SectorBreachAllocation | null;

  // True when Kairos has NO order path for this account (read-only). Only
  // `605420660` may ever place an order, so every other account is read-only.
  // Absent => assumed read-only (the honest default).
  readOnlyAccount?: boolean;

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
  const sectorKnown = isFiniteNum(ctx.sectorWeightPct) && isSectorCapEligible(h.sector);
  if (sectorKnown) {
    const sectorLimit = isFiniteNum(limits.maxSectorExposurePct) && limits.maxSectorExposurePct > 0 ? limits.maxSectorExposurePct : 30;
    const sectorPct = (ctx.sectorWeightPct as number) * 100;
    sectorUtil = sectorPct / sectorLimit;
    confidence += CONF_W.sector;
    // The sector NUMBER is shared by every name in the sector; the ALLOCATION is
    // what makes it a per-name fact. Record both in the driver evidence trail.
    const a = ctx.sectorBreachAllocation ?? null;
    const allocDetail =
      a?.role === "absorb"
        ? `; selected to absorb ${a.trimPct.toFixed(2)}pp (#${a.rank} of ${a.absorberCount}) → target ${a.targetWeightPct?.toFixed(2)}% of NAV`
        : a?.role === "not_selected"
          ? `; NOT selected to absorb the breach (${a.absorberCount} larger name(s) are)`
          : "";
    drivers.push({
      component: "sector_concentration",
      points: clamp01(sectorUtil) * CAP_SECTOR,
      cap: CAP_SECTOR,
      utilization: sectorUtil,
      detail: `${h.sector} sector ${sectorPct.toFixed(1)}% of NAV vs ${sectorLimit}% cap (${(sectorUtil * 100).toFixed(0)}% of limit)${allocDetail}`,
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
  // 2. hard name breach, OR a sector breach THIS name was SELECTED to absorb:
  //    review only. Global trading references are not account-specific sell mandates.
  // 3. correlated cluster breach → review until a deterministic allocator names
  //    the exposure and quantity to reduce
  // 3. sector breached but no usable allocation → review (honest: we cannot say
  //    whether THIS name should absorb it)
  // 4. incomplete / low-confidence evidence → review
  // 5. otherwise hold (naming WHY, when the sector is over cap and this name was
  //    not selected)
  const nameBreach = nameUtil >= 1;
  const sectorBreach = sectorUtil !== null && sectorUtil >= 1;

  // A sector-cap breach is a SECTOR property with no per-name allocation of its
  // own. It can only make THIS name a trim when the deterministic allocator
  // selected this name to absorb part of it.
  const alloc = ctx.sectorBreachAllocation ?? null;
  const allocUsable = alloc !== null && (alloc.role === "absorb" || alloc.role === "not_selected");
  const sectorSelected = sectorBreach && allocUsable && alloc!.role === "absorb";
  const sectorNotSelected = sectorBreach && allocUsable && alloc!.role === "not_selected";
  // No allocation, or one that contradicts the sector driver (e.g. `no_breach` /
  // `sector_unknown` while sectorUtil >= 1 — a denominator mismatch between the
  // caller's sectorWeightPct and the allocator's NAV basis).
  const sectorUnallocated = sectorBreach && !allocUsable;
  if (sectorUnallocated) missingInputs.push("sector_breach_allocation");

  // The whole feature is advisory. This says whether an order path exists at all,
  // rather than implying one does. Absent flag => assume read-only.
  const advisory = ctx.readOnlyAccount === false
    ? "Advisory only — this feature places no order; any action requires owner approval in the Execution Gateway."
    : "Advisory only — this account is read-only in Kairos; the app cannot trade it.";

  let riskPosture: RiskPosture;
  let actionReason: string;
  if (ctx.protectiveStopHit === true || ctx.thesisBreak === true) {
    // FIRST and unconditional. No allocation, and no absence of one, can reach
    // this branch — a risk-driven exit is never delayed or suppressed by the
    // sector-breach allocator.
    riskPosture = "exit_review";
    const why = [
      ctx.protectiveStopHit ? "protective stop breached" : null,
      ctx.thesisBreak ? "thesis break confirmed" : null,
    ].filter(Boolean).join(" + ");
    actionReason = `Exit review: ${why}. ${advisory}`;
  } else if (nameBreach || sectorSelected) {
    riskPosture = "review";
    const measured = [
      nameBreach ? `name weight ${weightPct.toFixed(1)}% exceeds the ${nameLimit}% global Kairos trading reference` : null,
      sectorSelected && alloc
        ? `${h.sector} exceeds the ${limits.maxSectorExposurePct}% global Kairos sector reference; this holding contributes materially to that exposure`
        : null,
    ].filter(Boolean).join("; ");
    actionReason = `Review concentration: ${measured}. Kairos has no approved account-specific concentration mandate or executable share-quantity plan for this account, so no trim is recommended. ${advisory}`;
  } else if (clusterBreach) {
    riskPosture = "review";
    actionReason =
      `Review overlap: this holding is in a material correlated cluster above the ${limits.maxAvgPairwiseCorr} correlation reference. ` +
      `Correlation identifies shared exposure but does not identify which holding or quantity to sell, so no trim is recommended.`;
  } else if (sectorUnallocated) {
    riskPosture = "review";
    actionReason =
      `Review: ${h.sector ?? "this holding's sector"} is over its ${limits.maxSectorExposurePct}% cap ` +
      `(${((ctx.sectorWeightPct as number) * 100).toFixed(1)}% of NAV), but the per-name breach allocation ` +
      `was not computed — so this engine cannot say whether ${h.symbol} is one of the names that should ` +
      `absorb the reduction. A sector breach alone is not a per-name verdict. ` +
      `Next: recompute with allocateSectorBreach() wired.`;
  } else if (dataConfidence < CONF_REVIEW_FLOOR) {
    riskPosture = "review";
    actionReason = `Review: partial data (confidence ${(dataConfidence * 100).toFixed(0)}%; missing ${missingInputs.join(", ") || "none"}).`;
  } else if (sectorNotSelected) {
    // A plain "within owner-approved risk limits" would be a LIE while the sector
    // is over its cap. Say what, why, and what would change it.
    riskPosture = "hold";
    actionReason = `Hold (score ${score}/100): ${alloc!.reason}`;
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
