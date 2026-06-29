import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { execClaude, parseClaudeOutput } from "@/lib/claude-exec";

export const dynamic = "force-dynamic";

// Cache live holdings for 5 minutes (RH positions don't change by the second)
let cache: { data: any[]; ts: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000;

export async function GET() {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return NextResponse.json({ positions: cache.data, cached: true });
  }

  const TRADING_ACCOUNT = process.env.TRADING_ACCOUNT_NUMBER ?? "965848641";

  const prompt = `Call the Robinhood MCP tool get_equity_positions with account_number: "${TRADING_ACCOUNT}"

From the response, for each position extract:
- symbol (string ticker)
- qty (number of shares, use quantity field)
- avg_cost (average cost per share, use average_buy_price field, convert to number)
- current_price (use last_trade_price or last_extended_hours_trade_price, convert to number)
- name (instrument name or symbol if name unavailable)

Return ONLY a JSON array (no markdown, no explanation):
[
  {"symbol":"AAPL","qty":10,"avg_cost":175.50,"current_price":183.20,"name":"Apple Inc."},
  ...
]

If the tool fails or returns no positions, return: []`;

  try {
    const stdout = await execClaude(prompt, 90000);
    const text = parseClaudeOutput(stdout);
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return NextResponse.json({ positions: [], stale: true });
    const positions = JSON.parse(match[0]);
    if (!Array.isArray(positions)) return NextResponse.json({ positions: [], stale: true });
    cache = { data: positions, ts: Date.now() };
    return NextResponse.json({ positions, cached: false });
  } catch {
    if (cache) return NextResponse.json({ positions: cache.data, cached: true, stale: true });
    return NextResponse.json({ positions: [], stale: true });
  }
}
