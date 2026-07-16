import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import {
  HORIZON_PRESETS, STRATEGY_TILTS, defaultMandate, hydrateMandate,
  type ExistingPositionsPolicy, type HorizonGovernance, type HorizonStyle,
  type StrategyPreference, type TradingMarket,
} from "@/lib/trading-mandate";

export const dynamic = "force-dynamic";

const MARKETS = new Set<TradingMarket>(["us", "india"]);
const GOVERNANCE = new Set<HorizonGovernance>(["user", "agent"]);
const POSITION_POLICIES = new Set<ExistingPositionsPolicy>(["grandfather", "apply"]);

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  const { data, error } = await svc.from("trading_mandates").select("*").order("market");
  if (error) {
    return NextResponse.json({
      mandates: [defaultMandate("us"), defaultMandate("india")],
      degraded: true,
      reason: "Migration 168 is not applied; defaults are shown and cannot be saved.",
    });
  }
  const byMarket = new Map((data ?? []).map((row: any) => [row.market, row]));
  return NextResponse.json({
    mandates: [hydrateMandate("us", byMarket.get("us")), hydrateMandate("india", byMarket.get("india"))],
    degraded: false,
  });
}

export async function PATCH(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const body = await req.json().catch(() => ({}));
  const market = body.market as TradingMarket;
  const style = body.horizon_style as HorizonStyle;
  const preference = body.strategy_preference as StrategyPreference;
  const governance = body.horizon_governance as HorizonGovernance;
  const positionPolicy = body.existing_positions_policy as ExistingPositionsPolicy;
  const maxOpenPositions = Number(body.max_open_positions);
  const maxSignalAgeSessions = Number(body.max_signal_age_sessions);

  if (!MARKETS.has(market)) return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  if (!(style in HORIZON_PRESETS)) return NextResponse.json({ error: "invalid horizon_style" }, { status: 400 });
  if (!(preference in STRATEGY_TILTS)) return NextResponse.json({ error: "invalid strategy_preference" }, { status: 400 });
  if (!GOVERNANCE.has(governance)) return NextResponse.json({ error: "invalid horizon_governance" }, { status: 400 });
  if (!POSITION_POLICIES.has(positionPolicy)) return NextResponse.json({ error: "invalid existing_positions_policy" }, { status: 400 });
  if (!Number.isInteger(maxOpenPositions) || maxOpenPositions < 1 || maxOpenPositions > 50) {
    return NextResponse.json({ error: "max_open_positions must be an integer from 1 to 50" }, { status: 400 });
  }
  if (!Number.isInteger(maxSignalAgeSessions) || maxSignalAgeSessions < 0 || maxSignalAgeSessions > 10) {
    return NextResponse.json({ error: "max_signal_age_sessions must be an integer from 0 to 10" }, { status: 400 });
  }

  const preset = HORIZON_PRESETS[style];
  const svc = createServiceClient();
  const { data: current, error: currentError } = await svc.from("trading_mandates").select("version").eq("market", market).maybeSingle();
  if (currentError) return NextResponse.json({ error: "Apply migration 168 before saving Trading Mandates." }, { status: 503 });
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  const row = {
    market,
    horizon_style: style,
    strategy_preference: preference,
    horizon_governance: governance,
    ...preset,
    max_open_positions: maxOpenPositions,
    max_signal_age_sessions: maxSignalAgeSessions,
    existing_positions_policy: positionPolicy,
    version: Number((current as any)?.version ?? 0) + 1,
    updated_by: user?.id ?? null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await svc.from("trading_mandates").upsert(row, { onConflict: "market" }).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await svc.from("decision_journal").insert({
    entry_type: "trading_mandate_change",
    summary: `${market.toUpperCase()} mandate v${row.version}: ${style}, ${preference}, horizon ${preset.min_hold_days}-${preset.max_hold_days} market days (${governance} governed), max ${maxOpenPositions} open alpha names, score freshness ${maxSignalAgeSessions} sessions, existing positions ${positionPolicy}.`,
    calculations: row,
    has_verified_facts: true,
    has_calculations: true,
    resolved: true,
    resolved_at: new Date().toISOString(),
  }).then(() => {}, () => {});

  return NextResponse.json({ mandate: hydrateMandate(market, data) });
}
