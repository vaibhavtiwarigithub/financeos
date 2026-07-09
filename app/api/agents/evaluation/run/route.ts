import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { runEvaluation } from "@/lib/evaluation/run-evaluation";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const deny = await requireOwner();
  if (deny) return deny;

  let body: { mandateId?: string; market?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const { mandateId, market } = body;
  if (!mandateId || !market) {
    return NextResponse.json({ ok: false, error: "mandateId and market required" }, { status: 400 });
  }
  if (!["us", "india"].includes(market)) {
    return NextResponse.json({ ok: false, error: "market must be us or india" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const result = await runEvaluation(mandateId, market, supabase);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
