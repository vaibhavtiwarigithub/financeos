import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sym = req.nextUrl.searchParams.get("symbol")?.toUpperCase().trim();
  if (!sym) return NextResponse.json({ history: [] });

  try {
    const svc = createServiceClient();
    const { data, error } = await svc
      .from("signal_score_history")
      .select(
        "symbol, analyst_score, fundamental_score, technical_score, sentiment_score, macro_score, insider_score, direction, source, created_at",
      )
      .eq("symbol", sym)
      .order("created_at", { ascending: true })
      .limit(60);

    if (error) {
      // Table may not exist yet (migration 054 not applied) — degrade to empty.
      return NextResponse.json({ history: [], error: error.message });
    }

    return NextResponse.json({ history: data ?? [] });
  } catch (err) {
    return NextResponse.json({ history: [] });
  }
}
