// API Key Vault — requires Supabase session (admin email) + X-Vault-Pin header
// Add VAULT_PIN=fos-vault-2026 to your .env.local before using this route.
import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { createClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

function maskKey(k: string): string {
  if (!k || k.length < 8) return "****"
  return k.slice(0, 4) + "•".repeat(Math.min(k.length - 8, 20)) + k.slice(-4)
}

export async function GET(req: NextRequest) {
  // Auth: must be signed in as admin
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user || user.email !== process.env.ADMIN_EMAIL) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Extra: vault PIN check
  const pin = req.headers.get("x-vault-pin")
  if (pin !== process.env.VAULT_PIN) {
    return NextResponse.json({ error: "Vault locked — PIN required" }, { status: 403 })
  }

  const svc = createServiceClient()
  const { data, error } = await svc.from("api_key_vault").select("*").order("provider")
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Mask stored values, also check env for each key
  const rows = (data ?? []).map((r: any) => ({
    ...r,
    key_value: maskKey(r.key_value),
    env_set: !!process.env[r.key_name],
    env_masked: process.env[r.key_name] ? maskKey(process.env[r.key_name]!) : null,
  }))

  return NextResponse.json({ keys: rows })
}

export async function POST(req: NextRequest) {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user || user.email !== process.env.ADMIN_EMAIL) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const pin = req.headers.get("x-vault-pin")
  if (pin !== process.env.VAULT_PIN) {
    return NextResponse.json({ error: "Vault locked" }, { status: 403 })
  }

  const body = await req.json()
  const { action, ...fields } = body

  const svc = createServiceClient()

  if (action === "upsert") {
    const { error } = await svc.from("api_key_vault").upsert({
      key_name: fields.key_name,
      key_value: fields.key_value,
      display_name: fields.display_name,
      provider: fields.provider,
      model_id: fields.model_id,
      tasks_suitable: fields.tasks_suitable ?? [],
      cost_per_1m_input: fields.cost_per_1m_input ?? 0,
      cost_per_1m_output: fields.cost_per_1m_output ?? 0,
      enabled: fields.enabled ?? true,
      notes: fields.notes ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "key_name" })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if (action === "toggle") {
    const { error } = await svc.from("api_key_vault")
      .update({ enabled: fields.enabled })
      .eq("key_name", fields.key_name)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 })
}
