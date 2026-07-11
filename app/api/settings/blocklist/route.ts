import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { LEVERAGED_INVERSE_ETFS } from "@/lib/trading/symbol-policy";

export const dynamic = "force-dynamic";

// Owner-curated tradable-universe blocklist. Leveraged/inverse ETFs are auto-
// blocked in code (returned here as read-only context). A blocked symbol is
// never scored, never paper-filled, and cannot be ordered.
export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  const { data, error } = await svc.from("symbol_blocklist").select("*").order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ blocklist: data ?? [], auto_leveraged_inverse: [...LEVERAGED_INVERSE_ETFS].sort() });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const body = await req.json().catch(() => ({}));
  const symbol = String(body.symbol ?? "").trim().toUpperCase();
  const market = ["us", "india", "all"].includes(body.market) ? body.market : "all";
  const category = body.category ? String(body.category).slice(0, 40) : "owner";
  const reason = body.reason ? String(body.reason).slice(0, 200) : null;
  if (!symbol || !/^[A-Z0-9.\-]{1,15}$/.test(symbol)) {
    return NextResponse.json({ error: "symbol required (letters/digits/.-, max 15)" }, { status: 400 });
  }
  const svc = createServiceClient();
  const { error } = await svc.from("symbol_blocklist").upsert(
    { symbol, market, category, reason },
    { onConflict: "symbol,market" },
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, symbol, market });
}

export async function DELETE(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const id = new URL(req.url).searchParams.get("id");
  const symbol = new URL(req.url).searchParams.get("symbol");
  if (!id && !symbol) return NextResponse.json({ error: "id or symbol required" }, { status: 400 });
  const svc = createServiceClient();
  let q = svc.from("symbol_blocklist").delete();
  q = id ? q.eq("id", Number(id)) : q.eq("symbol", String(symbol).toUpperCase());
  const { error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
