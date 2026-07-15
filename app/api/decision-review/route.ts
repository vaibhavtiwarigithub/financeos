import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// ── Decision Review (counterfactual) — READ-ONLY surfacing layer ──────────────
// For each past decision, show what we scored vs how the stock actually moved
// (the matured forward return from observation_labels). This route NEVER writes:
// it only SELECTs from decision_observations (059), observation_labels (060) and
// v_decision_quality (122). Every number rendered is a ledger field, not a fresh
// recompute — so it can never diverge from what the LearnerAgent reads.
//
// Locked owner decision (do not violate):
//  - Per-symbol attribution ("which dimension was most wrong") is DECORATIVE and
//    always tagged n=1 / illustrative. Actionable aggregate edge is shown ONLY at
//    the cohort level, and ONLY when the cohort has >= MATURED_FLOOR matured
//    outcomes at that horizon. Below the floor: count + "insufficient sample".
//  - Market-local, never mixed: one request = one market; USD and INR paths are
//    never cross-summed.

const DIMS = ["fundamental", "technical", "sentiment", "macro", "insider"] as const;
type Dim = typeof DIMS[number];

// Performance-Truth honesty floor (mirrors the 20-trade / P1 gate). A cohort with
// fewer matured outcomes than this at a given horizon is NOT actionable.
const MATURED_FLOOR = 20;

// Canonical horizon order; only horizons that actually have matured labels are
// surfaced. Reality (2026-07): 2d and 5d exist; 10d/20d back-fill as they mature.
const CANONICAL_HORIZONS = [2, 5, 10, 20];

