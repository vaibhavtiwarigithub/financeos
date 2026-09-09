// Manual Trade Guardian — Stage 0: detection + ledger + alert only.
// Spec: features/manual-trade-guardian/FEATURE_ARCHITECTURE.md.
//
// POST /api/agents/manual-fill-detect/cron (cron-secret gated)
//
// Scoped to 605420660 ONLY (the one order-permitted account, per CLAUDE.md /
// docs/arch/08 account allowlist). Every run:
//   1. fetches live Robinhood positions for that account (reuses
//      fetchRobinhoodBrokerAccounts — the same call holding-risk already makes,
//      not a second implementation);
//   2. diffs against the last known qty per symbol in agentic_position_ledger;
//   3. a qty increase with no matching broker_orders row for that symbol/window
//      is tagged source='manual'; one that matches an existing Kairos order is
//      tagged source='agentic'. Both get a ledger row regardless — the ledger
//      exists to answer "manual vs app" even when no stop is ever suggested.
//   4. a NEW manual position additionally gets a suggested stop price (mandate
//      stop_loss_pct off the live avg cost — the same source paper entries use)
//      and raises a warn-level agent_alerts row naming it.
//
// THIS ROUTE PLACES NO ORDER. Suggesting a stop is not placing one — Stage 0
// is alert-only by design (see the doc's Section 2.3: approval, never silent
// placement). Stage 1 (the approval-card UI wired to the existing
// trade_proposals approve→place path) is separate, unbuilt work.

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { fetchRobinhoodBrokerAccounts } from "@/lib/brokers";
import { loadTradingMandate } from "@/lib/trading-mandate";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import { detectManualFills, type RecentOrderInput } from "@/lib/trading/manual-fill-detection";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The ONLY account this route ever looks at or writes for. Hard-coded, not
// read from config — matches the CHECK constraint on agentic_position_ledger
// itself, so a config mistake can't widen this to another account.
const AGENTIC_ACCOUNT_ID = "605420660";

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const svc = createServiceClient();

  const accounts = await fetchRobinhoodBrokerAccounts();
  const account = accounts.find(a => a.accountId === AGENTIC_ACCOUNT_ID);
  if (!account) {
    await reportIssue({
      issueKey: "manual-trade-guardian:account-unavailable",
      severity: "warn", category: "broker",
      title: "Manual Trade Guardian could not read the agentic Robinhood account",
      detail: `fetchRobinhoodBrokerAccounts() returned no account matching ${AGENTIC_ACCOUNT_ID}. Detection skipped this run — check Webull/Robinhood connection status.`,
      autoExpireAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
    });
    return NextResponse.json({ ok: false, error: "agentic account not available" });
  }
  if (account.error) {
    await reportIssue({
      issueKey: "manual-trade-guardian:account-unavailable",
      severity: "warn", category: "broker",
      title: "Manual Trade Guardian: agentic account read failed",
      detail: account.error,
      autoExpireAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
    });
    return NextResponse.json({ ok: false, error: account.error });
  }
  await resolveIssue("manual-trade-guardian:account-unavailable", svc);

  // Last known qty per symbol this feature itself has recorded — the ledger
  // is the diff baseline, not paper_positions or broker_orders (those track a
  // different thing: what Kairos itself has done, not "what did we last see
  // live"). One row per symbol, most recent by detected_at.
  const { data: lastKnownRows, error: ledgerErr } = await svc
    .from("agentic_position_ledger")
    .select("symbol, qty, detected_at")
    .eq("account_id", AGENTIC_ACCOUNT_ID)
    .order("detected_at", { ascending: false });
  if (ledgerErr) throw new Error(`agentic_position_ledger read failed: ${ledgerErr.message}`);

  const lastKnownQty = new Map<string, number>();
  for (const row of (lastKnownRows ?? []) as { symbol: string; qty: number }[]) {
    if (!lastKnownQty.has(row.symbol)) lastKnownQty.set(row.symbol, Number(row.qty));
  }

  // Open Kairos-placed orders in the lookback window — a qty increase
  // matching one of these is OUR fill, not a manual one. Window matches the
  // detection cadence (15 min) with slack for a slow reconcile.
  //
  // broker_orders has NO account column. broker='robinhood' + market='us' is
  // the correct filter here — 605420660 is the ONLY order-permitted account in
  // this codebase (hard invariant, not config), so every filled live
  // Robinhood order in this table already belongs to it.
  const since = new Date(Date.now() - 3 * 3600_000).toISOString();
  const { data: recentOrders, error: ordersErr } = await svc
    .from("broker_orders")
    .select("id, symbol, side, filled_qty, status, submitted_at")
    .eq("broker", "robinhood")
    .eq("market", "us")
    .in("status", ["filled", "partially_filled"])
    .gte("submitted_at", since);
  if (ordersErr) throw new Error(`broker_orders read failed: ${ordersErr.message}`);

  const mandate = await loadTradingMandate(svc, "us");
  const stopLossPct = mandate.stop_loss_pct;

  const recentOrderInputs: RecentOrderInput[] = (recentOrders ?? []).map((o: any) => ({
    id: o.id, symbol: o.symbol, side: o.side, filledQty: Number(o.filled_qty),
  }));
  const { rowsToInsert, manualDetections } = detectManualFills(
    AGENTIC_ACCOUNT_ID,
    account.holdings.map(h => ({ symbol: h.symbol, qty: h.qty, currentPrice: h.currentPrice, costBasis: h.costBasis })),
    lastKnownQty,
    recentOrderInputs,
    stopLossPct,
  );

  if (rowsToInsert.length > 0) {
    const { error: insErr } = await svc.from("agentic_position_ledger").insert(rowsToInsert);
    if (insErr) throw new Error(`agentic_position_ledger insert failed: ${insErr.message}`);
  }

  // One alert per manual fill still open, not one per run — each carries its
  // own issueKey so multiple simultaneous manual buys don't collide into a
  // single alert that only names the last one.
  for (const d of manualDetections) {
    await reportIssue({
      issueKey: `manual-trade-guardian:${d.symbol}:${AGENTIC_ACCOUNT_ID}`,
      severity: "warn", category: "broker",
      title: `Manual buy detected: ${d.qty} ${d.symbol} — suggested stop $${d.suggestedStop}`,
      detail: `A manual Robinhood buy of ${d.symbol} on account ${AGENTIC_ACCOUNT_ID} was not placed by Kairos. Suggested protective stop: $${d.suggestedStop} (${stopLossPct}% below avg cost, per the US trading mandate — the same source PaperTrader uses for a new entry). This is a SUGGESTION ONLY, per Stage 0 of features/manual-trade-guardian/FEATURE_ARCHITECTURE.md — no order has been placed. Robinhood has no native stop order; if you approve this in a future Stage 1 UI, Kairos would watch the price itself and submit a market/limit sell on breach, the same mechanism PositionMonitor already uses for paper positions.`,
      autoExpireAt: new Date(Date.now() + 14 * 24 * 3600_000).toISOString(),
    });
  }

  return NextResponse.json({
    ok: true,
    accountId: AGENTIC_ACCOUNT_ID,
    holdingsChecked: account.holdings.length,
    ledgerRowsWritten: rowsToInsert.length,
    manualFillsDetected: manualDetections.length,
    manualFills: manualDetections,
  });
}
