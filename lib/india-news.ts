// India news sentiment via GDELT DOC 2.0 (free, no API key). The US research
// path scores a sentiment dimension from Alpha Vantage NEWS_SENTIMENT + StockTwits,
// both US-only, so India equities previously had NO sentiment source at all and
// were scored without that dimension. GDELT gives India (and any market) a real,
// zero-cost news-tone signal.
//
// GDELT DOC 2.0 artlist returns recent articles matching a query, each with a
// `tone` field (roughly -10..+10, GDELT's aggregate emotional tone). We average
// the tone of recent articles about the company and map it onto a 0-100 sentiment
// score so it plugs into the SAME scoreSentiment path US social sentiment uses.
//
// Defensive by construction: every failure path returns null. GDELT returning
// nothing (or no parseable tone) is NOT faked as neutral-50 — the caller leaves
// the sentiment dimension unavailable so the availability mask stays honest.

import { providerCachedFetch } from "@/lib/data/provider-fetch";

export interface IndiaNewsSentiment {
  score: number;        // 0-100, mapped from avgTone (50 = neutral)
  articleCount: number; // articles with a usable tone
  avgTone: number;      // mean GDELT tone (~ -10..+10)
  headlines: string[];  // up to 5 recent headlines (evidence for the thesis prompt)
  available: boolean;   // true iff articleCount >= MIN_ARTICLES (enough to be a signal)
}

// Fewer than this many toned articles is noise, not a sentiment signal — mirror
// the US path's MIN_SENTIMENT_SAMPLE guard so a single article can't read as a
// confident tone.
const MIN_ARTICLES = 3;

// GDELT `tonechart` mode returns a histogram of article emotional tone: one bin
// per integer tone value, each with a document count and up to a few example
// articles. (The `artlist` mode does NOT carry a per-article `tone` field, which
// is why the earlier artlist-based fetch scored EVERY India name as unavailable.)
interface GdeltToneBin {
  bin?: number | string;   // integer tone value (~ -100..+100, usually -15..+15)
  count?: number | string; // documents with this tone
  toparts?: { url?: string; title?: string }[];
}

interface GdeltToneChartResponse {
  tonechart?: GdeltToneBin[];
}

// tone → 0-100 score. GDELT tone is roughly -10..+10 centered on 0 (neutral).
// Map so tone 0 → 50, +5 → 75, -5 → 25 (i.e. 5 tone points = 25 score points),
// then clamp to [0, 100]. A strongly positive/negative news backdrop lands near
// the extremes without a single outlier article blowing past the clamp.
export function toneToScore(avgTone: number): number {
  const raw = 50 + avgTone * 5;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

// Strip the Yahoo/NSE/BSE suffix so the query is the bare ticker/name, then build
// a quoted-phrase GDELT query. A real company name (e.g. "Reliance Industries")
// matches far better than the ticker, so callers pass companyName when they have
// it; otherwise we fall back to the de-suffixed symbol (works for many NSE
// tickers that ARE the company short name, e.g. RELIANCE, TCS, INFY).
function buildQuery(symbol: string, companyName?: string): string {
  const base = (companyName?.trim() || symbol.replace(/\.(NS|BO)$/i, "")).trim();
  return `"${base}"`;
}

export async function fetchIndiaNewsSentiment(
  symbol: string,
  companyName?: string,
): Promise<IndiaNewsSentiment | null> {
  try {
    const query = buildQuery(symbol, companyName);
    // Route through the provider cache with a ~1-day freshness window: news tone
    // is a daily aggregate, not a live feed, so re-fetching the same name within
    // a day just wastes a call. GDELT has no daily budget cap (rate-limited only),
    // so this only de-dupes; it never starves a budget.
    //
    // `tonechart` (NOT `artlist`) is the mode that actually carries tone: it
    // returns a per-tone-value histogram {bin, count, toparts[]}. We take the
    // count-weighted mean bin as the aggregate tone, sum the counts as the
    // article sample, and pull example headlines from each bin's `toparts`.
    const url =
      `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}` +
      `&mode=tonechart&format=json&timespan=14d`;

    const data: GdeltToneChartResponse | null = await providerCachedFetch(
      "gdelt",
      `GDELT_TONECHART:${query}`,
      url,
      { timeoutMs: 8000, maxAgeDays: 1 },
    );
    if (!data) return null;

    const bins: GdeltToneBin[] = Array.isArray(data.tonechart) ? data.tonechart : [];
    if (bins.length === 0) return null;

    let weightedToneSum = 0;
    let articleCount = 0;
    const headlines: string[] = [];
    for (const b of bins) {
      const bin = typeof b.bin === "string" ? parseFloat(b.bin) : b.bin;
      const count = typeof b.count === "string" ? parseInt(b.count, 10) : b.count;
      if (typeof bin !== "number" || !Number.isFinite(bin)) continue;
      if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) continue;
      weightedToneSum += bin * count;
      articleCount += count;
      for (const p of b.toparts ?? []) {
        if (p.title && headlines.length < 5) headlines.push(String(p.title).trim());
      }
    }
    if (articleCount === 0) return null; // no toned documents → honestly unavailable

    const avgTone = weightedToneSum / articleCount;
    return {
      score: toneToScore(avgTone),
      articleCount,
      avgTone,
      headlines,
      available: articleCount >= MIN_ARTICLES,
    };
  } catch {
    return null; // never throw into the research pipeline
  }
}
