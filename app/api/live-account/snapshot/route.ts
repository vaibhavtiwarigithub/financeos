import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// GET — returns latest snapshot (no Robinhood call, just reads cache)
export async function GET() {
  const svc = createServiceClient();
  // Filter to the Trading account (••••8641) — the table holds one row per
  // account_id (unique constraint); without this filter, "most recent" could
  // return a different account's row instead.
  const { data } = await svc
    .from("live_account_snapshots")
    .select("*")
    .eq("account_id", "965848641")
    .order("captured_at", { ascending: false })
    .limit(1)
    .single();

  if (!data) return NextResponse.json({ snapshot: null });
  return NextResponse.json({ snapshot: data });
}

// POST — write a new snapshot (called by research agent after fetching positions)
// Body: { equity, buying_power, portfolio_value, position_count, positions_json }
export async function POST(req: NextRequest) {
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const svc = createServiceClient();

  // live_account_snapshots has a unique constraint on account_id (one row
  // per account, not a history table) — a plain insert crashes with a
  // duplicate-key error on every write after the first. Upsert instead.
  const { data, error } = await svc.from("live_account_snapshots").upsert({
    account_id:      body.account_id ?? "965848641",
    equity:          body.equity ?? null,
    buying_power:    body.buying_power ?? null,
    portfolio_value: body.portfolio_value ?? null,
    position_count:  body.position_count ?? null,
    positions_json:  body.positions_json ?? null,
    captured_at:     new Date().toISOString(),
  }, { onConflict: "account_id" }).select().single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ snapshot: data });
}
