import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { runDeepSeekResearch, ResearchResult } from "@/lib/deepseek-agent";

export const dynamic = "force-dynamic";

const ADMIN_EMAIL = "vterminater@gmail.com";

// POST /api/agents/deepseek-research
// Body: { symbol: string }
// Runs DeepSeek analysis for a single symbol, writes signal to DB, returns result.
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // Allow cron/internal calls with secret header (skips user auth)
    const cronSecret = req.headers.get("x-cron-secret");
    const isCron = cronSecret && cronSecret === process.env.CRON_SECRET;

    if (!isCron) {
      const userClient = await createClient();
      const {
        data: { user },
      } = await userClient.auth.getUser();
      if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (user.email !== ADMIN_EMAIL) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    let body: { symbol?: string };
    try {
      body = (await req.json()) as { symbol?: string };
    } catch {
      // Empty or missing body is fine — treated as batch mode below
      body = {};
    }

    const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";

    // Batch mode: no symbol provided → run on watchlist top 3
    if (!symbol) {
      const svc = createServiceClient();
      const { data: wl } = await svc
        .from("watchlist")
        .select("symbol")
        .order("added_at", { ascending: false })
        .limit(3);

      if (!wl || wl.length === 0) {
        return NextResponse.json({ error: "No symbols in watchlist to analyze" }, { status: 400 });
      }

      const results = [];
      for (const item of wl) {
        try {
          const result = await runDeepSeekResearch(item.symbol);
          results.push({ symbol: item.symbol, ok: true, result });
        } catch (e) {
          results.push({ symbol: item.symbol, ok: false, error: String(e) });
        }
      }
      return NextResponse.json({ ok: true, batch: true, results, processed: results.length });
    }

    const result: ResearchResult = await runDeepSeekResearch(symbol);
    return NextResponse.json({ ok: true, result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// GET /api/agents/deepseek-research
// Returns the last 10 deepseek signals from agent_signals.
export async function GET(): Promise<NextResponse> {
  try {
    const userClient = await createClient();
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const svc = createServiceClient();
    const { data, error } = await svc
      .from("agent_signals")
      .select(
        "id, symbol, direction, analyst_score, conviction, rationale, agent_label, agent_type, status, created_at"
      )
      .eq("agent_label", "deepseek")
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, signals: data ?? [] });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
