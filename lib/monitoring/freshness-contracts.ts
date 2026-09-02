// W6 — layer 1 of 2: versioned IN-CODE registry of CROSS-RUN freshness contracts.
//
// Run accounting (./run-accounting.ts) proves a single run accounted for its own
// work. It cannot prove the pipeline is moving: a job that reports
// `no_work` every day for 25 days is individually healthy and collectively
// dead. That is exactly what happened — label maturation returned
// {matured:0, skipped:800} for 25 consecutive days, all green.
//
// So the second layer asks a question no single run can answer: did the
// high-watermark of the table this job is responsible for actually ADVANCE
// within its grace window?
//
// PER-SCOPE, NOT AGGREGATE. A table-wide max(date) on `price_cache` read
// healthy at Aug 13 while 101 of 140 symbols sat frozen at Jul 22. One symbol
// still being refreshed made the whole table look alive. Any contract with a
// natural scope (symbol, market) is evaluated per scope value, and the contract
// declares the minimum fraction of scopes that must be fresh.
//
// WHY IN CODE, NOT A DB TABLE. Legitimate-skip and grace semantics are
// heterogeneous (a weekend is fresh for a daily bar and stale for an intraday
// mark) and a mutable config row moves that judgement outside code review. The
// registry is versioned so a contract loosening is a reviewable diff.

import { expectedNewestSession } from "@/lib/data/completed-candles";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import { fetchAllRows } from "@/lib/supabase/paginate";

/** Bump when a contract is added, removed, or its thresholds change. */
export const FRESHNESS_REGISTRY_VERSION = 1;

export interface FreshnessContract {
  /** Stable id — forms the alert issue_key. Never reuse for a different table. */
  id: string;
  /** Per-contract version. Bump on any threshold change so the diff is reviewable. */
  version: number;
  table: string;
  market: "us" | "india" | "global";
  /** Column holding the monotone progress marker. */
  watermarkColumn: string;
  /** 'date' = calendar date string (session close assumed 20:00Z); otherwise a timestamp. */
  watermarkType: "date" | "timestamp";
  /** Evaluate freshness separately per distinct value of this column. */
  scopeColumn?: string;
  /** Restrict a historical cache to scopes that can currently affect money or
   * evaluation paths. Without this, retired symbols remain permanent alerts. */
  scopeUniverse?: "active_us_price_symbols";
  /** Column to filter by market, when the table carries one. */
  marketColumn?: string;
  /** How long the watermark may sit still before it is a defect. */
  graceHours: number;
  /**
   * Judge a DAILY-bar contract against the market session that should exist by
   * now, instead of a rolling calendar window.
   *
   * A calendar grace cannot express "the newest session that should exist".
   * Measured on the prewarm, which used the same 96h rule: on a Tuesday the
   * window landed exactly on Friday, so every symbol stuck on Friday's bar
   * passed as fresh — and the condition regenerated every weekend. The same
   * arithmetic is in this contract. `expectedNewestSession` is what
   * lib/data/quotes.ts already uses to decide `stale`, so this makes the
   * monitor, the quote gate and the prewarm answer one question the same way.
   *
   * This is STRICTER than a 96h grace and will report staleness a lenient
   * window hid. That is the point: the 85% coverage that breached this contract
   * was measured with the generous rule.
   */
  sessionAware?: boolean;
  /** Fraction of scopes that must be within grace. 1 = every scope. */
  minCoverage: number;
  /** How far back to read rows when deriving the per-scope watermark. */
  lookbackDays: number;
  /** What breaks downstream when this goes stale. Shown in the alert. */
  impact: string;
  /** Concrete first move for the operator. */
  recovery: string;
}

// Grace windows are generous on purpose: a false page trains people to ignore
// the channel. 96h covers a weekend plus a one-day exchange holiday, which is
// the same allowance lib/data/quotes.ts makes for an off-hours EOD bar.
const WEEKEND_SAFE_HOURS = 96;

