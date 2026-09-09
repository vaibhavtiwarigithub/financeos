import type { EdgarListingFiling } from "./sec-edgar";

export const LISTING_DISCOVERY_POLICY = "listing-discovery-p1";

export function candidateStateForFiling(form: string): "pre_listing" | "announced" {
  // A prospectus is stronger evidence that a listing is imminent, but neither
  // it nor an S-1 is evidence of an exchange's first-trade date.
  return form === "424B4" ? "announced" : "pre_listing";
}

export function candidateRowForFiling(filing: EdgarListingFiling, now = new Date()) {
  const state = candidateStateForFiling(filing.form);
  return {
    market: "us", issuer_key: filing.cik, listing_key: `sec-cik:${filing.cik}`,
    company_name: filing.companyName, state, announced_at: state === "announced" ? `${filing.filedAt}T00:00:00.000Z` : null,
    source: "sec_edgar_daily_index", source_event_id: filing.accessionNumber, source_url: filing.sourceUrl,
    source_payload_hash: filing.payloadHash, last_seen_at: now.toISOString(), updated_at: now.toISOString(),
  };
}
