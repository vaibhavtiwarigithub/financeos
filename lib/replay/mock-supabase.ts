// In-memory, READ-ONLY data source shaped like the Supabase query builder, so the
// REAL gate functions (lib/validation/calibration.ts → fitCalibration, which calls
// lib/learning/dataset.ts → loadLabeledDataset) run UNCHANGED over sealed replay
// observations instead of the live decision_observations × observation_labels join.
//
// This is NOT a general Supabase mock — it supports exactly the read chains
// loadLabeledDataset uses:
//   from("decision_observations").select(..).eq("market",m).order("ts",..).limit(n)
//   from("observation_labels").select(..).eq("horizon_days",h).in("observation_id",ids)
// Any write/rpc throws — the harness must never write (measure-only, off by default).

import type { LabeledObservation } from "@/lib/learning/dataset";

type Row = Record<string, unknown>;

// Split sealed LabeledObservations into the two backing tables loadLabeledDataset joins.
export function observationsToTables(observations: LabeledObservation[]): {
  decision_observations: Row[];
  observation_labels: Row[];
} {
  const decision_observations: Row[] = observations.map((o) => ({
    id: o.id,
    ts: o.ts,
    market: o.market,
    symbol: o.symbol,
    analyst_score: o.analyst_score,
    fundamental_score: o.fundamental_score,
    technical_score: o.technical_score,
    sentiment_score: o.sentiment_score,
    macro_score: o.macro_score,
    insider_score: o.insider_score,
    direction: o.direction,
    entry_eligible: o.entry_eligible,
    score_threshold: o.score_threshold,
    availability_mask: o.availability_mask,
  }));
  const observation_labels: Row[] = observations.map((o) => ({
    observation_id: o.id,
    horizon_days: o.horizon_days,
    fwd_return: o.fwd_return,
    benchmark_return: o.benchmark_return,
    benchmark_neutral_return: o.benchmark_neutral_return,
    max_adverse_excursion: o.max_adverse_excursion,
    max_favorable_excursion: o.max_favorable_excursion,
  }));
  return { decision_observations, observation_labels };
}

class QueryBuilder {
  private rows: Row[];
  constructor(rows: Row[]) {
    this.rows = [...rows];
  }
  select(_cols?: string): this {
    return this;
  }
  eq(col: string, val: unknown): this {
    this.rows = this.rows.filter((r) => r[col] === val);
    return this;
  }
  in(col: string, vals: unknown[]): this {
    const set = new Set(vals);
    this.rows = this.rows.filter((r) => set.has(r[col]));
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    const asc = opts?.ascending !== false;
    this.rows = [...this.rows].sort((a, b) => {
      const av = String(a[col]);
      const bv = String(b[col]);
      return asc ? av.localeCompare(bv) : bv.localeCompare(av);
    });
    return this;
  }
  limit(n: number): this {
    this.rows = this.rows.slice(0, n);
    return this;
  }
  maybeSingle(): Promise<{ data: Row | null; error: null }> {
    return Promise.resolve({ data: this.rows[0] ?? null, error: null });
  }
  // Thenable: awaiting the builder resolves the accumulated query.
  then<T>(resolve: (v: { data: Row[]; error: null }) => T): T {
    return resolve({ data: this.rows, error: null });
  }
}

// Build a read-only client backed by in-memory tables. Reads are supported; writes
// and rpc throw loudly so no replay path can accidentally mutate a database.
export function inMemorySupabase(tables: Record<string, Row[]>): {
  from: (t: string) => QueryBuilder;
  rpc: () => never;
} {
  return {
    from(table: string): QueryBuilder {
      return new QueryBuilder(tables[table] ?? []);
    },
    rpc(): never {
      throw new Error("replay mock-supabase is read-only: rpc() is not permitted");
    },
  };
}
