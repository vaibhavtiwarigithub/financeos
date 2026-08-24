import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import {
  EVENT_VOCABULARY,
  checkEventTimestamps,
  eventTypeDefinition,
  isEventDirection,
  isKnownEventType,
  requiresSymbol,
} from "@/lib/events/vocabulary";

export const dynamic = "force-dynamic";

// Market event ledger — manual owner ingest and read.
//
// MEASUREMENT ONLY. Nothing here reaches a score, eligibility, size, entry,
// exit, promotion or broker decision. See features/event-ledger/FEATURE_ARCHITECTURE.md.
//
// Manual entry is the design, not a placeholder. At roughly one event a month
// the ingest volume is trivial, and a hand-entered event with a real
// `occurred_at` and a cited source is worth more than an automated one whose
// timestamp is when a news aggregator noticed it. Look-ahead enters through
// sloppy timestamps, and occurred_at is the field the whole ledger rests on.

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const url = new URL(req.url);
  const type = url.searchParams.get("event_type");
  const market = url.searchParams.get("market");
  if (market && market !== "us" && market !== "india" && market !== "global") {
    return NextResponse.json({ error: "market must be us | india | global" }, { status: 400 });
  }
  const svc = createServiceClient();

  let q = svc.from("market_events")
    .select("id, event_type, occurred_at, observed_at, market, direction, magnitude, source_url, source_name, notes")
    .order("occurred_at", { ascending: false })
    .limit(500);
  if (type) q = q.eq("event_type", type);
  if (market) q = q.in("market", market === "global" ? ["global"] : [market, "global"]);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // n is reported beside every grouping so a count is never read as an estimate.
  const byType = new Map<string, number>();
  for (const row of data ?? []) byType.set(row.event_type, (byType.get(row.event_type) ?? 0) + 1);

  return NextResponse.json({
    events: data ?? [],
    counts: Object.fromEntries(byType),
    vocabulary: EVENT_VOCABULARY,
    // Stated explicitly so a caller cannot mistake a ledger read for a result.
    note: "Ledger contents only. No base rate is computed here; a rate requires matured outcomes and a declared minimum n.",
  });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object" }, { status: 400 });
  }

  const { event_type, occurred_at, market, direction, magnitude, source_url, source_name, notes, symbol } = body as Record<string, unknown>;

  // Fail closed on the vocabulary. An unrecognised type is rejected rather than
  // recorded: a type minted per occurrence cannot be counted, and counting is
  // the only reason this table exists.
  if (!isKnownEventType(event_type)) {
    return NextResponse.json({
      error: `Unknown event_type. Extending the vocabulary is an owner-reviewed edit to lib/events/vocabulary.ts — each new type is another trial against an unresolved false-discovery correction.`,
      known_types: EVENT_VOCABULARY.map((e) => e.type),
    }, { status: 400 });
  }
  if (!isEventDirection(direction)) {
    return NextResponse.json({ error: "direction must be escalation | de_escalation | neutral" }, { status: 400 });
  }
  if (market !== "us" && market !== "india" && market !== "global") {
    return NextResponse.json({ error: "market must be us | india | global" }, { status: 400 });
  }
  if (typeof occurred_at !== "string") {
    return NextResponse.json({ error: "occurred_at is required (ISO timestamp of when the event became PUBLIC)" }, { status: 400 });
  }
  // A source is mandatory. An event with no citation cannot be re-verified, and
  // an unverifiable occurred_at is exactly the look-ahead this guards against.
  if (typeof source_url !== "string" || !/^https?:\/\//i.test(source_url)) {
    return NextResponse.json({ error: "source_url is required and must be an http(s) URL" }, { status: 400 });
  }
  if (typeof source_name !== "string" || !source_name.trim()) {
    return NextResponse.json({ error: "source_name is required" }, { status: 400 });
  }
  if (magnitude != null && !Number.isFinite(Number(magnitude))) {
    return NextResponse.json({ error: "magnitude must be a number or omitted" }, { status: 400 });
  }
  // An idiosyncratic event with no subject has nothing to compute a forward
  // return ON, so it could never mature — it would sit in the ledger forever
  // deflating the base rate's n. Reject it at the door rather than record it.
  if (requiresSymbol(String(event_type)) && (typeof symbol !== "string" || !symbol.trim())) {
    return NextResponse.json({
      error: `${event_type} is a per-company event and requires a subject "symbol". Without one it can never be matured.`,
    }, { status: 400 });
  }

  const observedAt = new Date().toISOString();
  const stamps = checkEventTimestamps(occurred_at, observedAt);
  if (!stamps.ok) return NextResponse.json({ error: stamps.reason }, { status: 400 });

  const svc = createServiceClient();
  const { data, error } = await svc.from("market_events").insert({
    event_type, occurred_at, observed_at: observedAt, market, direction,
    magnitude: magnitude == null ? null : Number(magnitude),
    source_url, source_name: String(source_name).trim(),
    symbol: typeof symbol === "string" && symbol.trim() ? symbol.trim().toUpperCase() : null,
    notes: typeof notes === "string" ? notes : null,
  }).select().single();

  if (error) {
    if (/duplicate key|unique/i.test(error.message)) {
      return NextResponse.json({ error: "An event of this type, market and instant is already recorded." }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const def = eventTypeDefinition(String(event_type));
  return NextResponse.json({
    ok: true,
    event: data,
    magnitude_unit: def?.magnitudeUnit ?? null,
  });
}
