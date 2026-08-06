/**
 * Market event ledger backfill — trade-policy family.
 *
 * Run:  npx tsx scripts/seed-market-events.ts [--dry]
 *
 * WHY A SCRIPT AND NOT SQL
 * Every row goes through the SAME validators the owner-facing POST /api/events
 * uses (`isKnownEventType`, `isEventDirection`, `checkEventTimestamps`). A raw
 * INSERT would bypass them and put exactly the rows in the ledger that the
 * vocabulary exists to keep out. Idempotent: the (event_type, market,
 * occurred_at) UNIQUE constraint makes a re-run a no-op.
 *
 * TIMESTAMP PRECISION — the field the whole ledger rests on
 * Rows carry a `precision` marker that is written into `notes`:
 *   - "intraday": the public moment is cited to the hour. Used only where a
 *     source states it.
 *   - "date": only the calendar date is established. Those are stamped
 *     23:59:00Z of that date, DELIBERATELY. Stamping 00:00Z would place the
 *     event up to a full day BEFORE it became public, and a forward return
 *     measured from there would silently include pre-announcement drift — the
 *     look-ahead in R3 of the feature architecture. End-of-day UTC is the
 *     conservative direction: 23:59Z is after the US cash close and before the
 *     next India open, so a forward measurement can never begin early.
 *
 * MARKET ASSIGNMENT — no 'global' rows, on purpose
 * A single event that moved both books is recorded as TWO rows, one per market,
 * each measurable against its own benchmark. A 'global' row would invite a
 * pooled statistic across US and India, and those must never cross-sum.
 *
 * MEASUREMENT ONLY. No score, sizing, entry, exit or broker path reads this.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import {
  checkEventTimestamps,
  isEventDirection,
  isKnownEventType,
  type EventDirection,
} from "../lib/events/vocabulary";

interface SeedEvent {
  event_type: string;
  /** Calendar date the event became PUBLIC (YYYY-MM-DD). */
  date: string;
  /** "HH:MM" UTC when a source states the hour; omit for date-only precision. */
  timeUtc?: string;
  market: "us" | "india";
  direction: EventDirection;
  magnitude: number | null;
  source_url: string;
  source_name: string;
  notes: string;
}

// Sources, in order of preference:
//   CRS R48549 — Congressional Research Service, primary and dated
//   Tax Foundation tariff tracker — maintained, dated, cites the underlying EOs
//   Wikipedia "Liberation Day tariffs" — used ONLY for the two events where it
//     supplies an intraday time the others do not
const CRS = "https://www.congress.gov/crs-product/R48549";
const CRS_NAME = "Congressional Research Service R48549 — Presidential 2025 Tariff Actions";
const TAXF = "https://taxfoundation.org/research/all/federal/trump-tariffs-trade-war/";
const TAXF_NAME = "Tax Foundation — Trump Tariffs Trade War Tracker";

