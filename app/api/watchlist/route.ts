import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

async function fetchCompanyName(symbol: string): Promise<string | null> {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(
      `https://www.alphavantage.co/query?function=COMPANY_OVERVIEW&symbol=${symbol}&apikey=${apiKey}`
    );
    const data = await res.json();
    return data.Name || null;
  } catch {
    return null;
  }
}

export async function GET() {
  const svc = createServiceClient();
  const now = new Date().toISOString();
  const { data, error } = await svc
    .from("watchlist")
    .select("id, symbol, source, theme, reason, notes, auto_added, expires_at, created_at, research_enabled, alert_on_signal, alert_on_earnings, company_name")
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Dedupe by symbol. Auto-added rows (theme-scout, briefing, etc.) can have a
  // null user_id, which means the DB's unique(user_id, symbol) constraint never
  // catches repeat inserts for the same symbol (NULL <> NULL in Postgres). Keep
  // the most recent row per symbol so the list — and any count derived from it —
  // reflects the real distinct number of symbols being tracked/researched.
  const bySymbol = new Map<string, (typeof data)[number]>();
  for (const row of data ?? []) {
    const existing = bySymbol.get(row.symbol);
    if (!existing || new Date(row.created_at).getTime() > new Date(existing.created_at).getTime()) {
      bySymbol.set(row.symbol, row);
    }
  }
  const deduped = [...bySymbol.values()].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return NextResponse.json({ items: deduped });
}

export async function POST(req: NextRequest) {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const symbol = body.symbol?.trim().toUpperCase();
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

  const company_name = body.company_name ?? await fetchCompanyName(symbol);

  const svc = createServiceClient();
  const { error } = await svc.from("watchlist").upsert({
    user_id: user.id,
    symbol,
    source: body.source ?? "manual",
    theme: body.theme ?? null,
    reason: body.reason ?? null,
    notes: body.notes ?? null,
    company_name: company_name ?? null,
    auto_added: false,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id,symbol" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

// PATCH — toggle research_enabled / alert_on_signal / alert_on_earnings per symbol
export async function PATCH(req: NextRequest) {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const symbol = body.symbol?.trim().toUpperCase();
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

  const allowed = ["research_enabled", "alert_on_signal", "alert_on_earnings", "notes"];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) {
    if (k in body) patch[k] = body[k];
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  const svc = createServiceClient();
  const { error } = await svc.from("watchlist")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("symbol", symbol);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol")?.toUpperCase();
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

  const svc = createServiceClient();
  const { error } = await svc.from("watchlist").delete()
    .or(`user_id.eq.${user.id},user_id.is.null`)
    .eq("symbol", symbol);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