export const FRESHNESS_CONTRACTS: FreshnessContract[] = [
  {
    id: "price-cache-us-symbols",
    version: 1,
    table: "price_cache",
    market: "us",
    watermarkColumn: "date",
    watermarkType: "date",
    scopeColumn: "symbol",
    scopeUniverse: "active_us_price_symbols",
    graceHours: WEEKEND_SAFE_HOURS,
    sessionAware: true,
    // 101/140 symbols were frozen while the table max looked current. At 0.9 the
    // real event trips at 28% coverage and a handful of delisted/retired tickers
    // lagging behind does not.
    minCoverage: 0.9,
    lookbackDays: 60,
    impact: "Frozen bars feed paper fills, position marks, NAV, sizing volatility and benchmark series. "
      + "In Aug 2026 this produced 15 fills off quotes as-of Jul 22, up to 19.6% off the real price.",
    recovery: "Re-run the price prewarm for the traded universe and confirm the per-symbol watermark advances, not just max(date).",
  },
  {
    id: "observation-labels-maturation",
    version: 1,
    table: "observation_labels",
    market: "global",
    watermarkColumn: "matured_at",
    watermarkType: "timestamp",
    graceHours: WEEKEND_SAFE_HOURS,
    minCoverage: 1,
    lookbackDays: 120,
    impact: "No new matured labels means every learner, validation sweep and coverage gate is reasoning "
      + "off a frozen cohort while reporting success.",
    recovery: "POST /api/agents/label-maturation and check matured>0; if it returns matured:0 with a large skipped count, the backlog is blocked, not empty.",
  },
  {
    id: "decision-observations-us",
    version: 1,
    table: "decision_observations",
    market: "us",
    watermarkColumn: "ts",
    watermarkType: "timestamp",
    marketColumn: "market",
    graceHours: WEEKEND_SAFE_HOURS,
    minCoverage: 1,
    lookbackDays: 60,
    impact: "The decision ledger stops growing, so nothing new can ever mature into a label.",
    recovery: "POST /api/agents/research/cron?market=us",
  },
  {
    id: "decision-observations-india",
    version: 1,
    table: "decision_observations",
    market: "india",
    watermarkColumn: "ts",
    watermarkType: "timestamp",
    marketColumn: "market",
    graceHours: WEEKEND_SAFE_HOURS,
    minCoverage: 1,
    lookbackDays: 60,
    impact: "The India decision ledger stops growing, so nothing new can ever mature into a label.",
    recovery: "POST /api/agents/research/cron?market=india",
  },
];

export interface WatermarkRow {
  scope?: string | null;
  watermark: string | null;
}

export interface FreshnessResult {
  contractId: string;
  version: number;
  breached: boolean;
  /** Fraction of scopes within grace. 1 when there is no scope column and it is fresh. */
  coverage: number;
  totalScopes: number;
  staleScopes: string[];
  newestWatermark: string | null;
  kind: "ok" | "empty" | "stale" | "coverage";
  detail: string;
}

function toMs(value: string | null | undefined, type: FreshnessContract["watermarkType"]): number {
  if (!value) return NaN;
  // A daily bar's watermark is its session, not midnight UTC — matching the
  // convention in lib/data/quotes.ts. Without this a Friday bar looks 20h older
  // than it is and every Tuesday morning check false-alarms.
  const iso = type === "date" ? `${String(value).slice(0, 10)}T20:00:00Z` : String(value);
  return Date.parse(iso);
}

/**
 * Pure evaluator. `rows` is the raw (scope, watermark) set read from the table;
 * the newest watermark per scope is derived here.
 */
