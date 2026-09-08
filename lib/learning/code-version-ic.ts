// Stage A — per-code_version IC ledger (DETECTION ONLY, not causal attribution).
//
// Answers "did this dimension's rank IC change after code_version X shipped",
// never "did code_version X cause the change". Deploys ship weeks apart and the
// market regime moves between them, so a before/after split on code_version is
// confounded by definition — the UI and alert copy must always say "changed
// after", never "caused by".
//
// Deliberately reuses `buildDimensionFindings` (lib/learning/dimension-diagnostics.ts)
// rather than re-deriving rank IC: that function already does the one thing
// that makes an IC number trustworthy here — per-SESSION Spearman IC, averaged,
// with the overlap-aware nEffective floor (see MIN_EFFECTIVE_OBSERVATIONS) and
// the eligible-long cohort restriction (lib/learning/entry-cohort.ts). A second
// pooled-Spearman implementation over one code_version's rows would silently
// treat overlapping forward-return windows as independent draws — the exact bug
// nEffective exists to catch — and could drift from what the learner and the
// dimension-diagnostics panel report for the SAME rows. This file only groups
// observations by code_version and reads the numbers already computed.
import {
  buildDimensionFindings,
  DIAGNOSTIC_DIMENSIONS,
  type DiagnosticDimension,
  type DiagnosticObservation,
} from "./dimension-diagnostics";
import { normalCdf } from "@/lib/validation/feature-check";

export type Market = "us" | "india";

/** Observations with no recorded code_version (~33-37% of history, both markets,
 * measured 2026-09-08) are bucketed here rather than dropped or blended into a
 * named version — they could span several real deploys, so grouping them under
 * one version key would manufacture a false "boundary". */
export const UNKNOWN_CODE_VERSION = "unknown";

export type CodeVersionCell = {
  market: Market;
  horizonDays: number;
  dimension: DiagnosticDimension;
  codeVersion: string;
  firstSeen: string;
  lastSeen: string;
  n: number;
  qualifyingSessions: number;
  meanIc: number | null;
  sd: number | null;
  tStat: number | null;
  /** Normal approximation on tStat (nEffective, not raw n — see file header).
   * Null whenever tStat is null (classification is insufficient_evidence). */
  ci95: [number, number] | null;
  pValue: number | null;
  effectiveObservations: number;
  classification: "insufficient_evidence" | "measured_descriptive";
  reason: string;
  /** Set by applyMultipleComparisonsControl. Undefined until that pass runs. */
  bhSignificant?: boolean;
  bhQ?: number;
};

const PAGE = 1000;

/**
 * Same shape/pagination discipline as
 * app/api/agents/dimension-diagnostics/route.ts's loadObservations (PostgREST
 * silently caps unpaginated reads at 1,000 rows — see that file's header
 * comment and docs/arch/09-learning-loop.md 2026-08-28 entry). Duplicated
 * rather than imported because that loader is a route-local, unexported
 * function and also joins agent_signals for a label this ledger never uses —
 * skipping that join here is a real cost saving, not laziness that loses
 * correctness.
 *
 * `benchmark_neutral_return` falls back to `fwd_return` per-row: production
 * has real fwd_return-only rows (e.g. US h10 11 rows, India h5 64, h10 53, h20
 * 91 — measured 2026-09-08), and dropping them would understate n for exactly
 * the small-sample cells this feature exists to police.
 */
