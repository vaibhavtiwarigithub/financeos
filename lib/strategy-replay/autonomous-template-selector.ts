export const AUTONOMOUS_TEMPLATE_SELECTOR_VERSION = "paired-horizon-spaced-forward-v2";
export const MIN_PAIRED_SESSIONS = 60;
export const MIN_NONOVERLAP_WINDOWS = 20;

export interface ForwardRuleOutcome {
  session: string;
  symbol: string;
  wouldEnter: boolean;
  baselineEligible: boolean;
  entrySession: string | null;
  exitSession: string | null;
  /** Null means the forward label has not matured or was not collected. */
  netReturnPct: number | null;
}

export interface RuleSelectionEvaluation {
  configId?: string;
  horizonSessions?: number;
  status: "insufficient" | "retain" | "select" | "retire";
  selectorVersion: string;
  pairedSessions: number;
  nonoverlapWindows: number;
  trialCount: number;
  meanRuleReturnPct: number | null;
  meanBaselineReturnPct: number | null;
  meanPairedExcessPct: number | null;
  oneSidedT: number | null;
  requiredT: number;
  maxDrawdownRulePct: number | null;
  maxDrawdownBaselinePct: number | null;
  positiveWindowFraction: number | null;
  firstHalfExcessPct: number | null;
  secondHalfExcessPct: number | null;
  reason: string;
}

export async function evaluateAndPersistAutonomousRuleShadows(supabase: any, market: "us" | "india") {
  const policy = await supabase.from("strategy_validation_automation")
    .select("enabled,auto_shadow_enabled,auto_rule_paper_select_enabled").eq("market", market).maybeSingle();
  if (policy.error) throw new Error(`rule selector policy read failed: ${policy.error.message}`);
  if (policy.data?.enabled !== true || policy.data?.auto_shadow_enabled !== true
    || policy.data?.auto_rule_paper_select_enabled !== true) {
    return { status: "disabled", market, evaluated: 0, selectedConfigId: null };
  }
  const configResult = await supabase.from("strategy_template_shadow_configs")
    .select("id,rule_spec,trial_family_id,state").eq("market", market).eq("state", "shadow").order("created_at", { ascending: true }).limit(3);
  if (configResult.error) throw new Error(`active rule candidates read failed: ${configResult.error.message}`);
  const configs = configResult.data ?? [];
  const evaluations: RuleSelectionEvaluation[] = [];
  for (const config of configs) {
    const decisions: any[] = [];
    for (let offset = 0; offset < 5000; offset += 1000) {
      const page = await supabase.from("strategy_template_shadow_decisions")
        .select("id,symbol,signal_session,would_enter,baseline_entry_eligible")
        .eq("config_id", config.id).eq("market", market).order("signal_session", { ascending: true })
        .range(offset, offset + 999);
      if (page.error) throw new Error(`forward rule decisions read failed: ${page.error.message}`);
      decisions.push(...(page.data ?? []));
      if ((page.data ?? []).length < 1000) break;
    }
    const outcomes: ForwardRuleOutcome[] = [];
    for (let offset = 0; offset < decisions.length; offset += 500) {
      const chunk = decisions.slice(offset, offset + 500);
      if (!chunk.length) continue;
      const labeled = await supabase.from("strategy_template_shadow_outcomes")
        .select("decision_id,entry_session,exit_session,net_return_pct").in("decision_id", chunk.map((row: any) => row.id));
      if (labeled.error) throw new Error(`forward rule outcomes read failed: ${labeled.error.message}`);
      const byId = new Map<number, any>((labeled.data ?? []).map((row: any) => [Number(row.decision_id), row] as [number, any]));
      for (const row of chunk) {
        const label = byId.get(Number(row.id));
        const netReturnPct = label ? Number(label.net_return_pct) : null;
        outcomes.push({ session: String(row.signal_session).slice(0, 10), symbol: String(row.symbol),
          wouldEnter: row.would_enter === true, baselineEligible: row.baseline_entry_eligible === true,
          entrySession: label?.entry_session ? String(label.entry_session).slice(0, 10) : null,
          exitSession: label?.exit_session ? String(label.exit_session).slice(0, 10) : null, netReturnPct });
      }
    }
    const trials = await supabase.from("trial_family_ledger").select("id", { count: "exact", head: true })
      .eq("trial_family_id", config.trial_family_id);
    if (trials.error) throw new Error(`declared trial-family count read failed: ${trials.error.message}`);
    const horizon = Number(config.rule_spec?.horizonSessions);
    const evaluation = evaluateAutonomousRuleForwardEvidence({ outcomes, horizonSessions: horizon,
      trialCount: Math.max(1, Number(trials.count ?? 0)) });
    evaluation.configId = String(config.id);
    evaluation.horizonSessions = horizon;
    evaluations.push(evaluation);
  }
  if (!evaluations.length) return { status: "no_active_candidates", market, evaluated: 0, selectedConfigId: null };
  const passing = evaluations.filter((row) => row.status === "select").sort((a, b) =>
    Number(b.meanPairedExcessPct) - Number(a.meanPairedExcessPct)
    || Number(b.oneSidedT) - Number(a.oneSidedT)
    || String(a.configId).localeCompare(String(b.configId)));
  const selectedConfigId = passing[0]?.configId ?? null;
  const applied = await supabase.rpc("apply_autonomous_rule_evaluations", {
    p_market: market, p_evaluations: evaluations, p_selected_config_id: selectedConfigId,
  });
  if (applied.error) throw new Error(`autonomous rule evaluation persistence failed: ${applied.error.message}`);
  return { status: "evaluated", market, evaluated: evaluations.length,
    selectedConfigId: applied.data?.selected_config_id ?? null, evaluations };
}

