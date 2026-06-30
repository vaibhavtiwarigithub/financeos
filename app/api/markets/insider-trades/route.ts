import { NextResponse } from "next/server";

export const revalidate = 3600; // 1h cache

interface Trade {
  symbol: string;
  name: string;
  type: "buy" | "sell";
  value: number;
  shares: number;
  date: string;
  filer: string;
  role: "insider" | "congress";
  title?: string;
}

export async function GET() {
  const avKey = process.env.ALPHA_VANTAGE_API_KEY ?? "";
  const results: Trade[] = [];

  // 1. Alpha Vantage top insider buys (use a watchlist of popular symbols)
  const watchSymbols = ["AAPL", "NVDA", "MSFT", "TSLA", "META", "AMZN", "GOOGL", "AMD", "PLTR", "CRWD"];

  await Promise.allSettled(watchSymbols.slice(0, 5).map(async (sym) => {
    try {
      const url = `https://www.alphavantage.co/query?function=INSIDER_TRANSACTIONS&symbol=${sym}&apikey=${avKey}`;
      const res = await fetch(url, { next: { revalidate: 3600 } });
      const data = await res.json();
      const txns = (data?.data ?? []).slice(0, 3);
      for (const t of txns) {
        const shares = Math.abs(parseFloat(t.shares ?? "0"));
        const price = parseFloat(t.price ?? "0");
        const type = (t.transactionType ?? "").toUpperCase();
        const isBuy = type.includes("BUY") || type === "P";
        const isSell = type.includes("SELL") || type === "S";
        if (isBuy || isSell) {
          results.push({
            symbol: sym,
            name: t.name ?? t.reportingName ?? "",
            type: isBuy ? "buy" : "sell",
            value: shares * price,
            shares,
            date: t.transactionDate ?? "",
            filer: t.name ?? t.reportingName ?? "",
            role: "insider",
            title: t.relationship ?? t.officerTitle ?? "",
          });
        }
      }
    } catch {
      // silently skip failed symbols
    }
  }));

  // 2. Congressional trades (House Stock Watcher public data)
  try {
    const res = await fetch(
      "https://house-stock-watcher-data.s3-us-east-2.amazonaws.com/data/all_transactions.json",
      { next: { revalidate: 3600 } }
    );
    const allTrades = await res.json();
    // Get last 30 days
    const cutoff = Date.now() - 30 * 86400000;
    const recent = (allTrades as any[])
      .filter((t: any) => {
        const d = new Date(t.transaction_date ?? t.disclosure_date ?? "").getTime();
        return d > cutoff && t.ticker && t.ticker !== "--";
      })
      .slice(0, 20);

    for (const t of recent) {
      const isBuy = (t.type ?? "").toLowerCase().includes("purchase");
      results.push({
        symbol: (t.ticker ?? "").replace("$", "").toUpperCase(),
        name: t.representative ?? "",
        type: isBuy ? "buy" : "sell",
        value: parseFloat((t.amount ?? "0").replace(/[^0-9.]/g, "") || "0"),
        shares: 0,
        date: t.transaction_date ?? t.disclosure_date ?? "",
        filer: t.representative ?? "",
        role: "congress",
        title: t.district ?? t.party ?? "",
      });
    }
  } catch {
    // silently skip if congressional data unavailable
  }

  // Sort by date desc, take top 30
  const sorted = results
    .filter((t) => t.symbol && t.date)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 30);

  return NextResponse.json({ trades: sorted });
}
