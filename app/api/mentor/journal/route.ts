import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") ?? "50"), 100);
  const svc = createServiceClient();
  const { data: entries } = await svc
    .from("trade_journal")
    .select("*")
    .eq("user_id", session.user.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  return NextResponse.json({ entries: entries ?? [] });
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const svc = createServiceClient();

  const { data, error } = await svc.from("trade_journal").insert({
    user_id: session.user.id,
    symbol: body.symbol?.toUpperCase(),
    action: body.action,
    entry_type: body.entry_type,
    user_reasoning: body.user_reasoning,
    ai_evaluation: body.ai_evaluation,
    ai_score: body.ai_score,
    verdict: body.verdict,
    bias_flags: body.bias_flags ?? [],
    suggestions: body.suggestions,
    data_verified: body.data_verified ?? {},
    paper_trade_id: body.paper_trade_id ?? null,
    evaluated_at: body.ai_evaluation ? new Date().toISOString() : null,
  } as any).select().single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ entry: data });
}
