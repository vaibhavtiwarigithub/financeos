import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { timingSafeEqual } from "crypto";

export const dynamic = "force-dynamic";

// Map the agent slug from issue_key (e.g. "cron:research") to its POST endpoint.
// Only agents that have a cron-callable POST route are listed here.
const CRON_AGENT_ROUTES: Record<string, string> = {
  "research":        "/api/agents/research/cron",
  "paper-trade":     "/api/agents/paper-trade",
  "paper-trader":    "/api/agents/paper-trade",
  "position-monitor":"/api/agents/position-monitor",
  "learner":         "/api/agents/learner",
  "macro-sentinel":  "/api/agents/macro-sentinel",
  "health-triage":   "/api/agents/health-triage",
};

function safeEquals(a: string, b: string): boolean {
  try {
    const ab = Buffer.from(a), bb = Buffer.from(b);
    if (ab.length !== bb.length) {
      // Compare anyway to avoid timing leak on length
      timingSafeEqual(ab, Buffer.alloc(ab.length));
      return false;
    }
    return timingSafeEqual(ab, bb);
  } catch { return false; }
}

export async function POST(req: NextRequest) {
  const ownerGate = await requireOwner();
  if (ownerGate) return ownerGate;

  const body = await req.json().catch(() => ({}));
  const { action, alert_id, issue_key } = body as {
    action?: string;
    alert_id?: string;
    issue_key?: string;
  };

  if (!action) return NextResponse.json({ error: "action required" }, { status: 400 });

  const svc = createServiceClient();

  // ── resolve_alert ──────────────────────────────────────────────────────────
  // Safe for any info/warn alert — marks it resolved so the health card clears.
  // Does NOT resolve critical/error alerts (user must fix the root cause).
  if (action === "resolve_alert") {
    if (!alert_id) return NextResponse.json({ error: "alert_id required" }, { status: 400 });

    const { data: alert } = await svc.from("agent_alerts")
      .select("id, severity").eq("id", alert_id).eq("resolved", false).maybeSingle();
    if (!alert) return NextResponse.json({ error: "Alert not found or already resolved" }, { status: 404 });

    if (alert.severity === "critical" || alert.severity === "error") {
      return NextResponse.json({ error: "Cannot auto-resolve critical/error alerts — fix the root cause first" }, { status: 403 });
    }

    await svc.from("agent_alerts")
      .update({ resolved: true, resolved_at: new Date().toISOString() })
      .eq("id", alert_id).eq("resolved", false);

    return NextResponse.json({ ok: true });
  }

  // ── retry_cron ─────────────────────────────────────────────────────────────
  // Retries the agent cron that raised the alert. Extracts the agent slug from
  // issue_key (format "cron:<agent>") and POSTs to its endpoint with CRON_SECRET.
  if (action === "retry_cron") {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });

    // Determine agent slug: prefer explicit issue_key param, fall back to the
    // alert row's issue_key column.
    let agentSlug: string | null = null;
    if (issue_key && issue_key.startsWith("cron:")) {
      agentSlug = issue_key.slice(5);
    } else if (alert_id) {
      const { data: alert } = await svc.from("agent_alerts")
        .select("issue_key").eq("id", alert_id).maybeSingle();
      const ik = alert?.issue_key ?? "";
      if (ik.startsWith("cron:")) agentSlug = ik.slice(5);
    }

    if (!agentSlug) return NextResponse.json({ error: "Cannot determine agent from issue_key" }, { status: 400 });

    const agentPath = CRON_AGENT_ROUTES[agentSlug];
    if (!agentPath) return NextResponse.json({ error: `No known cron route for agent "${agentSlug}"` }, { status: 400 });

    // Build the absolute URL using the app's own origin (same deployment).
    const appUrl = process.env.NEXT_PUBLIC_APP_URL
      || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
    const targetUrl = `${appUrl}${agentPath}`;

    const r = await fetch(targetUrl, {
      method: "POST",
      headers: { "x-cron-secret": cronSecret, "Content-Type": "application/json" },
    }).catch(e => ({ ok: false, status: 0, json: async () => ({ error: String(e) }) } as any));

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return NextResponse.json({ error: `Cron retry failed (${r.status}): ${err?.error ?? "unknown"}` }, { status: 502 });
    }

    return NextResponse.json({ ok: true, agent: agentSlug });
  }

  return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 });
}
