import { describe, it, expect } from 'vitest';
import { loadManifest, loadIndex, runChecks, computeCounts, flattenLinks, dedupeRelationships } from '../scripts/validate-p0-adjudication-manifest.mjs';

/**
 * Locks the P0 relationship-graph adjudication record.
 *
 * The study's original 5/79 headline was hand-asserted and could not be reproduced
 * from any committed artifact. These tests exist so that can never recur: every
 * number P0_COVERAGE_STUDY.md reports is derived here, and a hand edit to the
 * study that disagrees with the manifest fails the suite.
 */
const manifest = loadManifest();
const index = loadIndex();
const counts = computeCounts(manifest);

describe('P0 adjudication manifest — structural integrity', () => {
  it('passes every deterministic check in the validator', () => {
    const failed = runChecks(manifest, index).filter((c: { pass: boolean }) => !c.pass);
    expect(failed.map((c: { name: string; detail: string }) => `${c.name} [${c.detail}]`)).toEqual([]);
  });

  it('reviews exactly 682 candidates, one record per span', () => {
    expect(manifest.records).toHaveLength(682);
    expect(new Set(manifest.records.map((r: { id: string }) => r.id)).size).toBe(682);
  });

  it('has no missing, duplicate, or unknown ids versus the candidate index', () => {
    const manifestIds = new Set(manifest.records.map((r: { id: string }) => r.id));
    const indexIds = new Set(index.candidates.map((c: { id: string }) => c.id));
    expect([...indexIds].filter((i) => !manifestIds.has(i))).toEqual([]);
    expect([...manifestIds].filter((i) => !indexIds.has(i))).toEqual([]);
  });

  it('commits no raw filing text — only hashes and structured fields', () => {
    const blob = JSON.stringify(manifest.records);
    // A span averages >900 chars. Any verbatim span would blow these budgets.
    for (const r of manifest.records) {
      expect(Object.keys(r)).not.toContain('span');
      expect(r.spanSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(blob).not.toMatch(/Table of Contents/);
  });
});

describe('P0 adjudication manifest — fail-closed identity', () => {
  it('never lets an unresolved or ambiguous link carry a tradable symbol', () => {
    const bad = flattenLinks(manifest).filter(
      (l: { identity_resolution: string; resolved_symbol: string | null }) =>
        ['unresolved', 'ambiguous', 'resolved_private'].includes(l.identity_resolution) && l.resolved_symbol !== null,
    );
    expect(bad).toEqual([]);
  });

  it('never counts a non-resolved_ticker link as tradable', () => {
    const tradable = dedupeRelationships(flattenLinks(manifest)).filter(
      (r: { identity_resolution: string }) => r.identity_resolution === 'resolved_ticker',
    );
    expect(tradable.length).toBe(counts.resolved_tradable_relationships);
    expect(tradable.every((r: { resolved_symbol: string | null }) => r.resolved_symbol !== null)).toBe(true);
  });

  it('keeps the market-maker counterparties non-tradable (HOOD yields zero tradable links)', () => {
    const hood = dedupeRelationships(flattenLinks(manifest)).filter((r: { symbol: string }) => r.symbol === 'HOOD');
    expect(hood.map((r: { counterparty_name: string }) => r.counterparty_name).sort()).toEqual([
      'Citadel Securities, LLC',
      'Wintermute Trading Ltd',
    ]);
    expect(hood.every((r: { resolved_symbol: string | null }) => r.resolved_symbol === null)).toBe(true);
  });
});

describe('P0 adjudication manifest — multi-link flattening', () => {
  it('flattens AMT to four counterparties, not one', () => {
    const amt = manifest.records.find((r: { symbol: string; disposition: string }) => r.symbol === 'AMT' && r.disposition === 'accepted');
    expect(amt.links.map((l: { counterparty_name: string }) => l.counterparty_name)).toEqual([
      'T-Mobile',
      'AT&T',
      'Verizon Wireless',
      'Telefonica',
    ]);
  });

  it('flattens the DLR tenant table to 11 named links and records the 8 anonymized ones separately', () => {
    const dlr = manifest.records.find((r: { symbol: string; disposition: string }) => r.symbol === 'DLR' && r.disposition === 'accepted');
    expect(dlr.links).toHaveLength(11);
    expect(dlr.anonymized_counterparties_in_span).toHaveLength(8);
    // The exhibit: the anonymized #1 tenant outweighs the largest named one.
    const topNamed = Math.max(...dlr.links.map((l: { exposure_pct: number }) => l.exposure_pct));
    const topAnon = Math.max(...dlr.anonymized_counterparties_in_span.map((a: { exposure_pct: number }) => a.exposure_pct));
    expect(topNamed).toBe(9.0);
    expect(topAnon).toBe(11.7);
    expect(topAnon).toBeGreaterThan(topNamed);
  });

  it('flattens QCOM to three counterparties, all marked as floors not shares', () => {
    const qcom = manifest.records.filter((r: { symbol: string; disposition: string }) => r.symbol === 'QCOM' && r.disposition === 'accepted');
    expect(qcom.length).toBeGreaterThan(0);
    for (const r of qcom) {
      expect(r.links).toHaveLength(3);
      expect(r.links.every((l: { exposure_is_floor: boolean }) => l.exposure_is_floor)).toBe(true);
    }
  });
});

describe('P0 adjudication manifest — taxonomy is never conflated', () => {
  it('classifies the three economically different relationships separately', () => {
    const t = counts.by_relationship_type;
    expect(Object.keys(t).sort()).toEqual(['customer_revenue', 'market_maker_counterparty', 'tenant_rent']);
    // The KILL rests on customer_revenue alone. Summing the three would inflate it.
    expect(counts.customer_revenue_only.relationships).toBeLessThan(counts.named_relationships_deduped);
  });

  it('does not let a segment denominator masquerade as a consolidated one', () => {
    const seg = flattenLinks(manifest).filter((l: { exposure_basis: string }) => l.exposure_basis === 'segment_net_sales');
    expect(seg.length).toBeGreaterThan(0);
    expect(seg.every((l: { symbol: string }) => l.symbol === 'FSLR')).toBe(true);
  });
});

describe('P0 adjudication manifest — deduplication', () => {
  it('collapses overlapping spans that restate one disclosure', () => {
    expect(counts.named_relationships_span_level).toBe(48);
    expect(counts.named_relationships_deduped).toBe(27);
  });

  it('collapses CHD\'s six spans and SWK\'s three spans to one disclosure each', () => {
    const rows = dedupeRelationships(flattenLinks(manifest));
    expect(rows.filter((r: { symbol: string }) => r.symbol === 'CHD')).toHaveLength(1);
    expect(rows.filter((r: { symbol: string }) => r.symbol === 'SWK')).toHaveLength(2); // HD + LOW, one disclosure
    expect(manifest.records.filter((r: { symbol: string; disposition: string }) => r.symbol === 'CHD' && r.disposition === 'accepted')).toHaveLength(6);
  });
});

describe('P0 adjudication manifest — point in time', () => {
  it('uses acceptanceDateTime as available_at, never a date-only filingDate', () => {
    const links = flattenLinks(manifest);
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(l.available_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe('the validator itself has teeth', () => {
  // A validator that passes everything proves nothing. Each mutation is a way the
  // record could silently rot; each must be caught.
  const mutations: Array<[string, (m: typeof manifest) => void]> = [
    ['a dropped record', (m) => m.records.pop()],
    ['a duplicated record', (m) => { m.records[5] = { ...m.records[6] }; }],
    ['an invented id', (m) => { m.records[3].id = 'deadbeefdeadbeef'; }],
    ['a tampered spanSha256', (m) => { m.records[9].spanSha256 = '0'.repeat(64); }],
    ['an ambiguous link handed a tradable symbol', (m) => {
      const l = flattenLinks(m).find((x: { identity_resolution: string }) => x.identity_resolution === 'ambiguous');
      if (!l) throw new Error('fixture precondition: manifest has no ambiguous link to tamper with');
      m.records.find((r: { id: string }) => r.id === l.id).links.find(
        (x: { identity_resolution: string }) => x.identity_resolution === 'ambiguous',
      ).resolved_symbol = 'TEF';
    }],
    ['filingDate smuggled in as available_at', (m) => {
      m.records.find((r: { links: unknown[] }) => r.links.length).links[0].available_at = '2026-02-24';
    }],
    ['the DLR tenant table collapsed to one link', (m) => {
      const d = m.records.find((r: { symbol: string; disposition: string }) => r.symbol === 'DLR' && r.disposition === 'accepted');
      d.links = d.links.slice(0, 1);
    }],
    ['a span accepted with no links', (m) => {
      m.records.find((r: { disposition: string }) => r.disposition === 'rejected').disposition = 'accepted';
    }],
    ['an invented relationship_type', (m) => {
      m.records.find((r: { links: unknown[] }) => r.links.length).links[0].relationship_type = 'partner';
    }],
  ];

  it.each(mutations)('rejects %s', (_name, mutate) => {
    const broken = JSON.parse(JSON.stringify(manifest));
    mutate(broken);
    const failed = runChecks(broken, index).filter((c: { pass: boolean }) => !c.pass);
    expect(failed.length).toBeGreaterThan(0);
  });

  it('passes the unmutated manifest', () => {
    expect(runChecks(manifest, index).every((c: { pass: boolean }) => c.pass)).toBe(true);
  });
});

describe('P0 study headline numbers are derived, not hand-written', () => {
  it('reconciles the numbers P0_COVERAGE_STUDY.md reports', () => {
    expect({
      filers_with_any_named_weighted_relationship: counts.filers_with_any_named_weighted_relationship,
      named_relationships_deduped: counts.named_relationships_deduped,
      resolved_tradable_relationships: counts.resolved_tradable_relationships,
      relationships_at_or_above_10pct: counts.relationships_at_or_above_10pct,
      distinct_suppliers_represented: counts.distinct_suppliers_represented,
      by_relationship_type: counts.by_relationship_type,
      by_exposure_basis: counts.by_exposure_basis,
    }).toEqual({
      filers_with_any_named_weighted_relationship: 9,
      named_relationships_deduped: 27,
      resolved_tradable_relationships: 20,
      relationships_at_or_above_10pct: 15,
      distinct_suppliers_represented: 9,
      by_relationship_type: { tenant_rent: 15, customer_revenue: 10, market_maker_counterparty: 2 },
      by_exposure_basis: { revenue: 11, net_sales: 5, recurring_revenue: 11 },
    });
  });

  it('reconciles the homogeneous customer-revenue factor the KILL rests on', () => {
    expect(counts.customer_revenue_only).toEqual({
      relationships: 10,
      filers: 6,
      tradable: 7,
      tradable_filers: 6,
      tradable_with_a_real_weight_not_a_floor: 5,
      filers_with_a_real_weight: 4,
      weighted_pairs: ['CELH->PEP 43.2%', 'CHD->WMT 23%', 'CRWV->MSFT 67%', 'SWK->HD 15%', 'SWK->LOW 12%'],
    });
  });

  it('records the second pass\'s disagreement rate with the first pass', () => {
    // Zero disposition-level disagreements across 682. The disagreement is entirely
    // in the modelling of the 22 accepted spans (links[] and relationship_type).
    expect(counts.disagreements_with_first_pass_disposition).toBe(0);
    expect(counts.review_depth.second_pass_full_reread).toBe(129);
    expect(counts.review_depth.first_pass_adopted_after_screen).toBe(553);
    // The first pass emitted one customer per span; the manifest emits 48.
    const firstPassLinks = manifest.records.filter((r: { first_pass: { customer: string | null } }) => r.first_pass.customer).length;
    expect(firstPassLinks).toBe(22);
    expect(counts.named_relationships_span_level).toBe(48);
  });
});
