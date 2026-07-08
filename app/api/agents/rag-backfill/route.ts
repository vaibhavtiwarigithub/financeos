import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { indexClosedTrade } from "@/lib/rag/trade-memory";
import { embeddingsEnabled } from "@/lib/rag/embeddings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// RAG backfill (Tier-3 #10). Indexes CLOSED paper_trades into trade_memories that
// aren't there yet. Ongoing indexing happens at close time (position-monitor +
// learner); this route bootstraps the corpus from history and backfills anything
// that was closed while embeddings were disabled. Cron-secret protected.
//
// Idempotent: indexClosedTrade upserts by trade_id, so re-running is safe. Skips
// tainted/excluded trades at the source query AND inside indexClosedTrade.
export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!embeddingsEnabled()) {
    return NextResponse.json({
      ok: true,
      skipped: "VOYAGE_API_KEY not set — embeddings disabled, nothing indexed",
      indexed: 0,
    });
  }

  const svc = createServiceClient();
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 500);

  // Closed, learnable trades not already in the memory corpus.
  const { data: alreadyIndexed } = await svc
    .from("trade_memories")
    .select("trade_id");
  const have = new Set((alreadyIndexed ?? []).map((r: any) => r.trade_id));

  const { data: closed, error } = await svc
    .from("paper_trades")
    .select("id")
    .not("closed_at", "is", null)
    .order("closed_at", { ascending: false })
    .limit(limit);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const todo = (closed ?? []).filter((t: any) => !have.has(t.id));
  let indexed = 0;
  const failures: string[] = [];
  for (const t of todo) {
    try {
      const ok = await indexClosedTrade(String(t.id));
      if (ok) indexed++;
    } catch (e) {
      failures.push(String(t.id));
      void e;
    }
  }

  return NextResponse.json({
    ok: true,
    candidates: todo.length,
    indexed,
    alreadyIndexed: have.size,
    failures: failures.length,
  });
}
