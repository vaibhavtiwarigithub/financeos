import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { checkKillSwitches, type TradingBook } from "@/lib/kill-switches";
import { setMarketTrading } from "@/lib/market-controls";
import { resolveIssue } from "@/lib/system-health";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

type Market = "us" | "india";

function validMarket(value: unknown): value is Market {
  return value === "us" || value === "india";
}

function validBook(value: unknown): value is TradingBook {
  return value === "paper" || value === "live";
}

function inferBook(reason: unknown): TradingBook | null {
  const match = /^\[(paper|live)\]/.exec(String(reason ?? ""));
  return match?.[1] === "paper" || match?.[1] === "live" ? match[1] : null;
}

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  const { data, error } = await svc
    .from("market_controls")
    .select("market,paused,trading_enabled,paused_reason,paused_at,updated_at")
    .order("market");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    markets: (data ?? []).map((row: any) => ({ ...row, trip_book: inferBook(row.paused_reason) })),
  });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const body = await req.json().catch(() => ({}));
  if (!validMarket(body.market) || !validBook(body.book) || body.acknowledged !== true) {
    return NextResponse.json({ error: "market, book, and acknowledged=true are required" }, { status: 400 });
  }

  const market = body.market;
  const book = body.book;
  const svc = createServiceClient();
  const { data: control, error: controlError } = await svc
    .from("market_controls")
    .select("market,paused,trading_enabled,paused_reason")
    .eq("market", market)
    .limit(1)
    .maybeSingle();
  if (controlError || !control) {
    return NextResponse.json({ error: controlError?.message ?? "Market control missing" }, { status: 500 });
  }
  if ((control as any).paused) {
    return NextResponse.json({ error: "Market entry pause is still active; resume it separately before resetting trading." }, { status: 409 });
  }
  if ((control as any).trading_enabled === true) {
    return NextResponse.json({ ok: true, already_enabled: true, market, book });
  }

  const trippedBook = inferBook((control as any).paused_reason);
  if (trippedBook && trippedBook !== book) {
    return NextResponse.json({ error: `This latch was tripped by the ${trippedBook} book; reset that book instead.` }, { status: 409 });
  }

  const check = await checkKillSwitches(svc, { market, book, resolveAlerts: false });
  if (!check.safe) {
    return NextResponse.json({ error: check.reason ?? "Kill-switch conditions still fail", check }, { status: 409 });
  }

  const { data: journal, error: journalError } = await svc.from("decision_journal").insert({
    entry_type: "market_control",
    market,
    summary: `${market.toUpperCase()} ${book} kill-switch reset approved after all current breaker checks passed.`,
    calculations: { market, book, breaker_result: check },
    has_verified_facts: true,
    has_calculations: true,
    has_user_decisions: true,
    resolved: false,
  }).select("id").single();
  if (journalError || !journal) {
    return NextResponse.json({ error: `Reset audit write failed: ${journalError?.message ?? "unknown"}` }, { status: 500 });
  }

  try {
    await setMarketTrading(svc, market, true);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Market reset failed" }, { status: 500 });
  }

  await Promise.all([
    resolveIssue(`killswitch:${market}:${book}`, svc),
    resolveIssue(`killswitch:${market}`, svc),
    svc.from("decision_journal").update({ resolved: true, resolved_at: new Date().toISOString() }).eq("id", (journal as any).id),
  ]);

  return NextResponse.json({ ok: true, market, book, check });
}
