import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  // Scoped to one market (briefings.market, migration 085). Unfiltered, the
  // caller's `find(session === "morning")` picked whichever market's briefing was
  // newest and showed it under BOTH markets. Defaults to us when unspecified.
  const market = new URL(req.url).searchParams.get("market") === "india" ? "india" : "us";
  const { data } = await svc
    .from("briefings")
    .select("*")
    .eq("market", market)
    .order("created_at", { ascending: false })
    .limit(14); // 7 days * 2 sessions

  return NextResponse.json({ briefings: data ?? [] });
}

export async function DELETE(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const svc = createServiceClient();
  await svc.from("briefings").delete().eq("id", id);
  return NextResponse.json({ deleted: true });
}
