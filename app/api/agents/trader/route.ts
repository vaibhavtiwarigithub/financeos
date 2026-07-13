import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { loadTradingMandate } from "@/lib/trading-mandate";
import { createServiceClient } from "@/lib/supabase/service";
import { getQuote, computeFillPrice } from "@/lib/data/quotes";
import { checkKillSwitches } from "@/lib/kill-switches";
import { guardOrderRequest } from "@/lib/request-guards";
import { notifyTradeAction } from "@/lib/trade-notify";
import { sendTradeAlertEmail } from "@/lib/trade-alert";
import { positionSizePct as kellyPositionSizePct } from "@/lib/risk/sizing";
import { verifyCronSecret } from "@/lib/auth/cron";
import { isPaused } from "@/lib/market-controls";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// SAFETY: account number HARDCODED — never read from env or request.
// Must match CONNECTIONS.md and migration 037 default.
const AGENTIC_ACCOUNT = "605420660";
// Proposal expires after 30 min — stale price cannot be used
const PROPOSAL_EXPIRY_MINUTES = 30;

// GET: list pending proposals for user review
export async function GET() {
  try {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const supabase = createServiceClient();
    const { data } = await supabase
      .from("trade_proposals")
      .select("*")
      .in("status", ["pending_review", "approved", "submitted"])
      .order("created_at", { ascending: false })
      .limit(20);

    return NextResponse.json({ proposals: data ?? [] });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

// POST: create proposals from qualifying signals, OR approve/reject an existing proposal
export async function POST(req: NextRequest) {
  const supabase = createServiceClient();

  const isCron = verifyCronSecret(req);

  // Approving a proposal is the precondition for the owner-gated live Gateway
  // submit — so non-cron callers must be the OWNER, not just any authenticated
  // user. (Cron can only trigger proposal GENERATION; the check below blocks
  // cron from approve/reject.)
  if (!isCron) {
    const gate = await requireOwner();
    if (gate) return gate;
  }

  // Block DNS rebinding + CSRF on order-placing routes
  const guardError = guardOrderRequest(req);
  if (guardError) return guardError;

  const body = await req.json().catch(() => ({}));
  const { action, proposal_id } = body as { action?: string; proposal_id?: number };

  // SAFETY: cron credential can only trigger proposal generation — never approve or reject
  if (isCron && (action === "approve" || action === "reject")) {
    return NextResponse.json({ error: "Cron credential cannot approve or reject proposals — requires authenticated user session" }, { status: 403 });
  }

  // ── Action: user approves a proposal ──────────────────────────────────────
  if (action === "approve" && proposal_id) {
    return handleApproval(supabase, proposal_id);
  }

  // ── Action: user rejects a proposal ───────────────────────────────────────
  if (action === "reject" && proposal_id) {
    const reason = (body as any).reason ?? "Rejected by user";
    await supabase.from("trade_proposals").update({
      status: "rejected",
      rejected_at: new Date().toISOString(),
      rejection_reason: reason,
    }).eq("id", proposal_id).eq("status", "pending_review");
    return NextResponse.json({ success: true, action: "rejected" });
  }

  // ── Action: cron or manual trigger — build proposals from qualifying signals ──
  return buildProposals(supabase, isCron);
}

async function buildProposals(supabase: any, isCron: boolean) {
  try {
    // Kill-switch check (paper trader — builds paper proposals)
    const ks = await checkKillSwitches(supabase, { market: "us", book: "paper" });
    if (!ks.safe) {
      return NextResponse.json({ skipped: true, reason: ks.reason });
    }

    const { data: cfg } = await supabase
      .from("strategy_config")
      .select("trading_enabled, trading_mode, broker, score_threshold, position_size_pct, stop_loss_pct, target_pct")
      .limit(1)
      .single();

    if (await isPaused(supabase, "us")) {
      return NextResponse.json({ skipped: true, reason: "App is paused" });
    }
    // Support both old trading_enabled boolean and new trading_mode tristate
    const tradingMode = (cfg as any)?.trading_mode ?? ((cfg as any)?.trading_enabled ? "manual" : "disabled");
    if (tradingMode === "disabled") {
      return NextResponse.json({ skipped: true, reason: "trading_mode = disabled — set to manual in Settings → Agents to generate proposals" });
    }

    const tradingMandate = await loadTradingMandate(supabase, "us");
    const baseThreshold = tradingMandate.score_threshold;
    const positionSizePct = (cfg as any)?.position_size_pct ?? 10;

    // MacroSentinel: elevate score threshold when regime is stressed
    // danger_score 0-100: GREEN<40, YELLOW 40-59, ORANGE 60-79, RED≥80
    let macroWarning: string | null = null;
    let scoreThreshold = baseThreshold;
    try {
      const { data: macro } = await supabase
        .from("macro_regime")
        .select("danger_score, regime")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      if (macro) {
        const ds: number = (macro as any).danger_score ?? 0;
        const label: string = (macro as any).regime ?? "UNKNOWN";
        if (ds >= 80) {
          // RED: hard suppress — proposals require much higher conviction
          scoreThreshold = Math.min(95, baseThreshold + 20);
          macroWarning = `MacroSentinel RED (danger ${ds}/100): threshold raised ${baseThreshold}→${scoreThreshold}`;
        } else if (ds >= 60) {
          // ORANGE: raise threshold, add warning
          scoreThreshold = Math.min(90, baseThreshold + 10);
          macroWarning = `MacroSentinel ORANGE (danger ${ds}/100, ${label}): threshold raised ${baseThreshold}→${scoreThreshold}`;
        } else if (ds >= 40) {
          // YELLOW: mild raise
          scoreThreshold = baseThreshold + 5;
          macroWarning = `MacroSentinel YELLOW (danger ${ds}/100): threshold raised ${baseThreshold}→${scoreThreshold}`;
        }
      }
    } catch { /* macro table may not have data yet — proceed with base threshold */ }

    // Only signals not already proposed in the last 24h
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: existingProposals } = await supabase
      .from("trade_proposals")
      .select("signal_id")
      .eq("market", "us")
      .gte("created_at", since);
    const alreadyProposed = new Set((existingProposals ?? []).map((p: any) => p.signal_id));

    // Qualify: long, high score, not yet paper or live traded
    const { data: signals } = await supabase
      .from("agent_signals")
      .select("*")
      .eq("market", "us")
      .eq("direction", "long")
      .eq("status", "pending")
      .gte("analyst_score", scoreThreshold)
      // Positive allowlist: ONLY the versioned deterministic source is trade-eligible.
      // The prior negative filter admitted null/unknown score_source (fail-open).
      .eq("score_source", "deterministic_v1")
      .order("analyst_score", { ascending: false })
      .limit(3); // max 3 proposals per run

    const created: any[] = [];
    const skipped: any[] = [];
    // NAV is fetched once per run (below) but up to 3 proposals can be created
    // in the same run — each individually passed the 15%-of-NAV check against
    // the SAME stale snapshot, so 3 proposals at 10% each looked safe alone
    // but summed to 30% of real NAV. Track this run's own allocations and
    // treat them as already-spent capital for every subsequent proposal.
    let allocatedThisRun = 0;

    // Fetch Alpha Vantage key once for earnings blackout checks
    let avKey: string | null = null;
    try {
      const { data: vaultRow } = await supabase
        .from("api_key_vault")
        .select("key_value")
        .eq("key_name", "ALPHA_VANTAGE_API_KEY")
        .single();
      avKey = (vaultRow as any)?.key_value ?? process.env.ALPHA_VANTAGE_API_KEY ?? null;
    } catch { avKey = process.env.ALPHA_VANTAGE_API_KEY ?? null; }

    // Half-Kelly position sizing: requires ≥10 closed trades; falls back to flat positionSizePct.
    // Uses the shared, correct implementation in lib/risk/sizing.ts
    // (f* = (p·R − q)/R with R = avg_win/avg_loss payoff ratio, then half).
    // The previous inline formula here was Thorp's p/a − q/b form fed
    // per-trade fractional returns, which produces leverage-scale numbers
    // (e.g. 3.25) that pegged every proposal to the positionSizePct ceiling —
    // silently defeating conviction scaling. positionSizePct here is a PERCENT,
    // so caps go in as fractions and the fraction result scales back to percent.
    let effectiveSizePct = positionSizePct;
    let kellySizingSource = "flat";
    try {
      const { data: closedTrades } = await supabase
        .from("paper_trades")
        .select("pnl_pct")
        .not("closed_at", "is", null)
        .not("pnl_pct", "is", null)
        .order("closed_at", { ascending: false })
        .limit(100);

      const pnls = (closedTrades ?? []).map((t: any) => parseFloat(t.pnl_pct));
      if (pnls.length >= 10) {
        const wins   = pnls.filter((p: number) => p > 0);
        const losses = pnls.filter((p: number) => p <= 0);
        if (wins.length > 0 && losses.length > 0) {
          const win_rate    = wins.length / pnls.length;
          const avg_win     = wins.reduce((a: number, b: number) => a + b, 0) / wins.length / 100;   // fraction
          const avg_loss    = Math.abs(losses.reduce((a: number, b: number) => a + b, 0) / losses.length) / 100; // fraction
          const payoffRatio = avg_win / Math.max(0.001, avg_loss);
          const kellyFrac   = kellyPositionSizePct(win_rate, payoffRatio, {
            halfKellyCap: positionSizePct / 100,
            floorPct: Math.min(2, positionSizePct) / 100,
          });
          // Positive edge → conviction-scaled size; no edge (0) → keep flat
          // fallback (these already passed the score-threshold gate and a human
          // approves, so we don't suppress the proposal entirely here).
          if (kellyFrac > 0) {
            effectiveSizePct = parseFloat((kellyFrac * 100).toFixed(1));
            kellySizingSource = `half-kelly (n=${pnls.length}, wr=${(win_rate*100).toFixed(0)}%, R=${payoffRatio.toFixed(2)}, size=${effectiveSizePct}%)`;
          }
        }
      }
    } catch { /* sizing falls back to flat */ }

    for (const signal of (signals ?? []) as any[]) {
      if (alreadyProposed.has(signal.id)) {
        skipped.push({ symbol: signal.symbol, reason: "already_proposed_today" });
        continue;
      }

      // Earnings blackout: skip if earnings within ±2 days (±5 for safety)
      if (avKey) {
        try {
          const ecUrl = `https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&symbol=${encodeURIComponent(signal.symbol)}&horizon=3month&apikey=${avKey}`;
          const ecRes = await fetch(ecUrl, { signal: AbortSignal.timeout(5000) });
          if (ecRes.ok) {
            const csv = await ecRes.text();
            const today = new Date();
            const inBlackout = csv.split("\n").slice(1).some(row => {
              const cols = row.split(",");
              if (cols.length < 3) return false;
              const sym = cols[0]?.trim().toUpperCase();
              const reportDate = cols[2]?.trim();
              if (sym !== signal.symbol.toUpperCase() || !reportDate) return false;
              // Compare CALENDAR days at UTC midnight, not exact timestamps —
              // "today" carries the current time-of-day, so a same-day earnings
              // report could read as up to ~1 day off depending on what time
              // this cron happens to run, shifting the blackout window boundary.
              const rd = new Date(reportDate);
              const rdUtcDay = Date.UTC(rd.getUTCFullYear(), rd.getUTCMonth(), rd.getUTCDate());
              const todayUtcDay = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
              const diffDays = (rdUtcDay - todayUtcDay) / 86400000;
              return diffDays >= -2 && diffDays <= 5; // 2 days past, 5 days upcoming
            });
            if (inBlackout) {
              skipped.push({ symbol: signal.symbol, reason: "earnings_blackout" });
              continue;
            }
          }
        } catch { /* AV timeout — proceed without blackout check */ }
      }

      // Real price — must be fresh
      const quote = await getQuote(signal.symbol, supabase);
      if (quote.source === "unavailable" || quote.price <= 0) {
        skipped.push({ symbol: signal.symbol, reason: "price_unavailable" });
        continue;
      }
      if (quote.stale) {
        skipped.push({ symbol: signal.symbol, reason: "price_stale" });
        continue;
      }

      // Portfolio sizing — uses Half-Kelly if ≥10 closed trades, else flat positionSizePct
      // Phase 4: prefer the US pool; fall back to any row pre-057 (no market column)
      let { data: portfolio } = await supabase.from("paper_portfolio").select("nav, cash_balance").eq("market", "us").limit(1).maybeSingle();
      if (!portfolio) ({ data: portfolio } = await supabase.from("paper_portfolio").select("nav, cash_balance").limit(1).maybeSingle());
      const nav = (portfolio as any)?.nav ?? 10000;
      const navRemaining = Math.max(0, nav - allocatedThisRun);
      const estimatedValue = navRemaining * (effectiveSizePct / 100);
      const qty = Math.floor(estimatedValue / quote.price);
      if (qty < 1) {
        skipped.push({ symbol: signal.symbol, reason: "qty_too_small" });
        continue;
      }

      // Risk check: position would be within size limit. pctOfNav is checked
      // against total NAV (the real single-position limit), but qty was sized
      // off navRemaining, so earlier proposals in this run correctly shrink
      // the capital available to later ones instead of each being sized as if
      // it were the only proposal.
      const pctOfNav = (qty * quote.price) / nav;
      const riskPass = pctOfNav <= 0.15; // max 15% single position
      const riskReasons: any = {
        position_size: { pass: pctOfNav <= 0.15, value: pctOfNav, threshold: 0.15 },
        score_gate:    { pass: signal.analyst_score >= scoreThreshold, value: signal.analyst_score, threshold: scoreThreshold },
        price_fresh:   { pass: !quote.stale, value: null, threshold: null },
      };

      const expiresAt = new Date(Date.now() + PROPOSAL_EXPIRY_MINUTES * 60 * 1000).toISOString();

      const { data: proposal } = await supabase.from("trade_proposals").insert({
        symbol:          signal.symbol,
        market:          "us",
        side:            "buy",
        qty,
        order_type:      "market",
        signal_id:       signal.id,
        analyst_score:   signal.analyst_score,
        thesis:          signal.rationale,
        price_at_proposal:   quote.price,
        price_source:        quote.source,
        price_retrieved_at:  quote.retrievedAt,
        risk_check_pass:     riskPass,
        risk_check_reasons:  { ...riskReasons, sizing_method: { source: kellySizingSource, pct: effectiveSizePct }, trading_mandate: tradingMandate },
        estimated_value:     parseFloat((qty * quote.price).toFixed(2)),
        pct_of_nav:          parseFloat(pctOfNav.toFixed(4)),
        status:              "pending_review",
        approval_expires_at: expiresAt,
        account_number:      AGENTIC_ACCOUNT,
      }).select().single();

      created.push({ symbol: signal.symbol, qty, price: quote.price, risk_pass: riskPass });
      allocatedThisRun += qty * quote.price;

      // Fire-and-forget rich trade alert email
      if (proposal) {
        sendTradeAlertEmail({
          proposalId: (proposal as any).id,
          signalId: signal.id,
          symbol: signal.symbol,
          side: "buy",
          qty,
          orderType: "market",
          priceAtProposal: quote.price,
          estimatedValue: qty * quote.price,
          pctOfNav: pctOfNav,
          analystScore: signal.analyst_score,
          thesis: signal.rationale,
          expiresAt: expiresAt,
          riskCheckPass: riskPass,
        }).catch(() => {});
      }
    }

    return NextResponse.json({ success: true, created: created.length, proposals: created, skipped, macro_warning: macroWarning });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

async function handleApproval(supabase: any, proposalId: number) {
  try {
    // Load proposal
    const { data: proposal, error } = await supabase
      .from("trade_proposals")
      .select("*")
      .eq("id", proposalId)
      .single();

    if (error || !proposal) {
      return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
    }
    if (proposal.status !== "pending_review") {
      return NextResponse.json({ error: `Proposal already ${proposal.status}` }, { status: 409 });
    }

    // Check expiry
    if (proposal.approval_expires_at && new Date(proposal.approval_expires_at) < new Date()) {
      await supabase.from("trade_proposals").update({ status: "expired" }).eq("id", proposalId);
      return NextResponse.json({ error: "Proposal expired — generate a new one with a fresh price" }, { status: 410 });
    }

    // Safety: verify account number — NEVER proceed if it doesn't match
    if (proposal.account_number !== AGENTIC_ACCOUNT) {
      await supabase.from("trade_proposals").update({
        status: "failed",
        rejection_reason: `SAFETY: account mismatch — expected ${AGENTIC_ACCOUNT}, got ${proposal.account_number}`,
      }).eq("id", proposalId);
      notifyTradeAction({ action: "blocked", symbol: proposal.symbol, qty: proposal.qty, side: proposal.side, proposalId, reason: `Account mismatch — expected ${AGENTIC_ACCOUNT}` }).catch(() => {});
      return NextResponse.json({ error: "Safety violation: account number mismatch. Order blocked." }, { status: 403 });
    }

    // Kill-switch re-check at submission time (paper)
    const ks = await checkKillSwitches(supabase, { market: "us", book: "paper" });
    if (!ks.safe) {
      await supabase.from("trade_proposals").update({
        status: "failed",
        rejection_reason: `Kill switch: ${ks.reason}`,
      }).eq("id", proposalId);
      return NextResponse.json({ error: `Blocked by kill switch: ${ks.reason}` }, { status: 403 });
    }

    // Re-fetch current price — must not be stale (10 min tolerance at submission)
    const freshQuote = await getQuote(proposal.symbol, supabase);
    if (freshQuote.stale || freshQuote.source === "unavailable" || freshQuote.price <= 0) {
      return NextResponse.json({
        error: "Current price is unavailable or stale — cannot submit. Try again when market is open.",
      }, { status: 409 });
    }

    // Price drift check: if price moved > 3%, expire the proposal and require a fresh one
    const priceDrift = Math.abs(freshQuote.price - proposal.price_at_proposal) / proposal.price_at_proposal;
    if (priceDrift > 0.03) {
      await supabase.from("trade_proposals").update({ status: "expired" }).eq("id", proposalId);
      return NextResponse.json({
        error: `Price moved ${(priceDrift * 100).toFixed(1)}% since proposal (current $${freshQuote.price.toFixed(2)} vs proposal $${proposal.price_at_proposal.toFixed(2)}). Proposal expired — generate a new one.`,
      }, { status: 409 });
    }

    // Mark approved before attempting Robinhood submission
    await supabase.from("trade_proposals").update({
      status: "approved",
      approved_at: new Date().toISOString(),
    }).eq("id", proposalId);

    // Execution is manual-by-design: execClaude (a plain text-completion
    // subprocess, no MCP server attached) structurally cannot call
    // review_equity_order/place_equity_order — a prompt asking it to "call"
    // those tools can only ever produce a hallucinated result, which would
    // be a false "order submitted" with no real trade behind it. Instead,
    // generate the exact natural-language instruction to paste into an
    // interactive Claude session that DOES have live Robinhood MCP access
    // (e.g. Claude Code) — the human stays in the loop for every real order.
    const orderTypeText = proposal.order_type === "limit"
      ? `a limit order at $${proposal.limit_price}`
      : `a ${proposal.order_type} order`;
    const manualCommand = `Review and place ${orderTypeText} to ${proposal.side} ${proposal.qty} shares of ${proposal.symbol} on Robinhood account ${AGENTIC_ACCOUNT}.`;

    await supabase.from("trade_proposals").update({
      status: "approved",
      rejection_reason: null,
    }).eq("id", proposalId);
    notifyTradeAction({ action: "approved", symbol: proposal.symbol, qty: proposal.qty, side: proposal.side, proposalId, reason: "Awaiting manual execution via Claude MCP" }).catch(() => {});

    return NextResponse.json({
      success: true,
      action: "approved_awaiting_manual_execution",
      proposal_id: proposalId,
      symbol: proposal.symbol,
      qty: proposal.qty,
      current_price: freshQuote.price,
      price_at_proposal: proposal.price_at_proposal,
      account_number: AGENTIC_ACCOUNT,
      manual_command: manualCommand,
      manual_command_note: "Paste this into a Claude session with Robinhood MCP access (e.g. Claude Code) to actually place the order. This app cannot execute Robinhood trades itself.",
      message: `Approved — paste the manual_command into an MCP-enabled Claude session to place it: "${manualCommand}"`,
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
