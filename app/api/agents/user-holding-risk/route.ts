// Per-user (guest) risk analytics — compute cron.
//
// Spec: features/per-user-broker-risk/FEATURE_ARCHITECTURE.md §4.
//
// POST /api/agents/user-holding-risk?market=us|india  (cron-secret gated)
//
// One connected guest = one run. For each user with a live connection in the
// requested market we fetch their holdings with THEIR read-only credential,
// compute the deterministic risk figures, and write rows scoped to them.
//
// Invariants this route is responsible for:
//   • It never reads or writes the owner's tables. Guest output lives only in
//     `user_*` tables, so a guest position cannot enter an owner money-path
//     calculation (kill-switch NAV baseline, Guardian, paper book).
//   • Every service-role read carries an explicit `user_id` filter. RLS is the
//     backstop; the filter is the mechanism.
//   • A user who cannot be computed is recorded as `skipped` WITH A REASON —
//     expired Zerodha token, disconnected, revoked access. A money-adjacent
//     report never fails silently, and a stale token never yields yesterday's
//     numbers presented as today's.
//   • Read-only throughout: no order is placed, previewed or cancelled, and the
//     guest client has no method that could.
//   • No LLM and no metered market-data provider (see lib/risk/guest-risk.ts).
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { OWNER_EMAIL } from "@/lib/auth/owner";
import { guestReadOnlyClient } from "@/lib/brokers/guest-readonly";
import { computeGuestRisk, type GuestMarket } from "@/lib/risk/guest-risk";
import { getKiteCreds } from "@/lib/kite";
import { expectedLatestSessionDate } from "@/lib/trading/market-calendar";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Which broker serves which market. Guests connect one broker per market. */
const BROKER_FOR_MARKET: Record<GuestMarket, "kite" | "robinhood"> = {
  india: "kite",
  us: "robinhood",
};

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const market = (req.nextUrl.searchParams.get("market") ?? "india") as GuestMarket;
  if (market !== "us" && market !== "india") {
    return NextResponse.json({ error: "market must be us|india" }, { status: 400 });
  }

  const broker = BROKER_FOR_MARKET[market];
  const svc = createServiceClient();

  // Candidate users: a stored connection for this market's broker that has not
  // been disconnected. Revocation and staleness are decided per user below by
  // `loadGuestCredential`, so this is a candidate list, not an entitlement.
  const { data: rows, error } = await svc
    .from("user_broker_credentials")
    .select("user_id")
    .eq("broker", broker)
    .is("disconnected_at", null);

  if (error) {
    return NextResponse.json({ error: "could not list connections" }, { status: 500 });
  }

  const userIds: string[] = Array.from(new Set((rows ?? []).map((r: any) => String(r.user_id))));
  if (!userIds.length) {
    return NextResponse.json({ ok: true, market, users: 0, ran: 0, skipped: 0, results: [] });
  }

  const asOf = expectedLatestSessionDate(market);
  const asOfDate = asOf.date;
  const kiteApiKey = broker === "kite" ? (await getKiteCreds(svc)).apiKey ?? undefined : undefined;

  const results: Array<{ userId: string; status: string; reason?: string }> = [];

  for (const userId of userIds) {
    const started = new Date().toISOString();
    const client = await guestReadOnlyClient({ userId, broker, ownerEmail: OWNER_EMAIL, kiteApiKey });

    if ("ok" in client && client.ok === false) {
      await recordSkip(svc, userId, market, asOfDate, started, client.reason);
      results.push({ userId, status: "skipped", reason: client.reason });
      continue;
    }

    const fetched = await (client as Exclude<typeof client, { ok: false }>).holdings();
    if (!fetched.ok) {
      await recordRun(svc, {
        userId, market, asOfDate, started,
        status: "error", skipReason: fetched.error, summary: null,
      });
      results.push({ userId, status: "error", reason: fetched.error });
      continue;
    }

    if (!fetched.holdings.length) {
      await recordSkip(svc, userId, market, asOfDate, started, "no_holdings");
      results.push({ userId, status: "skipped", reason: "no_holdings" });
      continue;
    }

    try {
      const risk = await computeGuestRisk(fetched.holdings, market);

      // Snapshot the input separately from the output, so a later question about
      // a figure can be answered against the holdings it was computed from.
      await svc.from("user_account_snapshots").insert({
        user_id: userId,
        broker,
        market,
        captured_at: started,
        as_of_date: asOfDate,
        currency: risk.metrics.currency,
        nav: risk.metrics.totalValue,
        holdings: fetched.holdings as unknown as Record<string, unknown>[],
      });

      const runId = await recordRun(svc, {
        userId, market, asOfDate, started,
        status: "ok",
        skipReason: null,
        summary: {
          totalValue: risk.metrics.totalValue,
          holdingCount: risk.metrics.holdingCount,
          portfolioBeta: risk.metrics.portfolioBeta,
          var95_dollar: risk.metrics.var95_dollar,
          var95_pct: risk.metrics.var95_pct,
          maxDrawdownEst: risk.metrics.maxDrawdownEst,
          riskScore: risk.metrics.riskScore,
          riskLabel: risk.metrics.riskLabel,
          currency: risk.metrics.currency,
          sectorBreakdown: risk.metrics.sectorBreakdown,
          warnings: risk.metrics.warnings,
          // Recorded on every run so coverage is an observable fact rather than
          // an assumption: these are the held symbols the UNMETERED source could
          // not serve, whose correlation evidence is therefore missing.
          coverage: risk.coverage,
        },
      });

      if (runId) {
        const snapshots = risk.metrics.holdings.map((h) => ({
          run_id: runId,
          user_id: userId,
          market,
          symbol: h.symbol,
          as_of_date: asOfDate,
          metrics: {
            quantity: h.qty,
            marketValue: h.marketValue,
            weightPct: h.weightPct,
            sector: h.sector,
            beta: h.beta,
            riskContribution: h.riskContribution,
            correlation: risk.clusters[h.symbol] ?? null,
          },
        }));
        if (snapshots.length) await svc.from("user_holding_risk_snapshots").insert(snapshots);
      }

      results.push({ userId, status: "ok" });
    } catch (e: any) {
      await recordRun(svc, {
        userId, market, asOfDate, started,
        status: "error", skipReason: String(e?.message ?? e).slice(0, 300), summary: null,
      });
      results.push({ userId, status: "error", reason: "compute_failed" });
    }
  }

  return NextResponse.json({
    ok: true,
    market,
    users: userIds.length,
    ran: results.filter((r) => r.status === "ok").length,
    skipped: results.filter((r) => r.status !== "ok").length,
    // User ids only — never holdings, never figures. This response goes to a
    // scheduler log, which is not a place for anyone's positions.
    results,
  });
}

async function recordRun(
  svc: ReturnType<typeof createServiceClient>,
  p: {
    userId: string; market: GuestMarket; asOfDate: string | null; started: string;
    status: "ok" | "skipped" | "error"; skipReason: string | null;
    summary: Record<string, unknown> | null;
  },
): Promise<string | null> {
  const { data } = await svc
    .from("user_holding_risk_runs")
    .insert({
      user_id: p.userId,
      market: p.market,
      status: p.status,
      skip_reason: p.skipReason,
      as_of_date: p.asOfDate,
      started_at: p.started,
      completed_at: new Date().toISOString(),
      summary: p.summary,
    })
    .select("id")
    .maybeSingle();
  return data?.id ? String(data.id) : null;
}

function recordSkip(
  svc: ReturnType<typeof createServiceClient>,
  userId: string,
  market: GuestMarket,
  asOfDate: string | null,
  started: string,
  reason: string,
) {
  return recordRun(svc, { userId, market, asOfDate, started, status: "skipped", skipReason: reason, summary: null });
}
