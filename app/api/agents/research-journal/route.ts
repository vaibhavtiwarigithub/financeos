import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// Research Journal — daily funnel: for every symbol scored on the given date,
// join decision_observations -> pipeline_stage_events (by signal_id) into an
// ordered stage list plus a terminal state. Read-only, additive; a symbol
// with no pipeline_stage_events rows (pre-migration data, or research-only
// with signal_id still null) just shows the research stage.
export async function GET(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
  const market = url.searchParams.get("market") === "india" ? "india" : "us";

  const svc = createServiceClient();
  const dayStart = `${date}T00:00:00.000Z`;
  const dayEnd = `${date}T23:59:59.999Z`;

  const { data: observations } = await svc
    .from("decision_observations")
    .select("id, ts, symbol, analyst_score, score_threshold, entry_eligible, direction, fundamental_score, technical_score, sentiment_score, macro_score, insider_score, features, signal_id")
    .eq("market", market)
    .gte("ts", dayStart).lte("ts", dayEnd)
    .order("analyst_score", { ascending: false });

  const signalIds = (observations ?? []).map((o: any) => o.signal_id).filter(Boolean);
  let stageEvents: any[] = [];
  if (signalIds.length > 0) {
    const { data } = await svc.from("pipeline_stage_events").select("*").in("signal_id", signalIds).order("created_at", { ascending: true });
    stageEvents = data ?? [];
  }
  const eventsBySignal = new Map<string, any[]>();
  for (const e of stageEvents) {
    if (!eventsBySignal.has(e.signal_id)) eventsBySignal.set(e.signal_id, []);
    eventsBySignal.get(e.signal_id)!.push(e);
  }

  function terminalState(obs: any, events: any[]): string {
    if (events.length === 0) return obs.entry_eligible ? "passed_research_no_downstream_data" : "rejected_research";
    const last = events[events.length - 1];
    if (last.stage === "execution" && last.outcome === "filled") return "filled";
    if (last.outcome === "rejected") return `rejected_${last.stage}`;
    return `pending_${last.stage}`;
  }

  const symbols = (observations ?? []).map((obs: any) => ({
    symbol: obs.symbol,
    analyst_score: obs.analyst_score,
    score_threshold: obs.score_threshold,
    entry_eligible: obs.entry_eligible,
    direction: obs.direction,
    scores: {
      fundamental: obs.fundamental_score, technical: obs.technical_score,
      sentiment: obs.sentiment_score, macro: obs.macro_score, insider: obs.insider_score,
    },
    screener: obs.features?.screener ?? null,
    notes: {
      fundamental: obs.features?.fundamental?.note ?? null,
      technical: obs.features?.technical?.note ?? null,
      sentiment: obs.features?.sentiment?.note ?? null,
      macro: obs.features?.macro?.note ?? null,
      insider: obs.features?.insider?.note ?? null,
    },
    stages: (eventsBySignal.get(obs.signal_id) ?? []).map((e: any) => ({ stage: e.stage, outcome: e.outcome, reason: e.reason, detail: e.detail, at: e.created_at })),
    terminal: terminalState(obs, eventsBySignal.get(obs.signal_id) ?? []),
  }));

  return NextResponse.json({ date, market, count: symbols.length, symbols });
}
