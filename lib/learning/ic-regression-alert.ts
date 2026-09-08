// Stage A — rolling IC regression detector.
//
// "Regression" here means "the most recent code_version's IC sits further from
// the dimension's own historical IC spread than a threshold DERIVED FROM THAT
// SPREAD" — never "this code_version caused the drop". Deploys ship weeks
// apart; the market regime moves in between. Alert/UI copy must say
// "changed after <code_version>", never "caused by".
import { reconcileIssues, type ReportIssueInput, type Severity } from "@/lib/system-health";
import { UNKNOWN_CODE_VERSION, type CodeVersionCell, type Market } from "./code-version-ic";

export type RegressionAlert = {
  market: Market;
  horizonDays: number;
  dimension: string;
  boundaryCodeVersion: string;
  priorCodeVersions: string[];
  icBefore: number;
  icAfter: number;
  nBefore: number;
  nAfter: number;
  sdBefore: number;
  deltaInSd: number;
  severity: Severity;
};

const MIN_PRIOR_VERSIONS_FOR_BASELINE = 5;
/** How many SDs the current version's IC must sit below the historical mean
 * to raise `warn`; 3 SDs for `critical`. Not a picked absolute IC constant —
 * it scales with each dimension's own observed variance, so a naturally noisy
 * dimension (e.g. insider) needs a bigger absolute move than a stable one to
 * trigger, and a dimension whose IC has always been near zero never fires on
 * ordinary noise. */
const WARN_SD_MULTIPLE = 2;
const CRITICAL_SD_MULTIPLE = 3;

/**
 * Walks each dimension's code_version-ordered IC series (excluding the
 * UNKNOWN_CODE_VERSION bucket, which cannot anchor a boundary — it may span
 * several real deploys) and flags the LATEST version if its IC sits more than
 * WARN_SD_MULTIPLE historical standard deviations below the mean of every
 * PRIOR measured_descriptive version for that dimension/horizon/market.
 *
 * Requires at least MIN_PRIOR_VERSIONS_FOR_BASELINE prior measured versions to
 * even attempt a baseline — with fewer, "historical variance" is not
 * estimated, it is guessed, and guessing a threshold is exactly what this
 * function exists to avoid doing with a hardcoded IC constant instead.
 */
export function detectRegressions(cells: CodeVersionCell[]): RegressionAlert[] {
  const byKey = new Map<string, CodeVersionCell[]>();
  for (const cell of cells) {
    if (cell.codeVersion === UNKNOWN_CODE_VERSION) continue;
    const key = `${cell.market}:${cell.horizonDays}:${cell.dimension}`;
    const group = byKey.get(key);
    if (group) group.push(cell); else byKey.set(key, [cell]);
  }

  const alerts: RegressionAlert[] = [];
  for (const series of byKey.values()) {
    const ordered = [...series].sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
    const latest = ordered[ordered.length - 1];
    if (latest.classification !== "measured_descriptive" || latest.meanIc == null) continue;
    const priorMeasured = ordered.slice(0, -1).filter((c) => c.classification === "measured_descriptive" && c.meanIc != null);
    if (priorMeasured.length < MIN_PRIOR_VERSIONS_FOR_BASELINE) continue;

    const priorIcs = priorMeasured.map((c) => c.meanIc as number);
    const historicalMean = priorIcs.reduce((sum, v) => sum + v, 0) / priorIcs.length;
    const variance = priorIcs.reduce((sum, v) => sum + (v - historicalMean) ** 2, 0) / (priorIcs.length - 1 || 1);
    const historicalSd = Math.sqrt(variance);
    if (!Number.isFinite(historicalSd) || historicalSd <= 0) continue;

    const deltaInSd = (historicalMean - latest.meanIc) / historicalSd;
    if (deltaInSd < WARN_SD_MULTIPLE) continue;

    alerts.push({
      market: latest.market,
      horizonDays: latest.horizonDays,
      dimension: latest.dimension,
      boundaryCodeVersion: latest.codeVersion,
      priorCodeVersions: priorMeasured.map((c) => c.codeVersion),
      icBefore: historicalMean,
      icAfter: latest.meanIc,
      nBefore: priorMeasured.reduce((sum, c) => sum + c.n, 0),
      nAfter: latest.n,
      sdBefore: historicalSd,
      deltaInSd,
      severity: deltaInSd >= CRITICAL_SD_MULTIPLE ? "critical" : "warn",
    });
  }
  return alerts;
}

function alertToIssue(alert: RegressionAlert): ReportIssueInput {
  const shortVersion = alert.boundaryCodeVersion.slice(0, 12);
  return {
    issueKey: `ic-regression:${alert.market}:${alert.dimension}:h${alert.horizonDays}:${alert.boundaryCodeVersion}`,
    severity: alert.severity,
    category: "learning-ic-drift",
    title: `${alert.market} ${alert.dimension} h${alert.horizonDays} rank IC changed after code_version ${shortVersion}`,
    detail: `IC before ${alert.icBefore.toFixed(4)} (n=${alert.nBefore} across ${alert.priorCodeVersions.length} prior versions) `
      + `-> after ${alert.icAfter.toFixed(4)} (n=${alert.nAfter}), ${alert.deltaInSd.toFixed(2)} historical SDs `
      + `(SD=${alert.sdBefore.toFixed(4)}) below the prior mean. This says the IC changed AFTER code_version `
      + `${alert.boundaryCodeVersion} shipped, not that it was CAUSED by that version — deploys ship weeks apart `
      + `and the market regime moves between them. Detection only; no score, weight, or eligibility path reads this.`,
  };
}

/** Writes/refreshes an agent_alerts row per active regression and resolves any
 * previously-open regression alert for this market that is no longer active
 * (via lib/system-health.ts reconcileIssues, which owns dedup/auto-resolve). */
export async function reconcileRegressionAlerts(market: Market, cells: CodeVersionCell[], client?: any): Promise<RegressionAlert[]> {
  const alerts = detectRegressions(cells);
  await reconcileIssues(`ic-regression:${market}:`, alerts.map(alertToIssue), client);
  return alerts;
}
