import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;

  const svc = createServiceClient();
  const { data } = await svc
    .from("uploaded_trade_files")
    .select("*")
    .order("uploaded_at", { ascending: false });
  return NextResponse.json({ files: data ?? [] });
}

export async function DELETE(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const svc = createServiceClient();

  // Get filename first so we can delete its decisions
  const { data: file } = await svc
    .from("uploaded_trade_files")
    .select("filename")
    .eq("id", id)
    .single();

  if (file?.filename) {
    await svc.from("trade_decisions").delete().eq("source_file", file.filename);
  }
  await svc.from("uploaded_trade_files").delete().eq("id", id);
  return NextResponse.json({ deleted: true });
}
