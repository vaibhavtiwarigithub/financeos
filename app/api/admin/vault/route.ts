// API Key Vault — confirmed owner session only. The service-role client and
// owner check stay server-side; viewers never receive vault access.
import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireOwner } from "@/lib/auth/require-owner"

export const dynamic = "force-dynamic"

function maskKey(k: string): string {
  if (!k || k.length < 8) return "****"
  return k.slice(0, 4) + "•".repeat(Math.min(k.length - 8, 20)) + k.slice(-4)
}

export async function GET() {
  const denied = await requireOwner()
  if (denied) return denied

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
  const denied = await requireOwner()
  if (denied) return denied

  const body = await req.json()
  const { action, ...fields } = body

  const svc = createServiceClient()

  if (action === "upsert") {
    const row: Record<string, unknown> = {
      key_name: fields.key_name,
      display_name: fields.display_name,
      provider: fields.provider,
      model_id: fields.model_id || null,
      tasks_suitable: fields.tasks_suitable ?? [],
      cost_per_1m_input: fields.cost_per_1m_input ?? 0,
      cost_per_1m_output: fields.cost_per_1m_output ?? 0,
      enabled: fields.enabled ?? true,
      notes: fields.notes || null,
      updated_at: new Date().toISOString(),
    }
    // Only update key_value if provided (blank = keep existing)
    if (fields.key_value) row.key_value = fields.key_value

    const { error } = await svc.from("api_key_vault").upsert(row, { onConflict: "key_name" })
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
