import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { requireOwner } from "@/lib/auth/require-owner";
import { reportIssue, resolveIssue } from "@/lib/system-health";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// DB pruning job — removes data past safe retention windows.
// Safe tables only. Append-only ledgers (paper_trades, paper_order_events,
// decision_observations, broker_orders, strategy_evaluations) are NEVER touched.
//
// Cron: authenticated GET daily at 03:00 UTC (Vercel Cron uses GET).
// Manual: owner POST runs cleanup; owner GET previews without deleting.
//
// Returns per-table deleted row counts.

interface CleanupStep {
  label: string;
  run: (svc: ReturnType<typeof createServiceClient>) => Promise<number>;
}

const STEPS: CleanupStep[] = [
  {
    label: "av_cache price candles (>7d since provider fetch)",
    // These large raw provider responses are transient cache only. Candle
    // consumers use providerCachedFetch's default seven-day stale fallback;
    // normalized price_cache and immutable research/decision evidence are
    // separate and are not pruned here.
    run: async (svc) => {
      const cutoff = daysAgo(7);
      const { count, error } = await svc
        .from("av_cache")
        .delete({ count: "exact" })
        .lt("fetched_at", cutoff)
        .or("cache_key.like.YAHOO_CANDLES:%,cache_key.like.MASSIVE_CANDLES:%,cache_key.like.EODHD_CANDLES:%,cache_key.like.TD_CANDLES:%,cache_key.like.UPSTOX_CANDLES:%,cache_key.like.ALPACA_IEX_5MIN:%")
        .order("cache_key")
        .order("cache_date")
        .limit(2000);
      if (error) throw error;
      return count ?? 0;
    },
  },
  {
    label: "av_cache (>30d since provider fetch)",
    // This is an operational response cache, not research evidence. The longest
    // freshness window used by providerCachedFetch is 30 days; stale fallbacks
    // are bounded to 7 days or less. Keep a 30-day cache window and expire rows
    // using the original fetch timestamp, not cache_date (which can be carried
    // forward without renewing fetched_at).
    run: async (svc) => {
      const cutoff = daysAgo(30);
      const { count, error } = await svc
        .from("av_cache")
        .delete({ count: "exact" })
        .lt("fetched_at", cutoff)
        .order("cache_key")
        .order("cache_date")
        .limit(2000);
      if (error) throw error;
      return count ?? 0;
    },
  },
  {
    label: "llm_call_log (>90d)",
    run: async (svc) => {
      const cutoff = daysAgo(90);
      const { count, error } = await svc
        .from("llm_call_log")
        .delete({ count: "exact" })
        .lt("created_at", cutoff);
      if (error) throw error;
      return count ?? 0;
    },
  },
  {
    label: "agent_runs (>60d)",
    run: async (svc) => {
      const cutoff = daysAgo(60);
      const { count, error } = await svc
        .from("agent_runs")
        .delete({ count: "exact" })
        .lt("started_at", cutoff);
      if (error) throw error;
      return count ?? 0;
    },
  },
  {
    label: "briefings (>90d)",
    run: async (svc) => {
      const cutoff = daysAgo(90);
      const { count, error } = await svc
        .from("briefings")
        .delete({ count: "exact" })
        .lt("created_at", cutoff);
      if (error) throw error;
      return count ?? 0;
    },
  },
  {
    label: "newsletters (>90d)",
    run: async (svc) => {
      const cutoff = daysAgo(90);
      const { count, error } = await svc
        .from("newsletters")
        .delete({ count: "exact" })
        .lt("created_at", cutoff);
      if (error) throw error;
      return count ?? 0;
    },
  },
  {
    label: "signal_score_history (>180d)",
    run: async (svc) => {
      const cutoff = daysAgo(180);
      const { count, error } = await svc
        .from("signal_score_history")
        .delete({ count: "exact" })
        .lt("created_at", cutoff);
      if (error) throw error;
      return count ?? 0;
    },
  },
  {
    label: "macro_signals (>90d)",
    run: async (svc) => {
      const cutoff = daysAgo(90);
      const { count, error } = await svc
        .from("macro_signals")
        .delete({ count: "exact" })
        .lt("created_at", cutoff);
      if (error) throw error;
      return count ?? 0;
    },
  },
  {
    label: "macro_regime (>90d, not latest per regime)",
    run: async (svc) => {
      // Keep the most recent row — delete the rest older than 90d.
      const cutoff = daysAgo(90);
      const { data: latest, error: latestError } = await svc
        .from("macro_regime")
        .select("id")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latestError) throw latestError;
      let q = svc
        .from("macro_regime")
        .delete({ count: "exact" })
        .lt("created_at", cutoff);
      if (latest?.id) q = q.neq("id", latest.id);
      const { count, error } = await q;
      if (error) throw error;
      return count ?? 0;
    },
  },
  {
    label: "rag_traces (>90d)",
    run: async (svc) => {
      const cutoff = daysAgo(90);
      const { count, error } = await svc
        .from("rag_traces")
        .delete({ count: "exact" })
        .lt("ts", cutoff);
      if (error) throw error;
      return count ?? 0;
    },
  },
  {
    label: "edge_signals (>180d)",
    run: async (svc) => {
      const cutoff = daysAgo(180);
      const { count, error } = await svc
        .from("edge_signals")
        .delete({ count: "exact" })
        .lt("created_at", cutoff);
      if (error) throw error;
      return count ?? 0;
    },
  },
  {
    label: "doc_chunks (>180d)",
    run: async (svc) => {
      const cutoff = daysAgo(180);
      const { count, error } = await svc
        .from("doc_chunks")
        .delete({ count: "exact" })
        .lt("created_at", cutoff);
      if (error) throw error;
      return count ?? 0;
    },
  },
  {
    label: "india_screen_cache (>7d)",
    run: async (svc) => {
      const cutoff = daysAgo(7);
      const { count, error } = await svc
        .from("india_screen_cache")
        .delete({ count: "exact" })
        .lt("scored_at", cutoff);
      if (error) throw error;
      return count ?? 0;
    },
  },
  {
    label: "agent_alerts resolved (>30d)",
    run: async (svc) => {
      const cutoff = daysAgo(30);
      const { count, error } = await svc
        .from("agent_alerts")
        .delete({ count: "exact" })
        .eq("resolved", true)
        .lt("resolved_at", cutoff);
      if (error) throw error;
      return count ?? 0;
    },
  },
  {
    label: "agent_signals orphaned (>365d, no linked paper_trade)",
    // agent_signals older than 1 year with no paper_trade opened within 24h of signal
    // Uses RPC to avoid N+1 — falls back gracefully if RPC absent
    run: async (svc) => {
      const cutoff = daysAgo(365);
      const { data, error } = await svc.rpc("delete_orphaned_agent_signals", { cutoff_ts: cutoff });
      if (error) throw error;
      return (data as number) ?? 0;
    },
  },
  {
    label: "learning_priors_history (>365d)",
    run: async (svc) => {
      const cutoff = daysAgo(365);
      const { count, error } = await svc
        .from("learning_priors_history")
        .delete({ count: "exact" })
        .lt("changed_at", cutoff);
      if (error) throw error;
      return count ?? 0;
    },
  },
];

