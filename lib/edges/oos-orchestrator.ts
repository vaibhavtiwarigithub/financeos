// OOS orchestration — features/walk-forward-ic-folds step 7 (fetch layer).
//
// Wires the pieces together: session calendar -> purged folds -> PIT universe
// per as-of date -> candles -> per-date IC -> aggregate. The deliverable is the
// realized sigma of the OOS IC series, which Annex F makes the precondition for
// every approved sample floor.
//
// Cost shape, which drives the design:
//   membership  ~10 paginated calls PER as-of date   <- the expensive one
//   liquidity    1 call per as-of date
//   candles      1 call per symbol for the WHOLE span, then sliced per date
// Fetching candles per (symbol, date) would be ~24x the calls for identical
// data, so the union of symbols is fetched once and sliced.

import {
  resolvePitUniverse,
  PIT_ADV_WINDOW_SESSIONS,
  PIT_POLICY_VERSION,
  PIT_SNAPSHOT_SIZE,
  type PitMember,
  type PitUniverseResult,
} from "@/lib/edges/pit-universe";
import { fetchYahooCandles, yahooRange } from "@/lib/data/yahoo-candles";
import {
  buildPurgedFolds,
  sessionsPerFold,
  validateFoldDisjointness,
  type Fold,
} from "@/lib/edges/folds";
import { runOosFolds, type OosRunReport } from "@/lib/edges/oos-runner";
import { loadPitSnapshot, persistPitSnapshot } from "@/lib/edges/pit-snapshot";
import { createServiceClient } from "@/lib/supabase/service";
import type { Candle } from "@/lib/data/technicals";
import type { EdgeDef, Market } from "@/lib/edges/types";

/**
 * How often PIT membership is re-resolved.
 *
 * `per_date` is correct. `per_fold` is an APPROXIMATION used when the provider's
 * rate limit makes per-date resolution impractical: the fold's first as-of date
 * supplies membership for all dates in that fold. It degrades gracefully for the
 * case that matters most — a name delisting mid-fold simply runs out of candles,
 * so `forwardReturn` returns null and it drops out of later dates anyway. It
 * does miss names that LISTED mid-fold. Any run using it is flagged in the
 * report and must not be presented as fully point-in-time.
 */
export type MembershipCadence = "per_date" | "per_fold";

export interface OrchestrationReport {
  reportSchemaVersion: 2;
  run: OosRunReport | null;
  folds: Fold[];
  membershipCadence: MembershipCadence;
  approximationsUsed: string[];
  universeErrors: Array<{ asOf: string; reason: string; detail: string }>;
  universeSnapshots: Array<{
    resolvedAsOf: string;
    appliedDates: string[];
    policyVersion: string;
    source: string;
    fingerprint: string;
    members: PitMember[];
    selectionSize: number;
  }>;
  snapshotsConfirmed: number;
  symbolsFetched: number;
  symbolsMissingCandles: string[];
  sessionsAvailable: number;
  fatal?: string;
}

/** Trading sessions implied by a reference series (benchmark), ascending. */
export function sessionsFromCandles(candles: Candle[]): string[] {
  return candles.map((c) => c.date);
}

async function fetchSeries(
  symbols: string[],
  rangeDays: number,
  concurrency = 6,
): Promise<{ series: Map<string, Candle[]>; missing: string[] }> {
  const series = new Map<string, Candle[]>();
  const missing: string[] = [];
  const range = yahooRange(rangeDays);
  const queue = [...symbols];

  async function worker() {
    for (;;) {
      const sym = queue.shift();
      if (!sym) return;
      const c = await fetchYahooCandles(sym, range, { adjusted: true }).catch(() => [] as Candle[]);
      if (c.length) series.set(sym, c);
      else missing.push(sym);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, worker));
  return { series, missing };
}

