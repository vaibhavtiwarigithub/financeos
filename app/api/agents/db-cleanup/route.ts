import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// DB pruning job — removes data past safe retention windows.
// Safe tables only. Append-only ledgers (paper_trades, paper_order_events,
// decision_observations, broker_orders, strategy_evaluations) are NEVER touched.
//
// Cron: 1st of every month at 03:00 UTC
// Manual: POST /api/agents/db-cleanup (owner-only, x-cron-secret bypasses owner check)
//
// Returns per-table deleted row counts.

interface CleanupStep {
  label: string;
  run: (svc: ReturnType<typeof createServiceClient>) => Promise<number>;
}

const STEPS: CleanupStep[] = [
  {
    label: "llm_call_log (>90d)",
    run: async (svc) => {
      const cutoff = daysAgo(90);
      const { count } = await svc
        .from("llm_call_log")
        .delete({ count: "exact" })
        .lt("created_at", cutoff);
      return count ?? 0;
    },
  },
  {
    label: "agent_runs (>60d)",
    run: async (svc) => {
      const cutoff = daysAgo(60);
      const { count } = await svc
        .from("agent_runs")
        .delete({ count: "exact" })
        .lt("created_at", cutoff);
      return count ?? 0;
    },
  },
  {
    label: "briefings (>90d)",
    run: async (svc) => {
      const cutoff = daysAgo(90);
      const { count } = await svc
        .from("briefings")
        .delete({ count: "exact" })
        .lt("created_at", cutoff);
      return count ?? 0;
    },
  },
  {
    label: "newsletters (>90d)",
    run: async (svc) => {
      const cutoff = daysAgo(90);
      const { count } = await svc
        .from("newsletters")
        .delete({ count: "exact" })
        .lt("created_at", cutoff);
      return count ?? 0;
    },
  },
  {
    label: "signal_score_history (>180d)",
    run: async (svc) => {
      const cutoff = daysAgo(180);
      const { count } = await svc
        .from("signal_score_history")
        .delete({ count: "exact" })
        .lt("created_at", cutoff);
      return count ?? 0;
    },
  },
  {
    label: "macro_signals (>90d)",
    run: async (svc) => {
      const cutoff = daysAgo(90);
      const { count } = await svc
        .from("macro_signals")
        .delete({ count: "exact" })
        .lt("computed_at", cutoff);
      return count ?? 0;
    },
  },
  {
    label: "macro_regime (>90d, not latest per regime)",
    run: async (svc) => {
      // Keep the most recent row (highest computed_at) — delete the rest older than 90d
      const cutoff = daysAgo(90);
      const { data: latest } = await svc
        .from("macro_regime")
        .select("id")
        .order("computed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      let q = svc
        .from("macro_regime")
        .delete({ count: "exact" })
        .lt("computed_at", cutoff);
      if (latest?.id) q = q.neq("id", latest.id);
      const { count } = await q;
      return count ?? 0;
    },
  },
  {
    label: "rag_traces (>90d)",
    run: async (svc) => {
      const cutoff = daysAgo(90);
      const { count } = await svc
        .from("rag_traces")
        .delete({ count: "exact" })
        .lt("created_at", cutoff);
      return count ?? 0;
    },
  },
  {
    label: "edge_signals (>180d)",
    run: async (svc) => {
      const cutoff = daysAgo(180);
      const { count } = await svc
        .from("edge_signals")
        .delete({ count: "exact" })
        .lt("created_at", cutoff);
      return count ?? 0;
    },
  },
  {
    label: "doc_chunks (>180d)",
    run: async (svc) => {
      const cutoff = daysAgo(180);
      const { count } = await svc
        .from("doc_chunks")
        .delete({ count: "exact" })
        .lt("created_at", cutoff);
      return count ?? 0;
    },
  },
  {
    label: "india_screen_cache (>7d)",
    run: async (svc) => {
      const cutoff = daysAgo(7);
      const { count } = await svc
        .from("india_screen_cache")
        .delete({ count: "exact" })
        .lt("updated_at", cutoff);
      return count ?? 0;
    },
  },
  {
    label: "agent_alerts resolved (>30d)",
    run: async (svc) => {
      const cutoff = daysAgo(30);
      const { count } = await svc
        .from("agent_alerts")
        .delete({ count: "exact" })
        .eq("resolved", true)
        .lt("resolved_at", cutoff);
      return count ?? 0;
    },
  },
  {
    label: "agent_signals orphaned (>365d, no linked paper_trade)",
    // agent_signals older than 1 year with no paper_trade opened within 24h of signal
    // Uses RPC to avoid N+1 — falls back gracefully if RPC absent
    run: async (svc) => {
      const cutoff = daysAgo(365);
      try {
        const { data } = await svc.rpc("delete_orphaned_agent_signals", { cutoff_ts: cutoff });
        return (data as number) ?? 0;
      } catch {
        // RPC not yet deployed — skip silently
        return 0;
      }
    },
  },
  {
    label: "learning_priors_history (>365d)",
    run: async (svc) => {
      const cutoff = daysAgo(365);
      const { count } = await svc
        .from("learning_priors_history")
        .delete({ count: "exact" })
        .lt("created_at", cutoff);
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

  return { totalDeleted, results };
}

// Cron trigger (x-cron-secret header)
export async function POST(req: NextRequest) {
  const isCron = verifyCronSecret(req);

  if (!isCron) {
    // Manual trigger — must be owner
    const authError = await requireOwner();
    if (authError) return authError;
  }

  const { totalDeleted, results } = await runCleanup();

  return NextResponse.json({
    ok: true,
    totalDeleted,
    results,
    ranAt: new Date().toISOString(),
  });
}

// Manual GET — returns what WOULD be deleted (dry run row counts, no deletes)
export async function GET(req: NextRequest) {
  const authError = await requireOwner();
  if (authError) return authError;

  const svc = createServiceClient();

  const preview: Record<string, number> = {};

  const checks: Array<{ label: string; table: string; col: string; days: number }> = [
    { label: "llm_call_log (>90d)",          table: "llm_call_log",           col: "created_at",  days: 90  },
    { label: "agent_runs (>60d)",             table: "agent_runs",             col: "created_at",  days: 60  },
    { label: "briefings (>90d)",              table: "briefings",              col: "created_at",  days: 90  },
    { label: "newsletters (>90d)",            table: "newsletters",            col: "created_at",  days: 90  },
    { label: "signal_score_history (>180d)",  table: "signal_score_history",  col: "created_at",  days: 180 },
    { label: "macro_signals (>90d)",          table: "macro_signals",          col: "computed_at", days: 90  },
    { label: "rag_traces (>90d)",             table: "rag_traces",             col: "created_at",  days: 90  },
    { label: "edge_signals (>180d)",          table: "edge_signals",           col: "created_at",  days: 180 },
    { label: "doc_chunks (>180d)",            table: "doc_chunks",             col: "created_at",  days: 180 },
    { label: "india_screen_cache (>7d)",      table: "india_screen_cache",     col: "updated_at",  days: 7   },
    { label: "agent_alerts resolved (>30d)",  table: "agent_alerts",           col: "resolved_at", days: 30  },
    { label: "learning_priors_history (>365d)", table: "learning_priors_history", col: "created_at", days: 365 },
  ];

  for (const c of checks) {
    try {
      let q = svc.from(c.table).select("id", { count: "exact", head: true }).lt(c.col, daysAgo(c.days));
      if (c.table === "agent_alerts") q = (q as any).eq("resolved", true);
      const { count } = await q;
      preview[c.label] = count ?? 0;
    } catch {
      preview[c.label] = -1;
    }
  }

  const totalPreview = Object.values(preview).filter(v => v > 0).reduce((a, b) => a + b, 0);
  return NextResponse.json({ dryRun: true, totalPreview, preview });
}
