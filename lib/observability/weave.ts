// lib/observability/weave.ts — RAG observability sink (Tier-3 #11 + Tier-4 #14)
//
// One entry point, `traceRag`, that records a RAG span to two places:
//   1. rag_traces (migration 119) — durable, in-app queryable, the source of
//      truth. Always written (best-effort; never throws).
//   2. WandB Weave — mirrored ONLY when WANDB_API_KEY is set. Weave gives the
//      hosted trace UI (span tree, latencies, filter decisions). If the key is
//      absent or the call fails, we silently skip it; the DB row still exists.
//
// Design: fire-and-forget from the caller's perspective. A tracing failure must
// never break research/indexing (graceful-degradation idiom, same as Langfuse).

import { createServiceClient } from "@/lib/supabase/service";

export type RagOp = "retrieve" | "rerank" | "filter" | "index";

export interface RagTrace {
  op: RagOp;
  source?: string;
  symbol?: string | null;
  market?: string | null;
  span?: Record<string, unknown>;
  /** Binary-context-filter summary: {kept, rejected, reasons}. Tier-3 #11. */
  filter?: { kept: number; rejected: number; reasons?: string[] } | null;
  latencyMs?: number;
  ok?: boolean;
  err?: string | null;
}

function wandbKey(): string | null {
  const k = process.env.WANDB_API_KEY;
  return k && k.trim() ? k.trim() : null;
}

const WANDB_PROJECT = process.env.WANDB_PROJECT || "kairos-rag";
const WANDB_ENTITY = process.env.WANDB_ENTITY || null;

/**
 * Record a RAG span. Writes the durable rag_traces row and, if configured,
 * mirrors to WandB Weave. Awaitable but safe to fire-and-forget; never throws.
 */
export async function traceRag(t: RagTrace): Promise<void> {
  // 1) Durable DB row — source of truth.
  try {
    const svc = createServiceClient();
    await svc.from("rag_traces").insert({
      op: t.op,
      source: t.source ?? null,
      symbol: t.symbol ?? null,
      market: t.market ?? null,
      span: t.span ?? {},
      filter: t.filter ?? null,
      latency_ms: t.latencyMs ?? null,
      ok: t.ok ?? true,
      err: t.err ?? null,
    });
  } catch {
    // swallow — observability must not break the caller
  }

  // 2) Optional WandB Weave mirror.
  const key = wandbKey();
  if (key) {
    try {
      await mirrorToWeave(key, t);
    } catch {
      // swallow
    }
  }
}

// WandB Weave trace ingestion. Uses the public Weave trace REST endpoint so we
// carry no heavy SDK into the Next.js server bundle. Best-effort: a non-2xx or
// network error is swallowed by the caller's try/catch.
//
// Endpoint shape follows Weave's /call/start ingestion contract. Entity/project
// come from env; if WANDB_ENTITY is unset we let the server infer the default
// entity from the API key.
async function mirrorToWeave(key: string, t: RagTrace): Promise<void> {
  const project = WANDB_ENTITY
    ? `${WANDB_ENTITY}/${WANDB_PROJECT}`
    : WANDB_PROJECT;

  const body = {
    start: {
      project_id: project,
      op_name: `rag.${t.op}`,
      // Weave wants ISO start/end; we log a point event (start≈end).
      started_at: new Date().toISOString(),
      inputs: {
        source: t.source ?? null,
        symbol: t.symbol ?? null,
        market: t.market ?? null,
        ...(t.span ?? {}),
      },
      attributes: {
        filter: t.filter ?? null,
        latency_ms: t.latencyMs ?? null,
        ok: t.ok ?? true,
      },
    },
  };

  const res = await fetch("https://trace.wandb.ai/call/start", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // WandB uses HTTP basic auth with api as the username.
      authorization: `Basic ${Buffer.from(`api:${key}`).toString("base64")}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Read+discard so the socket frees; failure is intentionally swallowed.
    await res.text().catch(() => "");
    throw new Error(`weave ${res.status}`);
  }
}

/** True when the hosted Weave mirror is configured. */
export function weaveEnabled(): boolean {
  return wandbKey() !== null;
}
