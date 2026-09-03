import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { providerCachedFetch, providerConfig } from "@/lib/data/provider-fetch";
import { isEtfSymbol } from "@/lib/asset-classification";
import {
  analyzeEarningsEstimatesPayload,
  capacityScenarios,
  EARNINGS_EXPECTATIONS_CONFIRMATION,
  EARNINGS_EXPECTATIONS_CONTRACT_VERSION,
  EARNINGS_EXPECTATIONS_MAX_SYMBOLS,
  EARNINGS_EXPECTATIONS_STAGE0_VERSION,
  selectStratifiedCapabilitySample,
  summarizeCapabilityResults,
  type CapabilitySymbolResult,
  type CapabilityUniverseRow,
} from "@/lib/data/earnings-expectations-capability";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CACHE_PREFIX = "ALPHA_VANTAGE_EARNINGS_ESTIMATES:";

async function context(svc: ReturnType<typeof createServiceClient>, requestedLimit: number) {
  const today = new Date().toISOString().slice(0, 10);
  const budget = providerConfig().alpha_vantage.dailyBudget ?? 0;
  const [{ data: profiles, error: profileError }, { data: budgetRow, error: budgetError }] = await Promise.all([
    svc.from("symbol_profiles").select("symbol, market_cap_tier").eq("market", "us").order("symbol"),
    svc.from("provider_budget").select("calls").eq("provider", "alpha_vantage").eq("cache_date", today).maybeSingle(),
  ]);
  if (profileError) throw new Error(`US universe read failed: ${profileError.message}`);
  if (budgetError) throw new Error(`Alpha Vantage budget read failed: ${budgetError.message}`);

  const universe = ((profiles ?? []) as CapabilityUniverseRow[])
    .filter((row) => !isEtfSymbol(row.symbol));
  const sample = selectStratifiedCapabilitySample(universe, requestedLimit);
  const attempts = Number(budgetRow?.calls ?? 0);
  return {
    today,
    budget,
    attempts,
    remainingReservations: Math.max(0, budget - attempts),
    universe,
    sample,
  };
}

function baseReport(ctx: Awaited<ReturnType<typeof context>>) {
  return {
    generated_at: new Date().toISOString(),
    stage: "stage_0_capability_probe",
    policy_version: EARNINGS_EXPECTATIONS_STAGE0_VERSION,
    contract_version: EARNINGS_EXPECTATIONS_CONTRACT_VERSION,
    market: "us",
    influence: "measurement_only",
    limits: {
      enforced_alpha_vantage_daily_budget: ctx.budget,
      reservation_attempts_today: ctx.attempts,
      remaining_reservations_at_start: ctx.remainingReservations,
      hard_symbols_per_manual_run: EARNINGS_EXPECTATIONS_MAX_SYMBOLS,
    },
    universe: {
      symbols: ctx.universe.length,
      selected_sample: ctx.sample,
      selection: "Deterministic round-robin across mega, large, mid, small, micro and unknown market-cap tiers.",
    },
    capacity_scenarios: capacityScenarios(ctx.universe.length, ctx.budget),
    safety: [
      "Manual owner-only route; there is no cron or recurring capture.",
      "Uncached symbols are skipped when the shared Alpha Vantage reservation budget is exhausted.",
      "No estimate is written to a scored, trading, position, order, shadow or promotion table.",
      "Provider-reported trailing values are never represented as Kairos point-in-time historical vintages.",
    ],
  };
}

