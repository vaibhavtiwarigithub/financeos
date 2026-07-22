import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { classifyJournalAsset } from "@/lib/asset-classification";
import { resolveJournalTerminal } from "@/lib/research/journal-terminal";
import { buildIndicativeTradePlan } from "@/lib/trading/trade-plan";
import { getMaeMfeReadinessByHorizons } from "@/lib/risk/percentiles";
import { loadTradingMandate } from "@/lib/trading-mandate";
import {
  canonicalPositionSymbol,
  normalizeSnapshotHolding,
  reconstructAccountLivePositions,
} from "@/lib/trading/live-position-ledger";
import { JOURNAL_ALL_DATES_LIMIT, normalizeJournalSymbol } from "@/lib/research/journal-controls";

export const dynamic = "force-dynamic";

const DIMS = ["fundamental", "technical", "sentiment", "macro", "insider"] as const;
function titleCase(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, c => c.toUpperCase()); }
function finiteOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function assetLabel(type: string): string {
  return type === "etf" ? "ETF / fund" : type === "metal_fund" ? "Commodity / metal fund"
    : type === "india_company" ? "India-listed company" : "US-listed company";
}

function externalLinks(symbol: string, market: "us" | "india", assetType: string) {
  const upper = symbol.trim().toUpperCase();
  const base = upper.replace(/\.(NS|BO)$/, "");
  const links = market === "india" ? [
    { label: "TradingView", url: `https://www.tradingview.com/symbols/NSE-${encodeURIComponent(base)}/` },
    { label: "Yahoo Finance", url: `https://finance.yahoo.com/quote/${encodeURIComponent(upper)}` },
    { label: "NSE", url: `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(base)}` },
  ] : [
    { label: "TradingView", url: `https://www.tradingview.com/symbols/${encodeURIComponent(upper)}/` },
    { label: "Yahoo Finance", url: `https://finance.yahoo.com/quote/${encodeURIComponent(upper)}` },
    { label: assetType === "etf" || assetType === "metal_fund" ? "SEC / fund filings" : "SEC company filings", url: `https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(upper)}` },
  ];
  return links;
}

function technicalTranslation(evidence: Record<string, any>): string[] {
  const out: string[] = [];
  const trend = String(evidence.trend20d ?? "").toLowerCase();
  const above20 = evidence.priceVsEma20 === "above";
  const above50 = evidence.priceVsEma50 === "above";
  if (trend === "up" && above20 && above50) out.push("Price is in an established short-term uptrend above both the 20- and 50-day averages.");
  else if (trend === "down" && !above20 && !above50) out.push("Price is in a short-term downtrend below both the 20- and 50-day averages.");
  else if (trend) out.push(`The 20-day trend is ${trend}; moving-average confirmation is mixed.`);
  const rsi = Number(evidence.rsi14);
  if (Number.isFinite(rsi)) {
    out.push(rsi >= 70 ? `RSI ${rsi.toFixed(1)} is extended/overbought; momentum is strong but pullback risk is elevated.`
      : rsi <= 30 ? `RSI ${rsi.toFixed(1)} is oversold; this is not a buy signal without reversal confirmation.`
      : rsi >= 55 ? `RSI ${rsi.toFixed(1)} shows positive but not extreme momentum.`
      : rsi <= 45 ? `RSI ${rsi.toFixed(1)} shows weak momentum.`
      : `RSI ${rsi.toFixed(1)} is neutral.`);
  }
  const volume = Number(evidence.volumeVsAvg20);
  if (Number.isFinite(volume)) out.push(volume < 0.7
    ? `Volume is only ${volume.toFixed(2)}× its 20-day average, so participation does not confirm the move.`
    : volume >= 1.5 ? `Volume is ${volume.toFixed(2)}× average, providing strong participation confirmation.`
    : `Volume is ${volume.toFixed(2)}× average, providing ordinary participation.`);
  return out.slice(0, 4);
}

function localDate(iso: string, market: "us" | "india"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: market === "india" ? "Asia/Kolkata" : "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(iso));
}

