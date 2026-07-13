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

async function callTool(
  sess: { token: string; sessionId?: string },
  name: string,
  args: Record<string, unknown>,
): Promise<any | null> {
  try {
    const r = await mcpRpc(CFG, sess.token, "tools/call", { name, arguments: args }, sess.sessionId);
    if (!r.ok) return null;
    return unwrapRecord(r.result);
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

// Some Webull rating payloads express consensus as a 1-5 scale (1 = strong buy,
// 5 = strong sell) or as buy/hold/sell counts. Derive a 0-100 score defensively.
function deriveRatingScore(rec: any): number | null {
  // Counts of buy/hold/sell recommendations, if present.
  const strongBuy = pickNum(rec, ["strongBuy", "strong_buy", "ratingStrongBuy"]);
  const buy = pickNum(rec, ["buy", "ratingBuy"]);
  const hold = pickNum(rec, ["hold", "ratingHold"]);
  const sell = pickNum(rec, ["sell", "ratingSell"]);
  const strongSell = pickNum(rec, ["strongSell", "strong_sell", "ratingUnderPerform", "ratingStrongSell"]);
  const counts = [strongBuy, buy, hold, sell, strongSell];
  if (counts.some((c) => c != null)) {
    const sB = strongBuy ?? 0, b = buy ?? 0, h = hold ?? 0, s = sell ?? 0, sS = strongSell ?? 0;
    const total = sB + b + h + s + sS;
    if (total > 0) {
      return Math.round((sB * 100 + b * 80 + h * 50 + s * 20 + sS * 0) / total);
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

    const [ratingRec, targetRec, epsRec] = await Promise.all([
      callTool(sess, "get_analyst_rating", { symbol: sym }),
      callTool(sess, "get_analyst_target_price", { symbol: sym }),
      callTool(sess, "get_stock_forecast_eps", { symbol: sym }),
    ]);

    // All three missing → treat as no data (null), not an empty object.
    if (!ratingRec && !targetRec && !epsRec) { cacheSet(cacheKey, null); return null; }

    const ratingLabel = pickStr(ratingRec, [
      "ratingLabel", "rating_label", "ratingText", "rating", "consensusRating",
      "recommendation", "recommendationLabel", "label",
    ]);
    const rating = deriveRatingScore(ratingRec) ?? labelToScore(ratingLabel);

    const targetPrice = pickNum(targetRec, [
      "targetPrice", "target_price", "priceTarget", "meanTarget", "mean",
      "targetPriceMean", "consensusTargetPrice", "avgTargetPrice", "average",
    ]);

    const forecastEps = pickNum(epsRec, [
      "forecastEps", "forecast_eps", "eps", "epsEstimate", "estimatedEps",
      "meanEps", "epsMean", "forwardEps", "estimate",
    ]);

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

    const rec = await callTool(sess, "get_financial_indicators", { symbol: sym });
    if (!rec || typeof rec !== "object") { cacheSet(cacheKey, null); return null; }

    // Flatten to numeric leaves only — best-effort, keep whatever Webull returns.
    const out: Record<string, number> = {};
    const walk = (obj: any, prefix: string) => {
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          walk(v, prefix ? `${prefix}.${k}` : k);
        } else {
          const n = Number(v);
          if (Number.isFinite(n) && v !== "" && v !== null && typeof v !== "boolean") {
            out[prefix ? `${prefix}.${k}` : k] = n;
          }
        }
      }
    };
    walk(rec, "");

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
