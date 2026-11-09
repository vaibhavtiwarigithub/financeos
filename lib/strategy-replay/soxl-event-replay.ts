import type { Bar } from "./compile";

export const SOXL_REFERENCE_VERSION = "soxl-soxx-wilder-rsi-stop-target-v2-optional-vix";
export const SOXL_REFERENCE_FACTOR_FILTERS = ["none", "vix_close_lte_20", "vix_close_lte_25", "vix_close_lte_30", "vix_change_lte_-5pct", "vix_change_lte_-10pct", "vix_change_gte_5pct", "vix_change_gte_10pct"] as const;

export interface Provenance {
  provider: string | null;
  priceBasis: string | null;
  provenanceVersion: string | null;
}

export type CachedSoxlPriceRow = {
  symbol: "SOXX" | "SOXL" | "VIX";
  date: string;
  open: unknown;
  high: unknown;
  low: unknown;
  close: unknown;
  provider: unknown;
  price_basis: unknown;
  provenance_version: unknown;
};

/**
 * Prepare only the clean, paired SOXX/SOXL date intersection. Older legacy
 * rows are excluded before replay and counted; no missing prices are filled.
 * Verified provenance conflicts, duplicate sessions, and an unusable VIX
 * series remain fail-closed (VIX only affects its optional factor variants).
 */
