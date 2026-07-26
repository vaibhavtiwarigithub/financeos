import { createServiceClient } from "@/lib/supabase/service";
import { getValidAccessToken, mcpRpc, mcpToolJson } from "@/lib/brokers/mcp-driver";
import { MCP_BROKERS, type McpBrokerConfig } from "@/lib/brokers/mcp-registry";

// Webull MCP as a FREE, READ-ONLY research DATA provider (US symbols only).
//
// This is purely additive and ABSOLUTELY fail-soft: every exported function
// returns `null` on ANY failure — not connected, token expired, session error,
// tool error, unparseable payload — and NEVER throws into the research pipeline.
// When Webull isn't connected, research runs EXACTLY as before (these return
// null and the caller simply omits the Webull evidence line).
//
// There is NO order/money path here — only the Webull MCP research/fundamental
// read tools (analyst rating / target / EPS forecast / financial indicators)
// are ever called. It reuses the generic MCP driver's OAuth token accessor and
// JSON-RPC caller against MCP_BROKERS.webull, so it shares the same connection
// the read-only broker snapshot uses.
//
// It does NOT count against the Alpha Vantage (or any providerCachedFetch)
// budget — a simple in-memory 6h cache keyed by symbol collapses repeat lookups
// within a research pass instead.

const CFG: McpBrokerConfig = MCP_BROKERS.webull;

// Webull's analyst/financial data tools REQUIRE this category argument. A bare
// { symbol } call returns MCP error -32603 "No fallback available" (verified live
// 2026-07-14 — see features/data-source-policy/PROBE_RESULTS.md). This constant is
// owned here; callers never omit or override it.
const WEBULL_CATEGORY = "US_STOCK";

// ── in-memory 6h cache (keyed by tool+symbol) ───────────────────────────────
// Deliberately NOT routed through providerCachedFetch: that helper does a plain
// HTTP `fetch(url)`, whereas Webull data comes over MCP JSON-RPC. A tiny
// per-process cache is enough — the same symbols are scored repeatedly within a
// run, and this keeps Webull off the AV/provider daily budget entirely.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — analyst/fundamentals move slowly
const cache = new Map<string, { at: number; value: any }>();
// MCP sessions are scoped to a warm serverless instance. Reuse one briefly so
// a research run does not cold-initialize a session for every symbol.
const SESSION_TTL_MS = 5 * 60 * 1000;
type WebullSession = { token: string; sessionId?: string };
let activeSession: { at: number; value: WebullSession } | null = null;
let openingSession: Promise<WebullSession | null> | null = null;

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
  if (hit) cache.delete(key);
  return undefined;
}
function cacheSet(key: string, value: any): void {
  cache.set(key, { at: Date.now(), value });
}

