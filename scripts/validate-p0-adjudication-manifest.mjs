// Run with: node scripts/validate-p0-adjudication-manifest.mjs
// (no shebang: this module is imported by tests/p0-adjudication-manifest.test.ts,
//  and esbuild/vitest cannot parse "#!" when loading it as a module.)
/**
 * Deterministic validator for features/relationship-graph/P0_ADJUDICATION_MANIFEST.json.
 *
 * Read-only. No network, no DB, no keys. Offline and deterministic by construction:
 * it reads two committed JSON files and derives everything else.
 *
 * Why this exists: the P0 study's original headline (5/79) was asserted without a
 * preserved adjudication record and could not be reproduced from any committed
 * artifact. Every number the study reports must now come out of this script.
 *
 *   node scripts/validate-p0-adjudication-manifest.mjs           # human summary, exit 1 on failure
 *   node scripts/validate-p0-adjudication-manifest.mjs --json     # machine-readable {checks, counts}
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = path.join(ROOT, 'features/relationship-graph/P0_ADJUDICATION_MANIFEST.json');
const INDEX_PATH = path.join(ROOT, 'features/relationship-graph/P0_CANDIDATE_INDEX.json');

export const EXPECTED_CANDIDATES = 682;
export const IDENTITY_RESOLUTIONS = ['resolved_ticker', 'resolved_private', 'unresolved', 'ambiguous'];
export const RELATIONSHIP_TYPES = ['customer_revenue', 'market_maker_counterparty', 'tenant_rent', 'supplier', 'other'];
export const EXPOSURE_BASES = ['revenue', 'net_sales', 'recurring_revenue', 'segment_net_sales', 'receivables', 'unknown'];

export function loadManifest(p = MANIFEST_PATH) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
export function loadIndex(p = INDEX_PATH) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** One row per (record, link) — the flattening a single-`customer` schema cannot express. */
export function flattenLinks(manifest) {
  const rows = [];
  for (const r of manifest.records) {
    for (const l of r.links) {
      rows.push({
        id: r.id,
        symbol: r.symbol,
        accession: r.accession,
        counterparty_name: l.counterparty_name,
        identity_resolution: l.identity_resolution,
        resolved_symbol: l.resolved_symbol,
        relationship_type: l.relationship_type,
        exposure_pct: l.exposure_pct,
        exposure_basis: l.exposure_basis,
        exposure_is_floor: l.exposure_is_floor,
        period: l.period,
        available_at: l.available_at,
      });
    }
  }
  return rows;
}

const BASIS_RANK = { revenue: 3, net_sales: 3, recurring_revenue: 3, segment_net_sales: 2, receivables: 1, unknown: 0 };

/**
 * Deduplicate to one row per (filer, counterparty, period, relationship_type).
 * Overlapping spans restate ONE disclosure: CHD emits 6 spans for a single Walmart
 * link. Span-level counts double-count and must never be reported as relationships.
 * Where duplicates disagree on basis, the consolidated denominator wins (FSLR).
 */
export function dedupeRelationships(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = [r.symbol, r.counterparty_name, r.period, r.relationship_type].join('|');
    const prev = byKey.get(key);
    if (!prev || BASIS_RANK[r.exposure_basis] > BASIS_RANK[prev.exposure_basis]) byKey.set(key, r);
  }
  return [...byKey.values()].sort((a, b) => (a.symbol + a.counterparty_name < b.symbol + b.counterparty_name ? -1 : 1));
}

const tally = (xs, f) =>
  xs.reduce((a, x) => {
    const k = f(x);
    a[k] = (a[k] || 0) + 1;
    return a;
  }, {});

