// Deterministic sector-cap breach allocator — PURE CORE.
//
// Spec: features/risk-sector-breach-allocation/FEATURE_ARCHITECTURE.md
//
// THE PROBLEM THIS EXISTS TO FIX: a sector-cap breach is a property of the
// SECTOR. `sectorWeight > cap` is the same number for every name in the sector,
// so using it directly as a per-name verdict gives EVERY holding in the sector
// the identical "trim" — with no answer to which names should absorb the breach
// or how much each gives up. That advice is arbitrary and unactionable.
//
// This module answers exactly that question and nothing else:
//
//   Given a sector over its cap and the reduction required to reach it, WHICH
//   holdings absorb it, and HOW MUCH does each give up?
//
// HARD PROPERTIES (proven by tests, not by convention):
//   - DETERMINISTIC. No LLM, no I/O, no clock, no randomness. Same inputs →
//     same allocation, byte for byte. Input order does not matter.
//   - RISK-INTERNAL. A function of position weights and ONE owner-set cap.
//     It reads no research score, no analyst_score, no conviction ordering.
//     Adding one would couple Risk to Research — explicitly out of scope.
//   - NEVER TOUCHES AN EXIT. This module has no exit concept at all. Its output
//     is consumed strictly BELOW the exit branch in computeHoldingRisk, so a
//     protective-stop / thesis-break exit can never be delayed or suppressed by
//     an allocation. Same invariant as lib/evidence/degradation-guard.ts.
//   - HONEST ON MISSING SECTOR. An unknown sector is reported as unknown. It is
//     never bucketed into a synthetic sector and never assumed cap-compliant.
//   - ADVISORY. Nothing here reaches an order path.
//
// DENOMINATOR — NAV, and it decides the arithmetic. With S = sector value,
// D = denominator, c = cap fraction, the value that must be sold is:
//    D = NAV (cash-inclusive): proceeds become cash INSIDE D  → X = S − c·D
//    D = invested (cash-excl): proceeds LEAVE D               → X = (S − c·D)/(1−c)
// At Tech 65.6% / cap 30% that is 35.6pp vs 50.9pp — a ~43% error if confused.
// Kairos' cap is NAV-relative: lib/risk/live-portfolio-gate.ts, the code that
// enforces max_sector_exposure_pct on the live money path, builds the book as
// `valuePct = value / NAV × 100`. The input field is therefore named `navValue`
// so a caller cannot silently hand over an invested-total and get wrong advice.

export const SECTOR_BREACH_ALLOCATOR_VERSION = "sba-v1";

// The fill runs in weight-fraction space (values ~0–1), never in currency, so a
// single fixed tolerance is meaningful at every account size.
const EPS = 1e-12;

/** A sector label that carries no usable sector evidence. */
function isUnknownSector(sector: string | null | undefined): boolean {
  const s = (sector ?? "").trim();
  return s === "" || s === "Other";
}

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Deterministic string order (no locale dependence). */
const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export type BreachRole =
  | "absorb"          // selected to give up weight
  | "not_selected"    // sector IS over cap, but this name was not selected
  | "no_breach"       // this name's sector is within its cap
  | "sector_unknown"; // no usable sector evidence — excluded, honestly

export interface SectorBreachPosition {
  symbol: string;
  /** null / "" / "Other" => sector evidence missing. */
  sector: string | null;
  marketValue: number;
}

export interface SectorBreachInput {
  positions: readonly SectorBreachPosition[];
  /** Account NAV (cash-inclusive) — the basis the owner's sector cap is set on. */
  navValue: number;
  /** Owner-approved cap in percent (e.g. 30). */
  maxSectorExposurePct: number;
  currency: "USD" | "INR";
  market: "us" | "india";
}

