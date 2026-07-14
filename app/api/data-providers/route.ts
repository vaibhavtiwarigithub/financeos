import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { providerConfig, type ProviderId } from "@/lib/data/provider-fetch";

export const dynamic = "force-dynamic";

// Data Providers capacity dashboard feed. Per provider: limit, today's real
// calls, 7-day average, headroom, credential expiry countdown, and a bottleneck
// flag (which capped provider is closest to its ceiling). "Always know where
// the ceiling is." Owner-only.

// Which env var holds each provider's credential (for key-present + expiry).
const KEY_ENV: Record<ProviderId, string | null> = {
  alpha_vantage: "ALPHA_VANTAGE_API_KEY",
  financialdatasets: "FINANCIAL_DATASETS_API_KEY",
  massive: "MASSIVE_API_KEY",
  finnhub: "FINNHUB_API_KEY",
  fmp: "FMP_API_KEY",
  eodhd: "EODHD_API_KEY",
  twelvedata: "TWELVEDATA_API_KEY",
  upstox: "UPSTOX_ACCESS_TOKEN",
  fred: "FRED_API_KEY",
  gdelt: null, // free, no API key required
  sec: null,   // SEC EDGAR — official, no key
  yahoo: null, // Yahoo quoteSummary — unofficial, no key
  webull: null, // Webull MCP — OAuth token in vault, not an env key
};

// Decode a JWT's `exp` (seconds) without verifying — only for showing an expiry
// countdown for token credentials (Upstox). Returns null for non-JWT keys.
function jwtExpiryIso(token: string | undefined): string | null {
  if (!token || token.split(".").length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    return typeof payload.exp === "number" ? new Date(payload.exp * 1000).toISOString() : null;
  } catch { return null; }
}

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;

  const svc = createServiceClient();
  const cfg = providerConfig();
  const today = new Date().toISOString().slice(0, 10);

  // FinancialDatasets key may live in the vault rather than env — check both,
  // instead of assuming it's present (the scanner silently returns no
  // candidates if the key is actually missing).
  let fdKeyPresent = !!process.env.FINANCIAL_DATASETS_API_KEY;
  if (!fdKeyPresent) {
    try {
      const { data } = await svc.from("api_key_vault").select("key_value").eq("key_name", "FINANCIAL_DATASETS_API_KEY").maybeSingle();
      fdKeyPresent = !!(data as any)?.key_value;
    } catch { /* leave false */ }
  }

  const [{ data: todayRows }, { data: avgRows }] = await Promise.all([
    svc.from("provider_budget").select("provider, calls").eq("cache_date", today),
    svc.from("provider_budget_7d").select("provider, avg_calls_7d, peak_calls_7d, days_seen"),
  ]);
  const todayByProv = new Map((todayRows ?? []).map((r: any) => [r.provider, r.calls]));
  const avgByProv = new Map((avgRows ?? []).map((r: any) => [r.provider, r]));

  const providers = (Object.keys(cfg) as ProviderId[]).map((id) => {
    const c = cfg[id];
    const envName = KEY_ENV[id];
    const keyVal = envName ? process.env[envName] : undefined;
    const keyPresent = id === "financialdatasets" ? fdKeyPresent : !!keyVal;
    const expiresAt = jwtExpiryIso(keyVal);
    const daysToExpiry = expiresAt ? Math.round((new Date(expiresAt).getTime() - Date.now()) / 86400000) : null;
    const todayCalls = Number(todayByProv.get(id) ?? 0);
    const avg = avgByProv.get(id) as any;
    const avg7d = Number(avg?.avg_calls_7d ?? 0);
    const limit = c.dailyBudget; // null = no daily cap (rate-limited only)
    const headroom = limit != null ? Math.max(0, limit - todayCalls) : null;
    const pctUsed = limit != null && limit > 0 ? Math.round((todayCalls / limit) * 100) : null;

    return {
      id, label: c.label,
      keyPresent,
      limit,                         // daily cap or null (rate-limited)
      todayCalls,
      avg7d,
      peak7d: Number(avg?.peak_calls_7d ?? 0),
      headroom,
      pctUsed,                       // % of daily cap used today (null if uncapped)
      expiresAt, daysToExpiry,       // credential expiry (null = never)
    };
  });

  // Bottleneck = capped provider closest to its ceiling (highest pctUsed today).
  const capped = providers.filter((p) => p.pctUsed != null);
  const bottleneck = capped.length ? capped.reduce((a, b) => (b.pctUsed! > a.pctUsed! ? b : a)) : null;

  return NextResponse.json({
    providers,
    bottleneck: bottleneck ? { id: bottleneck.id, label: bottleneck.label, pctUsed: bottleneck.pctUsed } : null,
    as_of: new Date().toISOString(),
  });
}
