import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import { fetchQuotes } from "@/lib/india-markets/adapter";
import {
  buildSnapshot,
  computeBreadth,
  INDEX_SYMBOLS,
  SECTOR_SYMBOLS,
  type IndiaMarketsSnapshot,
} from "@/lib/india-markets/snapshot";
import { NIFTY50_UNIVERSE } from "@/lib/india-markets/constituents";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────────────
// India Markets snapshot boundary (display data only — NEVER on the money path).
//
// The browser must not call Yahoo/NSE directly. This route is the ONLY India
// market-data surface: server-side, allowlisted-adapter fetches, paced, cached in
// `india_market_snapshot` (India-only table — never cross-reads US `price_cache`).
//
//   GET  — cache-only: serves the latest frozen snapshot and never contacts a
//          provider from a page request. Empty cache returns honest unavailable.
//   POST — owner/cron-gated FULL fill: indices + sectors + NIFTY-50 breadth
//          (paced), persisted as the durable cache the GET path serves.
// ─────────────────────────────────────────────────────────────────────────────

const HEALTH_KEY = "india-markets-degraded";

interface StoredRow {
  fetched_at: string;
  status: string;
  snapshot: IndiaMarketsSnapshot;
}

async function loadLatest(
  svc: ReturnType<typeof createServiceClient>,
): Promise<StoredRow | null> {
  const { data, error } = await svc
    .from("india_market_snapshot")
    .select("fetched_at, status, snapshot")
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("india_snapshot_read_failed");
  return (data as StoredRow) ?? null;
}

async function persist(
  svc: ReturnType<typeof createServiceClient>,
  snap: IndiaMarketsSnapshot,
): Promise<void> {
  const { error } = await svc.from("india_market_snapshot").insert({
    as_of: snap.asOf,
    fetched_at: snap.fetchedAt,
    status: snap.status,
    snapshot: snap,
  });
  if (error) throw new Error("india_snapshot_write_failed");
}

// GET — public cache-only display read. Market data only, no personal/account
// data. Provider work is exclusively owner/cron-gated POST.
export async function GET() {
  try {
    const latest = await loadLatest(createServiceClient());
    if (latest?.snapshot) return NextResponse.json(latest.snapshot);
  } catch {
    // Return the same bounded unavailable contract on cache read failure. Never
    // leak a database error and never fall through to a provider call.
  }
  return NextResponse.json(buildSnapshot({
    indexQuotes: [],
    sectorQuotes: [],
    breadth: null,
    breadthUnavailableReason: "awaiting_scheduled_fill",
  }));
}

// Full fill including NIFTY-50 breadth. Cron-gated (x-cron-secret) OR owner.
async function runFullFill(): Promise<IndiaMarketsSnapshot> {
  const svc = createServiceClient();
  // One deduplicated stream prevents three concurrent fetch pools from combining
  // into a provider burst. ^NSEBANK is shared by index + sector and is fetched once.
  const allSymbols = [...new Set([
    ...INDEX_SYMBOLS,
    ...SECTOR_SYMBOLS,
    ...NIFTY50_UNIVERSE.symbols,
  ])];
  // One bounded stream. At 5-wide/3.5s timeout the 63-symbol worst-case stays
  // below the 60s route/65s pg_net limits instead of timing out mid-fill.
  const allQuotes = await fetchQuotes(allSymbols, {
    concurrency: 5,
    pacingMs: 500,
    timeoutMs: 3500,
  });
  const bySymbol = new Map(allQuotes.map((quote) => [quote.symbol, quote]));
  const indexQuotes = INDEX_SYMBOLS.flatMap((symbol) => {
    const quote = bySymbol.get(symbol);
    return quote ? [quote] : [];
  });
  const sectorQuotes = SECTOR_SYMBOLS.flatMap((symbol) => {
    const quote = bySymbol.get(symbol);
    return quote ? [quote] : [];
  });
  const constituentQuotes = NIFTY50_UNIVERSE.symbols.flatMap((symbol) => {
    const quote = bySymbol.get(symbol);
    return quote ? [quote] : [];
  });

  const breadth = computeBreadth(constituentQuotes);
  const snap = buildSnapshot({ indexQuotes, sectorQuotes, breadth });

  await persist(svc, snap);

  // System Health — aggregate ONE issue by overall status/coverage, never one
  // alert per symbol. Auto-clears at next UTC midnight.
  if (snap.status === "unavailable") {
    await reportIssue({
      issueKey: HEALTH_KEY,
      severity: "warn",
      category: "data",
      title: "India Markets snapshot unavailable",
      detail: `India index fetch resolved 0 rows via Yahoo. Markets (India) will show a temporarily-unavailable state until a later fill succeeds.`,
      autoExpireAt: nextUtcMidnight(),
    }, svc);
  } else if (snap.status === "partial") {
    const missing = snap.unavailable.map((u) => `${u.component}(${u.reasonCode})`).join(", ");
    await reportIssue({
      issueKey: HEALTH_KEY,
      severity: "warn",
      category: "data",
      title: `India Markets snapshot partial (breadth ${breadth.coveragePct}% coverage)`,
      detail: `Some India components did not resolve this fill: ${missing || "n/a"}. Available rows render with explicit coverage; no healthy-looking total is shown.`,
      autoExpireAt: nextUtcMidnight(),
    }, svc);
  } else {
    await resolveIssue(HEALTH_KEY, svc);
  }

  return snap;
}

function nextUtcMidnight(): string {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

export async function POST(req: NextRequest) {
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  try {
    const snap = await runFullFill();
    return NextResponse.json(snap);
  } catch {
    const svc = createServiceClient();
    await reportIssue({
      issueKey: HEALTH_KEY,
      severity: "warn",
      category: "data",
      title: "India Markets full fill failed",
      detail: "The scheduled India Markets fill failed before a snapshot was durably stored. The last stored snapshot remains in use.",
      autoExpireAt: nextUtcMidnight(),
    }, svc).catch(() => {});
    return NextResponse.json({ error: "india_markets_fill_failed" }, { status: 500 });
  }
}
