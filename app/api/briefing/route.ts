import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const svc = createServiceClient();
  const { data } = await svc
    .from("briefings")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(14); // 7 days * 2 sessions

  return NextResponse.json({ briefings: data ?? [] });
}