const EVENTS: SeedEvent[] = [
  // ── US: announce → reverse pairs ───────────────────────────────────────────
  {
    event_type: "policy_tariff_announced",
    date: "2025-02-01",
    market: "us",
    direction: "escalation",
    magnitude: 25,
    source_url: CRS,
    source_name: CRS_NAME,
    notes: "IEEPA order signed: 25% on Canada and Mexico, 10% on China, effective Feb 4. Pairs with the Feb 3 postponement.",
  },
  {
    event_type: "policy_tariff_reversed",
    date: "2025-02-03",
    market: "us",
    direction: "de_escalation",
    magnitude: 25,
    source_url: CRS,
    source_name: CRS_NAME,
    notes: "Canada and Mexico tariffs postponed 30 days, two days after signing. Pairs with 2025-02-01.",
  },
  {
    event_type: "policy_tariff_announced",
    date: "2025-04-02",
    timeUtc: "20:00",
    market: "us",
    direction: "escalation",
    magnitude: 10,
    source_url: "https://en.wikipedia.org/wiki/Liberation_Day_tariffs",
    source_name: "Wikipedia — Liberation Day tariffs (EO 14257)",
    notes: "\"Liberation Day\": EO 14257 signed at a Rose Garden ceremony AFTER the US cash close. 10% universal baseline recorded as magnitude; country rates ran to 50%. Time is the ceremony, cited to the hour.",
  },
  {
    event_type: "policy_tariff_announced",
    date: "2025-04-07",
    market: "us",
    direction: "escalation",
    magnitude: 50,
    source_url: TAXF,
    source_name: TAXF_NAME,
    notes: "Additional 50% on China announced, effective Apr 9. Pairs with the May 12 reduction.",
  },
  {
    event_type: "policy_tariff_reversed",
    date: "2025-04-09",
    timeUtc: "17:20",
    market: "us",
    direction: "de_escalation",
    magnitude: 40,
    source_url: "https://en.wikipedia.org/wiki/Liberation_Day_tariffs",
    source_name: "Wikipedia — Liberation Day tariffs",
    notes: "90-day pause on reciprocal tariffs above 10% for all countries except China, announced on Truth Social shortly after 13:00 ET — INTRADAY, seven days after the Apr 2 announcement. Magnitude is the 50pp ceiling cut back to the 10pp baseline. This is the canonical instance of the pattern the ledger exists to count.",
  },
  {
    event_type: "policy_tariff_reversed",
    date: "2025-05-12",
    market: "us",
    direction: "de_escalation",
    magnitude: 115,
    source_url: TAXF,
    source_name: TAXF_NAME,
    notes: "China reciprocal rate cut from 125% to 10% with a 90-day escalation pause. Pairs with 2025-04-07; interval 35 days.",
  },
  {
    event_type: "policy_tariff_announced",
    date: "2025-05-23",
    market: "us",
    direction: "escalation",
    magnitude: 50,
    source_url: TAXF,
    source_name: TAXF_NAME,
    notes: "50% EU reciprocal tariff announced, effective June 1. Pairs with the May 25 delay — interval two days.",
  },
  {
    event_type: "policy_tariff_reversed",
    date: "2025-05-25",
    market: "us",
    direction: "de_escalation",
    magnitude: 50,
    source_url: TAXF,
    source_name: TAXF_NAME,
    notes: "EU tariff implementation delayed from June 1 to July 9. Pairs with 2025-05-23.",
  },
  {
    event_type: "policy_tariff_announced",
    date: "2025-07-12",
    market: "us",
    direction: "escalation",
    magnitude: 30,
    source_url: TAXF,
    source_name: TAXF_NAME,
    notes: "Mexico and EU reciprocal rates set to 30% by August 1. Pairs with the July 31 Mexico delay.",
  },
  {
    event_type: "policy_tariff_reversed",
    date: "2025-07-31",
    market: "us",
    direction: "de_escalation",
    magnitude: 30,
    source_url: TAXF,
    source_name: TAXF_NAME,
    notes: "Mexico tariff increase delayed 90 days; made indefinite on Oct 28. Pairs with 2025-07-12.",
  },
  {
    event_type: "policy_tariff_announced",
    date: "2025-10-10",
    market: "us",
    direction: "escalation",
    magnitude: 100,
    source_url: TAXF,
    source_name: TAXF_NAME,
    notes: "Additional 100% tariff on China announced, effective November 1. Pairs with the Oct 26 framework.",
  },
  {
    event_type: "policy_tariff_reversed",
    date: "2025-10-26",
    market: "us",
    direction: "de_escalation",
    magnitude: 100,
    source_url: TAXF,
    source_name: TAXF_NAME,
    notes: "China deal framework averted the additional 100%. Pairs with 2025-10-10; interval 16 days.",
  },
  {
    event_type: "policy_tariff_announced",
    date: "2026-01-17",
    market: "us",
    direction: "escalation",
    magnitude: 10,
    source_url: TAXF,
    source_name: TAXF_NAME,
    notes: "Greenland-linked 10% tariff announced on eight European countries, effective Feb 1, rising to 25% June 1. Pairs with the Jan 21 withdrawal.",
  },
  {
    event_type: "policy_tariff_reversed",
    date: "2026-01-21",
    market: "us",
    direction: "de_escalation",
    magnitude: 10,
    source_url: TAXF,
    source_name: TAXF_NAME,
    notes: "Greenland-linked tariffs withdrawn four days after announcement; not imposed on Feb 1. Pairs with 2026-01-17.",
  },

  // ── India: the same policy actor, a different book ─────────────────────────
  // India is recorded separately rather than folded into a 'global' row so the
  // two books can never be pooled into one statistic.
  {
    event_type: "policy_tariff_announced",
    date: "2025-04-02",
    timeUtc: "20:00",
    market: "india",
    direction: "escalation",
    magnitude: 26,
    source_url: CRS,
    source_name: CRS_NAME,
    notes: "India's country-specific reciprocal rate under EO 14257 was 26%. Same announcement as the US row; recorded per-market so the books stay separate.",
  },
  {
    event_type: "policy_tariff_reversed",
    date: "2025-04-09",
    timeUtc: "17:20",
    market: "india",
    direction: "de_escalation",
    magnitude: 16,
    source_url: "https://en.wikipedia.org/wiki/Liberation_Day_tariffs",
    source_name: "Wikipedia — Liberation Day tariffs",
    notes: "The 90-day pause applied to India, cutting 26% back to the 10% baseline. Announced ~13:00 ET, which is after the Indian cash close — the Indian reaction lands the FOLLOWING session.",
  },
  {
    event_type: "policy_tariff_announced",
    date: "2025-07-30",
    market: "india",
    direction: "escalation",
    magnitude: 25,
    source_url: "https://www.business-standard.com/markets/stock-market-news/markets-resilient-amid-us-tariff-hike-sensex-nifty-close-lower-125073101301_1.html",
    source_name: "Business Standard — markets close lower on US tariff hike",
    notes: "25% tariff on India from August 1 plus an unquantified penalty. Nifty closed -0.35% and Sensex -0.4% on the July 31 session.",
  },
  {
    event_type: "policy_tariff_announced",
    date: "2025-08-06",
    market: "india",
    direction: "escalation",
    magnitude: 50,
    source_url: TAXF,
    source_name: TAXF_NAME,
    notes: "Additional 25% over Russian oil purchases, taking the cumulative rate to 50% effective August 27. Nifty opened -0.45% on August 7.",
  },
  {
    event_type: "policy_tariff_reversed",
    date: "2026-02-02",
    market: "india",
    direction: "de_escalation",
    magnitude: 32,
    source_url: "https://www.morganlewis.com/pubs/2026/02/us-india-trade-deal-cuts-tariffs-eases-tensions",
    source_name: "Morgan Lewis — US-India Trade Deal Cuts Tariffs",
    notes: "Tariff on Indian imports rolled back from 50% to 18%. Pairs with 2025-08-06; interval 180 days — the slowest reversal in the set, which is itself the kind of thing a base rate has to hold.",
  },
];

