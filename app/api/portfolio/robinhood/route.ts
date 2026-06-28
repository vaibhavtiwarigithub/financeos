import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { execClaude, parseClaudeOutput } from "@/lib/claude-exec";

export const dynamic = "force-dynamic";

let cache: { data: any; ts: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  try {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
      return NextResponse.json(cache.data);
    }

    const prompt = `Use the Robinhood MCP tools to read the agentic trading account portfolio.
Call get_portfolio and get_equity_positions.
Output ONLY a JSON object:
{
  "equity": 0.00,
  "buying_power": 0.00,
  "total_return_pct": 0.00,
  "positions": [
    { "symbol": "AAPL", "qty": 5, "avg_cost": 180.00, "current_price": 195.00, "pnl": 75.00, "pnl_pct": 8.33 }
  ]
}
If Robinhood is not authenticated, output: {"error": "auth_required", "positions": []}`;

    const stdout = await execClaude(prompt, 45000);
    const raw = parseClaudeOutput(stdout);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      return NextResponse.json({ error: "auth_required", positions: [], equity: 0, buying_power: 0 });
    }

    const data = JSON.parse(jsonMatch[0]);
    if (!data.error) {
      cache = { data, ts: Date.now() };
    }

    return NextResponse.json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg, positions: [], equity: 0, buying_power: 0 }, { status: 500 });
  }
}
