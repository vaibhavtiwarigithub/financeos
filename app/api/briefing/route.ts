import { NextRequest, NextResponse } from "next/server";
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

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const svc = createServiceClient();
  await svc.from("briefings").delete().eq("id", id);
  return NextResponse.json({ deleted: true });
}