/** Date-only rows are stamped end-of-day UTC. See the header: this is the
 *  conservative direction, so a forward measurement can never begin before the
 *  announcement was public. */
function occurredAt(e: SeedEvent): string {
  return `${e.date}T${e.timeUtc ?? "23:59"}:00.000Z`;
}

function precisionNote(e: SeedEvent): string {
  return e.timeUtc
    ? "precision=intraday (hour cited by source)"
    : "precision=date (stamped end-of-day UTC so forward measurement cannot start before the announcement)";
}

function loadEnv(): void {
  try {
    // .env.local is CRLF on this machine; split on \r?\n, never on "\n" alone.
    for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* env may already be in the environment */ }
}

async function main() {
  const dry = process.argv.includes("--dry");
  loadEnv();

  // Validate EVERYTHING before writing anything. A partial seed would leave the
  // ledger in a state no one chose.
  const observedAt = new Date().toISOString();
  const rows = EVENTS.map((e) => {
    const at = occurredAt(e);
    if (!isKnownEventType(e.event_type)) throw new Error(`unknown event_type: ${e.event_type}`);
    if (!isEventDirection(e.direction)) throw new Error(`bad direction: ${e.direction}`);
    const stamps = checkEventTimestamps(at, observedAt);
    if (!stamps.ok) throw new Error(`${e.event_type} ${e.date}: ${stamps.reason}`);
    return {
      event_type: e.event_type,
      occurred_at: at,
      observed_at: observedAt,
      market: e.market,
      direction: e.direction,
      magnitude: e.magnitude,
      source_url: e.source_url,
      source_name: e.source_name,
      notes: `${e.notes} [${precisionNote(e)}]`,
    };
  });

  const seen = new Set<string>();
  for (const r of rows) {
    const k = `${r.event_type}|${r.market}|${r.occurred_at}`;
    if (seen.has(k)) throw new Error(`duplicate key within seed: ${k}`);
    seen.add(k);
  }

  console.log(`${rows.length} rows validated (${rows.filter((r) => r.market === "us").length} us, ${rows.filter((r) => r.market === "india").length} india)`);
  if (dry) {
    for (const r of rows) console.log(`  ${r.occurred_at}  ${r.market.padEnd(5)}  ${r.event_type.padEnd(26)} ${r.magnitude}`);
    return;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required");
  const svc = createClient(url, key, { auth: { persistSession: false } });

  let inserted = 0;
  let already = 0;
  for (const r of rows) {
    const { error } = await svc.from("market_events").insert(r);
    if (!error) { inserted++; continue; }
    if (/duplicate key|unique/i.test(error.message)) { already++; continue; }
    throw new Error(`${r.event_type} ${r.occurred_at}: ${error.message}`);
  }
  console.log(`inserted ${inserted}, already present ${already}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
