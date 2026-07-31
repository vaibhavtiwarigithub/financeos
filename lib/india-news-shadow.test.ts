import { describe, expect, it } from "vitest";
import { isRelevantIndiaHeadline, parseGoogleNewsRss } from "@/lib/india-news-shadow";

describe("India news shadow", () => {
  it("requires symbol or distinctive company-name relevance", () => {
    expect(isRelevantIndiaHeadline("Reliance shares rise after results", "RELIANCE.NS", "Reliance Industries Limited")).toBe(true);
    expect(isRelevantIndiaHeadline("TCS announces a new contract", "TCS.NS", "Tata Consultancy Services Limited")).toBe(true);
    expect(isRelevantIndiaHeadline("Unrelated market roundup", "RELIANCE.NS", "Reliance Industries Limited")).toBe(false);
  });

  it("parses, bounds and deduplicates relevant RSS items", () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>Reliance shares rise after results</title><link>https://news.google.com/a</link><pubDate>Thu, 30 Jul 2026 10:00:00 GMT</pubDate><source>Example</source></item>
      <item><title>Reliance shares rise after results</title><link>https://news.google.com/b</link></item>
      <item><title>Unrelated market roundup</title><link>http://example.com/no</link></item>
    </channel></rss>`;
    expect(parseGoogleNewsRss(xml, "RELIANCE.NS", "Reliance Industries Limited")).toEqual([{
      title: "Reliance shares rise after results",
      source: "Example",
      publishedAt: "2026-07-30T10:00:00.000Z",
      url: "https://news.google.com/a",
    }]);
  });
});