/**
 * Compares rule and deterministic-baseline equal-weight sleeves on identical
 * signal sessions. Only complete paired sessions enter the test. The horizon
 * stride removes overlapping forward labels; familywise trial adjustment is
 * deliberately conservative. This is a paper eligibility gate, not a return
 * forecast or a claim of durable alpha.
 */
export function evaluateAutonomousRuleForwardEvidence(input: {
  outcomes: readonly ForwardRuleOutcome[];
  horizonSessions: number;
  trialCount: number;
  incumbentIsCandidate?: boolean;
}): RuleSelectionEvaluation {
  const trials = Math.max(1, Math.floor(input.trialCount));
  const minimumDf = MIN_NONOVERLAP_WINDOWS - 1;
  const invalid = input.outcomes.some((row) => !/^\d{4}-\d{2}-\d{2}$/.test(row.session)
    || !row.symbol || (row.netReturnPct != null && (!Number.isFinite(row.netReturnPct)
      || !validSession(row.entrySession) || !validSession(row.exitSession)
      || String(row.entrySession) >= String(row.exitSession))));
  if (invalid || !Number.isInteger(input.horizonSessions) || input.horizonSessions < 1) {
    return result("insufficient", "Malformed outcome or horizon; no selection was made.", [], [], trials, studentTCriticalOneSided(0.05 / trials, minimumDf));
  }

  const bySession = new Map<string, ForwardRuleOutcome[]>();
  for (const row of input.outcomes) {
    const group = bySession.get(row.session) ?? [];
    group.push(row);
    bySession.set(row.session, group);
  }
  const sessions = [...bySession.keys()].sort();
  const sessionRows = sessions.map((session) => {
    const rows = bySession.get(session)!;
    if (rows.some((row) => row.netReturnPct == null || !row.entrySession || !row.exitSession)) return null;
    const rule = rows.filter((row) => row.wouldEnter).map((row) => row.netReturnPct as number);
    const baseline = rows.filter((row) => row.baselineEligible).map((row) => row.netReturnPct as number);
    const ruleMean = rule.length ? mean(rule) : 0;
    const baselineMean = baseline.length ? mean(baseline) : 0;
    const entrySession = rows.map((row) => String(row.entrySession)).sort()[0];
    const exitSessions = rows.map((row) => String(row.exitSession)).sort();
    const exitSession = exitSessions[exitSessions.length - 1];
    return { session, entrySession, exitSession, rule: ruleMean, baseline: baselineMean, diff: ruleMean - baselineMean };
  });
  const paired = sessionRows.filter((row): row is NonNullable<typeof row> => row !== null);
  // Select labels only when the actual entry session begins at or after the
  // preceding selected label's exit session. This remains non-overlapping even
  // when whole research dates are missing or markets close for holidays.
  const windows: Array<NonNullable<(typeof sessionRows)[number]>> = [];
  let priorExit: string | null = null;
  for (const row of sessionRows) {
    if (!row || (priorExit != null && String(row.entrySession) < priorExit)) continue;
    windows.push(row);
    priorExit = String(row.exitSession);
  }
  const blockDiffs = windows.map((row) => row.diff);
  const ruleReturns = windows.map((row) => row.rule);
  const baselineReturns = windows.map((row) => row.baseline);
  const ruleDd = maxDrawdown(ruleReturns), baselineDd = maxDrawdown(baselineReturns);
  const avgRule = ruleReturns.length ? mean(ruleReturns) : null;
  const avgBaseline = baselineReturns.length ? mean(baselineReturns) : null;
  const avgDiff = blockDiffs.length ? mean(blockDiffs) : null;
  const rawT = blockDiffs.length >= 2 ? oneSampleT(blockDiffs) : null;
  const requiredT = studentTCriticalOneSided(0.05 / trials, Math.max(minimumDf, blockDiffs.length - 1));
  // JSONB cannot represent +/-Infinity; cap a degenerate, strictly positive
  // series at a finite value while retaining its overwhelmingly strong signal.
  const t = rawT == null ? null : Number.isFinite(rawT) ? rawT : rawT > 0 ? 1_000_000 : -1_000_000;
  const midpoint = Math.floor(blockDiffs.length / 2);
  const firstHalfExcessPct = midpoint ? mean(blockDiffs.slice(0, midpoint)) : null;
  const secondHalfExcessPct = blockDiffs.length - midpoint ? mean(blockDiffs.slice(midpoint)) : null;
  const positiveWindowFraction = blockDiffs.length ? blockDiffs.filter((value) => value > 0).length / blockDiffs.length : null;
  if (paired.length < MIN_PAIRED_SESSIONS || blockDiffs.length < MIN_NONOVERLAP_WINDOWS) {
    return result("insufficient", `Requires ${MIN_PAIRED_SESSIONS} complete paired sessions and ${MIN_NONOVERLAP_WINDOWS} labels with disjoint realized entry/exit intervals; at least ${MIN_NONOVERLAP_WINDOWS * input.horizonSessions} sessions are normally needed at this horizon.`, paired, blockDiffs, trials, requiredT, avgRule, avgBaseline, avgDiff, t, ruleDd, baselineDd, positiveWindowFraction, firstHalfExcessPct, secondHalfExcessPct);
  }
  const passed = avgRule != null && avgRule > 0 && avgDiff != null && avgDiff > 0
    && t != null && t >= requiredT && ruleDd <= baselineDd
    && positiveWindowFraction != null && positiveWindowFraction >= 0.6
    && firstHalfExcessPct != null && firstHalfExcessPct > 0
    && secondHalfExcessPct != null && secondHalfExcessPct > 0;
  const status = passed ? "select" : "retire";
  return result(status, passed
    ? "Predeclared paired forward gates passed; eligible for paper selection."
    : "Mature forward evidence failed at least one net-return, paired-skill, trial-adjusted confidence, stability, positive-window frequency, or drawdown gate.",
  paired, blockDiffs, trials, requiredT, avgRule, avgBaseline, avgDiff, t, ruleDd, baselineDd, positiveWindowFraction, firstHalfExcessPct, secondHalfExcessPct);
}