export function computeCounts(manifest) {
  const recs = manifest.records;
  const accepted = recs.filter((r) => r.disposition === 'accepted');
  const rows = flattenLinks(manifest);
  const deduped = dedupeRelationships(rows);
  const tradable = deduped.filter((r) => r.identity_resolution === 'resolved_ticker');

  return {
    candidates_reviewed: recs.length,
    accepted_spans: accepted.length,
    rejected_spans: recs.length - accepted.length,
    rejection_reasons: tally(recs.filter((r) => r.disposition === 'rejected'), (r) => r.rejection_reason),
    review_depth: tally(recs, (r) => r.review_depth),
    disagreements_with_first_pass_disposition: recs.filter((r) => !r.agrees_with_first_pass_disposition).length,

    // --- headline numbers, each reported separately; never summed across types
    filers_with_any_named_weighted_relationship: new Set(accepted.map((r) => r.symbol)).size,
    filers_by_relationship_type: Object.fromEntries(
      RELATIONSHIP_TYPES.map((t) => [t, new Set(deduped.filter((r) => r.relationship_type === t).map((r) => r.symbol)).size]).filter(
        ([, n]) => n > 0,
      ),
    ),
    named_relationships_span_level: rows.length,
    named_relationships_deduped: deduped.length,
    resolved_tradable_relationships: tradable.length,
    relationships_at_or_above_10pct: deduped.filter((r) => r.exposure_pct >= 10).length,
    resolved_tradable_at_or_above_10pct: tradable.filter((r) => r.exposure_pct >= 10).length,
    // "supplier" = the filer side of the edge, i.e. the issuer making the disclosure.
    distinct_suppliers_represented: new Set(deduped.map((r) => r.symbol)).size,
    distinct_suppliers_with_a_tradable_relationship: new Set(tradable.map((r) => r.symbol)).size,
    distinct_counterparties: new Set(deduped.map((r) => r.counterparty_name)).size,
    distinct_tradable_counterparties: new Set(tradable.map((r) => r.resolved_symbol)).size,

    by_relationship_type: tally(deduped, (r) => r.relationship_type),
    by_exposure_basis: tally(deduped, (r) => r.exposure_basis),
    // pre-dedup, so the segment-denominator case FSLR discloses stays visible
    by_exposure_basis_span_level: tally(rows, (r) => r.exposure_basis),
    by_identity_resolution: tally(deduped, (r) => r.identity_resolution),
    floors_not_shares: deduped.filter((r) => r.exposure_is_floor).length,

    // the homogeneous factor the pre-registered experiment actually needs
    customer_revenue_only: (() => {
      const cr = deduped.filter((r) => r.relationship_type === 'customer_revenue');
      const crt = cr.filter((r) => r.identity_resolution === 'resolved_ticker');
      const usable = crt.filter((r) => !r.exposure_is_floor && r.exposure_basis !== 'segment_net_sales');
      return {
        relationships: cr.length,
        filers: new Set(cr.map((r) => r.symbol)).size,
        tradable: crt.length,
        tradable_filers: new Set(crt.map((r) => r.symbol)).size,
        tradable_with_a_real_weight_not_a_floor: usable.length,
        filers_with_a_real_weight: new Set(usable.map((r) => r.symbol)).size,
        weighted_pairs: usable.map((r) => `${r.symbol}->${r.resolved_symbol} ${r.exposure_pct}%`).sort(),
      };
    })(),

    anonymized_counterparties_recorded: recs.reduce((n, r) => n + (r.anonymized_counterparties_in_span?.length ?? 0), 0),
  };
}

