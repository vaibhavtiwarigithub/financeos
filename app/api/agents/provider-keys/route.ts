import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import {
  getProviderKeyStatus, setProviderKey, clearProviderKey, isLLMProvider,
} from "@/lib/llm-keys";

export const dynamic = "force-dynamic";

// Settings-LLM Part 2 — provider API-key management. Owner-gated. Keys are
// WRITE-ONLY: GET returns only {source, last4}, never a raw key. POST stores a
// key in the vault; DELETE reverts a provider to its env var. Values are never
// logged and never echoed back.

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  const providers = await getProviderKeyStatus(svc);
  return NextResponse.json({ ok: true, providers });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }

  const provider = String(body?.provider ?? "");
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  if (!isLLMProvider(provider)) return NextResponse.json({ error: "unknown provider" }, { status: 400 });
  if (key.length < 8) return NextResponse.json({ error: "key too short" }, { status: 400 });

  const svc = createServiceClient();
  try {
    await setProviderKey(svc, provider, key);
  } catch (e: any) {
    // Never surface the key; only the failure reason.
    return NextResponse.json({ error: e?.message ?? "vault write failed" }, { status: 500 });
  }
  // Return fresh status (masked) — never the key.
  const providers = await getProviderKeyStatus(svc);
  return NextResponse.json({ ok: true, providers });
}

export async function DELETE(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const provider = String(new URL(req.url).searchParams.get("provider") ?? "");
  if (!isLLMProvider(provider)) return NextResponse.json({ error: "unknown provider" }, { status: 400 });

  const svc = createServiceClient();
  try {
    await clearProviderKey(svc, provider);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "vault delete failed" }, { status: 500 });
  }
  const providers = await getProviderKeyStatus(svc);
  return NextResponse.json({ ok: true, providers });
}
