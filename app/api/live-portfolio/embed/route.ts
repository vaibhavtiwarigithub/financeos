import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { createHash } from "crypto";

export const dynamic = "force-dynamic";
// Large first-time backfills need Vercel Pro (300s cap) or higher.
export const maxDuration = 300;

// Batch-embed enriched trade_decisions using Voyage AI (voyage-finance-2, 1024-dim).
// Skips rows that already have an embedding (idempotent).
// POST /api/live-portfolio/embed
//   body: { limit?: number }  — max rows to embed per call (default 50, max 200)
// Requires VOYAGE_API_KEY in .env.local.

const VOYAGE_MODEL = "voyage-finance-2";
const EMBED_DIM    = 1024;
const BATCH_SIZE   = 16; // Voyage recommended batch size

function buildContentText(d: any): string {
  const tags = Array.isArray(d.pattern_tags) ? d.pattern_tags.join(", ") : "";
  const outcome = d.outcome_score != null ? `outcome_score=${d.outcome_score}` : "outcome=unknown";
  const regime = d.macro_market_regime ?? "unknown_regime";
  const event = d.macro_event_tag ? ` macro_event=${d.macro_event_tag}` : "";
  const analysis = d.llm_analysis ? ` analysis="${d.llm_analysis.slice(0, 300)}"` : "";
  return `${d.action} ${d.symbol} qty=${d.qty} price=${d.exec_price} date=${d.exec_date} ${outcome} regime=${regime}${event} tags=[${tags}]${analysis}`;
}

async function voyageEmbed(texts: string[], apiKey: string): Promise<number[][]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: VOYAGE_MODEL, input: texts, input_type: "document" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Voyage API error ${res.status}: ${err}`);
  }
  const data = await res.json();
  // Voyage returns items with an explicit `index`; do NOT assume array order.
  // Sort by index so embeddings align to their input texts.
  const items = (data.data as any[]).slice().sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0));
  return items.map((d: any) => d.embedding as number[]);
}

export async function POST(req: NextRequest) {
  // Allow cron calls via x-cron-secret header (same pattern as position-monitor/learner)
  const cronSecret = req.headers.get("x-cron-secret");
  const isCron = cronSecret && cronSecret === process.env.CRON_SECRET;
  if (!isCron) {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "VOYAGE_API_KEY not configured" }, { status: 503 });

  const body = await req.json().catch(() => ({}));
  const limit = Math.min(parseInt(body.limit ?? "50"), 200);

  const svc = createServiceClient();

  // Candidate selection via NOT EXISTS in SQL (migration 047) — bounded,
  // deterministic, index-friendly. Enrichment is final, so an already-embedded
  // decision never needs re-embedding; content_hash is retained only for audit.
  const { data: decisions, error: fetchErr } = await svc
    .rpc("unembedded_trade_decisions" as any, { match_count: limit } as any) as { data: any[] | null; error: any };

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!decisions?.length) return NextResponse.json({ embedded: 0, message: "No unembedded enriched decisions found" });

  let embedded = 0;
  const errors: string[] = [];

  // Process in batches
  for (let i = 0; i < decisions.length; i += BATCH_SIZE) {
    const batch = decisions.slice(i, i + BATCH_SIZE);
    const texts = batch.map((d: any) => buildContentText(d));
    const hashes = texts.map((t: string) => createHash("sha256").update(t).digest("hex"));

    try {
      const vectors = await voyageEmbed(texts, apiKey);
      if (vectors.length !== batch.length) throw new Error(`Embedding count mismatch: got ${vectors.length}, expected ${batch.length}`);

      for (let j = 0; j < batch.length; j++) {
        const vec = vectors[j];
        if (!vec || vec.length !== EMBED_DIM) {
          errors.push(`${(batch[j] as any).id}: bad embedding dim ${vec?.length}`);
          continue;
        }
        if (!vec.every((n: number) => Number.isFinite(n))) {
          errors.push(`${(batch[j] as any).id}: embedding contains non-finite values`);
          continue;
        }
        const { error: insertErr } = await svc.from("trade_decision_embeddings").upsert({
          trade_decision_id: (batch[j] as any).id,
          embedding:         `[${vec.join(",")}]`,
          content_text:      texts[j],
          content_hash:      hashes[j],
          model:             VOYAGE_MODEL,
        }, { onConflict: "trade_decision_id" });

        if (insertErr) errors.push(`${(batch[j] as any).id}: ${insertErr.message}`);
        else embedded++;
      }
    } catch (e: any) {
      errors.push(`batch ${i}-${i + batch.length}: ${e.message}`);
    }
  }

  return NextResponse.json({
    embedded,
    total_candidates: decisions.length,
    errors: errors.length ? errors : undefined,
  });
}

// GET: return embedding coverage stats
export async function GET() {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  const [{ count: total }, { count: embedded }] = await Promise.all([
    svc.from("trade_decisions").select("*", { count: "exact", head: true }).eq("enrichment_status", "enriched"),
    svc.from("trade_decision_embeddings").select("*", { count: "exact", head: true }),
  ]);

  return NextResponse.json({
    enriched_total: total ?? 0,
    embedded: embedded ?? 0,
    pending: Math.max(0, (total ?? 0) - (embedded ?? 0)),
    coverage_pct: total ? Math.round(((embedded ?? 0) / total) * 100) : 0,
    model: VOYAGE_MODEL,
    dim: EMBED_DIM,
  });
}
