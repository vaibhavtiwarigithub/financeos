/**
 * Manifest-bound local historical replay.
 *
 * This process runs only on the operator machine. It verifies local evidence,
 * predeclares immutable lineage in Supabase, reads normalized rows without any
 * provider fallback, and writes a compact diagnostic result.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  openVerifiedLocalEvidenceDataset,
} from "../lib/replay/local-evidence.ts";
import {
  computeTechnicals,
  scoreTechnicals,
} from "../lib/data/technicals.ts";
import {
  neweyWestSEofMean,
  spearman,
} from "../lib/edges/rank-statistics.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE = path.resolve(process.env.KAIROS_EVIDENCE_DIR || path.join(os.homedir(), ".kairos", "evidence"));
const DEFAULT_PRICE_MANIFEST = path.join(
  STORE,
  "manifests",
  "nse-bhavcopy-2020-01-01-2026-07-29-v6.json",
);
const DEFAULT_ACTION_MANIFEST = path.join(
  STORE,
  "manifests",
  "nse-corporate-actions-2020-01-01-2026-07-29-v5.json",
);

/** @type {Readonly<Record<string, any>>} */
export const DEFAULT_PLAN = Object.freeze({
  schemaVersion: "kairos.historical-replay.v1",
  evidenceClass: "diagnostic",
  market: "india",
  edgeId: "kairos_technical_score_v1",
  formulaVersion: "production-technicals-v1/local-80-session-input",
  dateFrom: "2022-01-01",
  dateThrough: "2026-06-30",
  dataCutoff: "2026-07-29",
  horizonSessions: 10,
  stepSessions: 10,
  historySessions: 80,
  liquidityLookbackSessions: 20,
  universeSize: 200,
  minimumCrossSection: 100,
  foldCount: 4,
  minimumPriceInr: 20,
  benchmarkSymbol: "NIFTYBEES",
  universePolicyVersion: "nse_eq_trailing_turnover_top200_v1",
  actionPolicyVersion: "exclude_non_dividend_price_actions_v1",
  limitations: [
    "Diagnostic only: NSE EQ series can include ETFs; no historical instrument master is bound.",
    "Raw close returns exclude cash dividends and execution costs.",
    "No portfolio construction, capacity, tax, spread, or slippage simulation.",
    "This result cannot promote or alter a strategy.",
  ],
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Cannot fingerprint a non-finite number");
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(
    typeof value === "string" || Buffer.isBuffer(value) ? value : canonicalJson(value),
  ).digest("hex");
}

function parseEnv(name) {
  if (process.env[name]) return process.env[name];
  const envPath = path.join(ROOT, ".env.local");
  if (!fs.existsSync(envPath)) return undefined;
  const match = fs.readFileSync(envPath, "utf8").match(new RegExp(`^${name}=(.*)$`, "m"));
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, "");
}

function gitSha() {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("A committed git SHA is required");
  const changed = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  const relevant = changed
    .split(/\r?\n/)
    .filter((line) => /(?:scripts\/run-local-historical-replay|lib\/data\/technicals|lib\/edges\/rank-statistics|lib\/replay\/local-evidence)/.test(line));
  if (relevant.length) {
    throw new Error("Replay code has uncommitted changes; commit it before creating evidence");
  }
  return sha;
}

function asFinite(row, key) {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : null;
}

function isLikelyFund(row) {
  const symbol = String(row.symbol ?? "").toUpperCase();
  return /(?:BEES|ETF|GOLD|SILVER|LIQUID|NIFTY|SENSEX)$/.test(symbol);
}

function aggregate(values, horizonSessions, stepSessions, foldIndexes) {
  if (values.length < 2) return null;
  const meanIc = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sigmaIc = Math.sqrt(
    values.reduce((sum, value) => sum + (value - meanIc) ** 2, 0) / (values.length - 1),
  );
  const lag = Math.max(1, Math.ceil(horizonSessions / stepSessions));
  const seHac = neweyWestSEofMean(values, lag);
  const foldSums = new Map();
  values.forEach((value, index) => {
    const fold = foldIndexes[index];
    foldSums.set(fold, (foldSums.get(fold) ?? 0) + value);
  });
  return {
    n: values.length,
    meanIc,
    sigmaIc,
    icIr: sigmaIc > 0 ? meanIc / sigmaIc : null,
    seHac: Number.isFinite(seHac) ? seHac : null,
    tHac: Number.isFinite(seHac) && seHac > 0 ? meanIc / seHac : null,
    lag,
    foldSigns: [...foldSums.entries()].sort((a, b) => a[0] - b[0]).map(([, sum]) => Math.sign(sum)),
  };
}

