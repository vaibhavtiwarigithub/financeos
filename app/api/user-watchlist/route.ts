// Per-user watchlist: add/remove/list symbols for research tracking.
// Own-data route: every row is keyed to the session user via RLS.
import { NextRequest, NextResponse } from "next/server";
import { getSessionRole } from "@/lib/auth/session-role";
import { createServiceClient } from "@/lib/supabase/service";
import {
  addCloudflareUserWatchlistItem,
  listCloudflareUserWatchlist,
  removeCloudflareUserWatchlistItem,
} from "@/lib/cloudflare/db-gateway";

export const dynamic = "force-dynamic";

export async function GET() {
  const { role, userId } = await getSessionRole();
  if (!role || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let rows: Awaited<ReturnType<typeof listCloudflareUserWatchlist>>;
  try {
    rows = await listCloudflareUserWatchlist(userId);
  } catch {
    return NextResponse.json({ error: "failed to load watchlist" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }

  // Enrich with last research date + score from the owner's agent_signals.
  const keys = rows.map(r => `${r.symbol}:${r.market}`);
  const scoreMap: Record<string, { last_score: number | null; last_researched_at: string | null }> = {};

  if (rows.length) {
    const svc = createServiceClient();
    const { data: scores } = await svc
      .from("agent_signals")
      .select("symbol, market, analyst_score, created_at")
      .in("symbol", rows.map(r => r.symbol))
      .order("created_at", { ascending: false })
      .limit(rows.length * 5); // enough to get latest per symbol

    for (const row of (scores ?? []) as any[]) {
      const key = `${row.symbol}:${row.market}`;
      if (keys.includes(key) && !scoreMap[key]) {
        scoreMap[key] = { last_score: row.analyst_score != null ? Number(row.analyst_score) : null, last_researched_at: row.created_at };
      }
    }
  }

  const items = rows.map(r => ({
    id: r.id,
    symbol: r.symbol,
    market: r.market,
    added_at: r.added_at,
    ...(scoreMap[`${r.symbol}:${r.market}`] ?? { last_score: null, last_researched_at: null }),
  }));

  return NextResponse.json({ items });
}

export async function POST(req: NextRequest) {
  const { role, userId } = await getSessionRole();
  if (!role || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }

  const symbol = String(body?.symbol ?? "").trim().toUpperCase();
  const market = String(body?.market ?? "us").toLowerCase();
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  if (market !== "us" && market !== "india") return NextResponse.json({ error: "market must be us or india" }, { status: 400 });

  try {
    await addCloudflareUserWatchlistItem({ userId, symbol, market });
  } catch {
    return NextResponse.json({ error: "could not add symbol" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
  return NextResponse.json({ ok: true, symbol, market });
}

export async function DELETE(req: NextRequest) {
  const { role, userId } = await getSessionRole();
  if (!role || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const symbol = sp.get("symbol")?.trim().toUpperCase();
  const market = sp.get("market")?.toLowerCase() ?? "us";
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

  if (market !== "us" && market !== "india") return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  try {
    await removeCloudflareUserWatchlistItem({ userId, symbol, market });
  } catch {
    return NextResponse.json({ error: "could not remove symbol" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
  return NextResponse.json({ ok: true });
}