// GET is planning-only. It performs zero external provider calls.
export async function GET(req: NextRequest) {
  const denied = await requireOwner();
  if (denied) return denied;
  const requested = Number(req.nextUrl.searchParams.get("limit") ?? EARNINGS_EXPECTATIONS_MAX_SYMBOLS);
  const limit = Number.isFinite(requested)
    ? Math.max(1, Math.min(Math.floor(requested), EARNINGS_EXPECTATIONS_MAX_SYMBOLS))
    : EARNINGS_EXPECTATIONS_MAX_SYMBOLS;
  try {
    const ctx = await context(createServiceClient(), limit);
    return NextResponse.json({
      ...baseReport(ctx),
      mode: "plan_only",
      external_calls_made: 0,
      confirmation_required: EARNINGS_EXPECTATIONS_CONFIRMATION,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Capability plan failed." }, { status: 500 });
  }
}

// POST performs a deliberately tiny, explicitly-confirmed capability sample.
export async function POST(req: NextRequest) {
  const denied = await requireOwner();
  if (denied) return denied;

  let body: { confirmation?: unknown; limit?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "A JSON body is required." }, { status: 400 });
  }
  if (body.confirmation !== EARNINGS_EXPECTATIONS_CONFIRMATION) {
    return NextResponse.json({
      error: `Set confirmation to ${EARNINGS_EXPECTATIONS_CONFIRMATION}.`,
      note: "This explicit acknowledgement prevents accidental consumption of the shared provider budget.",
    }, { status: 400 });
  }
  const requested = Number(body.limit ?? EARNINGS_EXPECTATIONS_MAX_SYMBOLS);
  if (!Number.isInteger(requested) || requested < 1 || requested > EARNINGS_EXPECTATIONS_MAX_SYMBOLS) {
    return NextResponse.json({ error: `limit must be an integer from 1 to ${EARNINGS_EXPECTATIONS_MAX_SYMBOLS}.` }, { status: 400 });
  }
  if (!process.env.ALPHA_VANTAGE_API_KEY) {
    return NextResponse.json({ error: "Alpha Vantage is unavailable; no provider reservation was attempted." }, { status: 503 });
  }

  const svc = createServiceClient();
  try {
    const ctx = await context(svc, requested);
    const keys = ctx.sample.map((row) => `${CACHE_PREFIX}${row.symbol}`);
    const { data: cachedRows, error: cacheError } = await svc
      .from("av_cache")
      .select("cache_key")
      .in("cache_key", keys)
      .eq("cache_date", ctx.today);
    if (cacheError) throw new Error(`Alpha Vantage cache read failed: ${cacheError.message}`);
    const cached = new Set((cachedRows ?? []).map((row: { cache_key: string }) => row.cache_key));
    let remaining = ctx.remainingReservations;
    const runId = crypto.randomUUID();
    const results: CapabilitySymbolResult[] = [];
    let ledgerWriteFailures = 0;

    for (const item of ctx.sample) {
      const cacheKey = `${CACHE_PREFIX}${item.symbol}`;
      const cacheHit = cached.has(cacheKey);
      if (!cacheHit && remaining <= 0) {
        results.push(analyzeEarningsEstimatesPayload({
          symbol: item.symbol,
          marketCapTier: item.market_cap_tier,
          payload: null,
          outcome: "skipped_no_budget",
          asOf: ctx.today,
        }));
        continue;
      }

      const startedAt = new Date();
      if (!cacheHit) remaining--;
      const payload = await providerCachedFetch(
        "alpha_vantage",
        cacheKey,
        `https://www.alphavantage.co/query?function=EARNINGS_ESTIMATES&symbol=${encodeURIComponent(item.symbol)}&apikey=${process.env.ALPHA_VANTAGE_API_KEY}`,
        { timeoutMs: 10_000, maxStaleAgeDays: 0 },
      );
      const completedAt = new Date();
      const outcome = cacheHit ? "cache_hit" : payload ? "provider_success" : "unavailable";
      results.push(analyzeEarningsEstimatesPayload({
        symbol: item.symbol,
        marketCapTier: item.market_cap_tier,
        payload,
        outcome,
        asOf: ctx.today,
      }));

      const { error: ledgerError } = await svc.from("provider_call_ledger").insert({
        provider: "alpha_vantage",
        intent: "earnings_expectations_stage0",
        market: "us",
        symbol: item.symbol,
        run_id: runId,
        policy_version: EARNINGS_EXPECTATIONS_STAGE0_VERSION,
        cache_outcome: cacheHit ? "fresh" : "miss",
        lease_outcome: cacheHit ? "skipped" : payload ? "completed" : "denied",
        started_at: startedAt.toISOString(),
        completed_at: completedAt.toISOString(),
        latency_ms: completedAt.getTime() - startedAt.getTime(),
        transport_status: payload ? "payload_returned" : "no_payload",
        error_code: payload ? null : "provider_unavailable_or_budget_race",
        response_bytes: payload ? Buffer.byteLength(JSON.stringify(payload), "utf8") : 0,
        contract_version: EARNINGS_EXPECTATIONS_CONTRACT_VERSION,
      });
      if (ledgerError) ledgerWriteFailures++;
    }

    return NextResponse.json({
      ...baseReport(ctx),
      mode: "bounded_probe",
      run_id: runId,
      summary: summarizeCapabilityResults(results),
      results,
      audit: {
        provider_call_ledger_rows_expected: results.filter((row) => row.outcome !== "skipped_no_budget").length,
        provider_call_ledger_write_failures: ledgerWriteFailures,
      },
      decision: "Stage 0 evidence only. This response does not authorize Stage 1 capture or any shadow/scoring use.",
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Capability probe failed." }, { status: 500 });
  }
}
