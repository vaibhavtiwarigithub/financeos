import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

// GET /api/agents/edge-status?market=us|india
// Returns: edges with latest IC snapshot + IC history (2 most recent window_ends) for sparkline.
export async function GET(req: NextRequest) {
  const authErr = await requireOwner();
  if (authErr) return authErr;

  const market = req.nextUrl.searchParams.get("market") === "india" ? "india" : "us";
  const svc = createServiceClient();

  const [{ data: catalog }, { data: icHistory }, { data: icLatest }] = await Promise.all([
    svc.from("edge_catalog").select("edge_id, name, category, rationale, expected_sign, horizon_days, status").order("category").order("edge_id"),
    // full IC history for sparkline (last 10 window_ends per edge)
    svc.from("edge_ic_history")
      .select("edge_id, market, window_end, ic, ic_ir, t_stat, n_obs, status_after")
      .eq("market", market)
      .order("window_end", { ascending: false })
      .limit(500),
    // best-segment row per edge (highest n_obs per window_end)
    svc.from("edge_ic_history")
      .select("edge_id, market, window_end, ic, ic_ir, t_stat, n_obs, status_after")
      .eq("market", market)
      .order("window_end", { ascending: false })
      .order("n_obs", { ascending: false })
      .limit(200),
  ]);

  // Deduplicate: best row per (edge_id, window_end) = highest n_obs
  const bestPerWindow = new Map<string, Record<string, any>>();
  for (const row of icHistory ?? []) {
    const k = `${row.edge_id}:${row.window_end}`;
    if (!bestPerWindow.has(k) || (row.n_obs ?? 0) > (bestPerWindow.get(k)!.n_obs ?? 0)) {
      bestPerWindow.set(k, row);
    }
  }

  // Group history by edge_id, sorted by window_end asc
  const historyByEdge = new Map<string, any[]>();
  for (const row of Array.from(bestPerWindow.values()).sort((a, b) => a.window_end.localeCompare(b.window_end))) {
    if (!historyByEdge.has(row.edge_id)) historyByEdge.set(row.edge_id, []);
    historyByEdge.get(row.edge_id)!.push(row);
  }

  // Latest snapshot per edge (most recent window_end, best n_obs)
  const latestByEdge = new Map<string, any>();
  for (const row of icLatest ?? []) {
    if (!latestByEdge.has(row.edge_id)) latestByEdge.set(row.edge_id, row);
  }

  const edges = (catalog ?? []).map((e: Record<string, unknown>) => ({
    ...e,
    latest: latestByEdge.get(e.edge_id as string) ?? null,
    history: historyByEdge.get(e.edge_id as string) ?? [],
  }));

  return NextResponse.json({ edges, market });
}