function num(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Directional stake implied by the scored call. Neutral/hold has no stake, so it
// can neither "hit" nor "miss" a forward move — it only ever contributes to counts.
function expectedSign(direction: string | null): 1 | -1 | 0 {
  if (direction === "long") return 1;
  if (direction === "short") return -1;
  return 0;
}

function scoreBand(score: number | null): "high" | "mid" | "low" | null {
  if (score === null) return null;
  if (score >= 80) return "high";
  if (score >= 50) return "mid";
  return "low";
}

type LabelRow = {
  observation_id: number;
  horizon_days: number;
  fwd_return: number | null;
  benchmark_return: number | null;
  benchmark_neutral_return: number | null;
  max_adverse_excursion: number | null;
  max_favorable_excursion: number | null;
  entry_price: number | null;
  exit_price: number | null;
  matured_at: string | null;
};

export async function GET(req: NextRequest) {
  // Owner gate — same pattern as neighboring dashboard routes: an authenticated
  // session is required; unauthenticated callers get 401. Data reads use the
  // service client; auth uses the user client.
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const market: "us" | "india" = url.searchParams.get("market") === "india" ? "india" : "us";
  const symbolFilter = (url.searchParams.get("symbol") ?? "").trim().toUpperCase() || null;
  const recentLimit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 60) || 60, 1), 200);

  const svc = createServiceClient();

  // 1) Observations for THIS market only (never mixed). Bounded read; the whole
  //    ledger for one market is small. Ordered newest-first.
  let obsQuery = svc.from("decision_observations")
    .select("id,ts,market,symbol,analyst_score,score_threshold,direction,entry_eligible,action," +
      "fundamental_score,technical_score,sentiment_score,macro_score,insider_score," +
      "weights_used,availability_mask,price_at_decision,currency,signal_id,mandate_id")
    .eq("market", market)
    .order("ts", { ascending: false })
    .order("id", { ascending: false })
    .limit(1000);
  if (symbolFilter) obsQuery = obsQuery.eq("symbol", symbolFilter);
  const { data: obsRows, error: obsError } = await obsQuery;
  if (obsError) return NextResponse.json({ error: obsError.message }, { status: 500 });

  const observations = (obsRows ?? []) as any[];
  const obsIds = observations.map(o => Number(o.id));

  // 2) Matured forward outcomes + per-decision quality bookkeeping for those ids.
  let labels: LabelRow[] = [];
  let qualityById = new Map<number, any>();
  if (obsIds.length) {
    const [{ data: labelRows, error: labelError }, { data: qualityRows, error: qualityError }] = await Promise.all([
      svc.from("observation_labels")
        .select("observation_id,horizon_days,fwd_return,benchmark_return,benchmark_neutral_return," +
          "max_adverse_excursion,max_favorable_excursion,entry_price,exit_price,matured_at")
        .in("observation_id", obsIds),
      svc.from("v_decision_quality")
        .select("observation_id,real_dims,degraded_dims,decisive_dim,confidence_band,data_confidence")
        .in("observation_id", obsIds),
    ]);
    if (labelError) return NextResponse.json({ error: labelError.message }, { status: 500 });
    if (qualityError) return NextResponse.json({ error: qualityError.message }, { status: 500 });
    labels = (labelRows ?? []) as LabelRow[];
    qualityById = new Map((qualityRows ?? []).map((q: any) => [Number(q.observation_id), q]));
  }

  const labelsByObs = new Map<number, Map<number, LabelRow>>();
  const presentHorizons = new Set<number>();
  for (const l of labels) {
    const oid = Number(l.observation_id);
    if (!labelsByObs.has(oid)) labelsByObs.set(oid, new Map());
    labelsByObs.get(oid)!.set(Number(l.horizon_days), l);
    presentHorizons.add(Number(l.horizon_days));
  }
  // Column order: canonical horizons that have data, then any others, ascending.
  const horizons = [
    ...CANONICAL_HORIZONS.filter(h => presentHorizons.has(h)),
    ...[...presentHorizons].filter(h => !CANONICAL_HORIZONS.includes(h)).sort((a, b) => a - b),
  ];

  // Eligible attribution dimensions for an observation: real AND not degraded AND
  // not masked out. An unavailable dimension cannot be blamed for the outcome.
  function eligibleDims(obs: any): Dim[] {
    const q = qualityById.get(Number(obs.id));
    const real: string[] = Array.isArray(q?.real_dims) ? q.real_dims : [];
    const degraded = new Set<string>(Array.isArray(q?.degraded_dims) ? q.degraded_dims : []);
    const mask = obs.availability_mask ?? {};
    return DIMS.filter(d => {
      if (degraded.has(d)) return false;
      if (mask && mask[d] === false) return false;
      // If v_decision_quality reported real_dims, honor it; otherwise fall back to
      // "not explicitly masked false" so attribution still works on older rows.
      if (real.length) return real.includes(d);
      return true;
    });
  }

  // Per-decision, per-eligible-dim contribution = weight x (score - 50): how far
  // and in which direction the dimension pushed the composite off neutral.
  function contributions(obs: any): { dim: Dim; contribution: number }[] {
    const weights = obs.weights_used ?? {};
    const out: { dim: Dim; contribution: number }[] = [];
    for (const d of eligibleDims(obs)) {
      const w = num(weights[d]);
      const s = num(obs[`${d}_score`]);
      if (w === null || s === null) continue;
      out.push({ dim: d, contribution: Number((w * (s - 50)).toFixed(4)) });
    }
    return out;
  }

  // The horizon we anchor the (decorative, n=1) attribution to = the longest
  // matured horizon for this decision (most information about the realized path).
  function attributionFor(obs: any) {
    const byH = labelsByObs.get(Number(obs.id));
    if (!byH) return null;
    let anchor: LabelRow | null = null;
    for (const h of horizons) {
      const l = byH.get(h);
      if (l && num(l.benchmark_neutral_return) !== null) anchor = l;
    }
    if (!anchor) return null;
    const realized = num(anchor.benchmark_neutral_return);
    if (realized === null || realized === 0) return null;
    const realizedSign = realized > 0 ? 1 : -1;
    const contribs = contributions(obs);
    if (!contribs.length) return null;
    // "against" > 0 means the dim pushed the score the opposite way to the realized
    // move (i.e. plausibly wrong for THIS one path).
    const ranked = contribs.map(c => ({ ...c, against: -realizedSign * c.contribution }));
    let mostWrong = ranked[0], mostRight = ranked[0];
    for (const r of ranked) {
      if (r.against > mostWrong.against) mostWrong = r;
      if (r.against < mostRight.against) mostRight = r;
    }
    return {
      horizon_days: anchor.horizon_days,
      realized_alpha: realized,
      most_wrong: mostWrong.against > 0 ? { dim: mostWrong.dim, contribution: mostWrong.contribution } : null,
      most_right: mostRight.against < 0 ? { dim: mostRight.dim, contribution: mostRight.contribution } : null,
      illustrative: true, // ALWAYS: single realized path, n=1.
    };
  }

  // 3) Recent-decisions table rows (newest first, capped at recentLimit).
  const recent = observations.slice(0, recentLimit).map((obs: any) => {
    const byH = labelsByObs.get(Number(obs.id));
    const q = qualityById.get(Number(obs.id));
    const exp = expectedSign(obs.direction);
    const perHorizon = horizons.map(h => {
      const l = byH?.get(h) ?? null;
      if (!l) return { horizon_days: h, matured: false };
      const alpha = num(l.benchmark_neutral_return);
      // Score-vs-outcome delta: expected-direction x realized alpha. Positive =>
      // the realized move agreed with our directional call; negative => it
      // disagreed. Null for neutral/hold (no directional stake).
      const delta = exp !== 0 && alpha !== null ? Number((exp * alpha).toFixed(4)) : null;
      return {
        horizon_days: h,
        matured: true,
        fwd_return: num(l.fwd_return),
        benchmark_return: num(l.benchmark_return),
        benchmark_neutral_return: alpha,
        max_adverse_excursion: num(l.max_adverse_excursion),
        max_favorable_excursion: num(l.max_favorable_excursion),
        entry_price: num(l.entry_price),
        exit_price: num(l.exit_price),
        matured_at: l.matured_at,
        directional_hit: exp !== 0 && alpha !== null ? (exp > 0 ? alpha > 0 : alpha < 0) : null,
        delta,
      };
    });
    return {
      id: Number(obs.id),
      ts: obs.ts,
      symbol: obs.symbol,
      market: obs.market,
      currency: obs.currency ?? (market === "india" ? "INR" : "USD"),
      analyst_score: num(obs.analyst_score),
      score_threshold: num(obs.score_threshold),
      direction: obs.direction,
      entry_eligible: obs.entry_eligible,
      action: obs.action,
      price_at_decision: num(obs.price_at_decision),
      dimension_scores: Object.fromEntries(DIMS.map(d => [d, num(obs[`${d}_score`])])),
      confidence_band: q?.confidence_band ?? null,
      decisive_dim: q?.decisive_dim ?? null,
      horizons: perHorizon,
      // Decorative, n=1 attribution — the UI must render the illustrative tag.
      attribution: attributionFor(obs),
    };
  });

  // 4) Aggregate cohort stats (this market only), gated by the matured floor.
  //    Grouped by direction and by score-band; computed per horizon. Neutral
  //    decisions have no directional stake, so hit-rate is measured only over
  //    decisions that carried one.
  function cohortStats(members: any[]) {
    return horizons.map(h => {
      const matured = members
        .map(o => ({ obs: o, label: labelsByObs.get(Number(o.id))?.get(h) ?? null }))
        .filter(x => x.label && num(x.label!.benchmark_neutral_return) !== null);
      const maturedCount = matured.length;
      if (maturedCount < MATURED_FLOOR) {
        return { horizon_days: h, matured_count: maturedCount, actionable: false as const };
      }
      const alphas = matured.map(x => num(x.label!.benchmark_neutral_return)!);
      const fwds = matured.map(x => num(x.label!.fwd_return)).filter((v): v is number => v !== null);
      const staked = matured.filter(x => expectedSign(x.obs.direction) !== 0);
      const hits = staked.filter(x => {
        const exp = expectedSign(x.obs.direction);
        const a = num(x.label!.benchmark_neutral_return)!;
        return exp > 0 ? a > 0 : a < 0;
      }).length;
      const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
      return {
        horizon_days: h,
        matured_count: maturedCount,
        actionable: true as const,
        staked_count: staked.length,
        hit_rate: staked.length ? Number((hits / staked.length).toFixed(4)) : null,
        avg_forward_return: fwds.length ? Number(mean(fwds).toFixed(4)) : null,
        avg_alpha: Number(mean(alphas).toFixed(4)),
      };
    });
  }

  const byDirection = (["long", "short"] as const).map(dir => ({
    key: dir,
    label: dir === "long" ? "Long calls" : "Short calls",
    total_decisions: observations.filter(o => o.direction === dir).length,
    horizons: cohortStats(observations.filter(o => o.direction === dir)),
  }));

  const byScoreBand = (["high", "mid", "low"] as const).map(band => ({
    key: band,
    label: band === "high" ? "High conviction (score ≥ 80)" : band === "mid" ? "Moderate (50–79)" : "Low / bearish (< 50)",
    total_decisions: observations.filter(o => scoreBand(num(o.analyst_score)) === band).length,
    horizons: cohortStats(observations.filter(o => scoreBand(num(o.analyst_score)) === band)),
  }));

  return NextResponse.json({
    market,
    symbol: symbolFilter,
    currency_symbol: market === "india" ? "₹" : "$",
    horizons,
    matured_floor: MATURED_FLOOR,
    counts: {
      observations_in_scope: observations.length,
      observations_returned: recent.length,
      matured_labels: labels.length,
    },
    recent,
    aggregates: { floor: MATURED_FLOOR, byDirection, byScoreBand },
  });
}
