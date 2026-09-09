import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const market = req.nextUrl.searchParams.get("market") ?? "us";
  if (market !== "us" && market !== "india") return NextResponse.json({ error: "invalid market" }, { status: 400 });
  const state = req.nextUrl.searchParams.get("state");
  const svc = createServiceClient();
  let q = svc.from("listing_candidates").select("*,issuer_filings(id,form,filed_at,primary_document_url,quality_state)")
    .eq("market", market).order("last_seen_at", { ascending: false }).limit(200);
  if (state) q = q.eq("state", state);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ candidates: data ?? [], influence: "none" });
}