export function evaluateFreshness(
  contract: FreshnessContract,
  rows: WatermarkRow[],
  now: Date = new Date(),
): FreshnessResult {
  // A daily-bar contract asks "is this the session that should exist by now?".
  // Everything else keeps the rolling calendar grace, which is the right shape
  // for a timestamp watermark like label maturation.
  const cutoff = contract.sessionAware && contract.watermarkType === "date" && contract.market !== "global"
    ? toMs(expectedNewestSession(contract.market, now), "date")
    : now.getTime() - contract.graceHours * 3600_000;
  const newestByScope = new Map<string, number>();
  const allScopes = new Set<string>();
  for (const row of rows) {
    const scope = contract.scopeColumn ? String(row.scope ?? "") : "__all__";
    if (!scope && contract.scopeColumn) continue;
    allScopes.add(scope);
    const ms = toMs(row.watermark, contract.watermarkType);
    if (!Number.isFinite(ms)) continue;
    const prev = newestByScope.get(scope);
    if (prev == null || ms > prev) newestByScope.set(scope, ms);
  }

  const base = { contractId: contract.id, version: contract.version };
  if (allScopes.size === 0) {
    return {
      ...base,
      breached: true,
      coverage: 0,
      totalScopes: 0,
      staleScopes: [],
      newestWatermark: null,
      kind: "empty",
      // An empty read is NOT proof of health. It is the one case where "no rows"
      // and "the query is wrong" are indistinguishable, so it must alert.
      detail: `${contract.table} returned no usable ${contract.watermarkColumn} within the last ${contract.lookbackDays} days for market=${contract.market}.`,
    };
  }

  const stale = [...allScopes]
    .filter((scope) => (newestByScope.get(scope) ?? -Infinity) < cutoff)
    .sort();
  const total = allScopes.size;
  const coverage = (total - stale.length) / total;
  const newestMs = newestByScope.size ? Math.max(...newestByScope.values()) : NaN;
  const newestWatermark = Number.isFinite(newestMs) ? new Date(newestMs).toISOString() : null;
  const ageHours = Number.isFinite(newestMs) ? (now.getTime() - newestMs) / 3600_000 : null;

  if (coverage >= contract.minCoverage) {
    return {
      ...base, breached: false, coverage, totalScopes: total, staleScopes: stale, newestWatermark,
      kind: "ok",
      detail: `${total - stale.length}/${total} scope(s) fresh; newest ${newestWatermark}.`,
    };
  }

  const everythingStale = stale.length === total;
  return {
      ...base,
      breached: true,
    coverage,
    totalScopes: total,
    staleScopes: stale,
      newestWatermark,
      kind: newestByScope.size === 0 ? "empty" : everythingStale ? "stale" : "coverage",
      detail: everythingStale
      ? newestWatermark && ageHours != null
        ? `Newest ${contract.watermarkColumn} is ${newestWatermark}, ${ageHours.toFixed(0)}h old against a ${contract.graceHours}h grace. The watermark is not advancing.`
        : `All ${total} required scope(s) are missing a usable ${contract.watermarkColumn} within the last ${contract.lookbackDays} days.`
      : `${stale.length}/${total} scope(s) are past the ${contract.graceHours}h grace — coverage ${(coverage * 100).toFixed(0)}% vs required ${(contract.minCoverage * 100).toFixed(0)}%. `
        + `Aggregate max(${contract.watermarkColumn})=${newestWatermark} looks healthy and is hiding them. `
        + `Stale: ${stale.slice(0, 15).join(", ")}${stale.length > 15 ? ` … +${stale.length - 15} more` : ""}.`,
  };
}

/**
 * Read every contract in the registry and open/clear a System Health issue for
 * each. Never throws — a monitoring failure must not take down its caller.
 * Read-only against the monitored tables; the only writes are alert rows.
 */
