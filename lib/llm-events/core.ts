// LLM event extraction (measure-only). One news/announcement item per call, blind to price, scores and every other
// dimension. The model labels what the text says; a validator rejects anything not grounded in the text; the symbol
// score is computed by deterministic code. Nothing here is read by scoring, gates or trades.

export const EVENT_TYPES = [
  "earnings_results", "guidance", "ma_deal", "regulatory_legal", "management_change", "capital_raise",
  "contract_order", "dividend_buyback", "rating_analyst_action", "operational_update", "macro_policy_exposure", "other",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const HORIZONS = ["immediate", "weeks", "months", "unclear"] as const;
export type EventHorizon = (typeof HORIZONS)[number];

export type EventSource = "google_news_rss" | "nse_corporate_announcements";

export interface EventDoc {
  key: string; // stable identity for dedupe: hash of symbol|source|url-or-text|publishedAt
  symbol: string;
  source: EventSource;
  text: string;
  publishedAt: string | null;
  fetchedAt: string; // when the snapshot containing this item was fetched (the earliest it was knowable to us)
}

export interface ExtractedEvent {
  about_company: boolean;
  event_type: EventType;
  direction: number; // -1..1
  magnitude: number | null; // 0..1, null when the text gives no basis
  horizon: EventHorizon;
  quote: string;
}

export const MAX_DOC_AGE_DAYS = 14;
export const UNKNOWN_MAGNITUDE_WEIGHT = 0.3;
export const SCORE_HALF_LIFE_DAYS = 3;

export const EVENT_SYSTEM_PROMPT =
  "You label ONE news item for a research experiment. Use only the text provided. Do not use outside knowledge about the company, its price, or anything that happened later. If the text does not state something, answer null or 'unclear'. Output exactly one RFC 8259 JSON object with straight ASCII double quotes: no markdown, comments or surrounding prose.";

export function buildEventPrompt(doc: EventDoc): string {
  return `News item (published ${doc.publishedAt ?? "date unknown"}):
"""
${doc.text.slice(0, 600)}
"""

Return JSON with exactly these keys:
- about_company: true if the item is about a specific listed company's own business; false if it is generic market commentary or about a different firm.
- event_type: one of ${EVENT_TYPES.join(", ")}.
- direction: number from -1 to 1, the effect on the company's earnings or cash flow AS STATED OR DIRECTLY IMPLIED BY THE TEXT (not a forecast of market moves); 0 if the text implies none.
- magnitude: number from 0 to 1 only if the text gives a basis (an amount, a percentage, a size relative to the business); otherwise null.
- horizon: one of ${HORIZONS.join(", ")}.
- quote: a short phrase copied EXACTLY from the text above that supports your labels.`;
}

const norm = (s: string) => s.toLowerCase().replace(/[‘’“”]/g, "'").replace(/\s+/g, " ").trim();

/** Reject docs that must not be sent: undated-in-the-future, too old, or empty. Returns a reason or null. */
export function docRejectReason(doc: EventDoc, nowMs: number): string | null {
  if (!doc.text.trim()) return "empty_text";
  const fetched = Date.parse(doc.fetchedAt);
  if (!Number.isFinite(fetched)) return "bad_fetched_at";
  if (doc.publishedAt) {
    const pub = Date.parse(doc.publishedAt);
    if (!Number.isFinite(pub)) return "bad_published_at";
    if (pub > fetched + 5 * 60_000) return "published_after_fetch"; // look-ahead guard: cannot have been knowable at fetch time
    if (nowMs - pub > MAX_DOC_AGE_DAYS * 86_400_000) return "too_old";
  }
  return null;
}

export type ParseResult = { ok: true; event: ExtractedEvent } | { ok: false; reason: string };

export function parseExtraction(raw: string, doc: EventDoc): ParseResult {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let v: any;
  try { v = JSON.parse(trimmed); } catch { return { ok: false, reason: "invalid_json" }; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, reason: "invalid_shape" };
  if (typeof v.about_company !== "boolean") return { ok: false, reason: "about_company_not_boolean" };
  if (!EVENT_TYPES.includes(v.event_type)) return { ok: false, reason: "bad_event_type" };
  if (typeof v.direction !== "number" || !Number.isFinite(v.direction) || v.direction < -1 || v.direction > 1) return { ok: false, reason: "bad_direction" };
  if (v.magnitude != null && (typeof v.magnitude !== "number" || !Number.isFinite(v.magnitude) || v.magnitude < 0 || v.magnitude > 1)) return { ok: false, reason: "bad_magnitude" };
  if (!HORIZONS.includes(v.horizon)) return { ok: false, reason: "bad_horizon" };
  if (typeof v.quote !== "string" || !v.quote.trim()) return { ok: false, reason: "quote_missing" };
  if (!norm(doc.text).includes(norm(v.quote))) return { ok: false, reason: "quote_not_in_text" };
  return {
    ok: true,
    event: {
      about_company: v.about_company, event_type: v.event_type, direction: v.direction,
      magnitude: v.magnitude ?? null, horizon: v.horizon, quote: v.quote.trim().slice(0, 300),
    },
  };
}

export interface ScoredItem { published_at: string | null; extracted_from_fetch_at: string; event: ExtractedEvent }

/**
 * Deterministic per-symbol score: age-decayed sum of direction x magnitude over events about the company, squashed to 0..100
 * (50 = no net evidence). Age is measured from the item's publish time (fetch time when undated). Null when nothing counts.
 */
export function aggregateSymbolScore(items: readonly ScoredItem[], asOfMs: number): { score: number; n_items: number } | null {
  let sum = 0;
  let n = 0;
  for (const it of items) {
    if (!it.event.about_company) continue;
    const ref = Date.parse(it.published_at ?? it.extracted_from_fetch_at);
    if (!Number.isFinite(ref) || ref > asOfMs) continue; // never use an item that is not yet knowable at as-of
    const ageDays = Math.max(0, (asOfMs - ref) / 86_400_000);
    const weight = Math.pow(0.5, ageDays / SCORE_HALF_LIFE_DAYS);
    sum += it.event.direction * (it.event.magnitude ?? UNKNOWN_MAGNITUDE_WEIGHT) * weight;
    n++;
  }
  if (n === 0) return null;
  return { score: Math.round((50 + 50 * Math.tanh(sum)) * 10) / 10, n_items: n };
}
