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
  type BreadthBlock,
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
//   GET  — cache-first, bounded, LIGHT: serves the latest frozen snapshot; on a
//          stale/empty cache it refreshes only indices+sectors (14 symbols) inline
//          and CARRIES breadth forward from the last full fill. Never bursts the
//          provider with 50 constituent calls on page load.
//   POST — owner/cron-gated FULL fill: indices + sectors + NIFTY-50 breadth
//          (paced), persisted as the durable cache the GET path serves.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_FRESH_MS = 10 * 60 * 1000; // serve stored snapshot as-is when younger
const HEALTH_KEY = "india-markets-degraded";

interface StoredRow {
  fetched_at: string;
  status: string;
  snapshot: IndiaMarketsSnapshot;
}

async function loadLatest(
  svc: ReturnType<typeof createServiceClient>,
): Promise<StoredRow | null> {
  const { data } = await svc
    .from("india_market_snapshot")
    .select("fetched_at, status, snapshot")
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as StoredRow) ?? null;
}

async function persist(
  svc: ReturnType<typeof createServiceClient>,
  snap: IndiaMarketsSnapshot,
): Promise<void> {
  await svc.from("india_market_snapshot").insert({
    as_of: snap.asOf,
    fetched_at: snap.fetchedAt,
    status: snap.status,
    snapshot: snap,
  });
}

// GET — public display read. Market data only, no personal/account data, so it
// mirrors the US /api/markets/overview GET (not owner-gated). Bounded by design.
export async function GET() {
  const svc = createServiceClient();
  const latest = await loadLatest(svc);

  if (latest && Date.now() - new Date(latest.fetched_at).getTime() < CACHE_FRESH_MS) {
    return NextResponse.json(latest.snapshot);
  }

  // Cache stale/empty → refresh indices+sectors only (light), carry breadth.
  const carriedBreadth: BreadthBlock | null = latest?.snapshot?.breadth ?? null;
  let snap: IndiaMarketsSnapshot;
  try {
    const [indexQuotes, sectorQuotes] = await Promise.all([
      fetchQuotes(INDEX_SYMBOLS, { concurrency: 4 }),
      fetchQuotes(SECTOR_SYMBOLS, { concurrency: 4 }),
    ]);
    snap = buildSnapshot({ indexQuotes, sectorQuotes, breadth: carriedBreadth });
    // Best-effort persist; a failed write must not break the response.
    try { await persist(svc, snap); } catch { /* serve fetched snapshot anyway */ }
  } catch {
    // Total failure → serve last good snapshot if we have one, else an honest
    // unavailable snapshot. Loading always exits.
    if (latest?.snapshot) return NextResponse.json(latest.snapshot);
    snap = buildSnapshot({ indexQuotes: [], sectorQuotes: [], breadth: carriedBreadth });
  }
  return NextResponse.json(snap);
}

// Full fill including NIFTY-50 breadth. Cron-gated (x-cron-secret) OR owner.
async function runFullFill(): Promise<IndiaMarketsSnapshot> {
  const svc = createServiceClient();
  const [indexQuotes, sectorQuotes, constituentQuotes] = await Promise.all([
    fetchQuotes(INDEX_SYMBOLS, { concurrency: 4 }),
    fetchQuotes(SECTOR_SYMBOLS, { concurrency: 4 }),
    fetchQuotes(NIFTY50_UNIVERSE.symbols, { concurrency: 5, pacingMs: 200 }),
  ]);

  const breadth = computeBreadth(constituentQuotes);
  const snap = buildSnapshot({ indexQuotes, sectorQuotes, breadth });

  try { await persist(svc, snap); } catch { /* health reported below */ }

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
  const snap = await runFullFill();
  return NextResponse.json(snap);
}