export async function selectPointInTimeUniverses(rows, plan = DEFAULT_PLAN) {
  const state = new Map();
  const universes = new Map();
  const sessions = [];
  let currentDate = null;
  let current = new Map();
  let sampleCounter = 0;

  function finalizeDate() {
    if (!currentDate) return;
    sessions.push(currentDate);
    for (const [symbol, row] of current) {
      const prior = state.get(symbol) ?? { turnovers: [] };
      prior.turnovers.push(row.turnover);
      if (prior.turnovers.length > plan.liquidityLookbackSessions) prior.turnovers.shift();
      prior.close = row.close;
      prior.volume = row.volume;
      prior.seenOn = currentDate;
      state.set(symbol, prior);
    }
    if (currentDate < plan.dateFrom || currentDate > plan.dateThrough) return;
    const shouldSample = sampleCounter % plan.stepSessions === 0;
    sampleCounter++;
    if (!shouldSample) return;
    const ranked = [];
    for (const [symbol, value] of state) {
      if (
        value.seenOn !== currentDate
        || value.turnovers.length < plan.liquidityLookbackSessions
        || !(value.close >= plan.minimumPriceInr)
        || !(value.volume > 0)
        || isLikelyFund({ symbol })
      ) continue;
      const averageTurnover = value.turnovers.reduce((sum, item) => sum + item, 0)
        / value.turnovers.length;
      if (averageTurnover > 0) ranked.push({ symbol, averageTurnover });
    }
    ranked.sort((a, b) =>
      b.averageTurnover - a.averageTurnover || a.symbol.localeCompare(b.symbol),
    );
    universes.set(currentDate, ranked.slice(0, plan.universeSize).map((row) => row.symbol));
  }

  let previousDate = "";
  for await (const row of rows) {
    const date = String(row.session_date ?? "");
    if (!date || date > plan.dataCutoff) continue;
    if (previousDate && date < previousDate) throw new Error("NSE normalized bars are not date ordered");
    previousDate = date;
    if (currentDate !== date) {
      finalizeDate();
      currentDate = date;
      current = new Map();
    }
    const close = asFinite(row, "close");
    const volume = asFinite(row, "volume");
    const turnover = asFinite(row, "turnover");
    const symbol = String(row.symbol ?? "");
    if (!symbol || close == null || volume == null || turnover == null) continue;
    current.set(symbol, { close, volume, turnover });
  }
  finalizeDate();
  return { universes, sessions };
}

async function loadSelectedSeries(rows, symbols, dataCutoff) {
  const series = new Map([...symbols].map((symbol) => [symbol, []]));
  for await (const row of rows) {
    const symbol = String(row.symbol ?? "");
    const date = String(row.session_date ?? "");
    if (!series.has(symbol) || !date || date > dataCutoff) continue;
    const candle = {
      date,
      open: asFinite(row, "open"),
      high: asFinite(row, "high"),
      low: asFinite(row, "low"),
      close: asFinite(row, "close"),
      volume: asFinite(row, "volume"),
    };
    if (Object.values(candle).some((value) => value == null)) continue;
    series.get(symbol).push(candle);
  }
  return series;
}

async function loadBlockingActions(rows, symbols, dataCutoff) {
  const actions = new Map();
  for await (const row of rows) {
    const symbol = String(row.symbol ?? "");
    const exDate = String(row.ex_date ?? "");
    if (!symbols.has(symbol) || !exDate || exDate > dataCutoff) continue;
    const actionType = String(row.action_type ?? "").toLowerCase();
    const status = String(row.adjustment_status ?? "").toLowerCase();
    const subject = String(row.subject ?? "").toLowerCase();
    const blocks = (
      ["split", "bonus", "rights"].includes(actionType)
      || /demerger|spin.?off|scheme of arrangement/.test(subject)
      || !["parsed", "not_price_adjusting"].includes(status)
    );
    if (!blocks) continue;
    const list = actions.get(symbol) ?? [];
    list.push(exDate);
    actions.set(symbol, list);
  }
  for (const dates of actions.values()) dates.sort();
  return actions;
}

