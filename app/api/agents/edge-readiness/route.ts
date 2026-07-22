import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { evaluateEdgeReadiness, type EdgeReadinessInput, type EdgeReadinessStage } from "@/lib/edges/readiness";
import type { Market } from "@/lib/edges/types";
import { reportIssue, resolveIssue } from "@/lib/system-health";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const READY_STAGES = new Set<EdgeReadinessStage>([
  "ready_for_validation_build",
  "ready_for_shadow_review",
]);
const STALE_DAYS = 10;
const PAGE_SIZE = 1000;

type DbRow = {
  edge_id: string;
  market: Market;
  horizon: number;
  window_end: string;
  created_at: string;
  segment_type: string;
  segment_value: string;
  ic: number | string | null;
  t_stat: number | string | null;
  n_obs: number | string | null;
  evidence_quality: string | null;
  net_of_fee_ic: number | string | null;
  turnover: number | string | null;
};

async function loadHistory(svc: any): Promise<DbRow[]> {
  const cutoff = new Date(Date.now() - 400 * 86_400_000).toISOString();
  const rows: DbRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await svc.from("edge_ic_history")
      .select("edge_id,market,horizon,window_end,created_at,segment_type,segment_value,ic,t_stat,n_obs,evidence_quality,net_of_fee_ic,turnover")
      .eq("segment_type", "market")
      .eq("segment_value", "all")
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`edge readiness history read failed: ${error.message}`);
    rows.push(...((data ?? []) as DbRow[]));
    if ((data?.length ?? 0) < PAGE_SIZE) break;
  }
  return rows;
}

function toInput(row: DbRow): EdgeReadinessInput {
  return {
    edgeId: row.edge_id,
    market: row.market,
    horizon: Number(row.horizon),
    windowEnd: row.window_end,
    createdAt: row.created_at,
    segmentType: row.segment_type,
    segmentValue: row.segment_value,
    ic: row.ic,
    tStat: row.t_stat,
    nObs: row.n_obs,
    evidenceQuality: row.evidence_quality,
    netOfFeeIc: row.net_of_fee_ic,
    turnover: row.turnover,
  };
}

async function emitMilestoneBatches(
  svc: any,
  results: Array<{ key: string; result: ReturnType<typeof evaluateEdgeReadiness> }>,
  existingByKey: Map<string, any>,
) {
  const pending = new Map<string, Array<ReturnType<typeof evaluateEdgeReadiness>>>();
  for (const { key, result } of results) {
    if (!READY_STAGES.has(result.stage)) continue;
    const existing = existingByKey.get(key);
    const notifiedColumn = result.stage === "ready_for_shadow_review"
      ? "shadow_review_notified_at"
      : "validation_build_notified_at";
    if (existing?.policy_version === result.policyVersion && existing?.[notifiedColumn]) continue;
    const batchKey = `${result.market}|${result.stage}`;
    const batch = pending.get(batchKey) ?? [];
    batch.push(result);
    pending.set(batchKey, batch);
  }

  let notices = 0;
  for (const batch of pending.values()) {
    const first = batch[0];
    const isShadow = first.stage === "ready_for_shadow_review";
    const issueKey = `edge-readiness:${first.policyVersion}:${first.market}:${first.stage}`;
    const candidates = results
      .map(item => item.result)
      .filter(result => result.market === first.market && result.stage === first.stage)
      .map(result => `${result.edgeId} ${result.horizon}d`)
      .sort()
      .join(", ");
    const title = isShadow
      ? `${first.market.toUpperCase()} factor evidence is ready for shadow review`
      : `${first.market.toUpperCase()} factor evidence is ready for validation build`;
    const detail = isShadow
      ? `${candidates}. Required independent PIT walk-forward cost/FDR windows passed. This grants no scoring or trading permission. Review in Edge Catalog.`
      : `${candidates}. Six independent historical windows passed stability gates. Next: PIT walk-forward, costs, turnover, and multiple-testing control. This grants no scoring or trading permission.`;
    const { data: open, error: openError } = await svc.from("agent_alerts")
      .select("id")
      .eq("issue_key", issueKey)
      .eq("resolved", false)
      .limit(1)
      .maybeSingle();
    if (openError) throw new Error(`edge readiness notice lookup failed: ${openError.message}`);
    const noticeWrite = open?.id
      ? await svc.from("agent_alerts").update({ title, detail }).eq("id", open.id)
      : await svc.from("agent_alerts").insert({
          issue_key: issueKey, severity: "info", category: "calibration", title, detail, resolved: false,
        });
    if (noticeWrite.error) throw new Error(`edge readiness notice failed: ${noticeWrite.error.message}`);

    const notifiedAt = new Date().toISOString();
    for (const result of batch) {
      const notificationPatch = isShadow
        ? { shadow_review_notified_at: notifiedAt, validation_build_notified_at: notifiedAt }
        : { validation_build_notified_at: notifiedAt };
      const { error } = await svc.from("edge_readiness_status")
        .update(notificationPatch)
        .eq("edge_id", result.edgeId)
        .eq("market", result.market)
        .eq("horizon", result.horizon);
      if (error) throw new Error(`edge readiness notice ledger failed: ${error.message}`);
    }
    notices++;
  }
  return notices;
}

