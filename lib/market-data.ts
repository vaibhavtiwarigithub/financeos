import { execClaude, parseClaudeOutput } from "@/lib/claude-exec";

export type PriceSource = "financial_datasets" | "unavailable";

export type Quote = {
  symbol: string;
  price: number;
  source: PriceSource;
  fetchedAt: string;
};

// Fetch prices via FinancialDatasets MCP (API-key based, works in claude subprocess).
// LLM MUST call get_stock_prices — no estimation.
export async function fetchQuotes(symbols: string[]): Promise<Record<string, Quote>> {
  if (symbols.length === 0) return {};

  const fetchedAt = new Date().toISOString();
  const unavailable = (): Record<string, Quote> =>
    Object.fromEntries(
      symbols.map(s => [s, { symbol: s, price: 0, source: "unavailable" as PriceSource, fetchedAt }])
    );

  const symbolList = symbols.map(s => `"${s}"`).join(", ");
  const exampleEntry = symbols.map(s => `"${s}": 123.45`).join(", ");

  const prompt = `INSTRUCTIONS: Call the FinancialDatasets MCP tool get_stock_prices to get current prices.

Tool call required:
  get_stock_prices({ tickers: [${symbolList}], period: "annual", limit: 1 })

After the tool returns, extract the most recent price for each symbol (use close or price field).

Return ONLY this JSON object (no markdown, no explanation):
{${exampleEntry}}

Rules:
- Values MUST come from the tool result only
- Do NOT estimate or guess any price
- If a symbol has no price in the tool result, set it to null`;

  try {
    const stdout = await execClaude(prompt, 60000);
    const text = parseClaudeOutput(stdout);
    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) return unavailable();

    const prices: Record<string, number | null> = JSON.parse(match[0]);
    const result: Record<string, Quote> = {};

    for (const sym of symbols) {
      const price = prices[sym];
      result[sym] = {
        symbol: sym,
        price: price != null && price > 0 ? price : 0,
        source: price != null && price > 0 ? "financial_datasets" : "unavailable",
        fetchedAt,
      };
    }
    return result;
  } catch {
    return unavailable();
  }
}

export async function fetchQuote(symbol: string): Promise<Quote> {
  const quotes = await fetchQuotes([symbol]);
  return quotes[symbol];
}