function hasBlockingAction(actions, from, through) {
  return actions?.some((date) => date >= from && date <= through) ?? false;
}

export function runDiagnostic({ plan, universes, series, actions }) {
  const perDate = [];
  const skipped = [];
  const dates = [...universes.keys()].sort();
  const foldSize = Math.ceil(dates.length / plan.foldCount);

  dates.forEach((asOf, dateIndex) => {
    const raw = [];
    const forward = [];
    let actionExcluded = 0;
    for (const symbol of universes.get(asOf) ?? []) {
      const candles = series.get(symbol) ?? [];
      const index = candles.findIndex((candle) => candle.date === asOf);
      const start = index - plan.historySessions + 1;
      const end = index + plan.horizonSessions;
      if (start < 0 || end >= candles.length) continue;
      const history = candles.slice(start, index + 1);
      if (hasBlockingAction(actions.get(symbol), history[0].date, candles[end].date)) {
        actionExcluded++;
        continue;
      }
      const score = scoreTechnicals(computeTechnicals(history));
      const realized = candles[end].close / candles[index].close - 1;
      if (!Number.isFinite(score) || !Number.isFinite(realized)) continue;
      raw.push(score);
      forward.push(realized);
    }
    if (raw.length < plan.minimumCrossSection) {
      skipped.push({ asOf, reason: "cross_section_below_min", crossSection: raw.length, actionExcluded });
      return;
    }
    const ic = spearman(raw, forward);
    if (!Number.isFinite(ic)) {
      skipped.push({ asOf, reason: "ic_not_finite", crossSection: raw.length, actionExcluded });
      return;
    }
    perDate.push({
      date: asOf,
      ic,
      crossSection: raw.length,
      actionExcluded,
      foldIndex: Math.min(plan.foldCount - 1, Math.floor(dateIndex / foldSize)),
    });
  });

  const aggregateResult = aggregate(
    perDate.map((row) => row.ic),
    plan.horizonSessions,
    plan.stepSessions,
    perDate.map((row) => row.foldIndex),
  );
  return { perDate, skipped, aggregate: aggregateResult };
}

