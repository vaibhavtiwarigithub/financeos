import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { subscriptionPrompt, validateSubscriptionResult, workerTokenHash, isWorkerId } from "@/lib/llm-council/subscription";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function readBody(req: NextRequest) {
  const reader = req.body?.getReader();
  if (!reader) throw new Error("empty_body");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 32_768) { await reader.cancel(); throw new Error("body_too_large"); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function POST(req: NextRequest) {
  const hash = workerTokenHash(req.headers.get("authorization"));
  if (!hash) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body;
  try { body = await readBody(req); } catch { return NextResponse.json({ error: "Invalid or oversized JSON" }, { status: 400 }); }

  const svc = createServiceClient();
  if (body?.action === "claim") {
    // The claim RPC already authenticates the token hash and updates the worker
    // heartbeat in the same transaction. Avoid the redundant REST lookup here:
    // it adds a database round trip to every idle poll and places the
    // credential-derived hash in PostgREST's logged request URL.
    const { data: job, error: claimError } = await svc.rpc("council_subscription_claim", { p_token_hash: hash });
    if (claimError) return NextResponse.json({ error: claimError.message === "unauthorized_worker" ? "Unauthorized" : "Could not claim job" }, { status: claimError.message === "unauthorized_worker" ? 401 : 409 });
    return NextResponse.json({ job: job ? { ...job, prompt: subscriptionPrompt(job) } : null }, { headers: { "Cache-Control": "no-store" } });
  }
  if (body?.action !== "submit" || !isWorkerId(body.job_id)) return NextResponse.json({ error: "Invalid action" }, { status: 400 });

  // Keep this identity lookup on submit: the route needs the authenticated
  // worker ID to load the frozen packet and validate citations before invoking
  // the transactional submit RPC.
  const { data: worker, error } = await svc.from("llm_council_workers").select("id").eq("token_sha256", hash).is("revoked_at", null).maybeSingle();
  if (error) return NextResponse.json({ error: "Worker registry unavailable" }, { status: 503 });
  if (!worker) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: job, error: jobError } = await svc.from("llm_council_jobs").select("id,batch_id,expected_model").eq("id", body.job_id).eq("worker_id", worker.id).maybeSingle();
  if (jobError) return NextResponse.json({ error: "Job storage unavailable" }, { status: 503 });
  if (!job) return NextResponse.json({ error: "Unknown job" }, { status: 404 });
  const { data: batch, error: batchError } = await svc.from("llm_council_batches").select("snapshot").eq("id", job.batch_id).single();
  if (batchError) return NextResponse.json({ error: "Packet unavailable" }, { status: 503 });
  try {
    const result = validateSubscriptionResult(body, job, batch.snapshot);
    const { data, error: submitError } = await svc.rpc("council_subscription_submit", {
      p_token_hash: hash, p_job: body.job_id, p_lease: body.lease_id, p_hash: body.input_sha256,
      p_result: result.result, p_result_hash: result.result_hash, p_actual_model: result.actual_model,
      p_tokens_in: result.tokens_in, p_tokens_out: result.tokens_out, p_failure: result.failure_code,
    });
    if (submitError) return NextResponse.json({ error: "Submission refused: check lease, model, master switch or duplicate result" }, { status: 409 });
    return NextResponse.json({ status: data });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Invalid forecast" }, { status: 422 }); }
}
