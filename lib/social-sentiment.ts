import { avCachedFetch } from "@/lib/av-cache";
import { fetchNewsToneSentiment } from "@/lib/india-news";

export interface SocialSentiment {
  symbol: string;
  stocktwits_bullish_pct: number | null;   // 0-100
  stocktwits_bearish_pct: number | null;
  stocktwits_message_count: number | null;
  av_news_sentiment: number | null;         // -1 to 1 (Alpha Vantage)
  av_news_articles: number | null;
  gdelt_score: number | null;               // 0-100 GDELT news-tone (uncapped, free)
  gdelt_articles: number | null;
  sentiment_score: number | null;           // 0-100 direct score scoreSentiment reads first
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
  sentiment_sample_size: number;
}

// Below this many sentiment-tagged messages, a bullish/bearish % is noise —
// e.g. 1 tagged message reads as "100% bullish" with full apparent confidence.
// Require a real sample before treating the split as directional evidence.
const MIN_SENTIMENT_SAMPLE = 5;

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
  // FREE sources first (StockTwits + GDELT news-tone) — neither touches the Alpha
  // Vantage 25/day cap. On a 42-symbol US day, NEWS_SENTIMENT alone would blow the
  // whole AV budget, so AV is now a RESERVE: it is called only when BOTH free
  // sources come back thin/empty, keeping AV free for genuine emergencies.
  const [stocktwits, gdelt] = await Promise.allSettled([
    fetchStockTwits(symbol),
    fetchNewsToneSentiment(symbol),
  ]);

  const stRaw = stocktwits.status === "fulfilled" ? stocktwits.value : null;
  // A thin sample (< MIN_SENTIMENT_SAMPLE tagged messages) reads as fake-neutral —
  // do not count it as real evidence (else "1 bullish message = has_data" leaks a
  // coin-flip downstream).
  const st = stRaw && stRaw.sentiment_sample_size >= MIN_SENTIMENT_SAMPLE ? stRaw : null;
  const gd = gdelt.status === "fulfilled" && gdelt.value?.available ? gdelt.value : null;

  // RESERVE: only spend an AV NEWS_SENTIMENT call when both free sources failed.
  let av: AVNewsResult | null = null;
  if (!st && !gd) {
    av = await fetchAVNewsSentiment(symbol).catch(() => null);
  }

  // Combine into a single 0-100 sentiment_score (what scoreSentiment reads first).
  // StockTwits directional % (40%) blended with the news-tone component (60%);
  // news component = GDELT score when present, else AV (-1..1 → 0..100).
  const newsComponent = gd ? gd.score : av ? (av.sentiment + 1) / 2 * 100 : null;
  let sentimentScore: number | null = null;
  if (st && newsComponent != null) sentimentScore = st.bullish_pct * 0.4 + newsComponent * 0.6;
  else if (st) sentimentScore = st.bullish_pct;
  else if (newsComponent != null) sentimentScore = newsComponent;
  const bullishScore = sentimentScore ?? 50;

  return {
    symbol,
    stocktwits_bullish_pct: st?.bullish_pct ?? null,
    stocktwits_bearish_pct: st?.bearish_pct ?? null,
    stocktwits_message_count: stRaw?.message_count ?? null,
    av_news_sentiment: av?.sentiment ?? null,
    av_news_articles: av?.article_count ?? null,
    gdelt_score: gd?.score ?? null,
    gdelt_articles: gd?.articleCount ?? null,
    sentiment_score: sentimentScore != null ? Math.round(sentimentScore) : null,
    overall_sentiment: bullishScore > 60 ? "Bullish" : bullishScore < 40 ? "Bearish" : "Neutral",
    fetched_at: new Date().toISOString(),
    has_data: st != null || gd != null || av != null,
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
  const hasSample = total >= MIN_SENTIMENT_SAMPLE;
  return {
    bullish_pct: hasSample ? Math.round((bullish / total) * 100) : 50,
    bearish_pct: hasSample ? Math.round((bearish / total) * 100) : 50,
    message_count: messages.length,
    sentiment_sample_size: total,
  };
}

async function fetchAVNewsSentiment(symbol: string): Promise<AVNewsResult | null> {
  const key = process.env.ALPHA_VANTAGE_API_KEY;
  if (!key) return null;
  // News sentiment is slow-moving for scoring purposes — cache 3d so it isn't
  // re-fetched every research pass (one of the heaviest AV callers). A 3-day-old
  // aggregate sentiment score is fine for the weighting; not a live news feed.
  const data: AVNewsResponse | null = await avCachedFetch(
    `NEWS:${symbol}`,
    `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${symbol}&limit=20&apikey=${key}`,
    6000, undefined, 3
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