async function main() {
  const priceManifestPath = process.argv[2] || DEFAULT_PRICE_MANIFEST;
  const actionManifestPath = process.argv[3] || DEFAULT_ACTION_MANIFEST;
  process.stdout.write("Verifying immutable local evidence...\n");
  const [prices, corporateActions] = await Promise.all([
    openVerifiedLocalEvidenceDataset(priceManifestPath),
    openVerifiedLocalEvidenceDataset(actionManifestPath),
  ]);
  if (
    prices.manifest.sourceId !== "nse-bhavcopy"
    || corporateActions.manifest.sourceId !== "nse-corporate-actions"
    || prices.manifest.market !== "india"
    || corporateActions.manifest.market !== "india"
  ) {
    throw new Error("The initial worker accepts only the official India NSE manifests");
  }

  const codeVersion = gitSha();
  const plan = {
    ...DEFAULT_PLAN,
    codeVersion,
    datasets: [
      { datasetId: prices.manifest.datasetId, fingerprint: prices.manifest.datasetFingerprint },
      { datasetId: corporateActions.manifest.datasetId, fingerprint: corporateActions.manifest.datasetFingerprint },
    ],
  };
  const planFingerprint = sha256(plan);
  const url = parseEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) throw new Error("Supabase URL and service role key are required locally");
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: existing, error: existingError } = await supabase
    .from("backtest_experiments")
    .select("id,completed_at,result_summary")
    .eq("plan_fingerprint", planFingerprint)
    .maybeSingle();
  if (existingError) throw new Error(`Lineage lookup failed: ${existingError.message}`);
  if (existing?.completed_at) {
    process.stdout.write(`Existing completed experiment ${existing.id}; exact plan is idempotent.\n`);
    return;
  }
  if (existing) throw new Error(`Experiment ${existing.id} is incomplete; refusing an ambiguous retry`);

  const variant = {
    id: "india_top200_technical_h10",
    universeSize: plan.universeSize,
    minimumCrossSection: plan.minimumCrossSection,
  };
  const { data: created, error: createError } = await supabase
    .from("backtest_experiments")
    .insert({
      hypothesis: "The production Kairos technical composite positively ranks 10-session forward returns in a point-in-time liquid India cross-section.",
      author: "human",
      variant_budget: 1,
      variants: [variant],
      variants_proposed: 1,
      experiment_type: "historical_replay",
      market: "india",
      segment_type: "market",
      segment_value: "all",
      edge_id: plan.edgeId,
      formula_version: plan.formulaVersion,
      horizon_sessions: plan.horizonSessions,
      validation_mode: "purged_temporal_oos",
      trial_family_id: "local-nse-technical-v1",
      trials_considered: 1,
      universe_policy_version: plan.universePolicyVersion,
      data_cutoff: plan.dataCutoff,
      code_version: codeVersion,
      validation_spec: plan,
      plan_fingerprint: planFingerprint,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (createError || !created?.id) {
    throw new Error(`Immutable predeclaration failed: ${createError?.message ?? "missing id"}`);
  }
  process.stdout.write(`Predeclared experiment ${created.id}; reading normalized rows...\n`);

  const { universes } = await selectPointInTimeUniverses(
    prices.rows("/daily-bars.jsonl"),
    plan,
  );
  const selectedSymbols = new Set([...universes.values()].flat());
  selectedSymbols.add(plan.benchmarkSymbol);
  const [series, actions] = await Promise.all([
    loadSelectedSeries(prices.rows("/daily-bars.jsonl"), selectedSymbols, plan.dataCutoff),
    loadBlockingActions(corporateActions.rows("/corporate-actions.jsonl"), selectedSymbols, plan.dataCutoff),
  ]);
  const result = runDiagnostic({ plan, universes, series, actions });
  if (!result.aggregate || result.perDate.length < 20) {
    throw new Error(`Diagnostic produced only ${result.perDate.length} usable dates; completion refused`);
  }

  const universeFingerprint = sha256(
    [...universes.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  const datasetFingerprint = sha256(plan.datasets);
  const resultSummary = {
    schemaVersion: "kairos.historical-replay.result.v1",
    status: "completed_diagnostic",
    evidenceClass: "diagnostic",
    plan: {
      edgeId: plan.edgeId,
      formulaVersion: plan.formulaVersion,
      market: plan.market,
      dateFrom: plan.dateFrom,
      dateThrough: plan.dateThrough,
      horizonSessions: plan.horizonSessions,
      stepSessions: plan.stepSessions,
      universeSize: plan.universeSize,
      minimumCrossSection: plan.minimumCrossSection,
      benchmarkSymbol: plan.benchmarkSymbol,
    },
    coverage: {
      universeDates: universes.size,
      evaluatedDates: result.perDate.length,
      skippedDates: result.skipped.length,
      symbolsLoaded: [...series.values()].filter((candles) => candles.length > 0).length,
      medianCrossSection: [...result.perDate]
        .sort((a, b) => a.crossSection - b.crossSection)[Math.floor(result.perDate.length / 2)]?.crossSection ?? null,
    },
    aggregate: result.aggregate,
    perDate: result.perDate,
    skipped: result.skipped,
    datasets: plan.datasets,
    limitations: plan.limitations,
  };
  const runFingerprint = sha256({
    planFingerprint,
    universeFingerprint,
    datasetFingerprint,
    resultSummary,
  });
  const { data: completed, error: completeError } = await supabase
    .from("backtest_experiments")
    .update({
      variants_run: 1,
      completed_at: new Date().toISOString(),
      result_summary: resultSummary,
      universe_fingerprint: universeFingerprint,
      dataset_fingerprint: datasetFingerprint,
      run_fingerprint: runFingerprint,
    })
    .eq("id", created.id)
    .eq("plan_fingerprint", planFingerprint)
    .is("completed_at", null)
    .select("id");
  if (completeError || completed?.length !== 1) {
    throw new Error(`Write-once completion failed: ${completeError?.message ?? "row mismatch"}`);
  }
  process.stdout.write(
    `Completed ${created.id}: n=${result.aggregate.n}, meanIC=${result.aggregate.meanIc.toFixed(4)}, ` +
    `sigma=${result.aggregate.sigmaIc.toFixed(4)}, tHAC=${result.aggregate.tHac?.toFixed(2) ?? "n/a"}.\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
