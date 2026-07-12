import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

const DIMS = ["fundamental", "technical", "sentiment", "macro", "insider"] as const;

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
      svc.from("agent_signals").select("id,rationale,research_packet_id,source,status").in("id", signalIds),
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
    return {
      symbol: obs.symbol, run_count: obs.runCount, analyst_score: obs.analyst_score,
      score_threshold: obs.score_threshold, entry_eligible: obs.entry_eligible, direction: obs.direction,
      evidence_confidence: obs.evidence_confidence, scoring_version: obs.scoring_version,
      weighting, dimensions, missing_inputs: missingInputs, weak_dimensions: weakDimensions,
      selection: { source: discoverySource, reason: selectionReason, screener },
      thesis: {
        summary: packet?.summary ?? rationale,
        catalysts: Array.isArray(packet?.catalysts) ? packet.catalysts : [],
        risks: Array.isArray(packet?.key_risks) ? packet.key_risks : [],
      },
      decision: {
        verdict: obs.entry_eligible ? "eligible" : obs.direction === "long" ? "rejected" : "abstained",
        reason: decisionReason(obs, rationale),
        checks: [
          { name: "Score threshold", passed: obs.analyst_score >= obs.score_threshold, detail: `${obs.analyst_score} vs ${obs.score_threshold}` },
          { name: "Long direction", passed: obs.direction === "long", detail: obs.direction },
          { name: "Evidence breadth", passed: (weighting.included_dims?.length ?? 0) >= 2, detail: `${weighting.included_dims?.length ?? 0}/5 dimensions` },
        ],
      },
      counter_evidence: [
        ...weakDimensions.map(dim => `${dim} score ${dimensions[dim].score} is below neutral.`),
        ...missingInputs.map(dim => `${dim} evidence is ${dimensions[dim].state}.`),
        ...(Array.isArray(packet?.key_risks) ? packet.key_risks : []),
      ].slice(0, 8),
      stages: events.map((e: any) => ({ stage: e.stage, outcome: e.outcome, reason: e.reason, detail: e.detail, at: e.created_at })),
      terminal: terminalState(obs, events),
    };
  });

  return NextResponse.json({ date: requestedDate, market, latest_available_date: latestAvailableDate, count: symbols.length, symbols });
}