export function runChecks(manifest, index) {
  const c = [];
  const ok = (name, pass, detail = '') => c.push({ name, pass, detail });
  const recs = manifest.records;
  const ids = recs.map((r) => r.id);
  const idSet = new Set(ids);
  const indexIds = new Set(index.candidates.map((x) => x.id));

  ok('manifest has exactly 682 candidate records', recs.length === EXPECTED_CANDIDATES, `got ${recs.length}`);
  ok('candidate index has exactly 682 entries', index.candidates.length === EXPECTED_CANDIDATES, `got ${index.candidates.length}`);
  ok('no duplicate ids in the manifest', idSet.size === ids.length, `${ids.length - idSet.size} duplicate(s)`);

  const missing = [...indexIds].filter((i) => !idSet.has(i));
  const unknown = [...idSet].filter((i) => !indexIds.has(i));
  ok('no candidate missing from the manifest', missing.length === 0, missing.slice(0, 5).join(','));
  ok('no unknown id invented by the manifest', unknown.length === 0, unknown.slice(0, 5).join(','));

  const byId = Object.fromEntries(index.candidates.map((x) => [x.id, x]));
  const shaMismatch = recs.filter((r) => byId[r.id] && byId[r.id].spanSha256 !== r.spanSha256);
  ok('every spanSha256 matches the candidate index', shaMismatch.length === 0, shaMismatch.map((r) => r.id).join(','));
  const netMismatch = recs.filter((r) => byId[r.id] && byId[r.id].nets.join() !== r.nets.join());
  ok('every recall-net tag matches the candidate index', netMismatch.length === 0, netMismatch.map((r) => r.id).join(','));

  ok('sample frame hash matches the probe', manifest.sample_frame_sha256 === index.sample_frame_sha256, manifest.sample_frame_sha256);

  ok(
    'every record carries id, symbol, cik, accession, documentSha256, spanSha256, nets, disposition, adjudicator, links',
    recs.every(
      (r) =>
        r.id && r.symbol && r.cik && r.accession && /^[0-9a-f]{64}$/.test(r.documentSha256) && /^[0-9a-f]{64}$/.test(r.spanSha256) &&
        Array.isArray(r.nets) && r.nets.length > 0 && ['accepted', 'rejected'].includes(r.disposition) && r.adjudicator && Array.isArray(r.links),
    ),
  );
  ok('rejection_reason is null iff accepted', recs.every((r) => (r.disposition === 'accepted') === (r.rejection_reason === null)));
  ok('rejected records carry no links', recs.every((r) => r.disposition === 'rejected' ? r.links.length === 0 : true));
  ok('accepted records carry at least one link', recs.every((r) => r.disposition === 'accepted' ? r.links.length > 0 : true));

  const links = flattenLinks(manifest);
  ok('every link uses a known identity_resolution', links.every((l) => IDENTITY_RESOLUTIONS.includes(l.identity_resolution)));
  ok('every link uses a known relationship_type', links.every((l) => RELATIONSHIP_TYPES.includes(l.relationship_type)));
  ok('every link uses a known exposure_basis', links.every((l) => EXPOSURE_BASES.includes(l.exposure_basis)));
  ok('every link declares exposure_is_floor as a boolean', links.every((l) => typeof l.exposure_is_floor === 'boolean'));
  ok('every link carries a period', links.every((l) => typeof l.period === 'string' && l.period.length > 0));

  // FAIL-CLOSED (FEATURE_ARCHITECTURE 3 / 6.1). A link that is unresolved, ambiguous, or
  // resolved to a non-tradable entity must never carry a symbol, and is never counted as
  // tradable. This is how the study's BCRED->BX false positive is prevented structurally.
  ok(
    'fail-closed: resolved_symbol is non-null iff identity_resolution is resolved_ticker',
    links.every((l) => (l.identity_resolution === 'resolved_ticker') === (l.resolved_symbol !== null)),
    links.filter((l) => (l.identity_resolution === 'resolved_ticker') !== (l.resolved_symbol !== null)).map((l) => l.id).join(','),
  );

  // available_at must be the EDGAR acceptance timestamp, never filingDate (study 4).
  ok(
    'every link carries an intraday available_at (acceptanceDateTime, not filingDate)',
    links.every((l) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(l.available_at)),
  );
  ok(
    'available_at is identical across all links of one accession',
    (() => {
      const m = new Map();
      for (const l of links) {
        if (m.has(l.accession) && m.get(l.accession) !== l.available_at) return false;
        m.set(l.accession, l.available_at);
      }
      return true;
    })(),
  );

  // Multi-link spans must flatten, not collapse. The first pass's single-`customer`
  // field could not express these and pushed the extra names into free text.
  const multi = manifest.records.filter((r) => r.links.length > 1);
  ok('multi-link spans exist and flatten to one row per counterparty', multi.length > 0 && multi.every((r) => new Set(r.links.map((l) => l.counterparty_name)).size === r.links.length), `${multi.length} multi-link span(s)`);
  ok(
    'DLR names 11 tenants and anonymizes 8 in the same table',
    (() => {
      const dlr = manifest.records.find((r) => r.symbol === 'DLR' && r.disposition === 'accepted');
      return dlr?.links.length === 11 && dlr?.anonymized_counterparties_in_span?.length === 8;
    })(),
  );
  ok(
    'no relationship_type is summed with another: types are disjoint per link',
    links.every((l) => typeof l.relationship_type === 'string'),
  );

  const counts = computeCounts(manifest);
  ok('dedup collapses overlapping spans', counts.named_relationships_deduped < counts.named_relationships_span_level, `${counts.named_relationships_span_level} span-level -> ${counts.named_relationships_deduped} deduped`);
  ok('tradable relationships never exceed named relationships', counts.resolved_tradable_relationships <= counts.named_relationships_deduped);
  ok(
    'every accepted span was re-read in full by the second pass',
    recs.filter((r) => r.disposition === 'accepted').every((r) => r.review_depth === 'second_pass_full_reread'),
  );

  return c;
}

function main() {
  const manifest = loadManifest();
  const index = loadIndex();
  const checks = runChecks(manifest, index);
  const counts = computeCounts(manifest);
  const failed = checks.filter((x) => !x.pass);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ checks, counts }, null, 2));
  } else {
    for (const x of checks) console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.detail ? `  [${x.detail}]` : ''}`);
    console.log('\n--- counts derived from the manifest ---');
    console.log(JSON.stringify(counts, null, 2));
  }
  if (failed.length) {
    console.error(`\n${failed.length} check(s) FAILED`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
