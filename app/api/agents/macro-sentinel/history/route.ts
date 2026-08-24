import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  const { data: regimes, error: regimesError } = await svc
    .from("macro_regime")
    .select("*")
    .order("week_of", { ascending: false })
    .limit(52); // 1 year

  if (regimesError) {
    return NextResponse.json({ error: regimesError.message }, { status: 500 });
  }

  const { data: latest_signals, error: signalsError } = await svc
    .from("macro_signals")
    .select("*")
    .eq("week_of", regimes?.[0]?.week_of ?? new Date().toLocaleDateString("en-CA"))
    .order("week_of", { ascending: false });

  if (signalsError) {
    return NextResponse.json({ error: signalsError.message }, { status: 500 });
  }

  return NextResponse.json({ regimes: regimes ?? [], latest_signals: latest_signals ?? [] });
}