export interface SectorBreachSummary {
  sector: string;
  /** pp of NAV currently in this sector. */
  sectorWeightPct: number;
  capPct: number;
  breached: boolean;
  /** pp of NAV that must leave the sector to reach the cap. 0 when not breached. */
  requiredReductionPct: number;
  requiredReductionValue: number;
  /** The water-fill level, in pp of NAV. null when not breached. */
  levelWeightPct: number | null;
  /** Symbols selected to absorb, ordered by trim desc then symbol asc. */
  absorbers: string[];
  /** Symbols in the breached sector NOT selected, ordered by weight desc then symbol asc. */
  notSelected: string[];
  holdingCount: number;
}

export interface SectorBreachAllocation {
  symbol: string;
  sector: string | null;
  role: BreachRole;
  /** pp of NAV in this holding's sector; null when the sector is unknown. */
  sectorWeightPct: number | null;
  capPct: number;
  /** pp of NAV in THIS holding. */
  currentWeightPct: number;
  /** pp of NAV this holding should end at; null when unknown-sector. */
  targetWeightPct: number | null;
  /** pp of NAV this holding gives up. 0 for every non-`absorb` role. */
  trimPct: number;
  /** Account-currency value of the trim. 0 for every non-`absorb` role. */
  trimValue: number;
  /** 1 = largest absorber. null when not an absorber. */
  rank: number | null;
  /** How many names were selected to absorb this sector's breach. */
  absorberCount: number;
  /** What / why / next — never a bare verdict (CLAUDE.md "Detail Over Cryptic"). */
  reason: string;
  version: string;
}

export interface SectorBreachResult {
  version: string;
  /** Known sectors only, ordered by weight desc then sector asc. */
  sectors: SectorBreachSummary[];
  bySymbol: Map<string, SectorBreachAllocation>;
  /** Symbols excluded for want of usable sector evidence. */
  unknownSectorSymbols: string[];
}

const pp = (frac: number) => frac * 100;
const fmt = (x: number, d = 1) => x.toFixed(d);

/**
 * Solve the water-fill level L over `weights` (fractions of NAV, unsorted) such
 * that Σ min(wᵢ, L) = target.
 *
 * Σ min(wᵢ, L) is continuous and non-decreasing in L, from 0 at L=0 to Σwᵢ at
 * L=max(w), so exactly one L exists for any 0 < target < Σwᵢ. Closed form: sort
 * ascending; for each k assume the k smallest are untouched and the rest sit at
 * L = (target − prefix[k]) / (n − k); accept the first k where that L is
 * consistent (w[k−1] ≤ L ≤ w[k]).
 *
 * Ties need no arbitrary winner: L is a continuous function of the weight
 * vector, so equal weights always receive equal trims.
 */
function waterFillLevel(weights: readonly number[], target: number): number {
  const w = [...weights].sort((a, b) => a - b);
  const n = w.length;
  if (n === 0) return 0;
  if (target <= 0) return 0;

  let prefix = 0;
  for (let k = 0; k < n; k++) {
    const L = (target - prefix) / (n - k);
    const aboveLower = k === 0 || L >= w[k - 1] - EPS;
    const belowUpper = L <= w[k] + EPS;
    if (aboveLower && belowUpper) return Math.max(0, L);
    prefix += w[k];
  }
  // Unreachable for 0 < target < Σw. Defensive: level at the largest weight
  // (i.e. trim nothing) rather than fabricate an allocation.
  return w[n - 1];
}

/**
 * Deterministic sector-cap breach allocation.
 *
 * Pure: no I/O, no clock, no LLM, no research score. The caller threads the
 * per-symbol result into HoldingRiskContext.sectorBreachAllocation, where it is
 * consulted strictly BELOW the exit branch.
 */
