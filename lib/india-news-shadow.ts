import { XMLParser } from "fast-xml-parser";

export type NewsHeadline = {
  title: string;
  source: string | null;
  publishedAt: string | null;
  url: string | null;
};

export type NewsFetchResult = {
  ok: boolean;
  status: number | null;
  query: string;
  headlines: NewsHeadline[];
  errorCode: "http_error" | "timeout" | "parse_error" | null;
  responseBytes: number;
};

const COMPANY_SUFFIXES = new Set([
  "limited", "ltd", "india", "industries", "industry", "corporation", "corp",
  "company", "co", "holdings", "enterprises", "services", "technologies",
]);
const MAX_RSS_BYTES = 1_000_000;

async function readBoundedBody(response: Response): Promise<{ text: string; bytes: number } | null> {
  if (!response.body) {
    const text = await response.text();
    return text.length <= MAX_RSS_BYTES ? { text, bytes: text.length } : null;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RSS_BYTES) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, bytes };
}

function boundedText(value: unknown, max: number): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeHttpsUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" ? url.toString().slice(0, 1000) : null;
  } catch {
    return null;
  }
}

export function isRelevantIndiaHeadline(title: string, symbol: string, companyName: string): boolean {
  const normalized = boundedText(title, 500).toLowerCase();
  const bare = symbol.replace(/\.(NS|BO)$/i, "").toLowerCase();
  if (new RegExp(`(^|[^a-z0-9])${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(normalized)) return true;
  const tokens = boundedText(companyName, 160).toLowerCase().split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !COMPANY_SUFFIXES.has(token));
  return tokens.some((token) => normalized.includes(token));
}

export function parseGoogleNewsRss(xml: string, symbol: string, companyName: string): NewsHeadline[] {
  const parsed = new XMLParser({ ignoreAttributes: false, trimValues: true }).parse(xml);
  const raw = parsed?.rss?.channel?.item;
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const seen = new Set<string>();
  const result: NewsHeadline[] = [];
  for (const item of items) {
    const title = boundedText(item?.title, 400);
    if (!title || !isRelevantIndiaHeadline(title, symbol, companyName)) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const published = new Date(String(item?.pubDate ?? ""));
    result.push({
      title,
      source: boundedText(item?.source?.["#text"] ?? item?.source, 120) || null,
      publishedAt: Number.isFinite(published.getTime()) ? published.toISOString() : null,
      url: safeHttpsUrl(item?.link),
    });
    if (result.length >= 10) break;
  }
  return result;
}

export async function fetchGoogleNewsHeadlines(
  symbol: string,
  companyName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NewsFetchResult> {
  const query = `\"${boundedText(companyName, 100) || symbol.replace(/\.(NS|BO)$/i, "")}\" stock when:7d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/rss+xml, application/xml, text/xml" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const declaredBytes = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_RSS_BYTES) {
      return { ok: false, status: response.status, query, headlines: [], errorCode: "parse_error", responseBytes: declaredBytes };
    }
    const body = await readBoundedBody(response);
    if (!body) {
      return { ok: false, status: response.status, query, headlines: [], errorCode: "parse_error", responseBytes: Math.max(declaredBytes, MAX_RSS_BYTES + 1) };
    }
    const xml = body.text;
    if (!response.ok) return { ok: false, status: response.status, query, headlines: [], errorCode: "http_error", responseBytes: body.bytes };
    try {
      return { ok: true, status: response.status, query, headlines: parseGoogleNewsRss(xml, symbol, companyName), errorCode: null, responseBytes: body.bytes };
    } catch {
      return { ok: false, status: response.status, query, headlines: [], errorCode: "parse_error", responseBytes: body.bytes };
    }
  } catch (error) {
    const timeout = error instanceof Error && /timeout|abort/i.test(error.name + error.message);
    return { ok: false, status: null, query, headlines: [], errorCode: timeout ? "timeout" : "http_error", responseBytes: 0 };
  }
}
