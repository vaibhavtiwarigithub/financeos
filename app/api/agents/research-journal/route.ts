import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { classifyJournalAsset } from "@/lib/asset-classification";

export const dynamic = "force-dynamic";

const DIMS = ["fundamental", "technical", "sentiment", "macro", "insider"] as const;
function titleCase(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, c => c.toUpperCase()); }

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
  const [{ data: rawRows, error: obsError }, { data: latestRows, error: latestError }] = await Promise.all([
    svc.from("decision_observations")
      .select("id,ts,market,symbol,analyst_score,score_threshold,entry_eligible,direction,fundamental_score,technical_score,sentiment_score,macro_score,insider_score,features,availability_mask,weights_used,signal_id,discovery_source,evidence_confidence,scoring_version")
      .eq("market", market).gte("ts", envelopeStart.toISOString()).lte("ts", envelopeEnd.toISOString())
      .order("ts", { ascending: true }).order("id", { ascending: true }),
    svc.from("decision_observations").select("ts").eq("market", market).order("ts", { ascending: false }).limit(1),
  ]);
  if (obsError || latestError) {
    return NextResponse.json({ error: obsError?.message ?? latestError?.message ?? "journal query failed" }, { status: 500 });
  }
  const rawObservations = (rawRows ?? []).filter((row: any) => localDate(row.ts, market) === requestedDate);
  const latestAvailableDate = latestRows?.[0]?.ts ? localDate(latestRows[0].ts, market) : null;

  const bySymbol = new Map<string, { obs: any; runCount: number }>();
  for (const obs of rawObservations as any[]) {
    const existing = bySymbol.get(obs.symbol);
    bySymbol.set(obs.symbol, { obs, runCount: (existing?.runCount ?? 0) + 1 });
  }
  const observations = Array.from(bySymbol.values())
    .map(({ obs, runCount }) => ({ ...obs, runCount }))
    .sort((a, b) => b.analyst_score - a.analyst_score);

  const signalIds = observations.map((o: any) => o.signal_id).filter(Boolean);
  let stageEvents: any[] = [];
  let signals: any[] = [];
  if (signalIds.length) {
    const [{ data: stages, error: stageError }, { data: signalRows, error: signalError }] = await Promise.all([
      svc.from("pipeline_stage_events").select("signal_id,stage,outcome,reason,detail,created_at").in("signal_id", signalIds).order("created_at", { ascending: true }),
      svc.from("agent_signals").select("id,rationale,research_packet_id,source,status,asset_class").in("id", signalIds),
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
  const journalSymbols = observations.map((o: any) => o.symbol);
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

  function terminalState(obs: any, events: any[]): string {
    if (!events.length) return obs.entry_eligible ? "passed_research_no_downstream_data" : "rejected_research";
    const last = events[events.length - 1];
    if (last.stage === "execution" && last.outcome === "filled") return "filled";
    if (last.outcome === "rejected") return `rejected_${last.stage}`;
    return `pending_${last.stage}`;
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
    return {
      symbol: obs.symbol, run_count: obs.runCount, analyst_score: obs.analyst_score,
      score_threshold: obs.score_threshold, entry_eligible: obs.entry_eligible, direction: obs.direction,
      evidence_confidence: obs.evidence_confidence, scoring_version: obs.scoring_version,
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
      terminal: terminalState(obs, events),
    };
  });

  return NextResponse.json({ date: requestedDate, market, latest_available_date: latestAvailableDate, count: symbols.length, symbols });
}
