// Daily Per-Holding Risk Analytics — read API.
//
// Spec: features/holding-risk-daily/FEATURE_ARCHITECTURE.md.
//
// GET /api/portfolio/risk-daily?market=us|india[&accountId=...]
//
// Owner-gated: the authenticated client and owner-email RLS scope risk rows.
// Only after a visible run is found, a service client reads the latest broker
// nickname for presentation; raw snapshot rows are not returned and account IDs
// remain authenticated request keys rather than visible labels. Returns only
// COMPLETE runs.
//
//   • without accountId → one latest-complete run per account (for the account tabs),
//     never aggregated across accounts and never summed across currencies.
//   • with accountId    → { latest, previous } detail for that account, where
//     `previous` is the prior complete run with the SAME formula_version (no
//     cross-formula-version diffing) so the UI can show honest Δ-vs-yesterday.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  buildResearchBlock,
  indexLatestSignals,
  researchKey,
  type ResearchSignalRow,
} from "@/lib/research/risk-annotation";
import { effectiveHoldingRiskPosture } from "@/lib/risk/holding-risk-history";
import { createServiceClient } from "@/lib/supabase/service";
import { brokerAccountDisplayLabel, brokerAccountKey, loadLatestBrokerNicknames } from "@/lib/brokers/account-label";

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
      .order("completed_at", { ascending: false })
      .limit(200);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Keep the newest complete run per account_id (rows already sorted desc).
    const byAccount = new Map<string, RunRow>();
    for (const r of (runs ?? []) as RunRow[]) {
      if (!byAccount.has(r.account_id)) byAccount.set(r.account_id, r);
    }
    const latestNicknames = await loadLatestBrokerNicknames(
      createServiceClient(),
      Array.from(byAccount.values()).map((r) => ({ broker: r.broker, accountId: r.account_id })),
    );
    return NextResponse.json({
      market,
      accounts: Array.from(byAccount.values()).map(r => ({
        accountId: r.account_id,
        label: r.broker === "internal" ? "Paper Portfolio" : brokerAccountDisplayLabel({
          broker: r.broker,
          accountId: r.account_id,
          nickname: latestNicknames.get(brokerAccountKey(r.broker, r.account_id)),
        }),
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
    .order("completed_at", { ascending: false })
    .limit(30);
  if (runsErr) return NextResponse.json({ error: runsErr.message }, { status: 500 });

  const rows = (runs ?? []) as RunRow[];
  const latest = rows[0] ?? null;
  if (!latest) {
    return NextResponse.json({ market, accountId, latest: null, previous: null });
  }
  // Previous = first older run sharing the SAME formula_version (never diff across versions).
  const previous = rows.find(r =>
    r.id !== latest.id
    && r.formula_version === latest.formula_version
    && r.captured_on < latest.captured_on,
  ) ?? null;

  const latestNicknames = await loadLatestBrokerNicknames(
    createServiceClient(),
    [{ broker: latest.broker, accountId: latest.account_id }],
  );

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

  // ── Research annotation — a DISPLAY JOIN. It does not, and must not, touch risk ──
  //
  // Nothing below is read by `computeHoldingRisk` or `sba-v1`: those already ran
  // when the cron wrote the snapshot, and their output is replayed verbatim from
  // the table. This only ATTACHES a nullable block to rows that are already final.
  // Invariant R1 (features/risk-research-visibility/FEATURE_ARCHITECTURE.md §2);
  // T1 pins it. See also: the age is the feature, not the score — on 2026-07-16
  // AVGO was 6 days unscored while this very table said "trim".
  //
  // FAIL-SOFT: risk is the product, research is the annotation. If agent_signals
  // errors, the risk table STILL renders and the column says so explicitly —
  // never a silent blank, never a fake score. T8 pins it.
  //
  // RLS CAVEAT — the one failure this cannot see. This uses the AUTHENTICATED
  // user's client, and `agent_signals` carries an `authenticated_only` policy
  // (auth.role() = 'authenticated'), verified in prod 2026-07-17, so the owner
  // reads it fine. But an RLS denial is NOT an error: it returns zero rows. If
  // that policy is ever tightened, this join would silently report every holding
  // as `never` scored — which is precisely the class of confident-looking lie
  // this feature exists to remove. If you change RLS on agent_signals, revisit
  // this: a `never` for the WHOLE book is a symptom, not a fact.
  const latestSymbols = Array.from(new Set(
    (snapsByRun.get(latest.id) ?? []).map((s: any) => s.symbol).filter((s: any): s is string => typeof s === "string"),
  ));

  let researchByKey = new Map<string, ResearchSignalRow>();
  let researchAvailable = true;
  let researchUnavailableReason: string | null = null;

  if (latestSymbols.length > 0) {
    // Join on (symbol, market) — NEVER symbol alone. `market` is the validated
    // query param, so an India `.NS` book can only ever resolve against
    // market='india' rows. T6 pins no US/India cross-join.
    const { data: sigs, error: sigErr } = await supabase
      .from("agent_signals")
      .select("symbol,market,analyst_score,direction,created_at,is_holding")
      .eq("market", market)
      // Match the same canonical cohort every trade consumer trusts. Weekend
      // staged and LLM-advisory rows may be useful elsewhere, but must not look
      // like the current validated research verdict beside live holdings.
      .eq("score_source", "deterministic_v1")
      .eq("session_validated", true)
      .in("symbol", latestSymbols)
      .order("created_at", { ascending: false });

    if (sigErr) {
      researchAvailable = false;
      researchUnavailableReason = sigErr.message;
    } else {
      researchByKey = indexLatestSignals((sigs ?? []) as ResearchSignalRow[]);
    }
  }

  const now = new Date();

  const pack = (r: RunRow | null) => r == null ? null : {
    runId: r.id,
    capturedOn: r.captured_on,
    currency: r.currency,
    broker: r.broker,
    accountLabel: r.broker === "internal" ? "Paper Portfolio" : brokerAccountDisplayLabel({
      broker: r.broker,
      accountId: r.account_id,
      nickname: latestNicknames.get(brokerAccountKey(r.broker, r.account_id)),
    }),
    sourceCapturedAt: r.source_captured_at,
    completedAt: r.completed_at,
    formulaVersion: r.formula_version,
    dataConfidence: r.data_confidence,
    missingInputs: r.missing_inputs ?? [],
    account: acctByRun.get(r.id) ?? null,
    holdings: (snapsByRun.get(r.id) ?? [])
      .sort((a, b) => (b.holding_risk_score ?? -1) - (a.holding_risk_score ?? -1))
      // Annotate the LATEST run only. `previous` exists solely to compute the
      // Δ-vs-yesterday risk score; annotating it would imply a research history
      // this join does not model.
      .map((s: any) => {
        const effective = effectiveHoldingRiskPosture(s.risk_posture, s.action_reason, r.formula_version);
        const stored = {
          ...s,
          risk_posture: effective.posture,
          source_risk_posture: effective.sourcePosture,
          action_reason: effective.reason,
        };
        return r.id !== latest.id ? stored : {
        ...stored,
        // Additive and nullable. `null` = the research read failed (fail-soft);
        // a block with state 'never' = the read succeeded and found nothing.
        // Those are different facts and the UI renders them differently.
        research: researchAvailable
          ? buildResearchBlock(researchByKey.get(researchKey(s.symbol, market)), now, market)
          : null,
      };
      }),
    // Run-level honesty flag: distinguishes "research read failed" from "research
    // read fine, this symbol has no signal". Never let absence look like a score.
    researchAvailable,
    researchUnavailableReason,
  };

  return NextResponse.json({
    market,
    accountId,
    latest: pack(latest),
    previous: pack(previous),
  });
}