function result(
  status: RuleSelectionEvaluation["status"], reason: string,
  paired: Array<{ session: string; rule: number; baseline: number; diff: number }>, blocks: number[],
  trialCount: number, requiredT: number, meanRuleReturnPct: number | null = null,
  meanBaselineReturnPct: number | null = null, meanPairedExcessPct: number | null = null,
  oneSidedT: number | null = null, maxDrawdownRulePct: number | null = null,
  maxDrawdownBaselinePct: number | null = null,
  positiveWindowFraction: number | null = null, firstHalfExcessPct: number | null = null,
  secondHalfExcessPct: number | null = null,
): RuleSelectionEvaluation {
  return { status, selectorVersion: AUTONOMOUS_TEMPLATE_SELECTOR_VERSION, pairedSessions: paired.length,
    nonoverlapWindows: blocks.length, trialCount, meanRuleReturnPct, meanBaselineReturnPct,
    meanPairedExcessPct, oneSidedT, requiredT, maxDrawdownRulePct, maxDrawdownBaselinePct,
    positiveWindowFraction, firstHalfExcessPct, secondHalfExcessPct, reason };
}

function mean(values: readonly number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function validSession(value: string | null): boolean { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value); }
function oneSampleT(values: readonly number[]): number {
  const m = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
  const se = Math.sqrt(variance / values.length);
  return se === 0 ? (m > 0 ? Number.POSITIVE_INFINITY : m < 0 ? Number.NEGATIVE_INFINITY : 0) : m / se;
}

/** Exact one-sided Student-t critical value using regularized incomplete beta. */
function studentTCriticalOneSided(alpha: number, degreesOfFreedom: number): number {
  if (!(alpha > 0 && alpha < 0.5) || !Number.isFinite(degreesOfFreedom) || degreesOfFreedom < 1) return Number.POSITIVE_INFINITY;
  let low = 0, high = 1;
  while (studentTUpperTail(high, degreesOfFreedom) > alpha && high < 1e8) high *= 2;
  for (let i = 0; i < 90; i++) {
    const mid = (low + high) / 2;
    if (studentTUpperTail(mid, degreesOfFreedom) > alpha) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

function studentTUpperTail(t: number, df: number): number {
  const x = df / (df + t * t);
  return 0.5 * regularizedIncompleteBeta(x, df / 2, 0.5);
}

function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  if (x < (a + 1) / (a + b + 2)) return front * betaContinuedFraction(x, a, b) / a;
  return 1 - front * betaContinuedFraction(1 - x, b, a) / b;
}

function betaContinuedFraction(x: number, a: number, b: number): number {
  const maxIterations = 200, epsilon = 3e-14, tiny = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIterations; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < epsilon) return h;
  }
  return h;
}

function logGamma(z: number): number {
  const coefficients = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  const shifted = z - 1;
  let sum = 0.99999999999980993;
  for (let i = 0; i < coefficients.length; i++) sum += coefficients[i] / (shifted + i + 1);
  const t = shifted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}
function maxDrawdown(returns: readonly number[]): number {
  let wealth = 1, peak = 1, worst = 0;
  for (const value of returns) {
    wealth *= Math.max(0, 1 + value / 100);
    peak = Math.max(peak, wealth);
    if (peak > 0) worst = Math.max(worst, (peak - wealth) / peak * 100);
  }
  return worst;
}
