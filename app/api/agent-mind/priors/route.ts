import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

const CATEGORIES = ["fundamental", "technical", "macro", "insider", "general"] as const;

// GET — all priors grouped by category, plus recent confidence-drift history.
export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  const { data: priors } = await svc
    .from("learning_priors")
    .select("id, category, principle, confidence, source, enabled, notes, created_at")
    .order("confidence", { ascending: false });
  const { data: history } = await svc
    .from("learning_priors_history")
    .select("prior_id, confidence, enabled, changed_at, changed_by, reason")
    .order("changed_at", { ascending: false })
    .limit(200);
  return NextResponse.json({ priors: priors ?? [], history: history ?? [] });
}

// PATCH — owner curation of a prior (toggle enabled, edit text/confidence) or
// add a new one. Every change appends a learning_priors_history row and is
// logged to decision_journal as a human action. No LLM ever writes here.
export async function PATCH(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  const body = await req.json().catch(() => ({}));
  const { action } = body as { action?: string };

  if (action === "add") {
    const { category, principle, confidence, source } = body as Record<string, any>;
    if (!CATEGORIES.includes(category)) return NextResponse.json({ error: `category must be one of ${CATEGORIES.join(", ")}` }, { status: 400 });
    if (!principle || String(principle).trim().length < 8) return NextResponse.json({ error: "principle text too short" }, { status: 400 });
    const conf = Number(confidence);
    if (!Number.isFinite(conf) || conf < 0 || conf > 1) return NextResponse.json({ error: "confidence must be 0..1" }, { status: 400 });
    const { data, error } = await svc.from("learning_priors")
      .insert({ category, principle: String(principle).trim(), confidence: conf, source: source ?? "user", enabled: true })
      .select("id").single();
    if (error) return NextResponse.json({ error: error.message }, { status: error.code === "23505" ? 409 : 500 });
    const id = (data as any).id;
    await svc.from("learning_priors_history").insert({ prior_id: id, confidence: conf, enabled: true, changed_by: "user", reason: "created by user" });
    await svc.from("decision_journal").insert({ entry_type: "prior_change", summary: `User added prior (${category}): ${String(principle).slice(0, 120)}`, has_verified_facts: false, resolved: true }).then(() => {}, () => {});
    return NextResponse.json({ ok: true, id });
  }

  // Edit / toggle an existing prior.
  const { id, enabled, confidence, principle } = body as Record<string, any>;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const update: Record<string, any> = {};
  if (enabled !== undefined) update.enabled = !!enabled;
  if (confidence !== undefined) {
    const conf = Number(confidence);
    if (!Number.isFinite(conf) || conf < 0 || conf > 1) return NextResponse.json({ error: "confidence must be 0..1" }, { status: 400 });
    update.confidence = conf;
  }
  if (principle !== undefined) {
    if (String(principle).trim().length < 8) return NextResponse.json({ error: "principle text too short" }, { status: 400 });
    update.principle = String(principle).trim();
  }
  if (Object.keys(update).length === 0) return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  const { data: updated, error } = await svc.from("learning_priors").update(update).eq("id", id).select("id, confidence, enabled, category, principle").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await svc.from("learning_priors_history").insert({
    prior_id: id, confidence: (updated as any).confidence, enabled: (updated as any).enabled, changed_by: "user", reason: "edited by user",
  });
  await svc.from("decision_journal").insert({ entry_type: "prior_change", summary: `User updated prior #${id} (${(updated as any).category}): ${JSON.stringify(update)}`, has_verified_facts: false, resolved: true }).then(() => {}, () => {});
  return NextResponse.json({ ok: true });
}
