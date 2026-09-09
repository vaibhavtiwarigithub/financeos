import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { candidateRowForFiling, LISTING_DISCOVERY_POLICY } from "@/lib/listings/discovery";
import { fetchEdgarListingFilings, isFilingDay, type EdgarListingFiling } from "@/lib/listings/sec-edgar";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function ownerOrCron(req: NextRequest) { return verifyCronSecret(req) ? null : requireOwner(); }

function priorWeekdays(now = new Date(), count = 3): Date[] {
  const dates: Date[] = [];
  for (let offset = 0; dates.length < count && offset < 10; offset++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset));
    if (isFilingDay(d)) dates.push(d);
  }
  return dates;
}

async function persistFiling(svc: any, filing: EdgarListingFiling) {
  const now = new Date();
  const candidate = candidateRowForFiling(filing, now);
  const { data: existing, error: existingError } = await svc.from("listing_candidates")
    .select("id,state,first_seen_at").eq("market", "us").eq("listing_key", candidate.listing_key).maybeSingle();
  if (existingError) throw new Error(`candidate read failed: ${existingError.message}`);

  let candidateId = existing?.id as number | undefined;
  const eventState = candidate.state;
  if (!candidateId) {
    const { data, error } = await svc.from("listing_candidates").insert({ ...candidate, instrument_type: "unknown", first_seen_at: now.toISOString() }).select("id").single();
    if (error) throw new Error(`candidate insert failed: ${error.message}`);
    candidateId = data.id;
  } else {
    // Never downgrade an observed listing, withdrawal, or rejection merely
    // because an older filing is re-read by an overlapping daily window.
    const terminalOrAdvanced = ["listed_observing", "withdrawn", "postponed", "rejected", "delisted", "paper_admitted"].includes(existing.state);
    const { error } = await svc.from("listing_candidates").update({
      ...candidate,
      state: terminalOrAdvanced ? existing.state : eventState,
      first_seen_at: existing.first_seen_at,
    }).eq("id", candidateId);
    if (error) throw new Error(`candidate update failed: ${error.message}`);
  }

  const filingRow = {
    candidate_id: candidateId, cik: filing.cik, accession_number: filing.accessionNumber, form: filing.form,
    filed_at: filing.filedAt, primary_document_url: filing.sourceUrl, issuer_name: filing.companyName,
    document_hash: filing.payloadHash, parser_version: LISTING_DISCOVERY_POLICY, quality_state: "metadata_only",
    structured_payload: { source: "sec_edgar_daily_index", accession_number: filing.accessionNumber },
  };
  const { error: filingError } = await svc.from("issuer_filings").upsert(filingRow, { onConflict: "accession_number,document_hash", ignoreDuplicates: true });
  if (filingError) throw new Error(`filing write failed: ${filingError.message}`);

  const event = {
    candidate_id: candidateId, event_type: "filing_discovered", event_at: now.toISOString(), effective_at: `${filing.filedAt}T00:00:00.000Z`,
    prior_state: existing?.state ?? null, next_state: eventState, source: "sec_edgar_daily_index", source_event_id: filing.accessionNumber,
    source_url: filing.sourceUrl, source_payload_hash: filing.payloadHash, reason_code: "sec_registration_filing",
    calculations: { form: filing.form, evidence_only: true }, code_version: LISTING_DISCOVERY_POLICY,
  };
  const { error: eventError } = await svc.from("listing_candidate_events").upsert(event, {
    onConflict: "candidate_id,event_type,source,source_event_id,source_payload_hash", ignoreDuplicates: true,
  });
  if (eventError) throw new Error(`candidate event write failed: ${eventError.message}`);
  return { created: !existing, candidateId };
}

async function runDiscovery() {
  const svc = createServiceClient();
  const startedAt = new Date().toISOString();
  const dates = priorWeekdays();
  const fetched = await Promise.all(dates.map(async date => ({ date: date.toISOString().slice(0, 10), filings: await fetchEdgarListingFilings(date) })));
  const byAccession = new Map<string, EdgarListingFiling>();
  for (const batch of fetched) for (const filing of batch.filings) byAccession.set(filing.accessionNumber, filing);
  let created = 0;
  for (const filing of byAccession.values()) if ((await persistFiling(svc, filing)).created) created++;
  const summary = { policy: LISTING_DISCOVERY_POLICY, source: "sec_edgar_daily_index", dates: fetched.map(x => x.date), filings_seen: byAccession.size, candidates_created: created, influence: "none" };
  // agent_runs is operational health only; it is not used as listing evidence.
  await svc.from("agent_runs").insert({ agent_type: "listing_discovery", market: "us", status: "completed", started_at: startedAt, completed_at: new Date().toISOString(), result_summary: JSON.stringify(summary), symbols: [] });
  return summary;
}

export async function POST(req: NextRequest) {
  const gate = await ownerOrCron(req); if (gate) return gate;
  if (req.nextUrl.searchParams.get("market") !== "us") return NextResponse.json({ error: "only US evidence-only discovery is available" }, { status: 400 });
  try { return NextResponse.json(await runDiscovery()); }
  catch (error) {
    const message = error instanceof Error ? error.message : "listing discovery failed";
    // An unavailable regulator source must be visible as an errored run; no row
    // would make a dashboard interpret the absence as an empty listing day.
    await createServiceClient().from("agent_runs").insert({ agent_type: "listing_discovery", market: "us", status: "error", started_at: new Date().toISOString(), completed_at: new Date().toISOString(), result_summary: JSON.stringify({ source: "sec_edgar_daily_index", error: message, influence: "none" }), symbols: [] });
    return NextResponse.json({ error: message, influence: "none" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const svc = createServiceClient();
  const { data, error } = await svc.from("listing_candidates").select("id,state,last_seen_at").eq("market", "us").order("last_seen_at", { ascending: false }).limit(1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ policy: LISTING_DISCOVERY_POLICY, latest_candidate: data?.[0] ?? null, influence: "none" });
}
