import { NextRequest, NextResponse } from "next/server";
import { requireViewerOrOwner } from "@/lib/auth/session-role";
import { createServiceClient } from "@/lib/supabase/service";
import { buildPositionActivitySeries, buildPositionHistorySeries, type PositionActivityRow, type PositionMarkRow } from "@/lib/portfolio/position-history";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 500;
const MAX_MARKS = 10_000;
const MAX_ACTIVITY_ROWS = 10_000;

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
    .select("id, symbol, qty, opened_at, position_role")
    .eq("market", market)
    .in("id", requestedIds);
  if (positionError) return privateJson({ error: "Position history unavailable" }, 503);

  const activePositions = (positions ?? []) as Array<{ id: string; symbol: string; qty: number | string; opened_at: string | null; position_role: string | null }>;
  const verifiedIds = activePositions.map(p => p.id);
  const emptySeries = Object.fromEntries(activePositions.map(p => [p.id, {
    symbol: p.symbol, points: [], asOf: null, status: "unavailable" as const,
  }]));
  if (!verifiedIds.length) return privateJson({ market, series: {}, activity: {} });

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
    if (error) break; // Preserve execution activity even when optional daily marks are absent.
    marks.push(...((data ?? []) as PositionMarkRow[]));
    if (!data || data.length < PAGE_SIZE) break;
  }

  const trades: PositionActivityRow[] = [];
  let activityTruncated = false;
  let activityUnavailable = false;
  const symbols = [...new Set(activePositions.map(p => p.symbol))];
  const oldestOpenedAt = activePositions.map(p => p.opened_at).filter((v): v is string => !!v).sort()[0];
  if (oldestOpenedAt && symbols.length) {
    for (let offset = 0; offset < MAX_ACTIVITY_ROWS; offset += PAGE_SIZE) {
      let query = sb.from("paper_trades")
        .select("id,market,symbol,order_side,qty,fill_price,executed_at,signal_id,paper_event_id,position_role,exit_price,exit_reason,exit_at,closed_at,partial_exit_lot")
        .eq("market", market).in("symbol", symbols).gte("executed_at", oldestOpenedAt)
        .order("executed_at", { ascending: true }).order("id", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      const { data, error } = await query;
      if (error) {
        activityUnavailable = true;
        break;
      }
      trades.push(...((data ?? []) as PositionActivityRow[]));
      if (!data || data.length < PAGE_SIZE) break;
      if (offset + PAGE_SIZE >= MAX_ACTIVITY_ROWS) activityTruncated = true;
    }
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
  const activity = Object.fromEntries(activePositions.map(p => {
    const value = buildPositionActivitySeries({
      positionId: p.id, symbol: p.symbol, market, positionRole: p.position_role,
      openedAt: p.opened_at, currentQty: Number(p.qty), rows: trades,
    });
    if ((activityTruncated || activityUnavailable) && value.status === "ready") return [p.id, { ...value, events: [], status: "unavailable" as const }];
    return [p.id, value];
  }));
  return privateJson({ market, series, activity, historyUnavailable: marks.length === 0 });
}
