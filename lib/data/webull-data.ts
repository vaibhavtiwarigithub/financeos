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
async function openWebull(): Promise<{ token: string; sessionId?: string } | null> {
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
    return { token: tk.token, sessionId: init.sessionId };
  } catch {
    return null;
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
