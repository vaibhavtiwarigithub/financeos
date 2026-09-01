// Strategy replay seam — MEASURE-ONLY.
//
// Stage 0R step 3 of features/external-strategy-discovery: compile ONE frozen
// rule into events, run the existing portfolio simulator, mark a deterministic
// NAV/benchmark path, and persist a sealed result to `backtest_experiments`.
//
// Every run registers its specification in `trial_family_ledger` FIRST, so the
// multiple-testing denominator is the family's true total and cannot reset.
//
// NEGATIVE CONTROLS RUN ALONGSIDE EVERY REQUEST. If a rule that cannot have an
// edge reports one, the seam is wrong -- debug the seam, not the strategy.
//
// GET  = dry run, returns the result and writes nothing.
// POST = persists. Owner or cron only.
//
// Changes no score, position, order, stop, target or broker state.
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { fingerprint } from "@/lib/analytics/alpha-diagnostic-contract";
import { simulatePortfolio, type SimulationPolicy } from "@/lib/simulation/portfolio-simulator";
import { compileSpec, type Bar } from "@/lib/strategy-replay/compile";
import { markNavSeries, type DailyMark, type HoldingsAt } from "@/lib/strategy-replay/nav-marker";
import { specFingerprint, validateSpec, type RuleSpec } from "@/lib/strategy-replay/rule-spec";
import { alwaysInControl, neverTradesControl } from "@/lib/strategy-replay/negative-control";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const TRIAL_FAMILY = "external-strategy-discovery-us-v1";
const INITIAL_CASH = 100_000;

/**
 * The one real rule for the seam proof: 200-session trend on VOO.
 *
 * VOO rather than SPY deliberately. Both are S&P 500 exposure, but production
 * holds 1,280 VOO sessions against 280 for SPY -- 1,080 usable decisions after a
 * 200-session warm-up versus 80. See DATA_SUFFICIENCY_AUDIT.md. Under the ledger
 * contract this is a DIFFERENT specification from the SPY version and counts as
 * its own trial.
 */
function trendRule(): RuleSpec {
  return {
    id: "voo_trend_200",
    label: "200-session trend on VOO",
    role: "exposure_overlay",
    market: "us",
    universe: ["VOO"],
    horizonSessions: 20,
    // The signal reads the close, so it cannot trade that same close.
    execution: "next_open",
    positionSizePct: 1.0,
    entry: { op: "cmp2", left: { fn: "close" }, cmp: ">", right: { fn: "sma", period: 200 } },
    exit: { op: "cmp2", left: { fn: "close" }, cmp: "<", right: { fn: "sma", period: 200 } },
    sourceName: "Quantified Strategies — 200-day moving average",
    sourceUrl: "https://www.quantifiedstrategies.com/200-day-moving-average-trading-strategy",
    ruleVersion: "v1",
  };
}

async function loadBars(svc: any, symbols: string[]): Promise<Record<string, Bar[]>> {
  const rows = await fetchAllRows((from, to) => svc
    .from("price_cache")
    .select("symbol,date,open,high,low,close")
    .in("symbol", symbols)
    .order("symbol", { ascending: true })
    .order("date", { ascending: true })
    .range(from, to), "strategy replay bars");

  const out: Record<string, Bar[]> = {};
  for (const r of rows as any[]) {
    const bar: Bar = {
      session: String(r.date).slice(0, 10),
      open: Number(r.open), high: Number(r.high),
      low: Number(r.low), close: Number(r.close),
    };
    if (![bar.open, bar.high, bar.low, bar.close].every((v) => Number.isFinite(v) && v > 0)) continue;
    (out[r.symbol] ??= []).push(bar);
  }
  for (const s of Object.keys(out)) out[s].sort((a, b) => a.session.localeCompare(b.session));
  return out;
}

/** Benchmark closes keyed by session. VOO is the US benchmark instrument. */
async function loadBenchmark(svc: any, symbol: string): Promise<Map<string, number>> {
  const bars = await loadBars(svc, [symbol]);
  return new Map((bars[symbol] ?? []).map((b) => [b.session, b.close]));
}

/**
 * Reconstruct the holdings path from fills.
 *
 * The simulator returns FILLS, not a NAV path, so the marking layer needs the
 * position state at each session rebuilt here. This is the seam the architecture
 * wrongly assumed already existed.
 */
