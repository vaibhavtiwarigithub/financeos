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
  const { data, error } = await svc.from("api_key_vault")
    .select("id,key_name,key_value,display_name,provider,model_id,tasks_suitable,cost_per_1m_input,cost_per_1m_output,enabled,notes,updated_at")
    .order("provider")
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Mask stored values, also check env for each key
  const rows = (data ?? []).map((r: any) => ({
    id: r.id, key_name: r.key_name, display_name: r.display_name,
    provider: r.provider, model_id: r.model_id, tasks_suitable: r.tasks_suitable,
    cost_per_1m_input: r.cost_per_1m_input, cost_per_1m_output: r.cost_per_1m_output,
    enabled: r.enabled, notes: r.notes, updated_at: r.updated_at,
    key_value: maskKey(r.key_value),
    env_set: !!process.env[r.key_name],
    env_masked: process.env[r.key_name] ? maskKey(process.env[r.key_name]!) : null,
  }))

  return NextResponse.json({ keys: rows }, { headers: { "Cache-Control": "private, no-store" } })
}

export async function POST(req: NextRequest) {
  const denied = await requireOwner()
  if (denied) return denied

  // This endpoint is browser/session-only. Require the actual browser Origin;
  // don't trust forwarded headers or a user-supplied origin allowlist.
  if (req.headers.get("origin") !== new URL(req.url).origin || req.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Same-origin request required" }, { status: 403 })
  }
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return NextResponse.json({ error: "JSON content type required" }, { status: 415 })
  }
  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid request" }, { status: 400 })
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
