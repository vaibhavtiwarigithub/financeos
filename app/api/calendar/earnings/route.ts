import { NextResponse } from "next/server";
import { execClaude, parseClaudeOutput } from "@/lib/claude-exec";

const WATCHLIST = ["AAPL", "NVDA", "TSLA", "MSFT", "META", "GOOGL", "AMZN", "NFLX", "AMD", "INTC", "UBER"];

// Cache in memory for 7 days — earnings dates don't change week-to-week
let cache: { data: EarningsEvent[]; fetchedAt: number } | null = null;
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

export type EarningsEvent = {
  symbol: string;
  name: string;
  reportDate: string;
  timing: "am" | "pm" | "";
  epsEstimate: string;
  epsActual: string | null;
  quarter: string;
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const bust = url.searchParams.has("bust");

  // Serve cache if fresh and not force-busted
  if (!bust && cache && Date.now() - cache.fetchedAt < CACHE_TTL) {
    return NextResponse.json({ earnings: cache.data, source: "cache", hasApiKey: true });
  }

  const prompt = `Using your training knowledge, list upcoming Q2 2026 earnings dates for these symbols: ${WATCHLIST.join(", ")}.

Return ONLY a JSON array, no markdown, no explanation:
[{"symbol":"TSLA","name":"Tesla Inc","reportDate":"2026-07-22","timing":"pm","epsEstimate":"0.42","epsActual":null,"quarter":"Q2 2026"}]

Use your best estimate of earnings dates for Q2 2026 (typically reported July-August 2026). If unknown, omit the symbol. Sort by reportDate ascending. Response must start with [ and end with ].`;

  try {
    const stdout = await execClaude(prompt, 90000);
    const text = parseClaudeOutput(stdout);
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("No JSON array in response");

    const earnings: EarningsEvent[] = JSON.parse(match[0]);
    cache = { data: earnings, fetchedAt: Date.now() };

    return NextResponse.json({ earnings, source: "live", hasApiKey: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Fall back to known upcoming earnings if claude.cmd fails
    const fallback: EarningsEvent[] = [
      { symbol: "NFLX", name: "Netflix", reportDate: "2026-07-16", timing: "pm", epsEstimate: "0.79", epsActual: null, quarter: "Q2 2026" },
      { symbol: "TSLA", name: "Tesla", reportDate: "2026-07-22", timing: "pm", epsEstimate: "0.42", epsActual: null, quarter: "Q2 2026" },
      { symbol: "GOOGL", name: "Alphabet", reportDate: "2026-07-22", timing: "pm", epsEstimate: "2.87", epsActual: null, quarter: "Q2 2026" },
      { symbol: "INTC", name: "Intel", reportDate: "2026-07-23", timing: "pm", epsEstimate: "0.19", epsActual: null, quarter: "Q2 2026" },
    ];

    return NextResponse.json({ earnings: fallback, source: "fallback", error: msg, hasApiKey: true });
  }
}