function holdingsPath(
  sessions: string[],
  initialCash: number,
  fills: Array<{ session: string; symbol: string; kind: string; quantity: number; price: number }>,
): HoldingsAt[] {
  const bySession = new Map<string, typeof fills>();
  for (const f of fills) {
    const list = bySession.get(f.session) ?? [];
    list.push(f);
    bySession.set(f.session, list);
  }
  let cash = initialCash;
  const held = new Map<string, { quantity: number; costBasis: number }>();
  const out: HoldingsAt[] = [];

  for (const session of sessions) {
    for (const f of bySession.get(session) ?? []) {
      const cur = held.get(f.symbol) ?? { quantity: 0, costBasis: 0 };
      if (f.kind === "entry") {
        const cost = f.quantity * f.price;
        cash -= cost;
        const totalQty = cur.quantity + f.quantity;
        cur.costBasis = totalQty > 0
          ? (cur.costBasis * cur.quantity + cost) / totalQty : 0;
        cur.quantity = totalQty;
        held.set(f.symbol, cur);
      } else {
        cash += f.quantity * f.price;
        cur.quantity -= f.quantity;
        if (cur.quantity <= 1e-9) held.delete(f.symbol); else held.set(f.symbol, cur);
      }
    }
    out.push({
      session, cash,
      positions: [...held.entries()].map(([symbol, p]) => ({
        symbol, quantity: p.quantity, costBasis: p.costBasis,
      })),
    });
  }
  return out;
}

async function replayOne(svc: any, spec: RuleSpec, bars: Record<string, Bar[]>, bench: Map<string, number>) {
  const errors = validateSpec(spec);
  if (errors.length) return { spec: spec.id, errors };

  const compiled = compileSpec({ spec, bars, initialCash: INITIAL_CASH });
  if (compiled.errors.length) return { spec: spec.id, errors: compiled.errors };

  const policy: SimulationPolicy = {
    market: "us", currency: "USD", initialCash: INITIAL_CASH,
    maxOpenNames: Math.max(1, spec.universe.length),
    allowFractionalShares: true,
  };
  const sim = simulatePortfolio(policy, compiled.events);

  const sessions = [...new Set(Object.values(bars).flat().map((b) => b.session))].sort();
  const path = holdingsPath(sessions, INITIAL_CASH, sim.fills as any);
  const marks: DailyMark[] = sessions.map((session) => {
    const prices: Record<string, number> = {};
    for (const [sym, series] of Object.entries(bars)) {
      const bar = series.find((b) => b.session === session);
      if (bar) prices[sym] = bar.close;
    }
    return { session, prices, benchClose: bench.get(session) ?? null };
  });
  const nav = markNavSeries(path, marks);

  return {
    spec: spec.id,
    label: spec.label,
    role: spec.role,
    specFingerprint: specFingerprint(spec),
    decisionSessions: compiled.decisionSessions,
    warmupSkipped: compiled.warmupSkipped,
    events: compiled.events.length,
    fills: sim.fills.length,
    rejections: sim.rejections.length,
    totalReturnPct: nav.totalReturnPct,
    benchTotalReturnPct: nav.benchTotalReturnPct,
    netExcessReturnPp: nav.netExcessReturnPp,
    maxDrawdownPct: nav.maxDrawdownPct,
    sharpe: nav.sharpe,
    sortino: nav.sortino,
    stressCorrelation: nav.stressCorrelation,
    meanCashUtilization: nav.meanCashUtilization,
    unpricedSessions: nav.unpricedSessions,
    navPoints: nav.points.length,
    errors: [] as string[],
  };
}

