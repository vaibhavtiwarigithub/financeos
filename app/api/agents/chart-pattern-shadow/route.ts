import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { isEntryCandidateLong } from "@/lib/learning/entry-cohort";
import { CHART_PATTERN_SHADOW_VERSION, summarizeChartPatternEvidence, type ChartPatternType } from "@/lib/trading/chart-pattern-shadow";

export const dynamic = "force-dynamic";

async function readPages(queryFactory: (from: number, to: number) => any, limit: number) {
  const rows: any[] = [];
  const pageSize = Math.min(1_000, limit);
  for (let from = 0; from < limit; from += pageSize) {
    const { data, error } = await queryFactory(from, Math.min(from + pageSize - 1, limit - 1));
    if (error) throw new Error(error.message);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return { rows, complete: true };
  }
  return { rows, complete: false };
}
export async function GET(req: NextRequest) {
  const denied = await requireOwner();
  if (denied) return denied;
  const market = req.nextUrl.searchParams.get("market");
  const symbol = req.nextUrl.searchParams.get("symbol")?.trim().toUpperCase() ?? null;
  if (market !== "us" && market !== "india") {
    return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  }
  if (symbol && !/^[A-Z0-9.^_-]{1,24}$/.test(symbol)) {
    return NextResponse.json({ error: "invalid symbol" }, { status: 400 });
  }

  try {
    const svc = createServiceClient();
    if (symbol) {
      const { data, error } = await svc.from("chart_pattern_shadow_runs")
        .select("id,market,symbol,decision_observation_id,detection_status,pattern_type,candles_through_date,candle_source,detector_version,confirmation_date,confirmation_close,neckline_close,decision_observations!inner(ts,market,entry_eligible,direction,decision_context,discovery_source)")
        .eq("market", market).eq("symbol", symbol).eq("detector_version", CHART_PATTERN_SHADOW_VERSION).order("id", { ascending: false }).limit(100);
      if (error) throw new Error(error.message);
      const rows = (data ?? []).map((row: any) => ({
        ...row,
        observation: Array.isArray(row.decision_observations) ? row.decision_observations[0] : row.decision_observations,
      }));
      const invalidCohortRows = rows.filter((row: any) => row.market !== market || row.observation?.market !== market || !isEntryCandidateLong({
        entryEligible: row.observation?.entry_eligible,
        direction: row.observation?.direction,
        decisionContext: row.observation?.decision_context,
        discoverySource: row.observation?.discovery_source,
      }));
      if (invalidCohortRows.length) {
        return NextResponse.json({ error: `eligible-long cohort integrity guard failed for ${invalidCohortRows.length} row(s); no symbol evidence returned` }, { status: 503 });
      }
      const latest = rows[0] ?? null;
      return NextResponse.json({
        market,
        symbol,
        generatedAt: new Date().toISOString(),
        detector: CHART_PATTERN_SHADOW_VERSION,
        influence: "measure_only",
        historyWindowCount: rows.length,
        historyWindowComplete: rows.length < 100,
        latestAttempt: latest ? {
          decisionDate: latest.observation?.ts ? String(latest.observation.ts).slice(0, 10) : null,
          detectionStatus: latest.detection_status,
          patternType: latest.pattern_type,
          candlesThroughDate: latest.candles_through_date,
          candleSource: latest.candle_source,
          detectorVersion: latest.detector_version,
          confirmationDate: latest.confirmation_date,
          confirmationClose: latest.confirmation_close,
          necklineClose: latest.neckline_close,
        } : null,
        interpretation: "Prospective chart-pattern evidence only. It does not change the technical dimension, composite score, or any trade decision.",
      });
    }

    const { data: benchmark, error: benchmarkError } = await svc.from("benchmarks")
      .select("id").eq("market", market).eq("is_primary", true).eq("enabled", true).maybeSingle();
    if (benchmarkError || !benchmark?.id) {
      return NextResponse.json({ error: `primary benchmark calendar unavailable; no verdict computed: ${benchmarkError?.message ?? "missing primary benchmark"}` }, { status: 503 });
    }
    const calendar = await readPages((from, to) => svc.from("benchmark_price_observations")
      .select("date,component_symbol").eq("benchmark_id", benchmark.id).eq("source_status", "ok")
      .order("date", { ascending: true }).order("component_symbol", { ascending: true }).range(from, to), 50_000);
    if (!calendar.complete) {
      return NextResponse.json({ error: "benchmark session calendar exceeds the safe report bound; no verdict computed" }, { status: 503 });
    }
    const sessions = [...new Set(calendar.rows.map((row) => String(row.date).slice(0, 10)))];
    if (!sessions.length) {
      return NextResponse.json({ error: "primary benchmark has no successful session observations; no verdict computed" }, { status: 503 });
    }

    const attempts = await readPages((from, to) => svc.from("chart_pattern_shadow_runs")
      .select("id,market,symbol,decision_observation_id,detection_status,pattern_type,decision_observations!inner(ts,market,entry_eligible,direction,decision_context,discovery_source,observation_labels(horizon_days,benchmark_neutral_return,matured_at))")
      .eq("market", market).eq("detector_version", CHART_PATTERN_SHADOW_VERSION).order("id", { ascending: true }).range(from, to), 20_000);
    if (!attempts.complete) {
      return NextResponse.json({ error: "pattern evidence exceeds the safe report bound; no verdict computed" }, { status: 503 });
    }

    const rows = attempts.rows.map((row) => {
      const observation = Array.isArray(row.decision_observations) ? row.decision_observations[0] : row.decision_observations;
      return { ...row, observation, labels: observation?.observation_labels ?? [] };
    });
    const invalidCohortRows = rows.filter((row) => row.market !== market || row.observation?.market !== market || !isEntryCandidateLong({
      entryEligible: row.observation?.entry_eligible,
      direction: row.observation?.direction,
      decisionContext: row.observation?.decision_context,
      discoverySource: row.observation?.discovery_source,
    }));
    if (invalidCohortRows.length) {
      return NextResponse.json({ error: `eligible-long cohort integrity guard failed for ${invalidCohortRows.length} row(s); no verdict computed` }, { status: 503 });
    }
    const sessionSet = new Set(sessions);
    const unaligned = rows.filter((row) => row.observation?.ts && !sessionSet.has(String(row.observation.ts).slice(0, 10)));
    if (unaligned.length) {
      return NextResponse.json({ error: `${unaligned.length} decision(s) do not align to the primary benchmark session calendar; no verdict computed` }, { status: 503 });
    }
    const latestBySymbolSession = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const observation = row.observation;
      if (row.detection_status !== "detected" || (row.pattern_type !== "double_top" && row.pattern_type !== "double_bottom") || !observation?.ts) continue;
      latestBySymbolSession.set(`${row.symbol}:${String(observation.ts).slice(0, 10)}`, row);
    }
    const detected = [...latestBySymbolSession.values()];
    const horizons = [5, 10, 20].map((horizonDays) => {
      const events = detected.flatMap((row) => {
        const label = row.labels.find((candidate: any) => Number(candidate.horizon_days) === horizonDays);
        if (!label || label.benchmark_neutral_return == null) return [];
        return [{
          session: String(row.observation.ts).slice(0, 10),
          patternType: row.pattern_type as ChartPatternType,
          benchmarkNeutralReturn: Number(label.benchmark_neutral_return),
        }];
      });
      const summary = summarizeChartPatternEvidence({ sessions, events, horizonDays });
      const verdict = summary.independentBlocks.status;
      return { horizonDays, ...summary, verdict };
    });

    return NextResponse.json({
      market,
      generatedAt: new Date().toISOString(),
      detector: CHART_PATTERN_SHADOW_VERSION,
      influence: "measure_only",
      benchmarkSessions: sessions.length,
      attempts: rows.length,
      noPattern: rows.filter((row) => row.detection_status === "no_pattern").length,
      insufficientCandles: rows.filter((row) => row.detection_status === "insufficient_candles").length,
      detected: detected.length,
      horizons,
      interpretation: "Signed benchmark-neutral event outcomes, averaged within non-overlapping horizon-sized blocks on eligible-long market sessions. Descriptive event evidence only; not a portfolio P&L replay or proof of tradability.",
    });
  } catch (error) {
    return NextResponse.json({ error: String((error as Error)?.message ?? error) }, { status: 503 });
  }
}

