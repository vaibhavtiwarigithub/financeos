import { describe, expect, it } from "vitest";
import { aggregateSymbolScore, buildEventPrompt, docRejectReason, parseExtraction, type EventDoc, type ExtractedEvent } from "@/lib/llm-events/core";

const doc = (over: Partial<EventDoc> = {}): EventDoc => ({
  key: "k", symbol: "ABC.NS", source: "google_news_rss",
  text: "ABC Ltd wins Rs 500 crore order from state utility", publishedAt: "2026-10-12T08:00:00Z", fetchedAt: "2026-10-12T12:15:00Z", ...over,
});
const good = { about_company: true, event_type: "contract_order", direction: 0.6, magnitude: 0.4, horizon: "months", quote: "wins Rs 500 crore order" };

describe("llm event extraction core", () => {
  it("prompt is blind: contains the text but no symbol or score fields", () => {
    const p = buildEventPrompt(doc());
    expect(p).toContain("wins Rs 500 crore order");
    expect(p).not.toContain("ABC.NS");
    expect(p.toLowerCase()).not.toMatch(/score|price|composite|council/);
  });
  it("rejects look-ahead, stale and empty docs before any call is made", () => {
    const now = Date.parse("2026-10-13T00:00:00Z");
    expect(docRejectReason(doc(), now)).toBeNull();
    expect(docRejectReason(doc({ publishedAt: "2026-10-12T13:00:00Z" }), now)).toBe("published_after_fetch");
    expect(docRejectReason(doc({ publishedAt: "2026-09-01T00:00:00Z" }), now)).toBe("too_old");
    expect(docRejectReason(doc({ text: "  " }), now)).toBe("empty_text");
    expect(docRejectReason(doc({ publishedAt: null }), now)).toBeNull();
  });
  it("accepts a grounded extraction", () => {
    const r = parseExtraction(JSON.stringify(good), doc());
    expect(r.ok).toBe(true);
  });
  it("accepts a fenced JSON reply and smart quotes in the quote", () => {
    const r = parseExtraction("```json\n" + JSON.stringify({ ...good, quote: "ABC Ltd wins Rs 500 crore" }) + "\n```", doc());
    expect(r.ok).toBe(true);
  });
  it("rejects a quote that is not in the text (memory or invention)", () => {
    expect(parseExtraction(JSON.stringify({ ...good, quote: "record quarterly profit" }), doc())).toEqual({ ok: false, reason: "quote_not_in_text" });
  });
  it("rejects bad enums, ranges and shapes", () => {
    expect(parseExtraction(JSON.stringify({ ...good, event_type: "rumour" }), doc())).toEqual({ ok: false, reason: "bad_event_type" });
    expect(parseExtraction(JSON.stringify({ ...good, direction: 2 }), doc())).toEqual({ ok: false, reason: "bad_direction" });
    expect(parseExtraction(JSON.stringify({ ...good, magnitude: "big" }), doc())).toEqual({ ok: false, reason: "bad_magnitude" });
    expect(parseExtraction("not json", doc())).toEqual({ ok: false, reason: "invalid_json" });
    expect(parseExtraction("[]", doc())).toEqual({ ok: false, reason: "invalid_shape" });
  });
  it("score is 50 with no evidence, skips non-company items, and ignores items from the future", () => {
    const asOf = Date.parse("2026-10-13T12:00:00Z");
    const ev = (over: Partial<ExtractedEvent>): ExtractedEvent => ({ ...(good as ExtractedEvent), ...over });
    expect(aggregateSymbolScore([], asOf)).toBeNull();
    expect(aggregateSymbolScore([{ published_at: "2026-10-13T08:00:00Z", extracted_from_fetch_at: "2026-10-13T12:00:00Z", event: ev({ about_company: false }) }], asOf)).toBeNull();
    expect(aggregateSymbolScore([{ published_at: "2026-10-14T08:00:00Z", extracted_from_fetch_at: "2026-10-14T12:00:00Z", event: ev({}) }], asOf)).toBeNull();
  });
  it("positive events lift, negative events lower, older events count less", () => {
    const asOf = Date.parse("2026-10-13T12:00:00Z");
    const mk = (pub: string, direction: number) => ({ published_at: pub, extracted_from_fetch_at: pub, event: { ...(good as ExtractedEvent), direction, magnitude: 0.8 } });
    const up = aggregateSymbolScore([mk("2026-10-13T06:00:00Z", 1)], asOf)!;
    const down = aggregateSymbolScore([mk("2026-10-13T06:00:00Z", -1)], asOf)!;
    const oldUp = aggregateSymbolScore([mk("2026-10-03T06:00:00Z", 1)], asOf)!;
    expect(up.score).toBeGreaterThan(50);
    expect(down.score).toBeLessThan(50);
    expect(oldUp.score).toBeLessThan(up.score);
    expect(oldUp.score).toBeGreaterThan(50);
  });
});