async function run(req: NextRequest, persist: boolean) {
  if (!verifyCronSecret(req)) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const svc = createServiceClient();

  const real = trendRule();
  // Controls share the real rule's universe so any difference is the RULE, not
  // the data it saw.
  const controls = [
    neverTradesControl("us", real.universe),
    alwaysInControl("us", real.universe),
  ];
  const specs = [real, ...controls];

  let bars: Record<string, Bar[]>;
  let bench: Map<string, number>;
  try {
    bars = await loadBars(svc, real.universe);
    bench = await loadBenchmark(svc, "VOO");
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "bar load failed" }, { status: 500 });
  }

  const barCount = Object.fromEntries(Object.entries(bars).map(([k, v]) => [k, v.length]));
  const results = [];
  for (const spec of specs) {
    // Register FIRST: a spec that ran is a trial whether or not it produced a
    // usable result.
    const { data: reg } = await svc.rpc("register_trial", {
      p_family: TRIAL_FAMILY,
      p_spec_fingerprint: specFingerprint(spec),
      p_kind: spec.role === "negative_control" ? "rule" : "rule",
      p_label: spec.label,
      p_spec: spec as any,
      p_registered_by: "strategy-replay-route",
      p_code_version: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      p_adapted_from: spec.adaptedFrom ?? null,
    });
    const trial = Array.isArray(reg) ? reg[0] : reg;
    results.push({ ...(await replayOne(svc, spec, bars, bench)), trial });
  }

  const trialsConsidered = Math.max(1, ...results.map((r: any) => r.trial?.trials_considered ?? 1));
  const payload = {
    trialFamily: TRIAL_FAMILY,
    barCount,
    trialsConsidered,
    results,
    seamCheck: seamVerdict(results),
    influence: "None. Measure-only replay; no score, sizing, exit, order or broker path reads this.",
  };

  if (persist) {
    // SEALING IS REFUSED, DELIBERATELY.
    //
    // `backtest_experiments` enforces a full manifest for experiment_type
    // 'historical_replay' (backtest_experiments_historical_replay_manifest_required),
    // and one of its requirements is:
    //
    //     validation_mode = 'purged_temporal_oos'
    //
    // This seam performs a FULL-SAMPLE replay with no out-of-sample split, no
    // purge and no embargo. Writing 'purged_temporal_oos' would be a false
    // claim about how the number was produced, and the whole point of a sealed
    // ledger is that its provenance fields are true.
    //
    // The contract also requires edge_id, formula_version, universe_policy_version,
    // a validation_spec at schemaVersion 'kairos.historical-replay.v1' with
    // evidenceClass 'diagnostic', and variants_proposed = trials_considered <=
    // variant_budget. Note that `trials_considered` there means variants in THIS
    // experiment, which is NOT the same quantity as the trial family's running
    // total in `trial_family_ledger` -- the multiple-testing denominator. Those
    // two must not be conflated when sealing is eventually implemented.
    //
    // Step 7 of features/external-strategy-discovery is where walk-forward OOS
    // arrives. Until then this route is a dry-run instrument and says so rather
    // than forcing a full-sample result into a slot reserved for purged ones.
    return NextResponse.json({
      ok: false,
      persisted: false,
      refusal: "sealing_requires_purged_oos",
      detail:
        "backtest_experiments requires validation_mode='purged_temporal_oos' for historical_replay. " +
        "This seam runs a full-sample replay with no OOS split, so sealing it would misstate its provenance. " +
        "Walk-forward OOS is step 7; until then use GET for the dry run.",
      ...payload,
    }, { status: 409 });
  }

  return NextResponse.json({ ok: true, persisted: persist, ...payload });
}

/**
 * Does the seam behave? Controls are the evidence, not the rule.
 *
 * A never-trades control MUST be exactly flat. An always-in control must trade
 * and must NOT show material excess over the benchmark it is effectively
 * holding — if it does, the benchmark comparison is broken.
 */
function seamVerdict(results: any[]) {
  const never = results.find((r) => r.spec === "control_never_trades");
  const always = results.find((r) => r.spec === "control_always_in");
  const failures: string[] = [];

  // REJECTION RATE IS A SEAM FAILURE, NOT A RESULT.
  //
  // The first real run reported pass:true while the rule produced 1 fill and 96
  // rejections, because the compiler emitted exits with no `quantity` and the
  // simulator refused every one. A verdict that tolerates a 99% rejection rate
  // is not checking anything. Any spec whose events are mostly refused has not
  // been measured, whatever its return column says.
  for (const r of results) {
    const attempted = (r.fills ?? 0) + (r.rejections ?? 0);
    if (attempted === 0) continue;
    const rejectRate = (r.rejections ?? 0) / attempted;
    if (rejectRate > 0.1) {
      failures.push(
        `${r.spec}: ${r.rejections}/${attempted} events rejected (${(rejectRate * 100).toFixed(1)}%) — the events are not executable, so its metrics are not measurements`,
      );
    }
  }

  if (!never) failures.push("never-trades control missing");
  else {
    if (never.fills !== 0) failures.push(`never-trades control produced ${never.fills} fills`);
    if (never.totalReturnPct !== 0) failures.push(`never-trades control returned ${never.totalReturnPct}%, expected exactly 0`);
    if (never.maxDrawdownPct !== 0) failures.push(`never-trades control drew down ${never.maxDrawdownPct}%`);
  }

  if (!always) failures.push("always-in control missing");
  else if (always.fills === 0) failures.push("always-in control produced no fills, so the seam is inert");
  else if (always.netExcessReturnPp != null && Math.abs(always.netExcessReturnPp) > 25) {
    failures.push(`always-in control shows ${always.netExcessReturnPp.toFixed(2)}pp excess over its own benchmark — comparison is broken`);
  }

  return { pass: failures.length === 0, failures };
}

export async function GET(req: NextRequest) { return run(req, false); }
export async function POST(req: NextRequest) { return run(req, true); }