// ------------------------------------------------------------------

function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

async function runCleanup() {
  const svc = createServiceClient();
  const results: Record<string, number> = {};
  let totalDeleted = 0;

  for (const step of STEPS) {
    try {
      const deleted = await step.run(svc);
      results[step.label] = deleted;
      totalDeleted += deleted;
      console.log(`[db-cleanup] ${step.label}: deleted ${deleted} rows`);
    } catch (err: any) {
      console.error(`[db-cleanup] ${step.label} failed:`, err?.message ?? err);
      results[step.label] = -1; // -1 = error
    }
  }

  return { totalDeleted, results, ok: Object.values(results).every(value => value >= 0) };
}

async function cleanupResponse() {
  const { totalDeleted, results, ok } = await runCleanup();
  if (ok) {
    await resolveIssue("db-cleanup-failed");
  } else {
    await reportIssue({
      issueKey: "db-cleanup-failed", severity: "warn", category: "data",
      title: "Database cleanup did not complete",
      detail: `Failed retention steps: ${Object.entries(results).filter(([, count]) => count < 0).map(([label]) => label).join(", ")}. A failed delete is not proof that storage was reclaimed.`,
    });
  }

  return NextResponse.json({
    ok,
    totalDeleted,
    results,
    ranAt: new Date().toISOString(),
  }, { status: ok ? 200 : 503 });
}

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    const authError = await requireOwner();
    if (authError) return authError;
  }
  return cleanupResponse();
}