// ── field pickers (multi-key defensive probing) ─────────────────────────────
function pickNum(obj: any, keys: string[]): number | null {
  if (!obj || typeof obj !== "object") return null;
  for (const k of keys) {
    // support dotted paths
    let cur: any = obj;
    let ok = true;
    for (const seg of k.split(".")) {
      if (cur && typeof cur === "object" && seg in cur) cur = cur[seg];
      else { ok = false; break; }
    }
    if (!ok || cur == null) continue;
    const n = Number(cur);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
function pickStr(obj: any, keys: string[]): string | null {
  if (!obj || typeof obj !== "object") return null;
  for (const k of keys) {
    let cur: any = obj;
    let ok = true;
    for (const seg of k.split(".")) {
      if (cur && typeof cur === "object" && seg in cur) cur = cur[seg];
      else { ok = false; break; }
    }
    if (ok && cur != null && String(cur).trim()) return String(cur).trim();
  }
  return null;
}

// Unwrap the first plausible record from an MCP tool result. Webull wraps the
// JSON in content[0].text; the decoded object may be the record itself, or nest
// it under data / result / an array. Returns the first object-shaped candidate.
function unwrapRecord(result: any): any | null {
  const obj = mcpToolJson(result?.content ?? result);
  if (obj == null || typeof obj !== "object") return null;
  const data = (obj as any).data ?? obj;
  if (Array.isArray(data)) return data[0] ?? null;
  if (Array.isArray((data as any)?.results)) return (data as any).results[0] ?? null;
  return data;
}

// ── session + tool-call plumbing (read-only) ────────────────────────────────
// Open one MCP session and reuse it across the small number of tool calls a
// single analyst/financials fetch needs. Fail-soft: any error → null.
async function openWebull(): Promise<WebullSession | null> {
  if (activeSession && Date.now() - activeSession.at < SESSION_TTL_MS) return activeSession.value;
  if (openingSession) return openingSession;

  openingSession = (async () => {
    try {
    const svc = createServiceClient();
    const tk = await getValidAccessToken(svc, CFG);
    if (!tk.ok || !tk.token) return null; // not connected / expired → silent
    const init = await mcpRpc(CFG, tk.token, "initialize", {
      protocolVersion: CFG.protocolVersion,
      capabilities: {},
      clientInfo: { name: "kairos-financeos", version: "1.0" },
    });
    if (!init.ok) return null;
    await mcpRpc(CFG, tk.token, "notifications/initialized", undefined, init.sessionId, true).catch(() => {});
    const session = { token: tk.token, sessionId: init.sessionId };
    activeSession = { at: Date.now(), value: session };
    return session;
  } catch {
    return null;
    }
  })();
  try {
    return await openingSession;
  } finally {
    openingSession = null;
  }
}

// Call a tool and return the first object-shaped record (analyst rating / target
// return a single object). Always injects the required US_STOCK category.
async function callTool(
  sess: { token: string; sessionId?: string },
  name: string,
  args: Record<string, unknown>,
): Promise<any | null> {
  try {
    const r = await mcpRpc(CFG, sess.token, "tools/call", { name, arguments: { ...args, category: WEBULL_CATEGORY } }, sess.sessionId);
    if (!r.ok) return null;
    return unwrapRecord(r.result);
  } catch {
    return null;
  }
}

// Call a tool and return the raw decoded JSON WITHOUT array-unwrapping — the
// forecast-EPS and financial-indicators tools return an array / a keyed-array
// object that must be parsed whole, not collapsed to its first element.
async function callToolRaw(
  sess: { token: string; sessionId?: string },
  name: string,
  args: Record<string, unknown>,
): Promise<any | null> {
  try {
    const r = await mcpRpc(CFG, sess.token, "tools/call", { name, arguments: { ...args, category: WEBULL_CATEGORY } }, sess.sessionId);
    if (!r.ok) return null;
    return mcpToolJson(r.result?.content ?? r.result);
  } catch {
    return null;
  }
}

// ── analyst rating label → 0-100 numeric ────────────────────────────────────
// Webull returns ratings either as a numeric (already a score, or a 1-5 scale)
// or as a text label. Normalize a label to a 0-100 bullishness score aligned
// with the existing analyst dimension (100 = strong buy … 0 = strong sell).
function labelToScore(label: string | null): number | null {
  if (!label) return null;
  const l = label.toLowerCase();
  if (l.includes("strong buy")) return 100;
  if (l.includes("buy") || l.includes("outperform") || l.includes("overweight")) return 80;
  if (l.includes("hold") || l.includes("neutral") || l.includes("market perform") || l.includes("equal")) return 50;
  if (l.includes("strong sell")) return 0;
  if (l.includes("sell") || l.includes("underperform") || l.includes("underweight")) return 20;
  return null;
}

// Webull get_analyst_rating returns string counts per bucket:
//   { strong_buy, buy, hold, under_perform, sell, number }
// (verified 2026-07-14; there is NO strong_sell bucket). Weight the buckets
// 100/80/50/20/0 and divide by the analyst total. `number` is the reported
// total; fall back to the bucket sum. Legacy 1-5 / 0-100 shapes still handled.
function deriveRatingScore(rec: any): number | null {
  const strongBuy = pickNum(rec, ["strong_buy", "strongBuy", "ratingStrongBuy"]);
  const buy = pickNum(rec, ["buy", "ratingBuy"]);
  const hold = pickNum(rec, ["hold", "ratingHold"]);
  const underPerform = pickNum(rec, ["under_perform", "underPerform", "ratingUnderPerform"]);
  const sell = pickNum(rec, ["sell", "ratingSell"]);
  const strongSell = pickNum(rec, ["strong_sell", "strongSell", "ratingStrongSell"]);
  const counts = [strongBuy, buy, hold, underPerform, sell, strongSell];
  if (counts.some((c) => c != null)) {
    const sB = strongBuy ?? 0, b = buy ?? 0, h = hold ?? 0, uP = underPerform ?? 0, s = sell ?? 0, sS = strongSell ?? 0;
    const total = sB + b + h + uP + s + sS;
    if (total > 0) {
      // strong_buy 100, buy 80, hold 50, under_perform 20, sell 0, strong_sell 0.
      return Math.round((sB * 100 + b * 80 + h * 50 + uP * 20 + s * 0 + sS * 0) / total);
    }
  }

  // A 1-5 consensus mean (1 = strong buy … 5 = strong sell).
  const mean = pickNum(rec, ["rating", "ratingScore", "consensus", "consensusRating", "score"]);
  if (mean != null && mean >= 1 && mean <= 5) {
    // 1 → 100, 3 → 50, 5 → 0
    return Math.round(((5 - mean) / 4) * 100);
  }
  // Already a 0-100 style score.
  if (mean != null && mean >= 0 && mean <= 100) return Math.round(mean);
  return null;
}

// get_stock_forecast_eps → array of { fiscal_year, fiscal_period, actual?, est,
// reported }. Pick the EARLIEST future (reported:false) period's `est`. If every
// row is already reported, fall back to the latest row's est (still a forward-
// looking estimate field), never `actual`.
function pickForecastEps(raw: any): number | null {
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : null;
  if (!arr || arr.length === 0) return null;
  const key = (r: any) => (Number(r?.fiscal_year) || 0) * 10 + (Number(r?.fiscal_period) || 0);
  const future = arr
    .filter((r: any) => r && r.reported === false)
    .sort((a: any, b: any) => key(a) - key(b));
  const chosen = future[0] ?? [...arr].sort((a: any, b: any) => key(b) - key(a))[0];
  const est = Number(chosen?.est);
  return Number.isFinite(est) ? est : null;
}

export interface WebullAnalyst {
  rating: number | null;       // normalized 0-100 bullishness (100 = strong buy)
  ratingLabel: string | null;  // human label if Webull provided one
  targetPrice: number | null;  // consensus/mean price target
  forecastEps: number | null;  // forward EPS estimate
}

// Analyst evidence for a US symbol from Webull MCP. Fail-soft: returns null when
// Webull isn't connected or every sub-call fails; returns a partial object (with
// null fields) when at least one sub-call succeeds.
export async function fetchWebullAnalyst(symbol: string): Promise<WebullAnalyst | null> {
  const sym = String(symbol ?? "").trim().toUpperCase();
  if (!sym) return null;
  const cacheKey = `analyst:${sym}`;
  const cached = cacheGet<WebullAnalyst | null>(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const sess = await openWebull();
    if (!sess) { cacheSet(cacheKey, null); return null; }

    const [ratingRec, targetRec, epsRaw] = await Promise.all([
      callTool(sess, "get_analyst_rating", { symbol: sym }),
      callTool(sess, "get_analyst_target_price", { symbol: sym }),
      callToolRaw(sess, "get_stock_forecast_eps", { symbol: sym }),
    ]);

    // All three missing → treat as no data (null), not an empty object.
    if (!ratingRec && !targetRec && !epsRaw) { cacheSet(cacheKey, null); return null; }

    const ratingLabel = pickStr(ratingRec, [
      "ratingLabel", "rating_label", "ratingText", "rating", "consensusRating",
      "recommendation", "recommendationLabel", "label",
    ]);
    const rating = deriveRatingScore(ratingRec) ?? labelToScore(ratingLabel);

    const targetPrice = pickNum(targetRec, [
      "targetPrice", "target_price", "priceTarget", "meanTarget", "mean",
      "targetPriceMean", "consensusTargetPrice", "avgTargetPrice", "average",
    ]);

    // Forward EPS = the nearest fiscal period NOT yet reported (reported:false),
    // field `est`. The tool returns an ascending array of periods; the trailing
    // rows are the future estimates. NEVER use a reported period's `actual`.
    const forecastEps = pickForecastEps(epsRaw);

    const out: WebullAnalyst = { rating, ratingLabel, targetPrice, forecastEps };
    cacheSet(cacheKey, out);
    return out;
  } catch {
    cacheSet(cacheKey, null);
    return null;
  }
}

// Best-effort financial indicators (PE, margins, ROE, etc.) from Webull MCP.
// Returns a flat Record<string, number> of whatever numeric indicators are
// present, or null on any failure / no numeric fields. Fail-soft; never throws.
export async function fetchWebullFinancials(symbol: string): Promise<Record<string, number> | null> {
  const sym = String(symbol ?? "").trim().toUpperCase();
  if (!sym) return null;
  const cacheKey = `financials:${sym}`;
  const cached = cacheGet<Record<string, number> | null>(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const sess = await openWebull();
    if (!sess) { cacheSet(cacheKey, null); return null; }

    const rec = await callToolRaw(sess, "get_financial_indicators", { symbol: sym });
    // Shape: { currency, values: { <metric>: [{ fiscal_year, fiscal_period, value }] } }
    // QUARTERLY, newest-first, last ~5 quarters. Take the newest quarter's value
    // per metric. Ratios are already FRACTIONS (net_margin 0.266 = 26.6%) — do NOT
    // rescale here. Basis is quarterly; TTM is NOT computed (would need 4-quarter
    // derivation — deferred to a tested adapter version).
    const values = rec?.values;
    if (!values || typeof values !== "object") { cacheSet(cacheKey, null); return null; }

    const newestValue = (rows: any): number | null => {
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const key = (r: any) => (Number(r?.fiscal_year) || 0) * 10 + (Number(r?.fiscal_period) || 0);
      const newest = [...rows].sort((a, b) => key(b) - key(a))[0];
      const n = Number(newest?.value);
      return Number.isFinite(n) ? n : null;
    };

    const out: Record<string, number> = {};
    for (const [metric, rows] of Object.entries(values)) {
      const v = newestValue(rows);
      if (v != null) out[metric] = v;
    }

    if (Object.keys(out).length === 0) { cacheSet(cacheKey, null); return null; }
    cacheSet(cacheKey, out);
    return out;
  } catch {
    cacheSet(cacheKey, null);
    return null;
  }
}

// One-line evidence string for the research thesis prompt (US only). Returns
// null when there's nothing usable, so the caller omits the line entirely —
// exactly mirroring how the India FII/DII flow line is conditionally injected.
export function webullAnalystLine(a: WebullAnalyst | null): string | null {
  if (!a) return null;
  const parts: string[] = [];
  if (a.rating != null) {
    parts.push(`rating ${a.rating}/100${a.ratingLabel ? ` (${a.ratingLabel})` : ""}`);
  } else if (a.ratingLabel) {
    parts.push(`rating ${a.ratingLabel}`);
  }
  if (a.targetPrice != null) parts.push(`target $${a.targetPrice}`);
  if (a.forecastEps != null) parts.push(`EPS fcst ${a.forecastEps}`);
  if (parts.length === 0) return null;
  return `Webull analyst: ${parts.join(", ")}`;
}

// ── Extended research data (5 new tools) ─────────────────────────────────────
// Confirmed live 2026-07-25 via probe: get_stock_capital_flow,
// get_stock_earnings_calendar, get_financial_alert, get_company_profile,
// get_income_statement, get_balance_sheet all return data with {symbol,category}.
// get_stock_bars_single and get_stock_snapshot require additional required params.

export interface WebullCapitalFlow {
  days: Array<{ date: string; largeNet: number; mediumNet: number; smallNet: number }>;
  largNet5d: number;
  signal: "bullish" | "bearish" | "neutral";
}

export interface WebullEarnings {
  nextDate: string | null;
  nextEpsEst: number | null;
  nextRevEst: number | null;
  lastEpsActual: number | null;
  lastEpsBeat: boolean | null;
  epsYoY: number | null;
  revYoY: number | null;
}

export interface WebullProfile {
  companyName: string | null;
  industries: string[];
  employees: number | null;
  ceo: string | null;
  exchange: string | null;
}

export interface WebullIncomeStatement {
  revenue: number | null;
  grossMargin: number | null;
  opMargin: number | null;
  netMargin: number | null;
  dilutedEps: number | null;
  revenueGrowthQoQ: number | null;
  period: string | null;
}

export interface WebullBalanceSheet {
  totalDebt: number | null;
  totalEquity: number | null;
  debtToEquity: number | null;
  cash: number | null;
  totalAssets: number | null;
  period: string | null;
}

export interface WebullExtended {
  capitalFlow: WebullCapitalFlow | null;
  earnings: WebullEarnings | null;
  profile: WebullProfile | null;
  incomeStatement: WebullIncomeStatement | null;
  balanceSheet: WebullBalanceSheet | null;
}

export function parseCapitalFlow(raw: any): WebullCapitalFlow | null {
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : null;
  if (!arr || arr.length === 0) return null;
  // Missing flow legs are unavailable, not zero. Otherwise a partial payload
  // could fabricate a directional smart-money observation.
  const days: Array<{ date: string; largeNet: number; mediumNet: number; smallNet: number } | null> = arr.slice(0, 5).map((d: any) => {
    const largeIn = Number(d?.large_in);
    const largeOut = Number(d?.large_out);
    const mediumIn = Number(d?.medium_in);
    const mediumOut = Number(d?.medium_out);
    const smallIn = Number(d?.small_in);
    const smallOut = Number(d?.small_out);
    if (!String(d?.date ?? "").trim() ||
        [d?.large_in, d?.large_out, d?.medium_in, d?.medium_out, d?.small_in, d?.small_out].some((value) => value == null) ||
        ![largeIn, largeOut, mediumIn, mediumOut, smallIn, smallOut].every(Number.isFinite)) return null;
    return {
      date: String(d.date),
      largeNet: largeIn - largeOut,
      mediumNet: mediumIn - mediumOut,
      smallNet: smallIn - smallOut,
    };
  });
  if (days.some((day) => day == null)) return null;
  const completeDays = days as Array<{ date: string; largeNet: number; mediumNet: number; smallNet: number }>;
  const largNet5d = completeDays.reduce((s, d) => s + d.largeNet, 0);
  return {
    days: completeDays,
    largNet5d,
    signal: largNet5d > 0 ? "bullish" : largNet5d < 0 ? "bearish" : "neutral",
  };
}

function parseEarningsCalendar(calRaw: any, alertRaw: any): WebullEarnings | null {
  const arr = Array.isArray(calRaw) ? calRaw : Array.isArray(calRaw?.data) ? calRaw.data : null;
  let nextDate: string | null = null;
  let nextEpsEst: number | null = null;
  let nextRevEst: number | null = null;
  let lastEpsActual: number | null = null;
  let lastEpsBeat: boolean | null = null;

  if (arr && arr.length > 0) {
    const sorted = [...arr].sort((a: any, b: any) =>
      ((Number(a.fiscal_year) || 0) * 10 + (Number(a.fiscal_period) || 0)) -
      ((Number(b.fiscal_year) || 0) * 10 + (Number(b.fiscal_period) || 0))
    );
    const next = sorted.find((r: any) => r.eps_actual == null && r.expected_publish_date);
    if (next) {
      nextDate = String(next.expected_publish_date);
      const est = Number(next.eps_est);
      if (Number.isFinite(est)) nextEpsEst = est;
      const rest = Number(next.rev_est);
      if (Number.isFinite(rest)) nextRevEst = rest;
    }
    const reported = sorted.filter((r: any) => r.eps_actual != null).reverse();
    if (reported.length > 0) {
      const actual = Number(reported[0].eps_actual);
      if (Number.isFinite(actual)) {
        lastEpsActual = actual;
        const est = Number(reported[0].eps_est);
        if (Number.isFinite(est)) lastEpsBeat = actual > est;
      }
    }
  }

  let epsYoY: number | null = null;
  let revYoY: number | null = null;
  if (alertRaw && typeof alertRaw === "object") {
    const epsLy = Number(alertRaw.eps_ly);
    const revLy = Number(alertRaw.rev_ly);
    if (nextEpsEst != null && Number.isFinite(epsLy) && epsLy !== 0)
      epsYoY = (nextEpsEst - epsLy) / Math.abs(epsLy);
    if (nextRevEst != null && Number.isFinite(revLy) && revLy !== 0)
      revYoY = (nextRevEst - revLy) / Math.abs(revLy);
  }

  if (!nextDate && lastEpsActual == null && epsYoY == null) return null;
  return { nextDate, nextEpsEst, nextRevEst, lastEpsActual, lastEpsBeat, epsYoY, revYoY };
}

function parseProfile(raw: any): WebullProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const industries = Array.isArray(raw.industries) ? raw.industries.map(String) : [];
  const employees = Number(raw.employees);
  return {
    companyName: pickStr(raw, ["company_name", "companyName", "name"]),
    industries,
    employees: Number.isFinite(employees) && employees > 0 ? employees : null,
    ceo: pickStr(raw, ["ceo", "CEO"]),
    exchange: pickStr(raw, ["exhibition_code", "exchange", "exchangeCode"]),
  };
}

function parseIncomeStatement(raw: any): WebullIncomeStatement | null {
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : null;
  if (!arr || arr.length === 0) return null;
  const key = (r: any) => (Number(r?.fiscal_year) || 0) * 10 + (Number(r?.fiscal_period) || 0);
  const sorted = [...arr].sort((a, b) => key(b) - key(a));
  const latest = sorted[0];
  const prev = sorted[1] ?? null;

  const revenue = pickNum(latest, ["total_revenue", "revenue"]);
  const grossProfit = pickNum(latest, ["gross_profit"]);
  const opIncome = pickNum(latest, ["op_income", "op_profit"]);
  const netIncome = pickNum(latest, ["net_income"]);
  const dilutedEps = pickNum(latest, ["diluted_eps_incl_extra", "diluted_eps_excl_extra", "diluted_norm_eps"]);

  const grossMargin = revenue && grossProfit != null ? grossProfit / revenue : null;
  const opMargin = revenue && opIncome != null ? opIncome / revenue : null;
  const netMargin = revenue && netIncome != null ? netIncome / revenue : null;

  let revenueGrowthQoQ: number | null = null;
  if (prev && revenue != null) {
    const prevRev = pickNum(prev, ["total_revenue", "revenue"]);
    if (prevRev && prevRev !== 0) revenueGrowthQoQ = (revenue - prevRev) / Math.abs(prevRev);
  }

  const fy = latest?.fiscal_year;
  const fp = latest?.fiscal_period;
  if (revenue == null && dilutedEps == null) return null;
  return {
    revenue, grossMargin, opMargin, netMargin, dilutedEps, revenueGrowthQoQ,
    period: fy && fp ? `FY${fy}Q${fp}` : null,
  };
}

function parseBalanceSheet(raw: any): WebullBalanceSheet | null {
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : null;
  if (!arr || arr.length === 0) return null;
  const key = (r: any) => (Number(r?.fiscal_year) || 0) * 10 + (Number(r?.fiscal_period) || 0);
  const latest = [...arr].sort((a, b) => key(b) - key(a))[0];

  const totalDebt = pickNum(latest, ["total_debt"]);
  const totalEquity = pickNum(latest, ["total_equity", "total_sh_equity"]);
  const cash = pickNum(latest, ["cash_st_invest", "cash"]);
  const totalAssets = pickNum(latest, ["total_assets"]);
  const debtToEquity = totalDebt != null && totalEquity && totalEquity !== 0
    ? totalDebt / totalEquity : null;

  const fy = latest?.fiscal_year;
  const fp = latest?.fiscal_period;
  if (totalAssets == null && totalDebt == null) return null;
  return {
    totalDebt, totalEquity, debtToEquity, cash, totalAssets,
    period: fy && fp ? `FY${fy}Q${fp}` : null,
  };
}

// Opens ONE Webull session and fetches all 5 extended research tools in parallel.
// Fail-soft: null when not connected; partial result when some tools fail.
export async function fetchWebullExtended(symbol: string): Promise<WebullExtended | null> {
  const sym = String(symbol ?? "").trim().toUpperCase();
  if (!sym) return null;
  const cacheKey = `extended:${sym}`;
  const cached = cacheGet<WebullExtended | null>(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const sess = await openWebull();
    if (!sess) { cacheSet(cacheKey, null); return null; }

    const [flowRaw, calRaw, alertRaw, profileRaw, incomeRaw, balanceRaw] = await Promise.all([
      callToolRaw(sess, "get_stock_capital_flow", { symbol: sym }),
      callToolRaw(sess, "get_stock_earnings_calendar", { symbol: sym }),
      callToolRaw(sess, "get_financial_alert", { symbol: sym }),
      callToolRaw(sess, "get_company_profile", { symbol: sym }),
      callToolRaw(sess, "get_income_statement", { symbol: sym }),
      callToolRaw(sess, "get_balance_sheet", { symbol: sym }),
    ]);

    const capitalFlow = parseCapitalFlow(flowRaw);
    const earnings = parseEarningsCalendar(calRaw, alertRaw);
    const profile = parseProfile(profileRaw);
    const incomeStatement = parseIncomeStatement(incomeRaw);
    const balanceSheet = parseBalanceSheet(balanceRaw);

    if (!capitalFlow && !earnings && !profile && !incomeStatement && !balanceSheet) {
      cacheSet(cacheKey, null);
      return null;
    }

    const out: WebullExtended = { capitalFlow, earnings, profile, incomeStatement, balanceSheet };
    cacheSet(cacheKey, out);
    return out;
  } catch {
    cacheSet(cacheKey, null);
    return null;
  }
}

// One-line evidence string for the thesis prompt. Null = nothing usable.
export function webullExtendedLine(e: WebullExtended | null): string | null {
  if (!e) return null;
  const parts: string[] = [];
  if (e.capitalFlow) {
    const net = e.capitalFlow.largNet5d;
    parts.push(`smart-money ${net >= 0 ? "+" : ""}${(net / 1e6).toFixed(0)}M (${e.capitalFlow.signal})`);
  }
  if (e.earnings?.nextDate) {
    parts.push(`earnings ${e.earnings.nextDate}`);
    if (e.earnings.epsYoY != null) parts.push(`YoY ${(e.earnings.epsYoY * 100).toFixed(0)}%`);
  }
  if (e.incomeStatement) {
    const is = e.incomeStatement;
    if (is.grossMargin != null) parts.push(`GM ${(is.grossMargin * 100).toFixed(0)}%`);
    if (is.revenueGrowthQoQ != null) parts.push(`rev QoQ ${(is.revenueGrowthQoQ >= 0 ? "+" : "")}${(is.revenueGrowthQoQ * 100).toFixed(0)}%`);
  }
  if (e.balanceSheet?.debtToEquity != null)
    parts.push(`D/E ${e.balanceSheet.debtToEquity.toFixed(1)}`);
  return parts.length ? `Webull extended: ${parts.join(", ")}` : null;
}
