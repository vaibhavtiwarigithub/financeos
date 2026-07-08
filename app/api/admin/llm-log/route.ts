// GET /api/admin/llm-log?days=7&model=all
// Returns LLM call history with aggregated cost totals
import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireOwner } from "@/lib/auth/require-owner"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const gate = await requireOwner()
  if (gate) return gate
  const days = parseInt(req.nextUrl.searchParams.get("days") ?? "7")
  const model = req.nextUrl.searchParams.get("model")
  const svc = createServiceClient()

  const since = new Date(Date.now() - days * 86400000).toISOString()
  let q = svc
    .from("llm_call_log")
    .select("*")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(500)
  if (model && model !== "all") q = q.eq("model", model)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Aggregate costs by model
  const byModel: Record<
    string,
    { calls: number; tokens_in: number; tokens_out: number; cost_usd: number; errors: number }
  > = {}
  for (const row of data ?? []) {
    const m = row.model
    if (!byModel[m]) byModel[m] = { calls: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, errors: 0 }
    byModel[m].calls++
    byModel[m].tokens_in += row.tokens_in ?? 0
    byModel[m].tokens_out += row.tokens_out ?? 0
    byModel[m].cost_usd += Number(row.cost_usd ?? 0)
    if (!row.success) byModel[m].errors++
  }

  const totalCost = Object.values(byModel).reduce((s, m) => s + m.cost_usd, 0)

  return NextResponse.json({ logs: data, byModel, totalCost, days })
}
