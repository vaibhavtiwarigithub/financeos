import { execClaude, parseClaudeOutput } from "@/lib/claude-exec";

export type PriceSource = "robinhood" | "financial_datasets" | "unavailable";

export type Quote = {
  symbol: string;
  price: number;
  source: PriceSource;
  fetchedAt: string;
};

// Fetch prices via Robinhood MCP get_equity_quotes (works read-only in subprocess).
// Falls back to FinancialDatasets get_stock_price if Robinhood fails.
// LLM MUST call the tool — no estimation.
export async function fetchQuotes(symbols: string[]): Promise<Record<string, Quote>> {
  if (symbols.length === 0) return {};

  const fetchedAt = new Date().toISOString();
  const unavailable = (): Record<string, Quote> =>
    Object.fromEntries(
      symbols.map(s => [s, { symbol: s, price: 0, source: "unavailable" as PriceSource, fetchedAt }])
    );

  const symbolList = symbols.map(s => `"${s}"`).join(", ");
  const exampleEntry = symbols.map(s => `"${s}": 123.45`).join(", ");

  const prompt = `INSTRUCTIONS: Get current stock prices for these symbols: ${symbolList}

Step 1: Call Robinhood MCP tool get_equity_quotes({ symbols: [${symbolList}] })
  - From the result, use quote.last_non_reg_trade_price if available, else quote.last_trade_price
  - Use the numeric value (strip quotes)

Step 2: If Robinhood fails, fall back to FinancialDatasets get_stock_price for each symbol individually.

Return ONLY this JSON object (no markdown, no explanation):
{${exampleEntry}}

Rules:
- Values MUST come from tool results only — never estimate or fabricate
- If a symbol price is unavailable after both attempts, set it to null
- Return raw numbers only, no strings`;

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
        source: price != null && price > 0 ? "robinhood" : "unavailable",
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