export async function loadCodeVersionObservations(
  svc: any,
  market: Market,
  horizonDays: number,
): Promise<DiagnosticObservation[]> {
  const rows: any[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await svc
      .from("observation_labels")
      .select(
        "id,observation_id,horizon_days,benchmark_neutral_return,fwd_return,decision_observations!inner(id,ts,symbol,market,code_version,analyst_score,fundamental_score,technical_score,sentiment_score,macro_score,insider_score,availability_mask,entry_eligible,direction,action)",
      )
      .eq("horizon_days", horizonDays)
      .eq("decision_observations.market", market)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`code-version IC label query failed: ${error.message}`);
    const page = (data ?? []) as any[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows.flatMap((row) => {
    const decision = Array.isArray(row.decision_observations) ? row.decision_observations[0] : row.decision_observations;
    if (!decision?.id || !decision.ts) return [];
    const returnValue = row.benchmark_neutral_return ?? row.fwd_return;
    if (returnValue == null) return [];
    return [{
      id: Number(decision.id),
      ts: String(decision.ts),
      symbol: String(decision.symbol),
      codeVersion: decision.code_version == null ? null : String(decision.code_version),
      analystScore: decision.analyst_score == null ? null : Number(decision.analyst_score),
      scores: {
        fundamental: decision.fundamental_score == null ? null : Number(decision.fundamental_score),
        technical: decision.technical_score == null ? null : Number(decision.technical_score),
        sentiment: decision.sentiment_score == null ? null : Number(decision.sentiment_score),
        macro: decision.macro_score == null ? null : Number(decision.macro_score),
        insider: decision.insider_score == null ? null : Number(decision.insider_score),
      },
      availabilityMask: decision.availability_mask ?? null,
      benchmarkNeutralReturn: Number(returnValue),
      entryEligible: decision.entry_eligible === true,
      direction: decision.direction == null ? null : String(decision.direction),
      action: String(decision.action ?? "scored"),
      // Unused by buildDimensionFindings' dimension path (agentLabel only
      // feeds buildAgentFindings, which this ledger never calls); stubbed to
      // satisfy the shared DiagnosticObservation type without the extra
      // agent_signals join loadObservations pays for.
      agentLabel: "",
    } satisfies DiagnosticObservation];
  });
}

function ci95FromMeanSd(mean: number | null, sd: number | null, nEffective: number): [number, number] | null {
  if (mean == null || sd == null || !Number.isFinite(sd) || sd < 0 || !Number.isFinite(nEffective) || nEffective <= 0) return null;
  const se = sd / Math.sqrt(nEffective);
  if (!Number.isFinite(se)) return null;
  return [mean - 1.96 * se, mean + 1.96 * se];
}

/** Two-sided p-value from the already-computed t-stat, normal-approximated
 * (nEffective is rarely large enough for a t-distribution to matter more than
 * the normal approximation already used to build the t-stat itself). Null
 * whenever tStat is null. */
function pValueFromT(tStat: number | null): number | null {
  if (tStat == null || !Number.isFinite(tStat)) return null;
  return 2 * (1 - normalCdf(Math.abs(tStat)));
}

/** Builds one cell per (dimension) for every code_version present in the
 * loaded observations, at the given horizon. Read-only — no DB writes. */
export function buildCodeVersionIcLedger(
  market: Market,
  horizonDays: number,
  observations: DiagnosticObservation[],
): CodeVersionCell[] {
  const groups = new Map<string, DiagnosticObservation[]>();
  for (const row of observations) {
    const key = row.codeVersion ?? UNKNOWN_CODE_VERSION;
    const group = groups.get(key);
    if (group) group.push(row); else groups.set(key, [row]);
  }

  const cells: CodeVersionCell[] = [];
  for (const [codeVersion, rows] of groups) {
    const sortedTs = rows.map((r) => r.ts).sort();
    const findings = buildDimensionFindings(rows, horizonDays).filter((f) => f.findingType === "predictive");
    for (const finding of findings) {
      const m = finding.metrics as Record<string, unknown>;
      const classification = finding.classification as CodeVersionCell["classification"];
      const measured = classification === "measured_descriptive";
      const meanIc = (m.mean_session_rank_ic as number | null) ?? null;
      const sd = (m.sd_session_rank_ic as number | null) ?? null;
      const tStat = (m.t_stat as number | null) ?? null;
      const nEffective = (m.effective_observations as number) ?? 0;
      // A cell that never cleared the evidence floor gets NO numeric verdict —
      // not a number with no support behind it — even though
      // buildDimensionFindings still computes mean/sd internally for its own
      // reporting. CI and p-value are gated on `measured` explicitly here.
      cells.push({
        market,
        horizonDays,
        dimension: finding.subjectKey as DiagnosticDimension,
        codeVersion,
        firstSeen: sortedTs[0],
        lastSeen: sortedTs[sortedTs.length - 1],
        n: (m.labeled_observations as number) ?? 0,
        qualifyingSessions: (m.qualifying_sessions as number) ?? 0,
        meanIc: measured ? meanIc : null,
        sd: measured ? sd : null,
        tStat: measured ? tStat : null,
        ci95: measured ? ci95FromMeanSd(meanIc, sd, nEffective) : null,
        pValue: measured ? pValueFromT(tStat) : null,
        effectiveObservations: nEffective,
        classification,
        reason: finding.reason,
      });
    }
  }
  // Chronological, dimension grouped, so a consumer can walk deploy boundaries
  // in order without re-sorting.
  cells.sort((a, b) => a.dimension.localeCompare(b.dimension) || a.firstSeen.localeCompare(b.firstSeen));
  return cells;
}

/**
 * Benjamini-Hochberg false-discovery control across every cell that cleared
 * its own n/CI floor (insufficient_evidence cells never get a verdict and are
 * excluded from the correction entirely, not treated as non-significant).
 *
 * Why this exists: up to 50 code_versions x 6 dimensions is ~300 comparisons.
 * At alpha=0.05 uncontrolled, ~15 of those would show "significant" by chance
 * alone with NO real change — manufactured culprits, the exact trap
 * WORK_LOG.md 2026-09-05 parked "Systematic Pattern Discovery" over. BH
 * controls the expected false-discovery share among cells flagged significant,
 * not the false-positive rate of any one cell.
 */
export function applyMultipleComparisonsControl(cells: CodeVersionCell[], alpha = 0.05): CodeVersionCell[] {
  const testable = cells
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => cell.classification === "measured_descriptive" && cell.pValue != null);
  const m = testable.length;
  const sorted = [...testable].sort((a, b) => (a.cell.pValue as number) - (b.cell.pValue as number));
  let cutoffRank = 0;
  for (let rank = m; rank >= 1; rank--) {
    const p = sorted[rank - 1].cell.pValue as number;
    if (p <= (rank / m) * alpha) { cutoffRank = rank; break; }
  }
  const bhQByIndex = new Map<number, number>();
  // BH-adjusted q-value: running minimum of p * m / rank, walked from the
  // largest p-value down, which is the standard monotone BH q-value.
  let runningMin = Infinity;
  for (let rank = m; rank >= 1; rank--) {
    const { cell, index } = sorted[rank - 1];
    const q = Math.min(runningMin, (cell.pValue as number) * m / rank);
    runningMin = q;
    bhQByIndex.set(index, q);
  }
  return cells.map((cell, index) => {
    if (cell.classification !== "measured_descriptive" || cell.pValue == null) return cell;
    const sortedRank = sorted.findIndex((s) => s.index === index) + 1;
    return { ...cell, bhSignificant: sortedRank <= cutoffRank, bhQ: bhQByIndex.get(index) ?? null as unknown as number };
  });
}

export { DIAGNOSTIC_DIMENSIONS };
