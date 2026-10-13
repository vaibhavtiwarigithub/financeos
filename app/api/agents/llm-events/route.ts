import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { callLLM } from "@/lib/llm-router";
import { providerForModel, getProviderKey } from "@/lib/llm-keys";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/paginate";
import {
  EVENT_SYSTEM_PROMPT, aggregateSymbolScore, buildEventPrompt, docRejectReason, parseExtraction,
  type EventDoc, type EventSource,
} from "@/lib/llm-events/core";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// India LLM event extraction (measure-only, default OFF via llm_event_config). One news/NSE item per call, blind to price and
// every score. Writes append-only llm_event_items and llm_event_scores. No scorer, gate, trade or learner reads them.

const METHOD = "decay3d_v1";
const CONCURRENCY = 6;
const TIME_BUDGET_MS = 90_000;
const MAX_TOKENS = 300;
const PER_CALL_COST_ESTIMATE = 0.002; // pessimistic for deepseek-flash at ~700 tokens in / 120 out
const SNAPSHOT_LOOKBACK_DAYS = 7;
const SCORE_LOOKBACK_DAYS = 14;

const sha = (v: string) => createHash("sha256").update(v).digest("hex");

/** NSE announcement timestamps are IST wall-clock ("2026-10-13 12:44:23"); convert to an ISO instant. */
function nseToIso(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(raw.trim());
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}+05:30`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function docsFromSnapshot(row: any): EventDoc[] {
  const symbol = String(row.symbol).toUpperCase();
  const fetchedAt = new Date(row.fetched_at).toISOString();
  const out: EventDoc[] = [];
  if (row.source === "google_news_rss") {
    for (const h of row.payload?.headlines ?? []) {
      const text = String(h?.title ?? "").trim();
      const pubMs = Date.parse(String(h?.publishedAt ?? ""));
      const publishedAt = Number.isFinite(pubMs) ? new Date(pubMs).toISOString() : null;
      out.push({ key: sha(`${symbol}|rss|${h?.url ?? text}|${publishedAt ?? ""}`), symbol, source: "google_news_rss" as EventSource, text, publishedAt, fetchedAt });
    }
  } else if (row.source === "nse_corporate_announcements") {
    for (const e of row.payload?.events ?? []) {
      const text = String(e?.headline ?? "").trim();
      const publishedAt = nseToIso(e?.announcedAt);
      out.push({ key: sha(`${symbol}|nse|${e?.attachmentUrl ?? text}|${publishedAt ?? ""}`), symbol, source: "nse_corporate_announcements" as EventSource, text, publishedAt, fetchedAt });
    }
  }
  return out;
}

export async function GET(req: NextRequest) {
  const cron = verifyCronSecret(req);
  if (!cron) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const svc = createServiceClient();
  const startedAt = Date.now();
  const runId = `llm-events:${new Date().toISOString()}`;

  const { data: config } = await svc.from("llm_event_config").select("*").eq("id", "global").maybeSingle();
  if (!config?.enabled) return NextResponse.json({ ok: true, skipped: "disabled", shadowOnly: true });

  const model = String(config.model);
  const provider = providerForModel(model);
  if (!provider || !(await getProviderKey(provider, svc))) return NextResponse.json({ ok: false, error: `provider_key_missing:${provider ?? "unknown"}` }, { status: 500 });

  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const { data: spendRows } = await svc.from("llm_event_items").select("cost_usd").gte("extracted_at", dayStart.toISOString()).limit(5000);
  let spent = (spendRows ?? []).reduce((s: number, r: any) => s + Number(r.cost_usd ?? 0), 0);
  const budget = Number(config.daily_budget_usd);

  const since = new Date(Date.now() - SNAPSHOT_LOOKBACK_DAYS * 86_400_000).toISOString();
  const snapshots = await fetchAllRows((from, to) => svc.from("india_news_snapshots").select("id,symbol,source,fetched_at,payload")
    .gte("fetched_at", since).order("id", { ascending: true }).range(from, to), "llm events snapshots") as any[];
  const known = new Set<string>((await fetchAllRows((from, to) => svc.from("llm_event_items").select("id,item_key")
    .gte("fetched_at", since).order("id", { ascending: true }).range(from, to), "llm events known keys") as any[]).map((r: any) => r.item_key));

  const seen = new Set<string>();
  const fresh: EventDoc[] = [];
  for (const snap of snapshots) for (const d of docsFromSnapshot(snap)) {
    if (known.has(d.key) || seen.has(d.key)) continue;
    seen.add(d.key);
    fresh.push(d);
  }
  fresh.sort((a, b) => String(b.publishedAt ?? b.fetchedAt).localeCompare(String(a.publishedAt ?? a.fetchedAt)));
  const batch = fresh.slice(0, Number(config.max_items_per_run));

  const rows: Record<string, unknown>[] = [];
  const counts = { ok: 0, rejected: 0, provider_failed: 0, budget_stop: 0, not_attempted: fresh.length - batch.length };
  const queue = [...batch];
  const baseRow = (d: EventDoc) => ({ item_key: d.key, symbol: d.symbol, source: d.source, published_at: d.publishedAt, fetched_at: d.fetchedAt, doc_text: d.text.slice(0, 600), run_id: runId });

  const worker = async () => {
    while (queue.length) {
      const d = queue.shift()!;
      const pre = docRejectReason(d, Date.now());
      if (pre) { rows.push({ ...baseRow(d), status: "rejected", reject_reason: pre }); counts.rejected++; continue; }
      if (Date.now() - startedAt > TIME_BUDGET_MS) { counts.not_attempted++; continue; }
      if (spent + PER_CALL_COST_ESTIMATE > budget) { counts.budget_stop++; continue; }
      spent += PER_CALL_COST_ESTIMATE; // reserve; replaced by actual below
      try {
        const res = await callLLM({ task: "evaluate", model, prompt: buildEventPrompt(d), systemPrompt: EVENT_SYSTEM_PROMPT, maxTokens: MAX_TOKENS, timeoutMs: 20_000, symbol: d.symbol, agentLabel: "llm-events", runId });
        spent += res.costUsd - PER_CALL_COST_ESTIMATE;
        const usage = { model: res.model, tokens_in: res.tokensIn, tokens_out: res.tokensOut, cost_usd: res.costUsd };
        if (res.model !== model) { rows.push({ ...baseRow(d), ...usage, status: "rejected", reject_reason: "model_fallback_mismatch" }); counts.rejected++; continue; }
        const parsed = parseExtraction(res.text, d);
        if (!parsed.ok) { rows.push({ ...baseRow(d), ...usage, status: "rejected", reject_reason: parsed.reason }); counts.rejected++; continue; }
        const e = parsed.event;
        rows.push({ ...baseRow(d), ...usage, status: "ok", about_company: e.about_company, event_type: e.event_type, direction: e.direction, magnitude: e.magnitude, horizon: e.horizon, quote: e.quote });
        counts.ok++;
      } catch {
        spent -= PER_CALL_COST_ESTIMATE; // provider error: not stored, so the item is retried next run
        counts.provider_failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  let written = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const { data, error } = await svc.from("llm_event_items").upsert(rows.slice(i, i + 200), { onConflict: "item_key", ignoreDuplicates: true }).select("id");
    if (error) return NextResponse.json({ ok: false, error: `item write failed: ${error.message}`, counts }, { status: 500 });
    written += data?.length ?? 0;
  }

  // Deterministic per-symbol scores from validated items; one row per symbol per run.
  const scoreSince = new Date(Date.now() - SCORE_LOOKBACK_DAYS * 86_400_000).toISOString();
  const okItems = await fetchAllRows((from, to) => svc.from("llm_event_items")
    .select("id,symbol,published_at,fetched_at,about_company,event_type,direction,magnitude,horizon,quote")
    .eq("status", "ok").gte("fetched_at", scoreSince).order("id", { ascending: true }).range(from, to), "llm events ok items") as any[];
  const bySymbol = new Map<string, any[]>();
  for (const r of okItems) { const l = bySymbol.get(r.symbol) ?? []; l.push(r); bySymbol.set(r.symbol, l); }
  const nowMs = Date.now();
  const scoreRows: Record<string, unknown>[] = [];
  for (const [symbol, list] of bySymbol) {
    const agg = aggregateSymbolScore(list.map((r) => ({
      published_at: r.published_at, extracted_from_fetch_at: r.fetched_at,
      event: { about_company: !!r.about_company, event_type: r.event_type, direction: Number(r.direction), magnitude: r.magnitude == null ? null : Number(r.magnitude), horizon: r.horizon, quote: r.quote },
    })), nowMs);
    if (agg) scoreRows.push({ symbol, score: agg.score, n_items: agg.n_items, method: METHOD, as_of: new Date(nowMs).toISOString(), run_id: runId });
  }
  for (let i = 0; i < scoreRows.length; i += 200) {
    const { error } = await svc.from("llm_event_scores").upsert(scoreRows.slice(i, i + 200), { onConflict: "symbol,run_id", ignoreDuplicates: true });
    if (error) return NextResponse.json({ ok: false, error: `score write failed: ${error.message}`, counts }, { status: 500 });
  }

  await svc.from("agent_runs").insert({
    agent_type: "llm_events", status: "done", market: "india", symbols: [], trigger_source: cron ? "scheduled" : "manual",
    signals_written: 0, completed_at: new Date().toISOString(), tokens_input: 0, tokens_output: 0, claude_calls: 0,
    result_summary: `Shadow only: ${fresh.length} new items, ok=${counts.ok} rejected=${counts.rejected} provider_failed=${counts.provider_failed} not_attempted=${counts.not_attempted}, ${scoreRows.length} symbol scores, spend today ~$${spent.toFixed(4)}; behavior changed=false`,
  });

  return NextResponse.json({ ok: true, shadowOnly: true, behaviorChanged: false, newItems: fresh.length, written, counts, symbolScores: scoreRows.length, spentTodayUsd: Number(spent.toFixed(4)) });
}

export const POST = GET;