export function prepareSoxlReplayCohort(rows: CachedSoxlPriceRow[]) {
  const bySymbol = new Map<"SOXX" | "SOXL" | "VIX", CachedSoxlPriceRow[]>();
  for (const symbol of ["SOXX", "SOXL", "VIX"] as const) bySymbol.set(symbol, rows.filter((row) => row.symbol === symbol));

  const blockers: string[] = [];
  const excluded = {
    SOXX: { legacyRows: 0, unpairedSessions: 0 },
    SOXL: { legacyRows: 0, unpairedSessions: 0 },
    VIX: { legacyRows: 0, unpairedSessions: 0 },
  };
  const cleanRows = new Map<"SOXX" | "SOXL" | "VIX", CachedSoxlPriceRow[]>();
  const provenance = {} as Record<"SOXX" | "SOXL" | "VIX", Provenance | null>;

  for (const symbol of ["SOXX", "SOXL", "VIX"] as const) {
    const sourceRows = bySymbol.get(symbol) ?? [];
    const legacy = sourceRows.filter((row) => row.provenance_version == null || row.provenance_version === "v0_unprovenanced");
    excluded[symbol].legacyRows = legacy.length;
    const verified = sourceRows.filter((row) => row.provenance_version != null && row.provenance_version !== "v0_unprovenanced");
    const malformed = verified.some((row) => typeof row.provider !== "string" || !row.provider
      || typeof row.price_basis !== "string" || !["adjusted", "raw", "index"].includes(row.price_basis)
      || typeof row.provenance_version !== "string" || !row.provenance_version);
    if (malformed && symbol !== "VIX") blockers.push(`${symbol} has verified rows with incomplete or unsupported provenance.`);
    const metadata = new Set(verified.filter((row) => typeof row.provider === "string" && !!row.provider
      && typeof row.price_basis === "string" && ["adjusted", "raw", "index"].includes(row.price_basis)
      && typeof row.provenance_version === "string" && !!row.provenance_version)
      .map((row) => `${row.provider}|${row.price_basis}|${row.provenance_version}`));
    const rowsForReplay = metadata.size === 1 && !malformed ? verified : [];
    if (metadata.size > 1 && symbol !== "VIX") blockers.push(`${symbol} has mixed provider, price basis, or provenance versions.`);
    if (rowsForReplay.length) {
      const dates = rowsForReplay.map((row) => String(row.date).slice(0, 10));
      if (new Set(dates).size !== dates.length) {
        if (symbol !== "VIX") blockers.push(`${symbol} has duplicate verified sessions.`);
        cleanRows.set(symbol, []);
      } else cleanRows.set(symbol, rowsForReplay);
      const first = rowsForReplay[0];
      provenance[symbol] = { provider: String(first.provider), priceBasis: String(first.price_basis), provenanceVersion: String(first.provenance_version) };
    } else {
      cleanRows.set(symbol, []);
      provenance[symbol] = null;
    }
  }

  if (provenance.SOXX?.priceBasis && provenance.SOXL?.priceBasis && provenance.SOXX.priceBasis !== provenance.SOXL.priceBasis) {
    blockers.push("SOXX and SOXL verified price bases differ; cross-instrument adjusted/raw inputs cannot be mixed.");
  }

  const signalRows = cleanRows.get("SOXX") ?? [];
  const executionRows = cleanRows.get("SOXL") ?? [];
  const signalSessions = new Set(signalRows.map((row) => String(row.date).slice(0, 10)));
  const executionSessions = new Set(executionRows.map((row) => String(row.date).slice(0, 10)));
  const alignedSessions = [...signalSessions].filter((session) => executionSessions.has(session)).sort();
  excluded.SOXX.unpairedSessions = signalSessions.size - alignedSessions.length;
  excluded.SOXL.unpairedSessions = executionSessions.size - alignedSessions.length;
  const signalBySession = new Map(signalRows.map((row) => [String(row.date).slice(0, 10), row]));
  const executionBySession = new Map(executionRows.map((row) => [String(row.date).slice(0, 10), row]));
  const asBar = (row: CachedSoxlPriceRow): Bar => ({ session: String(row.date).slice(0, 10), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close) });
  const bars = {
    SOXX: alignedSessions.map((session) => asBar(signalBySession.get(session)!)),
    SOXL: alignedSessions.map((session) => asBar(executionBySession.get(session)!)),
    VIX: (cleanRows.get("VIX") ?? []).map(asBar),
  };

  const vixRows = [...(cleanRows.get("VIX") ?? [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const vixSessions = new Set(vixRows.map((row) => String(row.date).slice(0, 10)));
  excluded.VIX.unpairedSessions = vixSessions.size - [...vixSessions].filter((session) => alignedSessions.includes(session)).length;
  if (vixRows.length && (vixRows.length !== alignedSessions.length || vixRows.some((row, index) => String(row.date).slice(0, 10) !== alignedSessions[index]))) {
    bars.VIX = [];
    provenance.VIX = null;
  }

  const emptyProvenance = { provider: null, priceBasis: null, provenanceVersion: null };
  return { bars, provenance: { SOXX: provenance.SOXX ?? emptyProvenance, SOXL: provenance.SOXL ?? emptyProvenance, VIX: provenance.VIX }, blockers, excluded,
    alignedSessions: alignedSessions.length, vixAvailable: provenance.VIX?.priceBasis === "index"
      && bars.VIX.length === alignedSessions.length && alignedSessions.length > 0 };
}

export interface SoxlReplayInput {
  signalBars: Bar[];
  executionBars: Bar[];
  vixBars?: Bar[];
  provenance: Record<"SOXX" | "SOXL", Provenance> & { VIX?: Provenance | null };
  stopPct?: number;
  targetPct?: number;
  maxHoldingSessions?: number;
  rsiBelow?: number;
  vixMax?: number | null;
  costBpsPerSide?: number;
  stressCostBpsPerSide?: number;
}

export interface SoxlTrade {
  signalSession: string;
  entrySession: string;
  exitSession: string;
  entryPrice: number;
  exitPrice: number;
  returnPct: number;
  holdingSessions: number;
  exitReason: "stop" | "target" | "time";
  stopPrice: number;
  targetPrice: number;
}

export interface SoxlReplayResult {
  status: "insufficient_data" | "diagnostic_only";
  version: string;
  strategy: { signal: string; execution: string; stopPct: number; targetPct: number; maxHoldingSessions: number; rsiBelow: number; vixMax: number | null };
  data: { sessions: number; from: string | null; through: string | null; provenance: Record<string, Provenance | null> };
  assumptions: { entry: string; stopGap: string; sameBarCollision: string; targetGap: string; costBpsPerSide: number; stressCostBpsPerSide: number };
  trades: SoxlTrade[];
  summary: ReturnType<typeof summarize> | null;
  periods: Array<{ name: string; from: string; through: string; priorSelectionExposure: true; summary: ReturnType<typeof summarize> | null }>;
  stress: { costBpsPerSide: number; summary: ReturnType<typeof summarize> | null };
  factorScenarios: Array<{ name: string; status: "diagnostic_only" | "insufficient_data"; reason?: string; trades: number; summary: ReturnType<typeof summarize> | null }>;
  limitations: string[];
  caveats: string[];
}

const DEFAULTS = { stopPct: 6, targetPct: 25, maxHoldingSessions: 15, rsiBelow: 35, costBpsPerSide: 25, stressCostBpsPerSide: 50 };

/**
 * Fixed, measurement-only dual-instrument replay. SOXX/VIX are observed at the
 * close; SOXL enters at the next session open. On daily bars, a same-session
 * stop and target collision resolves to the stop. No output is an execution
 * recommendation or a promotion-grade validation result.
 */
export function replaySoxlPullback(input: SoxlReplayInput): SoxlReplayResult {
  const cfg = { ...DEFAULTS, ...input };
  const vixMax = input.vixMax ?? null;
  const limitations: string[] = [];
  const vixBars = input.vixBars ?? [];
  const bars = [input.signalBars, input.executionBars];
  const provenanceValues = [input.provenance.SOXX, input.provenance.SOXL];
  const provenanceGood = provenanceValues.every((p) =>
    typeof p.provider === "string" && !!p.provider && (["adjusted", "raw", "index"].includes(String(p.priceBasis)))
    && typeof p.provenanceVersion === "string" && !!p.provenanceVersion && p.provenanceVersion !== "v0_unprovenanced");
  if (!provenanceGood) limitations.push("SOXX and SOXL each need one verified provider, raw/adjusted basis, and non-legacy provenance version.");
  const validBars = bars.every((series) => isValidSeries(series));
  if (!validBars) limitations.push("Input bars must be unique, ascending sessions with valid positive OHLC values.");
  const sessions = input.signalBars.map((bar) => bar.session);
  const sameExecutionSessions = sessions.length > 0 && [input.executionBars].every((series) =>
    series.length === sessions.length && series.every((bar, index) => bar.session === sessions[index]));
  if (!sameExecutionSessions) limitations.push("SOXX and SOXL must have identical session coverage; missing sessions are not imputed.");
  const vixProvenance = input.provenance.VIX;
  const vixProvenanceGood = !!vixProvenance && typeof vixProvenance.provider === "string" && !!vixProvenance.provider
    && vixProvenance.priceBasis === "index" && typeof vixProvenance.provenanceVersion === "string"
    && !!vixProvenance.provenanceVersion && vixProvenance.provenanceVersion !== "v0_unprovenanced";
  const vixAligned = vixBars.length > 0 && isValidSeries(vixBars) && vixBars.length === sessions.length
    && vixBars.every((bar, index) => bar.session === sessions[index]);
  const vixUsable = vixProvenanceGood && vixAligned;
  // VIX is an optional factor. It cannot block the independent SOXX/SOXL
  // baseline, but no VIX-filtered result is emitted unless its own data passes.
  if (vixMax != null && !vixUsable) limitations.push("A VIX-filtered baseline requires aligned, consistently provenanced VIX index bars.");
  if (!Number.isFinite(cfg.stopPct) || cfg.stopPct <= 0 || !Number.isFinite(cfg.targetPct) || cfg.targetPct <= 0
    || !Number.isInteger(cfg.maxHoldingSessions) || cfg.maxHoldingSessions < 1 || !Number.isFinite(cfg.rsiBelow)
    || (vixMax != null && (!Number.isFinite(vixMax) || vixMax <= 0))
    || !Number.isFinite(cfg.costBpsPerSide) || cfg.costBpsPerSide < 0
    || !Number.isFinite(cfg.stressCostBpsPerSide) || cfg.stressCostBpsPerSide < cfg.costBpsPerSide) {
    limitations.push("Invalid strategy parameter or cost scenario.");
  }
  if (sessions.length < 230) limitations.push(`At least 230 aligned sessions are required for SMA200, Wilder RSI warm-up, and next-session execution; received ${sessions.length}.`);

  const base = {
    status: "insufficient_data" as const,
    version: SOXL_REFERENCE_VERSION,
    strategy: { signal: "SOXX close > SMA200 and Wilder RSI(14) < threshold", execution: "SOXL next-session open", stopPct: cfg.stopPct, targetPct: cfg.targetPct, maxHoldingSessions: cfg.maxHoldingSessions, rsiBelow: cfg.rsiBelow, vixMax },
    data: { sessions: sessions.length, from: sessions[0] ?? null, through: sessions.at(-1) ?? null, provenance: input.provenance },
    assumptions: { entry: vixUsable ? "Signal known at SOXX/VIX close; entry at next SOXL session open with adverse per-side costs." : "Signal known at SOXX close; entry at next SOXL session open with adverse per-side costs. VIX filters are unavailable.", stopGap: "If SOXL opens through stop, fill at open; otherwise fill at stop.", sameBarCollision: "Stop is assumed before target when both are touched on one daily bar.", targetGap: "Target fills at target price; favorable gap improvement is not credited.", costBpsPerSide: cfg.costBpsPerSide, stressCostBpsPerSide: cfg.stressCostBpsPerSide },
    trades: [] as SoxlTrade[], summary: null as ReturnType<typeof summarize> | null,
    periods: [] as Array<{ name: string; from: string; through: string; priorSelectionExposure: true; summary: ReturnType<typeof summarize> | null }>,
    stress: { costBpsPerSide: cfg.stressCostBpsPerSide, summary: null as ReturnType<typeof summarize> | null },
    factorScenarios: [] as Array<{ name: string; status: "diagnostic_only" | "insufficient_data"; reason?: string; trades: number; summary: ReturnType<typeof summarize> | null }>,
    limitations,
    caveats: ["Matching input dates verifies cross-instrument alignment, not completeness against every historical exchange session.",
      "Corporate-action correctness depends on the cached provider's declared price basis and provenance; it is not independently audited by this replay.",
      "Costs are fixed assumptions, not historical quote-level spreads, commissions, market impact, or liquidity-aware fills."],
  };
  if (limitations.length) return base;

  const primary = simulate(input, cfg, vixMax, cfg.costBpsPerSide);
  const stress = simulate(input, cfg, vixMax, cfg.stressCostBpsPerSide);
  const predicates: Record<(typeof SOXL_REFERENCE_FACTOR_FILTERS)[number], (level: number, changePct: number) => boolean> = {
    none: () => true,
    vix_close_lte_20: (vix) => vix <= 20,
    vix_close_lte_25: (vix) => vix <= 25,
    vix_close_lte_30: (vix) => vix <= 30,
    "vix_change_lte_-5pct": (_vix, change) => change <= -5,
    "vix_change_lte_-10pct": (_vix, change) => change <= -10,
    vix_change_gte_5pct: (_vix, change) => change >= 5,
    vix_change_gte_10pct: (_vix, change) => change >= 10,
  };
  const scenarioFilters = SOXL_REFERENCE_FACTOR_FILTERS.filter((filter) => filter !== "none");
  const labels: Record<Exclude<(typeof SOXL_REFERENCE_FACTOR_FILTERS)[number], "none">, string> = {
    vix_close_lte_20: "VIX close <= 20", vix_close_lte_25: "VIX close <= 25", vix_close_lte_30: "VIX close <= 30",
    "vix_change_lte_-5pct": "VIX one-day change <= -5%", "vix_change_lte_-10pct": "VIX one-day change <= -10%",
    vix_change_gte_5pct: "VIX one-day change >= +5%", vix_change_gte_10pct: "VIX one-day change >= +10%",
  };
  const factorScenarios = scenarioFilters.map((filter) => {
    if (!vixUsable) return { name: labels[filter], status: "insufficient_data" as const,
      reason: "Aligned, consistently provenanced VIX index bars are unavailable; this factor variant was not evaluated.", trades: 0, summary: null };
    const scenarioTrades = simulate({ ...input, vixBars }, cfg, null, cfg.costBpsPerSide, predicates[filter]);
    return { name: labels[filter], status: "diagnostic_only" as const, trades: scenarioTrades.length, summary: summarize(scenarioTrades) };
  });
  const periods = [
    { name: "2022–2024", from: "2022-01-01", through: "2024-12-31" },
    { name: "2025–2026", from: "2025-01-01", through: "2026-12-31" },
  ].map((period) => ({ ...period, priorSelectionExposure: true as const,
    summary: summarize(primary.filter((trade) => trade.signalSession >= period.from && trade.signalSession <= period.through)) }));
  return { ...base, status: "diagnostic_only", trades: primary, summary: summarize(primary), periods,
    stress: { costBpsPerSide: cfg.stressCostBpsPerSide, summary: summarize(stress) }, factorScenarios };
}

function isValidSeries(series: Bar[]): boolean {
  if (!Array.isArray(series) || !series.length) return false;
  const seen = new Set<string>();
  let prior = "";
  for (const b of series) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.session) || b.session <= prior || seen.has(b.session)) return false;
    if (![b.open, b.high, b.low, b.close].every((value) => Number.isFinite(value) && value > 0)
      || b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close) || b.low > b.high) return false;
    prior = b.session; seen.add(b.session);
  }
  return true;
}