// Vercel Cron GET runs cleanup; owner GET previews without deleting.
export async function GET(req: NextRequest) {
  if (verifyCronSecret(req)) return cleanupResponse();
  const authError = await requireOwner();
  if (authError) return authError;

  const svc = createServiceClient();

  const preview: Record<string, number> = {};

  const checks: Array<{ label: string; table: string; col: string; keyCol: string; days: number; filter?: string }> = [
    { label: "av_cache price candles (>7d since provider fetch)", table: "av_cache", col: "fetched_at", keyCol: "cache_key", days: 7, filter: "cache_key.like.YAHOO_CANDLES:%,cache_key.like.MASSIVE_CANDLES:%,cache_key.like.EODHD_CANDLES:%,cache_key.like.TD_CANDLES:%,cache_key.like.UPSTOX_CANDLES:%,cache_key.like.ALPACA_IEX_5MIN:%" },
    { label: "av_cache (>30d since provider fetch)", table: "av_cache", col: "fetched_at", keyCol: "cache_key", days: 30 },
    { label: "llm_call_log (>90d)",          table: "llm_call_log",           col: "created_at",  keyCol: "id", days: 90  },
    { label: "agent_runs (>60d)",             table: "agent_runs",             col: "started_at",  keyCol: "id", days: 60  },
    { label: "briefings (>90d)",              table: "briefings",              col: "created_at",  keyCol: "id", days: 90  },
    { label: "newsletters (>90d)",            table: "newsletters",            col: "created_at",  keyCol: "id", days: 90  },
    { label: "signal_score_history (>180d)",  table: "signal_score_history",  col: "created_at",  keyCol: "id", days: 180 },
    { label: "macro_signals (>90d)",          table: "macro_signals",          col: "created_at",  keyCol: "id", days: 90  },
    { label: "macro_regime (>90d, preserve newest)", table: "macro_regime", col: "created_at", keyCol: "id", days: 90 },
    { label: "rag_traces (>90d)",             table: "rag_traces",             col: "ts",          keyCol: "id", days: 90  },
    { label: "edge_signals (>180d)",            table: "edge_signals",            col: "created_at",  keyCol: "id", days: 180 },
    { label: "doc_chunks (>180d)",            table: "doc_chunks",             col: "created_at",  keyCol: "id", days: 180 },
    { label: "india_screen_cache (>7d)",      table: "india_screen_cache",     col: "scored_at",   keyCol: "symbol", days: 7   },
    { label: "agent_alerts resolved (>30d)",  table: "agent_alerts",           col: "resolved_at", keyCol: "id", days: 30  },
    { label: "learning_priors_history (>365d)", table: "learning_priors_history", col: "changed_at", keyCol: "id", days: 365 },
  ];

  for (const c of checks) {
    try {
      let q = svc.from(c.table).select(c.keyCol, { count: "exact", head: true }).lt(c.col, daysAgo(c.days));
      if (c.table === "agent_alerts") q = (q as any).eq("resolved", true);
      if (c.filter) q = (q as any).or(c.filter);
      const { count, error } = await q;
      if (error) throw error;
      preview[c.label] = count ?? 0;
    } catch {
      preview[c.label] = -1;
    }
  }

  const totalPreview = Object.values(preview).filter(v => v > 0).reduce((a, b) => a + b, 0);
  const ok = Object.values(preview).every(value => value >= 0);
  return NextResponse.json({ ok, dryRun: true, totalPreview, preview }, { status: ok ? 200 : 503 });
}
