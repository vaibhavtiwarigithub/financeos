import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { fetchSymbolProfile, PROFILE_TTL_DAYS, type ProfileMarket } from "@/lib/data/symbol-profile";
import { isIndia } from "@/lib/india-data";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST /api/agents/symbol-profiles/backfill?market=us|india&limit=<n>
//
// Fills symbol_profiles for watchlist symbols that lack a FRESH (<30d) profile,
// and backfills watchlist.company_name where null. Bounded by a wall-clock budget
// so it never blows maxDuration (mirrors the research cron pattern). Idempotent:
// fresh profiles are skipped; the budget re-defers the rest to the next run.
//
// Auth: owner session OR x-cron-secret (service-to-service). DISPLAY-ONLY feature,
// off the money path.
export async function POST(req: NextRequest) {
  const routeStartedAt = Date.now();

  // Dual gate: cron secret first (for scheduled/service calls), else owner session.
  if (!verifyCronSecret(req)) {
    const gate = await requireOwner();
    if (gate) return gate;
  }

  const sp = req.nextUrl.searchParams;
  const mktParam = sp.get("market");
  const marketScope: ProfileMarket | null = mktParam === "india" ? "india" : mktParam === "us" ? "us" : null;

  const limitParam = Number.parseInt(sp.get("limit") ?? "", 10);
  const maxSymbols = Number.isFinite(limitParam) ? Math.min(200, Math.max(1, limitParam)) : 60;

  // Wall-clock budget — stop starting new symbols once this elapses, leaving
  // headroom inside maxDuration for the response. Configurable via env.
  const configuredBudget = Number(process.env.SYMBOL_PROFILE_BUDGET_MS ?? 90_000);
  const BUDGET_MS = Number.isFinite(configuredBudget) ? Math.min(105_000, Math.max(10_000, configuredBudget)) : 90_000;
  const deadline = routeStartedAt + BUDGET_MS;

  const svc = createServiceClient();
  const nowIso = new Date().toISOString();

  // Candidate universe: non-expired watchlist symbols, scoped to the market.
  let wq = svc
    .from("watchlist")
    .select("symbol, company_name, market")
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`);
  if (marketScope === "india") wq = wq.eq("market", "india");
  else if (marketScope === "us") wq = wq.in("market", ["us", "US", "Global", "Crypto"]);
  const { data: wlRows, error: wlErr } = await wq;
  if (wlErr) return NextResponse.json({ error: wlErr.message }, { status: 500 });

  // Dedupe by (symbol, resolved market).
  const seen = new Set<string>();
  const candidates: { symbol: string; market: ProfileMarket; companyNameNull: boolean }[] = [];
  for (const row of wlRows ?? []) {
    const symbol = String((row as any).symbol ?? "").toUpperCase();
    if (!symbol) continue;
    // The stored market is authoritative. Suffix inference is only a compatibility
    // fallback for older rows; bare India symbols must never be backfilled as US.
    const rowMarket = String((row as any).market ?? "").toLowerCase();
    const market: ProfileMarket = rowMarket === "india" || isIndia(symbol) ? "india" : "us";
    const key = `${symbol}::${market}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ symbol, market, companyNameNull: (row as any).company_name == null });
  }

  // Which of these already have a FRESH profile? One batched read, then skip them.
  const freshKeys = new Set<string>();
  if (candidates.length > 0) {
    const staleBefore = new Date(Date.now() - PROFILE_TTL_DAYS * 86400000).toISOString();
    const { data: existing } = await svc
      .from("symbol_profiles")
      .select("symbol, market, updated_at")
      .in("symbol", candidates.map((c) => c.symbol))
      .gte("updated_at", staleBefore);
    for (const p of (existing ?? []) as any[]) {
      freshKeys.add(`${String(p.symbol).toUpperCase()}::${p.market}`);
    }
  }

  const todo = candidates.filter((c) => !freshKeys.has(`${c.symbol}::${c.market}`)).slice(0, maxSymbols);

  let filled = 0;
  let watchlistNamesBackfilled = 0;
  let errors = 0;
  let deferred = 0;

  for (const c of todo) {
    if (Date.now() >= deadline) { deferred = todo.length - (filled + errors); break; }
    try {
      const profile = await fetchSymbolProfile(c.symbol, c.market);
      const row = { ...profile, updated_at: new Date().toISOString() };
      const { error: upErr } = await svc.from("symbol_profiles").upsert(row, { onConflict: "symbol,market" });
      if (upErr) { errors++; continue; }
      filled++;

      // Backfill watchlist.company_name where null (idempotent — only when null).
      if (c.companyNameNull && profile.company_name) {
        const { error: wErr } = await svc
          .from("watchlist")
          .update({ company_name: profile.company_name, updated_at: new Date().toISOString() })
          .eq("symbol", c.symbol)
          .is("company_name", null);
        if (!wErr) watchlistNamesBackfilled++;
      }
    } catch {
      errors++;
    }
  }

  return NextResponse.json({
    success: true,
    market: marketScope ?? "all",
    candidates: candidates.length,
    skippedFresh: candidates.length - todo.length,
    attempted: filled + errors,
    filled,
    watchlistNamesBackfilled,
    errors,
    deferred,
  });
}