function wilderRsi(closes: number[], end: number, period = 14): number | null {
  if (end < period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    gain += Math.max(0, delta); loss += Math.max(0, -delta);
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i <= end; i++) {
    const delta = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, delta)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -delta)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

type ReplayConfig = { stopPct: number; targetPct: number; maxHoldingSessions: number; rsiBelow: number; costBpsPerSide: number; stressCostBpsPerSide: number };

function simulate(input: SoxlReplayInput, cfg: ReplayConfig, vixMax: number | null, costBps: number,
  factorFilter?: (vixLevel: number, vixChangePct: number) => boolean): SoxlTrade[] {
  const closes = input.signalBars.map((bar) => bar.close);
  const trades: SoxlTrade[] = [];
  let index = 0;
  while (index < input.signalBars.length - 1) {
    const signal = input.signalBars[index];
    const smaStart = index - 199;
    if (smaStart < 0) { index++; continue; }
    const sma = closes.slice(smaStart, index + 1).reduce((sum, value) => sum + value, 0) / 200;
    const rsi = wilderRsi(closes, index);
    const vix = input.vixBars?.[index]?.close ?? null;
    const previousVix = index > 0 ? input.vixBars?.[index - 1]?.close ?? null : null;
    const vixChangePct = vix != null && previousVix != null && previousVix > 0 ? (vix / previousVix - 1) * 100 : null;
    if (signal.close <= sma || rsi == null || rsi >= cfg.rsiBelow || vix == null && vixMax != null || (vix != null && vixMax != null && vix > vixMax)) { index++; continue; }
    if (factorFilter && (vix == null || vixChangePct == null || !factorFilter(vix, vixChangePct))) { index++; continue; }
    const entryIndex = index + 1;
    // Do not silently treat a truncated final observation as a completed
    // time-stop trade. It has no fully observed maximum-hold horizon.
    if (entryIndex + cfg.maxHoldingSessions > input.executionBars.length) break;
    const entryBar = input.executionBars[entryIndex];
    const entryPrice = entryBar.open * (1 + costBps / 10_000);
    const stopPrice = entryPrice * (1 - cfg.stopPct / 100);
    const targetPrice = entryPrice * (1 + cfg.targetPct / 100);
    let exitIndex = Math.min(input.executionBars.length - 1, entryIndex + cfg.maxHoldingSessions - 1);
    let exitPrice = input.executionBars[exitIndex].close;
    let exitReason: SoxlTrade["exitReason"] = "time";
    for (let j = entryIndex; j <= exitIndex; j++) {
      const bar = input.executionBars[j];
      const stopTouched = bar.low <= stopPrice;
      const targetTouched = bar.high >= targetPrice;
      if (bar.open <= stopPrice) { exitIndex = j; exitPrice = bar.open; exitReason = "stop"; break; }
      if (bar.open >= targetPrice) { exitIndex = j; exitPrice = targetPrice; exitReason = "target"; break; }
      if (stopTouched && targetTouched) { exitIndex = j; exitPrice = stopPrice; exitReason = "stop"; break; }
      if (stopTouched) { exitIndex = j; exitPrice = stopPrice; exitReason = "stop"; break; }
      if (targetTouched) { exitIndex = j; exitPrice = targetPrice; exitReason = "target"; break; }
      if (j === exitIndex) { exitPrice = bar.close; exitReason = "time"; }
    }
    const netExit = exitPrice * (1 - costBps / 10_000);
    trades.push({ signalSession: signal.session, entrySession: entryBar.session, exitSession: input.executionBars[exitIndex].session,
      entryPrice, exitPrice: netExit, returnPct: (netExit / entryPrice - 1) * 100,
      holdingSessions: exitIndex - entryIndex + 1, exitReason, stopPrice, targetPrice });
    index = exitIndex + 1;
  }
  return trades;
}

