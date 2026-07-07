import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

// Owner-only list of the account allowlist, for the Settings account selector.
// Never exposes anything sensitive — account numbers are the user's own.
export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  const { data, error } = await svc.from("broker_accounts").select("broker, market, account_number, label, role").order("market");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ accounts: data ?? [] });
}

// Add an account to the allowlist. Role defaults to view_only — becoming a
// trading target still requires an explicit role='trading' here AND selecting it
// as active_account_* in Settings. No auto-discovery, no bulk import.
export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const body = await req.json().catch(() => ({}));
  const { broker, market, account_number, label, role } = body as Record<string, string>;
  if (!broker || !["us", "india"].includes(market) || !account_number) {
    return NextResponse.json({ error: "broker, market ('us'|'india'), and account_number are required" }, { status: 400 });
  }
  const safeRole = role === "trading" ? "trading" : "view_only";
  const svc = createServiceClient();
  const { error } = await svc.from("broker_accounts").upsert(
    { broker, market, account_number, label: label ?? null, role: safeRole },
    { onConflict: "broker,account_number" }
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