export async function orchestrateOosRun(opts: {
  edge: EdgeDef;
  market: Market;
  horizonSessions: number;
  foldCount: number;
  datesPerFold: number;
  universeSize: number;
  minSymbols: number;
  minCrossSection: number;
  benchmarkSymbol: string;
  historyDays: number;
  /** Cap as-of dates to the most recent N sessions (the liquidity-entitled window). */
  liquidityWindowSessions?: number;
  membershipCadence?: MembershipCadence;
  apiKey?: string;
  /** Required for promotion-grade evidence; false is diagnostic-only. */
  persistSnapshots?: boolean;
  onProgress?: (msg: string) => void;
}): Promise<OrchestrationReport> {
  const cadence = opts.membershipCadence ?? "per_date";
  const log = opts.onProgress ?? (() => {});
  const approximations: string[] = [];
  if (opts.universeSize > PIT_SNAPSHOT_SIZE) {
    return {
      reportSchemaVersion: 2,
      run: null,
      folds: [],
      membershipCadence: cadence,
      approximationsUsed: [],
      universeErrors: [],
      universeSnapshots: [],
      snapshotsConfirmed: 0,
      symbolsFetched: 0,
      symbolsMissingCandles: [],
      sessionsAvailable: 0,
      fatal: `universeSize ${opts.universeSize} exceeds PIT snapshot cap ${PIT_SNAPSHOT_SIZE}`,
    };
  }
  if (cadence === "per_fold") {
    approximations.push(
      "membership resolved once per fold, not per as-of date — misses names that listed mid-fold; " +
      "NOT fully point-in-time",
    );
  }
  if (!opts.persistSnapshots) {
    approximations.push(
      "PIT universe snapshots were returned in the artifact but not persisted; " +
      "NOT promotion-grade",
    );
  }

  // 1. Session calendar from the benchmark. step = horizon => no label overlap.
  const bench = await fetchYahooCandles(
    opts.benchmarkSymbol,
    yahooRange(opts.historyDays),
    { adjusted: true },
  );
  if (!bench.length) {
    return { reportSchemaVersion: 2, run: null, folds: [], membershipCadence: cadence, approximationsUsed: approximations,
             universeErrors: [], universeSnapshots: [], snapshotsConfirmed: 0,
             symbolsFetched: 0, symbolsMissingCandles: [], sessionsAvailable: 0,
             fatal: `benchmark ${opts.benchmarkSymbol} returned no candles` };
  }
  const allSessions = sessionsFromCandles(bench);

  // Restrict to the liquidity-entitled window BEFORE building folds.
  // buildPurgedFolds lays out from the OLDEST session forward, so on a 5-year
  // benchmark it would place fold 0 in 2021 — where membership resolves but the
  // grouped-aggregate liquidity rank returns NOT_AUTHORIZED, and every as-of
  // date refuses. The candle history stays deep (features need a 252-session
  // lookback); only the AS-OF dates are constrained.
  const sessions = opts.liquidityWindowSessions
    ? allSessions.slice(-opts.liquidityWindowSessions)
    : allSessions;
  log(`sessions: ${allSessions.length} total, ${sessions.length} usable for as-of dates ` +
      `(${sessions[0]} .. ${sessions[sessions.length - 1]})`);

  // 2. Folds. Only the most recent `liquidityWindow` sessions are usable, since
  // the liquidity rank needs the ~2-year aggregate entitlement.
  // Use the newest complete block inside the entitled window. Passing the
  // entire window to the oldest-first pure builder silently left the newest
  // ~238 sessions unused in the 2x6 measurement and measured an older regime
  // despite reporting the current entitlement window.
  const requiredSessions = sessionsPerFold({
    horizonSessions: opts.horizonSessions,
    datesPerFold: opts.datesPerFold,
    stepSessions: opts.horizonSessions,
  }) * opts.foldCount;
  const foldSessions = sessions.slice(-requiredSessions);
  const built = buildPurgedFolds({
    sessions: foldSessions, horizonSessions: opts.horizonSessions, foldCount: opts.foldCount,
    datesPerFold: opts.datesPerFold, stepSessions: opts.horizonSessions,
  });
  if (!built.ok) {
    return { reportSchemaVersion: 2, run: null, folds: [], membershipCadence: cadence, approximationsUsed: approximations,
             universeErrors: [], universeSnapshots: [], snapshotsConfirmed: 0,
             symbolsFetched: 0, symbolsMissingCandles: [], sessionsAvailable: sessions.length,
             fatal: `${built.reason}: ${built.detail}` };
  }
  const disj = validateFoldDisjointness(built.folds);
  if (!disj.ok) {
    return { reportSchemaVersion: 2, run: null, folds: built.folds, membershipCadence: cadence, approximationsUsed: approximations,
             universeErrors: [], universeSnapshots: [], snapshotsConfirmed: 0,
             symbolsFetched: 0, symbolsMissingCandles: [], sessionsAvailable: sessions.length,
             fatal: `folds not disjoint: ${disj.violations.join("; ")}` };
  }
  log(
    `folds: ${built.folds.length} x ${opts.datesPerFold} dates, ${built.sessionsRequired} ` +
    `latest sessions used (${foldSessions[0]} .. ${foldSessions[foldSessions.length - 1]})`,
  );

  // 3. PIT universe per as-of date (or per fold under the approximation).
  const universeByDate = new Map<string, string[]>();
  const universeErrors: OrchestrationReport["universeErrors"] = [];
  const universeSnapshots: OrchestrationReport["universeSnapshots"] = [];
  const liquidityCache = new Map<string, Promise<Map<string, number> | null>>();
  const sessionIndex = new Map(allSessions.map((date, index) => [date, index]));
  const snapshotClient = opts.persistSnapshots ? createServiceClient() : null;
  let snapshotsConfirmed = 0;
  for (const fold of built.folds) {
    const dates = cadence === "per_fold" ? [fold.asOfDates[0]] : fold.asOfDates;
    for (const asOf of dates) {
      const endIndex = sessionIndex.get(asOf) ?? -1;
      const liquidityDates = endIndex >= PIT_ADV_WINDOW_SESSIONS - 1
        ? allSessions.slice(endIndex - PIT_ADV_WINDOW_SESSIONS + 1, endIndex + 1)
        : [];
      let u: PitUniverseResult;
      try {
        const persisted = snapshotClient
          ? await loadPitSnapshot(snapshotClient, {
              market: opts.market,
              asOf,
              policyVersion: PIT_POLICY_VERSION,
              minSymbols: PIT_SNAPSHOT_SIZE,
            })
          : null;
        u = persisted ?? await resolvePitUniverse({
          market: opts.market, asOf, size: PIT_SNAPSHOT_SIZE,
          minSymbols: PIT_SNAPSHOT_SIZE, apiKey: opts.apiKey,
          liquidityDates,
          liquidityCache,
        });
        if (persisted) log(`universe ${asOf}: reused persisted snapshot`);
      } catch (error) {
        universeErrors.push({
          asOf,
          reason: "snapshot_read_failed",
          detail: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (!u.ok) { universeErrors.push({ asOf, reason: u.reason, detail: u.detail }); continue; }
      if (snapshotClient) {
        try {
          await persistPitSnapshot(snapshotClient as any, u);
          snapshotsConfirmed++;
        } catch (error) {
          universeErrors.push({
            asOf,
            reason: "snapshot_persistence_failed",
            detail: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      }
      const selectedMembers = u.members.slice(0, opts.universeSize);
      if (selectedMembers.length < opts.minSymbols) {
        universeErrors.push({
          asOf,
          reason: "universe_below_min_symbols",
          detail: `Selected ${selectedMembers.length} members, below ${opts.minSymbols}.`,
        });
        continue;
      }
      const syms = selectedMembers.map((m) => m.symbol);
      const appliedDates = cadence === "per_fold" ? [...fold.asOfDates] : [asOf];
      for (const d of appliedDates) universeByDate.set(d, syms);
      universeSnapshots.push({
        resolvedAsOf: asOf,
        appliedDates,
        policyVersion: u.policyVersion,
        source: u.source,
        fingerprint: u.fingerprint,
        members: u.members,
        selectionSize: opts.universeSize,
      });
      log(`universe ${asOf}: ${syms.length} names (fp ${u.fingerprint.slice(0, 8)})`);
    }
  }
  if (!universeByDate.size) {
    return { reportSchemaVersion: 2, run: null, folds: built.folds, membershipCadence: cadence, approximationsUsed: approximations,
             universeErrors, universeSnapshots, snapshotsConfirmed,
             symbolsFetched: 0, symbolsMissingCandles: [], sessionsAvailable: sessions.length,
             fatal: "no PIT universe resolved for any as-of date" };
  }

  // 4. Candles once per symbol across the union, then sliced per date.
  const union = [...new Set([...universeByDate.values()].flat())];
  log(`fetching candles for ${union.length} symbols`);
  const { series, missing } = await fetchSeries(union, opts.historyDays);
  log(`candles: ${series.size} ok, ${missing.length} missing`);

  // 5. Run.
  const run = runOosFolds({
    folds: built.folds, universeByDate, series, benchmark: bench, edge: opts.edge,
    market: opts.market, horizonSessions: opts.horizonSessions,
    stepSessions: opts.horizonSessions, minCrossSection: opts.minCrossSection,
  });

  return {
    reportSchemaVersion: 2,
    run, folds: built.folds, membershipCadence: cadence, approximationsUsed: approximations,
    universeErrors, universeSnapshots, snapshotsConfirmed,
    symbolsFetched: series.size, symbolsMissingCandles: missing,
    sessionsAvailable: sessions.length,
  };
}
