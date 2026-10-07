import { NextRequest, NextResponse } from "next/server";
import { requireViewerOrOwner } from "@/lib/auth/session-role";
import { createServiceClient } from "@/lib/supabase/service";
import { buildPositionHistorySeries, type PositionMarkRow } from "@/lib/portfolio/position-history";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 500;
const MAX_MARKS = 10_000;

function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(req: NextRequest) {
  const { gate } = await requireViewerOrOwner(req);
  if (gate) return gate;

  const sp = req.nextUrl.searchParams;
  const market = sp.get("market")?.toLowerCase();
  if (market !== "us" && market !== "india") {
    return privateJson({ error: "market must be us or india" }, 400);
  }
  const requestedIds = [...new Set((sp.get("positionIds") ?? "").split(",").map(s => s.trim()).filter(Boolean))];
  if (!requestedIds.length) return privateJson({ market, series: {} });
  if (requestedIds.length > 8 || requestedIds.some(id => !UUID.test(id))) {
    return privateJson({ error: "positionIds must contain at most eight valid IDs" }, 400);
  }

  const sb = createServiceClient();
  const { data: positions, error: positionError } = await sb.from("paper_positions")
    .select("id, symbol, opened_at")
    .eq("market", market)
    .in("id", requestedIds);
  if (positionError) return privateJson({ error: "Position history unavailable" }, 503);

  const activePositions = (positions ?? []) as Array<{ id: string; symbol: string; opened_at: string | null }>;
  const verifiedIds = activePositions.map(p => p.id);
  const emptySeries = Object.fromEntries(activePositions.map(p => [p.id, {
    symbol: p.symbol, points: [], asOf: null, status: "unavailable" as const,
  }]));
  if (!verifiedIds.length) return privateJson({ market, series: {} });

  const oldestOpenedDate = activePositions
    .map(p => p.opened_at?.slice(0, 10))
    .filter((d): d is string => !!d)
    .sort()[0];

  const marks: PositionMarkRow[] = [];
  for (let offset = 0; offset < MAX_MARKS; offset += PAGE_SIZE) {
    let query = sb.from("paper_position_marks")
      .select("position_id, symbol, market, session_date, recorded_at, mark_price, provenance, stale, source")
      .eq("market", market)
      .in("position_id", verifiedIds)
      // Keep the newest observations if an unusually long position exceeds the
      // hard response cap; the UI labels that truncated window explicitly.
      .order("session_date", { ascending: false })
      .order("recorded_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    if (oldestOpenedDate) query = query.gte("session_date", oldestOpenedDate);
    const { data, error } = await query;
    if (error) {
      // Keep the portfolio page usable if the optional mark ledger is unavailable.
      return privateJson({ market, series: emptySeries, historyUnavailable: true });
    }
    marks.push(...((data ?? []) as PositionMarkRow[]));
    if (!data || data.length < PAGE_SIZE) break;
  }

  const series = Object.fromEntries(activePositions.map(p => {
    const value = buildPositionHistorySeries({
      positionId: p.id,
      symbol: p.symbol,
      market,
      openedAt: p.opened_at,
      rows: marks,
    });
    if (marks.length >= MAX_MARKS) value.truncated = true;
    return [p.id, value];
  }));
  return privateJson({ market, series });
}