function compactEvidence(value: any): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, v]) => key !== "note" && ["string", "number", "boolean"].includes(typeof v))
    .slice(0, 8));
}

function decisionReason(obs: any, rationale: string | null): string {
  if (obs.entry_eligible) return `Eligible: long direction and score ${obs.analyst_score} cleared the ${obs.score_threshold} threshold.`;
  const abstain = rationale?.match(/\[abstained:\s*([^\]]+)\]/i)?.[1];
  if (abstain) return `Abstained: ${abstain}.`;
  const included = obs.features?.weighting?.included_dims ?? [];
  if (included.length < 2) return `Abstained: only ${included.length}/5 usable score dimensions; new entries require at least 2.`;
  if (obs.analyst_score < obs.score_threshold) return `Rejected: score ${obs.analyst_score} was below the ${obs.score_threshold} entry threshold.`;
  if (obs.direction !== "long") {
    return `Abstained despite score ${obs.analyst_score}: direction was ${obs.direction}; a score alone never authorizes entry.`;
  }
  return "Rejected by the research eligibility gate; the historical row did not record a more specific reason.";
}

export async function GET(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") === "all" ? "all" : "date";
  const rawSymbolFilter = url.searchParams.get("symbol");
  const symbolFilter = normalizeJournalSymbol(rawSymbolFilter);
  if (rawSymbolFilter?.trim() && !symbolFilter) {
    return NextResponse.json({ error: "invalid symbol" }, { status: 400 });
  }
  const requestedDate = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    return NextResponse.json({ error: "invalid date; expected YYYY-MM-DD" }, { status: 400 });
  }
  const market: "us" | "india" = url.searchParams.get("market") === "india" ? "india" : "us";
  const svc = createServiceClient();

  // Fetch a bounded UTC envelope and filter by the market's local calendar date.
  // A fixed UTC day omitted India pre-open rows and misfiled US evening reruns.
  const envelopeStart = new Date(`${requestedDate}T00:00:00.000Z`);
  envelopeStart.setUTCDate(envelopeStart.getUTCDate() - 1);
  const envelopeEnd = new Date(`${requestedDate}T23:59:59.999Z`);
  envelopeEnd.setUTCDate(envelopeEnd.getUTCDate() + 1);
  const observationColumns = "id,ts,market,symbol,analyst_score,score_threshold,entry_eligible,direction,fundamental_score,technical_score,sentiment_score,macro_score,insider_score,features,availability_mask,weights_used,signal_id,discovery_source,evidence_confidence,scoring_version,price_at_decision,currency";
  let observationQuery = svc.from("decision_observations").select(observationColumns).eq("market", market);
  let latestQuery = svc.from("decision_observations").select("ts").eq("market", market);
  if (symbolFilter) {
    observationQuery = observationQuery.eq("symbol", symbolFilter);
    latestQuery = latestQuery.eq("symbol", symbolFilter);
  }
  observationQuery = scope === "all"
    ? observationQuery.order("ts", { ascending: false }).order("id", { ascending: false }).limit(JOURNAL_ALL_DATES_LIMIT + 1)
    : observationQuery.gte("ts", envelopeStart.toISOString()).lte("ts", envelopeEnd.toISOString())
      .order("ts", { ascending: true }).order("id", { ascending: true });

  const [{ data: rawRows, error: obsError }, { data: latestRows, error: latestError }] = await Promise.all([
    observationQuery,
    latestQuery.order("ts", { ascending: false }).limit(1),
  ]);
  if (obsError || latestError) {
    return NextResponse.json({ error: obsError?.message ?? latestError?.message ?? "journal query failed" }, { status: 500 });
  }
  const allDatesCapped = scope === "all" && (rawRows?.length ?? 0) > JOURNAL_ALL_DATES_LIMIT;
  const rawObservations = scope === "all"
    ? (rawRows ?? []).slice(0, JOURNAL_ALL_DATES_LIMIT)
    : (rawRows ?? []).filter((row: any) => localDate(row.ts, market) === requestedDate);
  const latestAvailableDate = latestRows?.[0]?.ts ? localDate(latestRows[0].ts, market) : null;

  const bySymbol = new Map<string, { obs: any; runCount: number }>();
  for (const obs of rawObservations as any[]) {
    const existing = bySymbol.get(obs.symbol);
    bySymbol.set(obs.symbol, { obs, runCount: (existing?.runCount ?? 0) + 1 });
  }
  const observations = scope === "all"
    ? (rawObservations as any[]).map(obs => ({ ...obs, runCount: bySymbol.get(obs.symbol)?.runCount ?? 1 }))
    : Array.from(bySymbol.values())
      .map(({ obs, runCount }) => ({ ...obs, runCount }))
      .sort((a, b) => b.analyst_score - a.analyst_score);

  const signalIds = [...new Set(observations.map((o: any) => o.signal_id).filter(Boolean))];
  let stageEvents: any[] = [];
  let signals: any[] = [];
  if (signalIds.length) {
    const [{ data: stages, error: stageError }, { data: signalRows, error: signalError }] = await Promise.all([
      svc.from("pipeline_stage_events").select("signal_id,stage,outcome,reason,detail,created_at").in("signal_id", signalIds).order("created_at", { ascending: true }),
      svc.from("agent_signals").select("id,rationale,research_packet_id,source,status,asset_class,stop_loss_pct,take_profit_pct,signal_breakdown").in("id", signalIds),
    ]);
    if (stageError || signalError) return NextResponse.json({ error: stageError?.message ?? signalError?.message }, { status: 500 });
    stageEvents = stages ?? [];
    signals = signalRows ?? [];
  }
  const packetIds = signals.map(s => s.research_packet_id).filter(Boolean);
  let packets: any[] = [];
  if (packetIds.length) {
    const { data, error } = await svc.from("research_packets")
      .select("id,summary,key_risks,catalysts,is_held_position,raw_data,created_at").in("id", packetIds);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    packets = data ?? [];
  }

  const eventsBySignal = new Map<string, any[]>();
  for (const e of stageEvents) {
    const rows = eventsBySignal.get(e.signal_id) ?? [];
    rows.push(e); eventsBySignal.set(e.signal_id, rows);
  }
  const signalById = new Map(signals.map(s => [s.id, s]));
  const packetById = new Map(packets.map(p => [p.id, p]));

  // One bounded cross-symbol read supplies novelty and score-change context.
  // It never mutates historical observations and avoids an N+1 query per card.
  const journalSymbols = [...new Set(observations.map((o: any) => o.symbol))];
  const latestObservationTs = observations.reduce((latest: string, o: any) => o.ts > latest ? o.ts : latest, "");
  const historyBySymbol = new Map<string, any[]>();
  let historyCapped = false;
  if (journalSymbols.length) {
    const { data: historyRows, error: historyError } = await svc.from("decision_observations")
      .select("id,symbol,ts,analyst_score,direction,entry_eligible")
      .eq("market", market).in("symbol", journalSymbols)
      .lte("ts", latestObservationTs)
      .order("ts", { ascending: false }).order("id", { ascending: false }).limit(1000);
    if (historyError) return NextResponse.json({ error: historyError.message }, { status: 500 });
    historyCapped = (historyRows?.length ?? 0) === 1000;
    for (const row of historyRows ?? []) {
      const rows = historyBySymbol.get(row.symbol) ?? [];
      rows.push(row); historyBySymbol.set(row.symbol, rows);
    }
  }

  const paperBySymbol = new Map<string, any>();
  const outcomeBySignal = new Map<string, any>();
  const liveHoldingBySymbol = new Map<string, ReturnType<typeof normalizeSnapshotHolding>>();
  const livePlanBySymbol = new Map<string, any>();
  let liveSnapshotMeta: { broker: string | null; captured_at: string } | null = null;
  const requestedHorizons = [...new Set(observations.map((obs: any) =>
    Number(obs.features?.trade_plan?.horizon_sessions ?? obs.features?.trading_mandate?.target_hold_days ?? 10)
  ).filter((day: number) => [2, 5, 10, 20].includes(day)))];

  if (journalSymbols.length) {
    const [{ data: paperRows, error: paperError }, { data: outcomeRows, error: outcomeError }, configResult, mandate, readiness] = await Promise.all([
      svc.from("paper_positions")
        .select("id,symbol,qty,avg_cost,current_price,opened_at,updated_at,price_target,stop_loss,initial_stop_loss,highest_price,target_updated_at,resolved_horizon_days,mandate_version")
        .eq("market", market).in("symbol", journalSymbols),
      signalIds.length ? svc.from("paper_trades")
        .select("id,signal_id,symbol,qty,fill_price,exit_price,realized_pnl,pnl_pct,outcome,executed_at,closed_at,exit_reason")
        .eq("market", market).in("signal_id", signalIds).order("executed_at", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
      svc.from("strategy_config").select("active_account_us,active_account_india").limit(1).maybeSingle(),
      loadTradingMandate(svc, market),
      getMaeMfeReadinessByHorizons(svc, market, requestedHorizons),
    ]);
    if (paperError || outcomeError || configResult.error) {
      return NextResponse.json({ error: paperError?.message ?? outcomeError?.message ?? configResult.error?.message }, { status: 500 });
    }
    for (const row of paperRows ?? []) paperBySymbol.set(canonicalPositionSymbol(row.symbol, market), row);
    for (const row of outcomeRows ?? []) if (row.signal_id && !outcomeBySignal.has(row.signal_id)) outcomeBySignal.set(row.signal_id, row);

    const readinessByHorizon = readiness;
    for (const obs of observations as any[]) {
      const horizon = Number(obs.features?.trade_plan?.horizon_sessions ?? obs.features?.trading_mandate?.target_hold_days ?? 10);
      obs.learningReadiness = readinessByHorizon[horizon] ?? { n: 0, required: 60, ready: false, available: false };
    }

    const config = configResult.data as any;
    const activeAccount = market === "india" ? config?.active_account_india : config?.active_account_us;
    if (activeAccount) {
      const { data: snapshot, error: snapshotError } = await svc.from("live_account_snapshots")
        .select("account_id,broker,positions_json,captured_at")
        .eq("account_id", activeAccount).order("captured_at", { ascending: false }).limit(1).maybeSingle();
      if (snapshotError) return NextResponse.json({ error: snapshotError.message }, { status: 500 });
      if (snapshot) {
        liveSnapshotMeta = { broker: snapshot.broker ?? null, captured_at: snapshot.captured_at };
        for (const raw of Array.isArray(snapshot.positions_json) ? snapshot.positions_json : []) {
          const holding = normalizeSnapshotHolding(raw);
          if (holding) liveHoldingBySymbol.set(canonicalPositionSymbol(holding.symbol, market), holding);
        }
      }

      const { data: fills, error: fillsError } = await svc.from("broker_orders")
        .select("proposal_id,symbol,side,filled_qty,qty,avg_fill_price,created_at")
        .eq("broker_env", "live").eq("market", market).eq("status", "filled");
      if (fillsError) return NextResponse.json({ error: fillsError.message }, { status: 500 });
      const proposalIds = [...new Set((fills ?? []).map((row: any) => row.proposal_id).filter((id: any) => id != null))];
      let proposals: any[] = [];
      if (proposalIds.length) {
        const { data, error } = await svc.from("trade_proposals")
          .select("id,account_number,policy_snapshot").in("id", proposalIds);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        proposals = data ?? [];
      }
      for (const position of reconstructAccountLivePositions({
        orders: (fills ?? []) as any[], proposals, activeAccount,
        fallbackPolicy: {
          stopLossPct: mandate.stop_loss_pct, targetPct: mandate.target_pct,
          maxHoldDays: mandate.max_hold_days, horizonDays: mandate.target_hold_days,
          mandateVersion: mandate.version,
        },
      })) livePlanBySymbol.set(canonicalPositionSymbol(position.symbol, market), position);
    }
  }

  const symbols = observations.map((obs: any) => {
    const signal = signalById.get(obs.signal_id) as any;
    const packet = packetById.get(signal?.research_packet_id) as any;
    const assetType = classifyJournalAsset(obs.symbol, signal?.asset_class);
    const isFund = assetType === "etf" || assetType === "metal_fund";
    const weighting = obs.features?.weighting ?? {};
    const quality = obs.features?.quality ?? {};
    const rationale = signal?.rationale ?? packet?.summary ?? null;
    const dimensions = Object.fromEntries(DIMS.map(dim => {
      const score = obs[`${dim}_score`];
      const weight = Number(weighting.applied_weights?.[dim] ?? obs.weights_used?.[dim] ?? 0);
      const state = quality?.[dim]?.state ?? (obs.availability_mask?.[dim] ? "ok" : "missing");
      const feature = obs.features?.[dim] ?? {};
      return [dim, {
        score, weight, contribution: Number.isFinite(score) && Number.isFinite(weight) ? Number((score * weight).toFixed(2)) : null,
        state, note: feature?.note ?? null, evidence: compactEvidence(feature),
      }];
    }));
    if (isFund) {
      dimensions.fundamental.state = "inapplicable";
      dimensions.fundamental.weight = 0;
      dimensions.fundamental.contribution = 0;
      dimensions.fundamental.note = "Company fundamentals are not applicable to a fund; use fund exposure, holdings, liquidity and structure instead.";
      dimensions.insider.state = "inapplicable";
      dimensions.insider.weight = 0;
      dimensions.insider.contribution = 0;
      dimensions.insider.note = "Corporate insider transactions are not applicable to a fund.";
    }
    const missingInputs = DIMS.filter(dim => ["missing", "degraded"].includes(dimensions[dim].state));
    const weakDimensions = DIMS.filter(dim => dimensions[dim].state === "ok" && Number(dimensions[dim].score) < 50);
    const screener = obs.features?.screener ?? null;
    const discoverySource = obs.discovery_source ?? signal?.source ?? null;
    const selectionReason = screener
      ? `Screened into ${screener.bucket}: ${(screener.criteria_matched ?? []).join(", ") || "bucket criteria matched"}.`
      : packet?.is_held_position ? "Existing holding was reassessed as part of portfolio monitoring."
      : discoverySource ? `Entered research from ${String(discoverySource).replaceAll("_", " ")}.`
      : "Research provenance was not recorded for this historical observation.";
    const events = eventsBySignal.get(obs.signal_id) ?? [];
    const history = (historyBySymbol.get(obs.symbol) ?? []).filter(row =>
      row.ts < obs.ts || (row.ts === obs.ts && Number(row.id) <= Number(obs.id))
    );
    const previous = history.find(row => row.id !== obs.id) ?? null;
    const earliest = history.length ? history[history.length - 1] : null;
    const held = Boolean(packet?.is_held_position);
    const discoveryState = held ? "holding" : history.length <= 1 ? "new" : "recurring";
    const applicableDims = DIMS.filter(dim => dimensions[dim].state !== "inapplicable");
    const usableDims = applicableDims.filter(dim => dimensions[dim].state === "ok");
    const baseWeights = weighting.base_weights ?? obs.weights_used ?? {};
    const structuralWeight = applicableDims.reduce((sum, dim) => sum + Math.max(0, Number(baseWeights[dim] ?? 0)), 0);
    const usableWeight = usableDims.reduce((sum, dim) => sum + Math.max(0, Number(baseWeights[dim] ?? 0)), 0);
    const evidenceCoverage = structuralWeight > 0 ? usableWeight / structuralWeight
      : applicableDims.length ? usableDims.length / applicableDims.length : 0;
    const confidenceLabel = obs.evidence_confidence != null
      ? (obs.evidence_confidence >= 0.75 && evidenceCoverage >= 0.8 ? "High" : obs.evidence_confidence >= 0.5 && evidenceCoverage >= 0.6 ? "Moderate" : "Limited")
      : evidenceCoverage >= 0.8 && usableDims.length >= 3 ? "Unrated (good coverage)" : "Limited";
    const downstreamRejection = events.find((e: any) => e.stage !== "research" && e.outcome === "rejected");
    const action = held
      ? obs.direction === "short" ? "EXIT REVIEW" : obs.direction === "long" ? "HOLD / MONITOR" : "REVIEW"
      : downstreamRejection ? "BLOCKED DOWNSTREAM"
      : obs.entry_eligible ? "PAPER CANDIDATE" : obs.analyst_score < obs.score_threshold ? "AVOID FOR NOW" : "WAIT FOR CONFIRMATION";
    const technicalRead = technicalTranslation(dimensions.technical.evidence ?? {});
    const volumeRatio = Number(dimensions.technical.evidence?.volumeVsAvg20);
    const sentimentScore = Number(dimensions.sentiment.score);
    const hypeRead = sentimentScore >= 85 && Number.isFinite(volumeRatio) && volumeRatio < 0.7
      ? `Sentiment is extremely bullish, but volume is only ${volumeRatio.toFixed(2)}× average. Treat the excitement as unconfirmed rather than broad market participation.`
      : Number(dimensions.technical.evidence?.rsi14) >= 70 && Number.isFinite(volumeRatio) && volumeRatio >= 1.5
        ? "Momentum and volume are both elevated. The move has participation, but chase/pullback risk is also higher."
        : "The stored technical and sentiment evidence does not show an extreme hype pattern; current news intensity was not recorded in this historical packet.";
    const social = packet?.raw_data?._social_sentiment ?? null;
    const sentimentSample = Number(social?.stocktwits_message_count ?? 0) + Number(social?.av_news_articles ?? 0);
    const strongest = Object.entries(dimensions)
      .filter(([, d]: [string, any]) => d.state === "ok")
      .sort((a: any, b: any) => Number(b[1].contribution ?? 0) - Number(a[1].contribution ?? 0))[0];
    const strongestEvidence = strongest?.[0] === "technical"
      ? `Technical evidence was strongest. ${technicalRead[0] ?? `Technical score was ${(strongest[1] as any).score}.`}`
      : strongest?.[0] === "sentiment" ? sentimentSample > 0
        ? `Sentiment was strongest across ${sentimentSample} recorded messages/articles; source mix and freshness still matter.`
        : `Sentiment was strongest, but the historical packet did not record a supporting sample size, so treat it cautiously.`
      : strongest ? `${titleCase(String(strongest[0]))} evidence was strongest, with a score of ${(strongest[1] as any).score}.`
      : "No usable evidence dimension was recorded.";
    // Known-sparse dims (India sentiment via GDELT, US insider via Form 4) are
    // absent on most names by nature — say so, instead of implying a fault. The
    // availability mask already renormalizes the score over the present dimensions.
    const SPARSE_BY_NATURE = new Set(["sentiment", "insider"]);
    const mainRisk = missingInputs.length
      ? (SPARSE_BY_NATURE.has(String(missingInputs[0]).toLowerCase())
          ? `${titleCase(String(missingInputs[0]))} coverage is limited for this name (expected — this signal is sparse); the score is renormalized over the available evidence.`
          : `${missingInputs[0]} evidence is unavailable or degraded.`)
      : weakDimensions.length ? `${weakDimensions[0]} evidence is below neutral.`
      : packet?.key_risks?.[0] ?? "No specific counter-evidence was recorded.";
    const fundRisks = Array.isArray(packet?.key_risks)
      ? packet.key_risks.filter((risk: string) => !/company fundamentals|fundamental data|earnings surprise|insider activity|macro regime|US\/India/i.test(risk)) : [];
    const thesisSummary = isFund
      ? `This is a fund, not an operating company. Its available-evidence score was ${obs.analyst_score}/100, driven by ${usableDims.join(" and ") || "no usable dimensions"}; evidence coverage was ${Math.round(evidenceCoverage * 100)}%. ${technicalRead[0] ?? "No technical translation was available."} Confidence is ${confidenceLabel.toLowerCase()} because fund-profile data and/or applicable market context were incomplete in this historical packet.`
      : packet?.summary ?? rationale;
    const storedPlan = obs.features?.trade_plan;
    const tradePlan = storedPlan?.version === "v1"
      ? storedPlan
      : buildIndicativeTradePlan({
          referencePrice: obs.price_at_decision,
          referenceAsOf: obs.ts,
          referenceSource: "historical_observation",
          decisionAt: obs.ts,
          currency: market === "india" ? "INR" : "USD",
          stopLossPct: signal?.stop_loss_pct ?? obs.features?.trading_mandate?.stop_loss_pct,
          targetPct: signal?.take_profit_pct ?? obs.features?.trading_mandate?.target_pct,
          horizonSessions: obs.features?.trading_mandate?.target_hold_days,
          mandateVersion: obs.features?.trading_mandate?.version,
          entryEligible: Boolean(obs.entry_eligible),
          direction: obs.direction,
          isHeld: held,
        });
    const positionKey = canonicalPositionSymbol(obs.symbol, market);
    const paperPosition = paperBySymbol.get(positionKey) ?? null;
    const liveHolding = liveHoldingBySymbol.get(positionKey) ?? null;
    const livePlan = livePlanBySymbol.get(positionKey) ?? null;
    const liveQtyMatches = liveHolding && livePlan
      ? Math.abs(liveHolding.qty - livePlan.qty) <= Math.max(0.001, liveHolding.qty * 0.01)
      : false;
    const outcome = outcomeBySignal.get(obs.signal_id) ?? null;
    return {
      observation_id: obs.id,
      observed_at: obs.ts,
      observed_date: localDate(obs.ts, market),
      symbol: obs.symbol, run_count: obs.runCount, analyst_score: obs.analyst_score,
      score_threshold: obs.score_threshold, entry_eligible: obs.entry_eligible, direction: obs.direction,
      evidence_confidence: obs.evidence_confidence, scoring_version: obs.scoring_version,
      trade_plan: tradePlan,
      current_position: {
        paper: paperPosition ? {
          status: "open", qty: finiteOrNull(paperPosition.qty), avg_cost: finiteOrNull(paperPosition.avg_cost),
          current_price: finiteOrNull(paperPosition.current_price), initial_stop_loss: finiteOrNull(paperPosition.initial_stop_loss),
          current_stop_loss: finiteOrNull(paperPosition.stop_loss), price_target: finiteOrNull(paperPosition.price_target),
          highest_price: finiteOrNull(paperPosition.highest_price), opened_at: paperPosition.opened_at,
          updated_at: paperPosition.updated_at, target_updated_at: paperPosition.target_updated_at,
          horizon_days: paperPosition.resolved_horizon_days, mandate_version: paperPosition.mandate_version,
        } : null,
        live: liveHolding ? {
          status: livePlan && liveQtyMatches ? "managed" : livePlan ? "lineage_mismatch" : "unmanaged_by_kairos",
          qty: liveHolding.qty, avg_cost: liveHolding.avgPrice, current_price: liveHolding.currentPrice,
          stop_loss: livePlan && liveQtyMatches ? livePlan.stopPrice : null,
          price_target: livePlan && liveQtyMatches ? livePlan.targetPrice : null,
          horizon_days: livePlan && liveQtyMatches ? livePlan.horizonDays : null,
          policy_source: livePlan && liveQtyMatches ? livePlan.policySource : null,
          snapshot: liveSnapshotMeta,
        } : null,
      },
      realized_outcome: outcome ? {
        trade_id: outcome.id, qty: finiteOrNull(outcome.qty), fill_price: finiteOrNull(outcome.fill_price),
        exit_price: finiteOrNull(outcome.exit_price), realized_pnl: finiteOrNull(outcome.realized_pnl),
        pnl_pct: finiteOrNull(outcome.pnl_pct), outcome: outcome.outcome,
        executed_at: outcome.executed_at, closed_at: outcome.closed_at, exit_reason: outcome.exit_reason,
      } : null,
      learning_readiness: obs.learningReadiness ?? { n: 0, required: 60, ready: false, available: false },
      weighting, dimensions, missing_inputs: missingInputs, weak_dimensions: weakDimensions,
      identity: {
        asset_type: assetType, asset_label: assetLabel(assetType), is_fund: isFund,
        description: isFund ? "Fund exposure; issuer profile and holdings were not stored with this historical decision."
          : dimensions.fundamental.evidence?.sector ? `${assetLabel(assetType)} in the ${dimensions.fundamental.evidence.sector} sector.`
          : `${assetLabel(assetType)}; business description was not stored with this historical decision.`,
      },
      history: {
        state: discoveryState, observations_in_window: history.length,
        first_seen: earliest?.ts ?? obs.ts, capped: historyCapped,
        previous_score: previous?.analyst_score ?? null,
        score_change: previous ? obs.analyst_score - previous.analyst_score : null,
        previous_direction: previous?.direction ?? null,
      },
      novice: {
        action, confidence_label: confidenceLabel,
        evidence_coverage: Number(evidenceCoverage.toFixed(3)),
        usable_dimensions: usableDims.length, applicable_dimensions: applicableDims.length,
        strongest_evidence: strongestEvidence,
        main_risk: mainRisk,
        technical_read: technicalRead, hype_read: hypeRead,
        next_step: held ? "Monitor the invalidation risks and reassess on the next scheduled research run."
          : downstreamRejection ? `Do not advance: ${String(downstreamRejection.reason ?? downstreamRejection.stage).replaceAll("_", " ")}.`
          : obs.entry_eligible ? "Eligible for downstream paper/risk gates; this is not an instruction to place a live order."
          : "Wait for the failed evidence or direction gate to improve before considering an entry.",
      },
      external_links: externalLinks(obs.symbol, market, assetType),
      selection: { source: discoverySource, reason: selectionReason, screener },
      thesis: {
        summary: thesisSummary,
        catalysts: Array.isArray(packet?.catalysts) ? packet.catalysts : [],
        risks: isFund ? fundRisks : Array.isArray(packet?.key_risks) ? packet.key_risks : [],
      },
      decision: {
        verdict: obs.entry_eligible ? "eligible" : obs.direction === "long" ? "rejected" : "abstained",
        reason: decisionReason(obs, rationale),
        checks: [
          { name: "Score threshold", passed: obs.analyst_score >= obs.score_threshold, detail: `${obs.analyst_score} vs ${obs.score_threshold}` },
          { name: "Long direction", passed: obs.direction === "long", detail: obs.direction },
          { name: "Evidence coverage", passed: evidenceCoverage >= 0.6, detail: `${Math.round(evidenceCoverage * 100)}% · ${usableDims.length}/${applicableDims.length} applicable dimensions` },
        ],
      },
      counter_evidence: [
        ...weakDimensions.map(dim => `${dim} score ${dimensions[dim].score} is below neutral.`),
        ...missingInputs.map(dim => `${dim} evidence is ${dimensions[dim].state}.`),
        ...(isFund ? fundRisks : Array.isArray(packet?.key_risks) ? packet.key_risks : []),
      ].slice(0, 8),
      stages: events.map((e: any) => ({
        stage: e.stage, outcome: e.outcome,
        // Older research events encoded every rejection as "score < threshold",
        // even when a high score abstained on direction/parse/evidence. Preserve
        // the immutable row in DB but normalize its display from the observation.
        reason: e.stage === "research" ? decisionReason(obs, rationale) : e.reason,
        detail: e.detail, original_reason: e.stage === "research" ? e.reason : null,
        at: e.created_at,
      })),
      terminal: resolveJournalTerminal({
        entryEligible: obs.entry_eligible,
        signalStatus: signal?.status,
        events,
      }),
    };
  });

  return NextResponse.json({
    scope, date: requestedDate, market, symbol_filter: symbolFilter || null,
    latest_available_date: latestAvailableDate, count: symbols.length,
    capped: allDatesCapped, limit: scope === "all" ? JOURNAL_ALL_DATES_LIMIT : null, symbols,
  });
}