function summarize(trades: SoxlTrade[]) {
  const returns = trades.map((trade) => trade.returnPct);
  const wins = returns.filter((value) => value > 0).length;
  const gains = returns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = -returns.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
  let equity = 1, peak = 1, maxDrawdownPct = 0;
  for (const value of returns) { equity *= 1 + value / 100; peak = Math.max(peak, equity); maxDrawdownPct = Math.max(maxDrawdownPct, (1 - equity / peak) * 100); }
  const sorted = [...returns].sort((a, b) => a - b);
  return { trades: trades.length, wins, winRatePct: trades.length ? wins / trades.length * 100 : null,
    profitFactor: losses > 0 ? gains / losses : gains > 0 ? null : 0,
    averageReturnPct: trades.length ? returns.reduce((sum, value) => sum + value, 0) / trades.length : null,
    medianReturnPct: trades.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null,
    compoundedReturnPct: (equity - 1) * 100, maxDrawdownPct, averageHoldingSessions: trades.length ? trades.reduce((sum, trade) => sum + trade.holdingSessions, 0) / trades.length : null,
    stopExits: trades.filter((trade) => trade.exitReason === "stop").length, targetExits: trades.filter((trade) => trade.exitReason === "target").length,
    timeExits: trades.filter((trade) => trade.exitReason === "time").length };
}
