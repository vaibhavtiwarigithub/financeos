import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { readRecentCandidates } from "@/lib/research/recent-candidates";
import { expectedMarketSessionsBetween, getMarketDayStatus } from "@/lib/trading/market-calendar";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { EXCLUDE_SHADOW_FILTER } from "@/lib/trading/proposal-status";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const market = req.nextUrl.searchParams.get("market");
  const book = req.nextUrl.searchParams.get("book");
  if ((market !== "us" && market !== "india") || (book !== "paper" && book !== "live")) {
    return NextResponse.json({ error: "market=us|india and book=paper|live required" }, { status: 400 });
  }
  try {
    const svc = createServiceClient();
    const now = new Date();
    const day = getMarketDayStatus(market, now);
    const rows = await readRecentCandidates(svc, market, now);
    // Display-only per-book evidence. No broker call, paid research or mutation.
    const symbols = rows.map(row => row.symbol);
    const { data: firstSignals, error: firstError } = rows.length ? await svc.from("agent_signals")
      .select("id,created_at").in("id", rows.map(row => row.first_signal_id)) : { data: [], error: null };
    if (firstError || firstSignals?.length !== rows.length) throw new Error("Candidate admission timestamps unavailable");
    const firstAt = new Map<string, string>((firstSignals ?? []).map((signal: any) => [String(signal.id), String(signal.created_at)]));
    const since = [...firstAt.values()].sort()[0];
    // Include intermediate assessments too: a refresh today must not hide
    // yesterday's blocked attempt just because it has another signal ID.
    const events = rows.length && book === "paper" ? await fetchAllRows<any>((from, to) => svc.from("pipeline_stage_events")
      .select("id,signal_id,symbol,reason,outcome,stage,created_at").eq("market", market).in("symbol", symbols).gte("created_at", since)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to), "shortlist paper decisions") : [];
    const { data: positions, error: positionsError } = book === "paper"
      ? await svc.from("paper_positions").select("symbol").eq("market", market).gt("qty", 0)
      : { data: null, error: null };
    if (positionsError) throw new Error(positionsError.message);
    const held = new Set((positions ?? []).map((row: any) => row.symbol));
    const proposals = rows.length && book === "live" ? await fetchAllRows<any>((from, to) => svc.from("trade_proposals")
      .select("id,symbol,status,rejection_reason,risk_check_reasons,created_at").eq("market", market).in("symbol", symbols).gte("created_at", since)
      .or(EXCLUDE_SHADOW_FILTER)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to), "shortlist live proposals") : [];
    return NextResponse.json({ market, book, as_of: now.toISOString(), retention_sessions: 5, capacity: 20,
      candidates: rows.map((row, i) => {
        const previous = new Date(`${row.first_session}T12:00:00Z`); previous.setUTCDate(previous.getUTCDate() - 1);
        const sessions = expectedMarketSessionsBetween(market, previous.toISOString().slice(0, 10), row.expires_session);
        const lastDecision = events.find((event: any) => event.symbol === row.symbol
          && event.created_at >= firstAt.get(row.first_signal_id)!
          && ["execution", "capital_rotation", "portfolio_constructor", "sector_gate", "reentry_gate", "liquidity_gate", "pricing", "existing_position_gate", "trade_plan", "sizing", "risk_gate"].includes(event.stage));
        const proposal = proposals.find((item: any) => item.symbol === row.symbol && item.created_at >= firstAt.get(row.first_signal_id)!);
        return { ...row, rank: i + 1,
          sessions_remaining: sessions.filter(session => session >= day.localYmd).length,
          research_state: held.has(row.symbol) ? "already_held" : row.latest_session < day.localYmd ? "needs_refresh" : "research_qualified",
          last_decision: lastDecision ? { reason: lastDecision.reason, outcome: lastDecision.outcome,
            stage: lastDecision.stage, at: lastDecision.created_at } : proposal ? {
            reason: proposal.rejection_reason ?? (proposal.risk_check_reasons?.length ? proposal.risk_check_reasons.join("; ") : `Proposal ${proposal.status}`),
            outcome: proposal.status, stage: "live_proposal", at: proposal.created_at,
          } : null,
        };
      }),
      note: "Research shortlist, not an order queue. All prices, geometry, eligibility and risk controls are checked afresh. Live account eligibility is separate." },
    { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Shortlist unavailable" }, { status: 500 });
  }
}
