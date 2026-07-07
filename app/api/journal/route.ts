import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";

export const dynamic = "force-dynamic";

// Phase 4: Decision Journal API
// Every significant decision (signal, fill, exit, experiment) gets a journal entry.
// Entries link evidence → calculations → interpretations → outcomes.

export async function GET(req: NextRequest) {
  const supabase = createServiceClient();
  const symbol   = req.nextUrl.searchParams.get("symbol");
  const type     = req.nextUrl.searchParams.get("type");
  const resolved = req.nextUrl.searchParams.get("resolved");
  const market   = req.nextUrl.searchParams.get("market"); // us|india — global market switcher
  const limit    = parseInt(req.nextUrl.searchParams.get("limit") ?? "50");

  let query = supabase
    .from("decision_journal")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(Math.min(limit, 100));

  if (symbol)   query = query.eq("symbol", symbol);
  if (type)     query = query.eq("entry_type", type);
  if (resolved !== null) query = query.eq("resolved", resolved === "true");
  // Entries with no derivable market (settings changes, broker-order alerts,
  // cron-gap alerts) stay null and are treated as US, same pattern as
  // agent_runs.market.
  if (market === "india") query = query.eq("market", "india");
  else if (market === "us") query = query.or("market.eq.us,market.is.null");

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ entries: data ?? [] });
}

export async function POST(req: NextRequest) {
  const supabase = createServiceClient();

  // Validate cron or user session
  if (!verifyCronSecret(req)) {
    const client = await import("@/lib/supabase/server").then(m => m.createClient());
    const { data: { user } } = await client.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { action, ...fields } = body as { action?: string; [k: string]: unknown };

  // action: "resolve" — mark an entry as resolved with outcome
  if (action === "resolve") {
    const { id, outcome } = fields as { id: number; outcome: Record<string, unknown> };
    const { error } = await supabase.from("decision_journal").update({
      resolved: true,
      resolved_at: new Date().toISOString(),
      outcome,
    }).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  // Default: create new journal entry
  const {
    entry_type, symbol, summary,
    signal_id, paper_trade_id, paper_event_id, trade_proposal_id,
    experiment_run_id, learner_run_id, strategy_version_id,
    evidence_refs, calculations, interpretations,
    has_verified_facts, has_calculations, has_estimates,
    has_interpretations, has_user_decisions,
  } = fields as any;

  if (!entry_type || !summary) {
    return NextResponse.json({ error: "entry_type and summary required" }, { status: 400 });
  }

  const { data, error } = await supabase.from("decision_journal").insert({
    entry_type, symbol, summary,
    signal_id:          signal_id          ?? null,
    paper_trade_id:     paper_trade_id     ?? null,
    paper_event_id:     paper_event_id     ?? null,
    trade_proposal_id:  trade_proposal_id  ?? null,
    experiment_run_id:  experiment_run_id  ?? null,
    learner_run_id:     learner_run_id     ?? null,
    strategy_version_id: strategy_version_id ?? null,
    evidence_refs:      evidence_refs  ?? null,
    calculations:       calculations   ?? null,
    interpretations:    interpretations ?? null,
    has_verified_facts:   has_verified_facts   ?? false,
    has_calculations:     has_calculations     ?? false,
    has_estimates:        has_estimates        ?? false,
    has_interpretations:  has_interpretations  ?? false,
    has_user_decisions:   has_user_decisions   ?? false,
    resolved: false,
  }).select().single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, entry: data });
}
