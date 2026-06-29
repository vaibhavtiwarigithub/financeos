import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const svc = createServiceClient();
  const now = new Date().toISOString();
  const { data, error } = await svc
    .from("watchlist")
    .select("id, symbol, source, theme, reason, notes, auto_added, expires_at, created_at")
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data ?? [] });
}

export async function POST(req: NextRequest) {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const symbol = body.symbol?.trim().toUpperCase();
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

  const svc = createServiceClient();
  const { error } = await svc.from("watchlist").upsert({
    user_id: user.id,
    symbol,
    source: body.source ?? "manual",
    theme: body.theme ?? null,
    reason: body.reason ?? null,
    notes: body.notes ?? null,
    auto_added: false,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id,symbol" });

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
  // Allow deleting any row with this symbol (user-owned or agent-added)
  const { error } = await svc.from("watchlist").delete()
    .or(`user_id.eq.${user.id},user_id.is.null`)
    .eq("symbol", symbol);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