export async function POST(req: NextRequest) {
  const svc = createServiceClient();
  let runId: string | null = null;
  try {
    const isCron = verifyCronSecret(req);
    if (!isCron) {
      const gate = await requireOwner();
      if (gate) return gate;
    }
    const { data: run } = await svc.from("agent_runs").insert({
      agent_type: "edge_readiness",
      status: "running",
      trigger_source: isCron ? "scheduled" : "manual",
    }).select("id").single();
    runId = run?.id ?? null;

    const history = await loadHistory(svc);
    const existingRes = await svc.from("edge_readiness_status").select("*");
    if (existingRes.error) throw new Error(`edge readiness status read failed: ${existingRes.error.message}`);
    const existingByKey = new Map<string, any>((existingRes.data ?? []).map((row: any): [string, any] => [
      `${row.edge_id}|${row.market}|${row.horizon}`,
      row,
    ]));
    const grouped = new Map<string, EdgeReadinessInput[]>();
    for (const row of history) {
      const input = toInput(row);
      if (!input.edgeId || !["us", "india"].includes(input.market) || !(input.horizon > 0)) continue;
      const key = `${input.edgeId}|${input.market}|${input.horizon}`;
      const group = grouped.get(key) ?? [];
      group.push(input);
      grouped.set(key, group);
    }

    const results = [...grouped.entries()].map(([key, rows]) => ({
      key,
      result: evaluateEdgeReadiness(rows),
    }));
    const evaluatedAt = new Date().toISOString();
    const projectionRows = results.map(({ key, result }) => {
      const existing = existingByKey.get(key) as any;
      return {
        edge_id: result.edgeId,
        market: result.market,
        horizon: result.horizon,
        policy_version: result.policyVersion,
        stage: result.stage,
        windows_observed: result.windowsObserved,
        windows_required: result.windowsRequired,
        positive_windows: result.positiveWindows,
        median_ic: result.medianIc,
        median_t_stat: result.medianTStat,
        min_n_obs: result.minNObs,
        latest_window_end: result.latestWindowEnd,
        validation_windows_observed: result.validationWindowsObserved,
        validation_windows_required: result.validationWindowsRequired,
        positive_validation_windows: result.positiveValidationWindows,
        median_net_of_fee_ic: result.medianNetOfFeeIc,
        next_action: result.nextAction,
        gates: result.gates,
        validation_build_notified_at: existing?.policy_version === result.policyVersion ? existing.validation_build_notified_at : null,
        shadow_review_notified_at: existing?.policy_version === result.policyVersion ? existing.shadow_review_notified_at : null,
        evaluated_at: evaluatedAt,
      };
    });
    if (projectionRows.length) {
      const { error } = await svc.from("edge_readiness_status").upsert(projectionRows, {
        onConflict: "edge_id,market,horizon",
      });
      if (error) throw new Error(`edge readiness status write failed: ${error.message}`);
    }

    const notices = await emitMilestoneBatches(svc, results, existingByKey);

    const now = Date.now();
    for (const market of ["us", "india"] as const) {
      const latest = history
        .filter(row => row.market === market)
        .reduce((max, row) => Math.max(max, Date.parse(row.created_at) || 0), 0);
      const stale = !latest || now - latest > STALE_DAYS * 86_400_000;
      const key = `edge-readiness-stalled:${market}`;
      if (stale) {
        await reportIssue({
          issueKey: key,
          severity: "warn",
          category: "calibration",
          title: `${market.toUpperCase()} factor calibration evidence is stale`,
          detail: latest
            ? `No successful market-wide IC snapshot in more than ${STALE_DAYS} days. Readiness cannot advance; scoring and trading remain unchanged.`
            : "No market-wide IC snapshot exists. Readiness cannot advance; scoring and trading remain unchanged.",
        }, svc);
      } else {
        await resolveIssue(key, svc);
      }
    }

    if (runId) {
      await svc.from("agent_runs").update({
        status: "done",
        completed_at: new Date().toISOString(),
        signals_written: 0,
        result_summary: `Edge readiness: ${results.length} identities evaluated; ${notices} one-time notices. Measure-only.`,
      }).eq("id", runId);
    }
    await resolveIssue("edge-readiness-monitor", svc);
    return NextResponse.json({
      ok: true,
      measureOnly: true,
      evaluated: results.length,
      notices,
      stages: results.reduce<Record<string, number>>((counts, row) => {
        counts[row.result.stage] = (counts[row.result.stage] ?? 0) + 1;
        return counts;
      }, {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await reportIssue({
      issueKey: "edge-readiness-monitor",
      severity: "warn",
      category: "calibration",
      title: "Factor calibration readiness monitor failed",
      detail: `${message.slice(0, 500)} Scoring and trading remain unchanged.`,
    }, svc);
    if (runId) {
      await svc.from("agent_runs").update({
        status: "error",
        completed_at: new Date().toISOString(),
        result_summary: message.slice(0, 500),
      }).eq("id", runId).catch(() => {});
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
