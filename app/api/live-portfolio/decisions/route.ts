import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol");
  const status = url.searchParams.get("status");
  const limit = parseInt(url.searchParams.get("limit") ?? "100");
  const offset = parseInt(url.searchParams.get("offset") ?? "0");

  const svc = createServiceClient();
  let q = svc
    .from("trade_decisions")
    .select("*", { count: "exact" })
    .order("exec_date", { ascending: false })
    .range(offset, offset + limit - 1);

  if (symbol) q = q.eq("symbol", symbol.toUpperCase());
  if (status) q = q.eq("enrichment_status", status);

  const { data, count } = await q;
  return NextResponse.json({ decisions: data ?? [], total: count ?? 0 });
}

export async function DELETE(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const svc = createServiceClient();
  await svc.from("trade_decisions").delete().eq("id", id);
  return NextResponse.json({ deleted: true });
}
