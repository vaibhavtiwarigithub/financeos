import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();

  // Fetch from trade_journal — scores stored per evaluation
  const { data: journal } = await svc
    .from("trade_journal")
    .select("created_at, ai_score, verdict, symbol")
    .eq("user_id", session.user.id)
    .not("ai_score", "is", null)
    .order("created_at", { ascending: true })
    .limit(60);

  if (!journal?.length) return NextResponse.json({ scores: [] });

  // Group by date, avg score per day
  const byDate: Record<string, { scores: number[]; verdicts: string[] }> = {};
  for (const row of journal) {
    if (row.ai_score == null) continue;
    const date = new Date(row.created_at).toLocaleDateString("en-CA");
    if (!byDate[date]) byDate[date] = { scores: [], verdicts: [] };
    byDate[date].scores.push(row.ai_score);
    if (row.verdict) byDate[date].verdicts.push(row.verdict);
  }

  const scores = Object.entries(byDate).map(([date, v]) => ({
    date,
    score: Math.round(v.scores.reduce((a, b) => a + b, 0) / v.scores.length),
    count: v.scores.length,
    topVerdict: v.verdicts[0] ?? null,
  }));

  return NextResponse.json({ scores });
}
