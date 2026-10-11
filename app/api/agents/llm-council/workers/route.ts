import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { sha256 } from "@/lib/llm-council/core";
import { enqueueSubscription, isWorkerId, isWorkerModel } from "@/lib/llm-council/subscription";
export const dynamic = "force-dynamic";
export async function GET() {
  const gate = await requireOwner(); if (gate) return gate;
  const svc = createServiceClient();
  const [workers, batches] = await Promise.all([
    svc.from("llm_council_workers").select("id,label,family,expected_model,created_at,revoked_at,last_seen_at").order("created_at", { ascending: false }).limit(100),
    svc.from("llm_council_batches").select("id,run_id,synthetic,status,consensus_score,created_at,deadline,completed_at,llm_council_jobs(id,worker_id,round,status,actual_model,tokens_in,tokens_out,failure_code,submitted_at,result)").order("created_at", { ascending: false }).limit(20),
  ]);
  if (workers.error || batches.error) return NextResponse.json({ error: "Could not load subscription evidence" }, { status: 503 });
  return NextResponse.json({ workers: workers.data, batches: batches.data }, { headers: { "Cache-Control": "no-store" } });
}
export async function POST(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const svc = createServiceClient();
  if (body.action === "register") {
    if (!["codex", "claude"].includes(body.family) || !isWorkerModel(body.expected_model) || typeof body.label !== "string" || !body.label.trim() || body.label.length > 80) return NextResponse.json({ error: "Provide a worker name, Claude/Codex family and exact model ID" }, { status: 400 });
    const { count, error: countError } = await svc.from("llm_council_workers").select("id", { count: "exact", head: true }).is("revoked_at", null);
    if (countError || count == null || count >= 10) return NextResponse.json({ error: "At most 10 registered workers; revoke unused workers first" }, { status: 409 });
    const token = `kcw_${randomBytes(32).toString("hex")}`;
    const { data, error } = await svc.from("llm_council_workers").insert({ label: body.label.trim(), family: body.family, expected_model: body.expected_model, token_sha256: sha256(token) }).select("id,label,family,expected_model").single();
    if (error) return NextResponse.json({ error: "Could not register worker" }, { status: 500 });
    return NextResponse.json({ worker: data, token, note: "Shown once. This credential accesses council jobs only; it is not your provider login." }, { headers: { "Cache-Control": "no-store" } });
  }
  if (body.action === "revoke" && isWorkerId(body.worker_id)) {
    const { error } = await svc.from("llm_council_workers").update({ revoked_at: new Date().toISOString() }).eq("id", body.worker_id);
    return NextResponse.json(error ? { error: "Revoke failed" } : { revoked: true }, { status: error ? 500 : 200 });
  }
  if (body.action === "synthetic") {
    if (!Array.isArray(body.worker_ids) || body.worker_ids.length < 1 || body.worker_ids.length > 5 || !body.worker_ids.every(isWorkerId)) return NextResponse.json({ error: "Select 1–5 registered workers" }, { status: 400 });
    const snapshot = { symbol: "TEST-NO-REAL-ASSET", market: "us", observed_at: new Date().toISOString(), synthetic: true, facts: { as_of: "2026-10-10", revenue_growth_pct: 8, debt_to_equity: 0.3, trend_score: 55 }, note: "Synthetic transport test; no real financial instrument or market prediction." };
    try {
      const id = await enqueueSubscription(svc, { subscription_worker_ids: body.worker_ids, debate_rounds: 0 }, snapshot, null, `synthetic:${randomUUID()}`);
      return NextResponse.json({ batch_id: id, synthetic: true });
    } catch { return NextResponse.json({ error: "Could not enqueue synthetic test: check selected workers, diversity and daily cap" }, { status: 409 }); }
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