export function allocateSectorBreach(input: SectorBreachInput): SectorBreachResult {
  const bySymbol = new Map<string, SectorBreachAllocation>();
  const unknownSectorSymbols: string[] = [];
  const sectors: SectorBreachSummary[] = [];

  const nav = input.navValue;
  const capPct = input.maxSectorExposurePct;
  // A cap outside (0,100) cannot be evaluated. Report it and claim no breach —
  // never fabricate one from an unusable limit.
  const capUsable = isFiniteNum(capPct) && capPct > 0 && capPct < 100;
  const capFrac = capUsable ? capPct / 100 : NaN;
  const navUsable = isFiniteNum(nav) && nav > 0;

  // ── Bucket by sector. Unknown sector and unvalued positions are EXCLUDED from
  // every sector total — never rolled into a synthetic bucket, never counted as 0.
  const buckets = new Map<string, SectorBreachPosition[]>();
  for (const p of input.positions) {
    const valued = isFiniteNum(p.marketValue) && p.marketValue >= 0;
    if (!navUsable || isUnknownSector(p.sector) || !valued) {
      unknownSectorSymbols.push(p.symbol);
      const why = !navUsable
        ? "account NAV is unavailable, so no sector weight can be computed"
        : !valued
          ? "this holding has no usable market value, so its sector weight is unknown"
          : "no sector is mapped for this symbol";
      bySymbol.set(p.symbol, {
        symbol: p.symbol,
        sector: isUnknownSector(p.sector) ? null : (p.sector as string),
        role: "sector_unknown",
        sectorWeightPct: null,
        capPct,
        currentWeightPct: navUsable && valued ? pp(p.marketValue / nav) : 0,
        targetWeightPct: null,
        trimPct: 0,
        trimValue: 0,
        rank: null,
        absorberCount: 0,
        reason:
          `Sector unknown for ${p.symbol} — ${why}. This holding is excluded from sector-cap ` +
          `allocation: it is neither counted toward any sector's breach nor asked to absorb one, ` +
          `and it is NOT being treated as cap-compliant. Next: map ${p.symbol} to a sector ` +
          `(lib/portfolio-risk.ts) to bring it under the ${capPct}% sector cap.`,
        version: SECTOR_BREACH_ALLOCATOR_VERSION,
      });
      continue;
    }
    const key = p.sector as string;
    const arr = buckets.get(key);
    if (arr) arr.push(p);
    else buckets.set(key, [p]);
  }

  // ── Per-sector allocation.
  for (const [sector, members] of buckets) {
    const sectorValue = members.reduce((s, m) => s + m.marketValue, 0);
    const sectorFrac = sectorValue / nav;
    const breached = capUsable && sectorFrac > capFrac + EPS;

    // Weight fractions of NAV, keyed by symbol.
    const weights = members.map(m => ({ symbol: m.symbol, w: m.marketValue / nav }));

    if (!breached) {
      const why = capUsable
        ? `${sector} is ${fmt(pp(sectorFrac))}% of NAV, within the ${capPct}% sector cap`
        : `the sector cap (${capPct}%) is not a usable limit, so no sector-cap reduction can be computed for ${sector}`;
      for (const m of weights) {
        bySymbol.set(m.symbol, {
          symbol: m.symbol, sector, role: "no_breach",
          sectorWeightPct: pp(sectorFrac), capPct,
          currentWeightPct: pp(m.w), targetWeightPct: pp(m.w),
          trimPct: 0, trimValue: 0, rank: null, absorberCount: 0,
          reason: `${why} — no sector-cap reduction is required of ${m.symbol}.`,
          version: SECTOR_BREACH_ALLOCATOR_VERSION,
        });
      }
      sectors.push({
        sector, sectorWeightPct: pp(sectorFrac), capPct, breached: false,
        requiredReductionPct: 0, requiredReductionValue: 0, levelWeightPct: null,
        absorbers: [], notSelected: [], holdingCount: members.length,
      });
      continue;
    }

    // Breach amount. NAV basis: sale proceeds stay inside NAV as cash, so the
    // denominator does not move and the reduction is exactly S − c·NAV.
    const requiredReductionFrac = sectorFrac - capFrac;
    const level = waterFillLevel(weights.map(m => m.w), capFrac);

    const rows = weights.map(m => {
      const target = Math.min(m.w, level);
      const trim = Math.max(0, m.w - level);
      return { symbol: m.symbol, w: m.w, target, trim };
    });

    // Deterministic ordering: trim desc, then symbol asc.
    const absorberRows = rows
      .filter(r => r.trim > EPS)
      .sort((a, b) => (b.trim - a.trim) || byString(a.symbol, b.symbol));
    const notSelectedRows = rows
      .filter(r => r.trim <= EPS)
      .sort((a, b) => (b.w - a.w) || byString(a.symbol, b.symbol));

    const absorberCount = absorberRows.length;
    const sectorPctS = fmt(pp(sectorFrac));
    const redPctS = fmt(pp(requiredReductionFrac));
    const levelPctS = fmt(pp(level), 2);

    absorberRows.forEach((r, i) => {
      const rank = i + 1;
      const trimValue = r.trim * nav;
      bySymbol.set(r.symbol, {
        symbol: r.symbol, sector, role: "absorb",
        sectorWeightPct: pp(sectorFrac), capPct,
        currentWeightPct: pp(r.w), targetWeightPct: pp(r.target),
        trimPct: pp(r.trim), trimValue, rank, absorberCount,
        reason:
          `Trim ${r.symbol} by ${fmt(pp(r.trim), 2)}pp of NAV — from ${fmt(pp(r.w), 2)}% to ` +
          `${fmt(pp(r.target), 2)}% of NAV (≈ ${trimValue.toFixed(0)} ${input.currency}). ` +
          `Why: ${sector} is ${sectorPctS}% of NAV against the ${capPct}% cap, so ${redPctS}pp ` +
          `must come out of the sector; ${r.symbol} is #${rank} of the ${absorberCount} largest ` +
          `${sector} position${absorberCount === 1 ? "" : "s"}, and the breach is allocated ` +
          `largest-first down to a common ${levelPctS}% level (this discharges the sector cap ` +
          `while doing the most it can for the name-concentration cap). ` +
          `Next: re-check after the reduction — the sector lands exactly on ${capPct}%.`,
        version: SECTOR_BREACH_ALLOCATOR_VERSION,
      });
    });

    for (const r of notSelectedRows) {
      bySymbol.set(r.symbol, {
        symbol: r.symbol, sector, role: "not_selected",
        sectorWeightPct: pp(sectorFrac), capPct,
        currentWeightPct: pp(r.w), targetWeightPct: pp(r.w),
        trimPct: 0, trimValue: 0, rank: null, absorberCount,
        reason:
          `Hold ${r.symbol}. Why: ${sector} IS over its ${capPct}% cap (${sectorPctS}% of NAV) ` +
          `and ${redPctS}pp must come out of the sector — but ${r.symbol} is not among the names ` +
          `selected to absorb it. At ${fmt(pp(r.w), 2)}% of NAV it already sits at or below the ` +
          `${levelPctS}% level the ${absorberCount} larger ${sector} position` +
          `${absorberCount === 1 ? "" : "s"} (${absorberRows.map(a => a.symbol).join(", ")}) ` +
          `${absorberCount === 1 ? "is" : "are"} being trimmed down to, so trimming ${r.symbol} ` +
          `would deepen concentration in the larger names instead of relieving it. ` +
          `Next: ${r.symbol} only becomes a candidate if those larger positions are not reduced.`,
        version: SECTOR_BREACH_ALLOCATOR_VERSION,
      });
    }

    sectors.push({
      sector, sectorWeightPct: pp(sectorFrac), capPct, breached: true,
      requiredReductionPct: pp(requiredReductionFrac),
      requiredReductionValue: requiredReductionFrac * nav,
      levelWeightPct: pp(level),
      absorbers: absorberRows.map(r => r.symbol),
      notSelected: notSelectedRows.map(r => r.symbol),
      holdingCount: members.length,
    });
  }

  sectors.sort((a, b) => (b.sectorWeightPct - a.sectorWeightPct) || byString(a.sector, b.sector));
  unknownSectorSymbols.sort(byString);

  return { version: SECTOR_BREACH_ALLOCATOR_VERSION, sectors, bySymbol, unknownSectorSymbols };
}
