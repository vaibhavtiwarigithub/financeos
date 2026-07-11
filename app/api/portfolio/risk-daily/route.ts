// Daily Per-Holding Risk Analytics — read API.
//
// Spec: features/holding-risk-daily/FEATURE_ARCHITECTURE.md.
//
// GET /api/portfolio/risk-daily?market=us|india[&accountId=...]
//
// Owner-gated: this uses the AUTHENTICATED user's Supabase client, so the
// owner-email RLS policy on holding_risk_* is what actually scopes the rows — no
// service-role read here. Returns only COMPLETE runs.
//
//   • without accountId → one latest-complete run per account (for the account tabs),
//     never aggregated across accounts and never summed across currencies.
//   • with accountId    → { latest, previous } detail for that account, where
//     `previous` is the prior complete run with the SAME formula_version (no
//     cross-formula-version diffing) so the UI can show honest Δ-vs-yesterday.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RunRow {
  id: string;
  captured_on: string;
  market: string;
  currency: string;
  broker: string;
  account_id: string;
  account_label: string | null;
  status: string;
  source_captured_at: string | null;
  completed_at: string | null;
  formula_version: string;
  data_confidence: number | null;
  missing_inputs: string[] | null;
}

const RUN_COLS =
  "id,captured_on,market,currency,broker,account_id,account_label,status,source_captured_at,completed_at,formula_version,data_confidence,missing_inputs";

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const marketParam = req.nextUrl.searchParams.get("market");
  if (marketParam !== "us" && marketParam !== "india") {
    return NextResponse.json({ error: "invalid_market: expected market=us|india" }, { status: 400 });
  }
  const market = marketParam;
  const accountId = req.nextUrl.searchParams.get("accountId");

  // ── No account → one latest-complete run per account (tab list) ───────────────
  if (!accountId) {
    const { data: runs, error } = await supabase
      .from("holding_risk_runs")
      .select(RUN_COLS)
      .eq("market", market)
      .eq("status", "complete")
      .order("captured_on", { ascending: false })
      .limit(200);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Keep the newest complete run per account_id (rows already sorted desc).
    const byAccount = new Map<string, RunRow>();
    for (const r of (runs ?? []) as RunRow[]) {
      if (!byAccount.has(r.account_id)) byAccount.set(r.account_id, r);
    }
    return NextResponse.json({
      market,
      accounts: Array.from(byAccount.values()).map(r => ({
        accountId: r.account_id,
        label: r.account_label,
        broker: r.broker,
        currency: r.currency,
        capturedOn: r.captured_on,
        sourceCapturedAt: r.source_captured_at,
        completedAt: r.completed_at,
        formulaVersion: r.formula_version,
        dataConfidence: r.data_confidence,
      })),
    });
  }

  // ── Account detail: latest + previous (same formula_version) ──────────────────
  const { data: runs, error: runsErr } = await supabase
    .from("holding_risk_runs")
    .select(RUN_COLS)
    .eq("market", market)
    .eq("account_id", accountId)
    .eq("status", "complete")
    .order("captured_on", { ascending: false })
    .limit(30);
  if (runsErr) return NextResponse.json({ error: runsErr.message }, { status: 500 });

  const rows = (runs ?? []) as RunRow[];
  const latest = rows[0] ?? null;
  if (!latest) {
    return NextResponse.json({ market, accountId, latest: null, previous: null });
  }
  // Previous = first older run sharing the SAME formula_version (never diff across versions).
  const previous = rows.find(r => r.id !== latest.id && r.formula_version === latest.formula_version) ?? null;

  const runIds = [latest.id, ...(previous ? [previous.id] : [])];

  const [{ data: snaps, error: snapErr }, { data: accts, error: acctErr }] = await Promise.all([
    supabase
      .from("holding_risk_snapshots")
      .select("run_id,symbol,sector,source,qty,current_price,average_cost,market_value,weight_pct,beta,realized_vol_pct,unrealized_pnl_pct,holding_risk_score,risk_label,risk_drivers,risk_posture,action_reason,add_capacity,data_confidence,missing_inputs,strategy_note")
      .in("run_id", runIds),
    supabase
      .from("account_risk_snapshots")
      .select("run_id,metrics,total_value,data_confidence,missing_inputs")
      .in("run_id", runIds),
  ]);
  if (snapErr) return NextResponse.json({ error: snapErr.message }, { status: 500 });
  if (acctErr) return NextResponse.json({ error: acctErr.message }, { status: 500 });

  const snapsByRun = new Map<string, any[]>();
  for (const s of (snaps ?? []) as any[]) {
    const arr = snapsByRun.get(s.run_id);
    if (arr) arr.push(s); else snapsByRun.set(s.run_id, [s]);
  }
  const acctByRun = new Map<string, any>();
  for (const a of (accts ?? []) as any[]) acctByRun.set(a.run_id, a);

  const pack = (r: RunRow | null) => r == null ? null : {
    runId: r.id,
    capturedOn: r.captured_on,
    currency: r.currency,
    broker: r.broker,
    accountLabel: r.account_label,
    sourceCapturedAt: r.source_captured_at,
    completedAt: r.completed_at,
    formulaVersion: r.formula_version,
    dataConfidence: r.data_confidence,
    missingInputs: r.missing_inputs ?? [],
    account: acctByRun.get(r.id) ?? null,
    holdings: (snapsByRun.get(r.id) ?? []).sort((a, b) =>
      (b.holding_risk_score ?? -1) - (a.holding_risk_score ?? -1)),
  };

  return NextResponse.json({
    market,
    accountId,
    latest: pack(latest),
    previous: pack(previous),
  });
}
