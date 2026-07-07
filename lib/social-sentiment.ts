import { avCachedFetch } from "@/lib/av-cache";

export interface SocialSentiment {
  symbol: string;
  stocktwits_bullish_pct: number | null;   // 0-100
  stocktwits_bearish_pct: number | null;
  stocktwits_message_count: number | null;
  av_news_sentiment: number | null;         // -1 to 1 (Alpha Vantage)
  av_news_articles: number | null;
  overall_sentiment: "Bullish" | "Bearish" | "Neutral";
  fetched_at: string;
  // This object is ALWAYS returned (never null) even when both providers fail —
  // has_data is the only reliable signal that real evidence backs the neutral-50
  // "Neutral" default vs. a genuine absence of data. Do not use `!!socialResult`
  // as an availability check; it is always true.
  has_data: boolean;
}

interface StockTwitsResult {
  bullish_pct: number;
  bearish_pct: number;
  message_count: number;
}

interface AVNewsResult {
  sentiment: number;
  article_count: number;
}

interface StockTwitsMessage {
  entities?: {
    sentiment?: {
      basic?: string;
    };
  };
}

interface StockTwitsResponse {
  messages?: StockTwitsMessage[];
}

interface AVTickerSentiment {
  ticker?: string;
  ticker_sentiment_score?: string;
}

interface AVArticle {
  ticker_sentiment?: AVTickerSentiment[];
}

interface AVNewsResponse {
  feed?: AVArticle[];
}

export async function fetchSocialSentiment(symbol: string): Promise<SocialSentiment> {
  const [stocktwits, avNews] = await Promise.allSettled([
    fetchStockTwits(symbol),
    fetchAVNewsSentiment(symbol),
  ]);

  const st = stocktwits.status === "fulfilled" ? stocktwits.value : null;
  const av = avNews.status === "fulfilled" ? avNews.value : null;

  // Combine signals: weight stocktwits 40%, AV news 60%
  let bullishScore = 50; // neutral default
  if (st && av) {
    bullishScore = st.bullish_pct * 0.4 + (av.sentiment + 1) / 2 * 100 * 0.6;
  } else if (st) {
    bullishScore = st.bullish_pct;
  } else if (av) {
    bullishScore = (av.sentiment + 1) / 2 * 100;
  }

  return {
    symbol,
    stocktwits_bullish_pct: st?.bullish_pct ?? null,
    stocktwits_bearish_pct: st?.bearish_pct ?? null,
    stocktwits_message_count: st?.message_count ?? null,
    av_news_sentiment: av?.sentiment ?? null,
    av_news_articles: av?.article_count ?? null,
    overall_sentiment: bullishScore > 60 ? "Bullish" : bullishScore < 40 ? "Bearish" : "Neutral",
    fetched_at: new Date().toISOString(),
    has_data: st != null || av != null,
  };
}

async function fetchStockTwits(symbol: string): Promise<StockTwitsResult | null> {
  const res = await fetch(
    `https://api.stocktwits.com/api/2/streams/symbol/${symbol}.json`,
    { headers: { "User-Agent": "Kairos/1.0" } }
  );
  if (!res.ok) return null;
  const data: StockTwitsResponse = await res.json();
  const messages: StockTwitsMessage[] = data.messages ?? [];
  const withSentiment = messages.filter((m) => m.entities?.sentiment);
  const bullish = withSentiment.filter((m) => m.entities?.sentiment?.basic === "Bullish").length;
  const bearish = withSentiment.filter((m) => m.entities?.sentiment?.basic === "Bearish").length;
  const total = bullish + bearish;
  return {
    bullish_pct: total > 0 ? Math.round((bullish / total) * 100) : 50,
    bearish_pct: total > 0 ? Math.round((bearish / total) * 100) : 50,
    message_count: messages.length,
  };
}

async function fetchAVNewsSentiment(symbol: string): Promise<AVNewsResult | null> {
  const key = process.env.ALPHA_VANTAGE_API_KEY;
  if (!key) return null;
  // Day-cached + budget-guarded via avCachedFetch (imported below) — news
  // sentiment is refreshed once/day here rather than on every research pass,
  // which was one of the four heaviest uncached AV callers.
  const data: AVNewsResponse | null = await avCachedFetch(
    `NEWS:${symbol}`,
    `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${symbol}&limit=20&apikey=${key}`
  );
  if (!data) return null;
  const feed: AVArticle[] = data.feed ?? [];
  if (feed.length === 0) return null;

  // Find ticker-specific sentiment in each article
  let totalSentiment = 0;
  let count = 0;
  for (const article of feed) {
    const tickerData = (article.ticker_sentiment ?? []).find(
      (t) => t.ticker === symbol
    );
    if (tickerData?.ticker_sentiment_score) {
      totalSentiment += parseFloat(tickerData.ticker_sentiment_score);
      count++;
    }
  }

  return {
    sentiment: count > 0 ? totalSentiment / count : 0,
    article_count: count,
  };
}