export async function checkFreshnessContracts(
  svc: any,
  opts: { now?: Date; contracts?: FreshnessContract[]; includeIndia?: boolean } = {},
): Promise<FreshnessResult[]> {
  const now = opts.now ?? new Date();
  const contracts = (opts.contracts ?? FRESHNESS_CONTRACTS)
    .filter((c) => c.market !== "india" || opts.includeIndia !== false);
  const results: FreshnessResult[] = [];

  for (const contract of contracts) {
    const issueKey = `freshness:${contract.id}`;
    try {
      const columns = [contract.watermarkColumn, contract.scopeColumn].filter(Boolean).join(",");
      const since = new Date(now.getTime() - contract.lookbackDays * 86400_000);
      const sinceValue = contract.watermarkType === "date"
        ? since.toISOString().slice(0, 10)
        : since.toISOString();

      // An unscoped freshness contract needs the true MAX watermark, not an
      // arbitrary PostgREST page. `limit(50000)` without ordering caused the
      // label monitor to keep reading an older Aug-17 row even while hundreds
      // of labels matured through Aug-21. For scoped contracts we still need
      // every scope, so retain the bounded window and derive each max in memory.
      let requiredScopes: Set<string> | null = null;
      if (contract.scopeUniverse === "active_us_price_symbols") {
        const decisionSince = new Date(now.getTime() - 7 * 86400_000).toISOString();
        const [decisions, positions] = await Promise.all([
          // Paginated: this builds the REQUIRED-SCOPE set, so a truncated read
          // silently shrinks what the monitor considers in scope and turns a
          // stale symbol into a passing contract. 888 rows today, under the cap.
          fetchAllRows((from, to) => svc.from("decision_observations")
            .select("id,symbol")
            .eq("market", "us")
            .gte("ts", decisionSince)
            .order("id", { ascending: true })
            .range(from, to), "active price scope decisions")
            .then((rows) => ({ data: rows as any[], error: null as any }))
            .catch((e: any) => ({ data: null as any, error: { message: String(e?.message ?? e) } })),
          svc.from("paper_positions")
            .select("symbol")
            .eq("market", "us")
            .is("exit_reason", null)
            .gt("qty", 0)
            .limit(500),
        ]);
        if (decisions.error || positions.error) {
          throw new Error(`active price scope unavailable: ${decisions.error?.message ?? positions.error?.message}`);
        }
        requiredScopes = new Set([
          ...(decisions.data ?? []).map((row: any) => String(row.symbol ?? "").toUpperCase()),
          ...(positions.data ?? []).map((row: any) => String(row.symbol ?? "").toUpperCase()),
        ].filter(Boolean));
      }

      let query = svc.from(contract.table)
        .select(columns)
        .gte(contract.watermarkColumn, sinceValue);
      if (contract.marketColumn) query = query.eq(contract.marketColumn, contract.market);
      if (requiredScopes?.size && contract.scopeColumn) {
        query = query.in(contract.scopeColumn, [...requiredScopes]);
      }
      query = query.order(contract.watermarkColumn, { ascending: false });
      if (!contract.scopeColumn) query = query.limit(1);
      else query = query.limit(50000);

      const { data, error } = await query;
      if (error) {
        // A monitor that cannot read its subject must say so, not stay silent.
        await reportIssue({
          issueKey,
          severity: "warn",
          category: "data",
          title: `Freshness contract ${contract.id} could not be evaluated`,
          detail: `Reading ${contract.table} failed: ${error.message ?? String(error)}. Freshness is UNKNOWN, not healthy.`,
        }, svc);
        results.push({
          contractId: contract.id, version: contract.version, breached: false, coverage: 0,
          totalScopes: 0, staleScopes: [], newestWatermark: null, kind: "empty",
          detail: `unreadable: ${error.message ?? String(error)}`,
        });
        continue;
      }

      const rows: WatermarkRow[] = (data ?? []).map((row: any) => ({
        scope: contract.scopeColumn ? row[contract.scopeColumn] : null,
        watermark: row[contract.watermarkColumn] ?? null,
      }));
      if (requiredScopes && contract.scopeColumn) {
        const returned = new Set(rows.map((row) => String(row.scope ?? "").toUpperCase()));
        for (const scope of requiredScopes) {
          if (!returned.has(scope)) rows.push({ scope, watermark: null });
        }
      }
      const result = evaluateFreshness(contract, rows, now);
      results.push(result);

      if (!result.breached) {
        await resolveIssue(issueKey, svc);
        continue;
      }
      await reportIssue({
        issueKey,
        severity: contract.market === "global" || result.kind === "stale" ? "critical" : "warn",
        category: "data",
        title: `${contract.table} (${contract.market}) freshness contract breached — ${contract.id} v${contract.version}`,
        detail: [
          result.detail,
          `Impact: ${contract.impact}`,
          `Recovery: ${contract.recovery}`,
        ].join(" · "),
      }, svc);
    } catch (e) {
      console.error(`[freshness] ${contract.id} threw:`, e);
      const message = e instanceof Error ? e.message : String(e);
      await reportIssue({
        issueKey,
        severity: "warn",
        category: "data",
        title: `Freshness contract ${contract.id} could not be evaluated`,
        detail: `Freshness is UNKNOWN because the monitor failed before evaluation: ${message}`,
      }, svc).catch(() => undefined);
      results.push({
        contractId: contract.id, version: contract.version, breached: true, coverage: 0,
        totalScopes: 0, staleScopes: [], newestWatermark: null, kind: "empty",
        detail: `monitor failed: ${message}`,
      });
    }
  }

  return results;
}
