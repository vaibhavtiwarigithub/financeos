import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";

const ALLOWED = new Set(["SH", "PSQ"]);
const bounded = (value: unknown, min: number, max: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  const [{ data: config, error }, { data: state }, { data: events }] = await Promise.all([
    svc.from("downside_hedge_config").select("*").eq("market", "us").single(),
    svc.from("downside_hedge_state").select("*").eq("market", "us").single(),
    svc.from("downside_hedge_events").select("id,event_type,decision,reason,symbol,created_at").eq("market", "us").order("created_at", { ascending: false }).limit(5),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 503 });
  return NextResponse.json({ config, state, events: events ?? [] });
}

export async function PATCH(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const body = await req.json().catch(() => ({}));
  if (typeof body.enabled !== "boolean" || typeof body.paper_execute_enabled !== "boolean") {
    return NextResponse.json({ error: "enabled and paper_execute_enabled are required" }, { status: 400 });
  }
  if (body.paper_execute_enabled && !body.enabled) {
    return NextResponse.json({ error: "Paper execution requires shadow evaluation to be enabled." }, { status: 400 });
  }
  if (body.paper_execute_enabled && body.confirmation !== "ENABLE PAPER HEDGE") {
    return NextResponse.json({ error: "Type ENABLE PAPER HEDGE to enable simulated execution." }, { status: 400 });
  }

  const symbols: string[] = Array.isArray(body.allowed_symbols)
    ? [...new Set<string>(body.allowed_symbols.map((s: unknown) => String(s).trim().toUpperCase()))]
    : [];
  const target = bounded(body.target_nav_pct, 1, 8);
  const max = bounded(body.max_nav_pct, 1, 10);
  if (!symbols.length || symbols.some((s) => !ALLOWED.has(s)) || target == null || max == null || target > max) {
    return NextResponse.json({ error: "Invalid symbols or NAV limits." }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: state } = await svc.from("downside_hedge_state").select("state").eq("market", "us").single();
  if (!body.enabled && (state?.state === "active" || state?.state === "exit_pending")) {
    return NextResponse.json({ error: "Close the paper hedge before disabling its controller." }, { status: 409 });
  }
  const { data, error } = await svc.from("downside_hedge_config").update({
    enabled: body.enabled,
    paper_execute_enabled: body.paper_execute_enabled,
    allowed_symbols: symbols,
    target_nav_pct: target,
    max_nav_pct: max,
    updated_at: new Date().toISOString(),
  }).eq("market", "us").select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ config: data });
}
