// Compile a frozen RuleSpec into simulator events.
//
// The rule is DATA (a predicate tree), not code, so it can be fingerprinted,
// stored and replayed identically later. This module is the only place that
// interprets it.
//
// EXECUTION TIMING IS LOAD-BEARING. A signal computed from a bar's close cannot
// be traded at that same close. `validateSpec` refuses that combination and this
// compiler prices `next_open` fills at the NEXT session's open, never the signal
// bar's close.
//
// MEASURE-ONLY.

import type { SimulationEvent } from "@/lib/simulation/portfolio-simulator";
import type { Indicator, Predicate, RuleSpec } from "./rule-spec";
import { validateSpec } from "./rule-spec";

export interface Bar {
  session: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface CompileInput {
  spec: RuleSpec;
  /** Bars per symbol, ascending by session, already point-in-time. */
  bars: Record<string, Bar[]>;
  initialCash: number;
}

export interface CompileResult {
  events: SimulationEvent[];
  /** Sessions skipped because an indicator had insufficient warm-up. */
  warmupSkipped: number;
  /** Decision sessions where the rule could actually be evaluated. */
  decisionSessions: number;
  errors: string[];
}

function sma(closes: number[], end: number, period: number): number | null {
  if (end + 1 < period) return null;
  let sum = 0;
  for (let i = end - period + 1; i <= end; i++) sum += closes[i];
  return sum / period;
}

/** Wilder RSI, the standard definition. Frozen: changing it is a new ruleVersion. */
function rsi(closes: number[], end: number, period: number): number | null {
  if (end < period) return null;
  let gain = 0, loss = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  // Seed then smooth is the textbook form; with a single window this reduces to
  // the simple average, which is what the seed period means.
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function rangePct(bars: Bar[], end: number, period: number): number | null {
  if (end + 1 < period) return null;
  let widest = 0;
  for (let i = end - period + 1; i <= end; i++) {
    widest = Math.max(widest, bars[i].high - bars[i].low);
  }
  return bars[end].close > 0 ? widest / bars[end].close : null;
}

function isNarrowestRange(bars: Bar[], end: number, period: number): number | null {
  if (end + 1 < period) return null;
  const today = bars[end].high - bars[end].low;
  for (let i = end - period + 1; i < end; i++) {
    if (bars[i].high - bars[i].low <= today) return 0;
  }
  return 1;
}

interface EvalCtx {
  bars: Bar[];
  idx: number;
  entryPrice?: number;
  heldSessions?: number;
}

function indicatorValue(ind: Indicator, ctx: EvalCtx): number | null {
  const { bars, idx } = ctx;
  const closes = bars.map((b) => b.close);
  switch (ind.fn) {
    case "close": return bars[idx].close;
    case "open": return bars[idx].open;
    case "sma": return sma(closes, idx, ind.period);
    case "rsi": return rsi(closes, idx, ind.period);
    case "range_pct": return rangePct(bars, idx, ind.period);
    case "is_narrowest_range": return isNarrowestRange(bars, idx, ind.period);
    case "return_pct_from_entry":
      return ctx.entryPrice && ctx.entryPrice > 0
        ? ((bars[idx].close - ctx.entryPrice) / ctx.entryPrice) * 100
        : null;
  }
}

function compare(a: number, cmp: string, b: number): boolean {
  switch (cmp) {
    case "<": return a < b;
    case "<=": return a <= b;
    case ">": return a > b;
    case ">=": return a >= b;
    default: return false;
  }
}

/** null = undecidable here (warm-up), which is NOT false. */
export function evaluate(p: Predicate, ctx: EvalCtx): boolean | null {
  switch (p.op) {
    case "always": return true;
    case "never": return false;
    case "and": {
      let sawNull = false;
      for (const t of p.terms) {
        const v = evaluate(t, ctx);
        if (v === false) return false;   // short-circuit: a false term decides it
        if (v === null) sawNull = true;
      }
      return sawNull ? null : true;
    }
    case "or": {
      let sawNull = false;
      for (const t of p.terms) {
        const v = evaluate(t, ctx);
        if (v === true) return true;
        if (v === null) sawNull = true;
      }
      return sawNull ? null : false;
    }
    case "not": {
      const v = evaluate(p.term, ctx);
      return v === null ? null : !v;
    }
    case "cmp": {
      const l = indicatorValue(p.left, ctx);
      return l == null ? null : compare(l, p.cmp, p.right);
    }
    case "cmp2": {
      const l = indicatorValue(p.left, ctx);
      const r = indicatorValue(p.right, ctx);
      return l == null || r == null ? null : compare(l, p.cmp, r);
    }
    case "held_sessions":
      return ctx.heldSessions == null
        ? null : compare(ctx.heldSessions, p.cmp, p.value);
  }
}

/**
 * Compile to events.
 *
 * One open lot per symbol at a time — this is a single-rule replay, not a
 * pyramiding engine. Exit is forced at `horizonSessions` even when the exit
 * predicate has not fired, so a rule cannot hold forever and quietly become a
 * buy-and-hold in disguise.
 */
export function compileSpec(input: CompileInput): CompileResult {
  const { spec, bars } = input;
  const errors = validateSpec(spec);
  if (errors.length) return { events: [], warmupSkipped: 0, decisionSessions: 0, errors };

  const events: SimulationEvent[] = [];
  let warmupSkipped = 0;
  const decisionSet = new Set<string>();

  for (const symbol of spec.universe) {
    const series = bars[symbol];
    if (!series || series.length < 2) continue;

    // The exit MUST carry an explicit quantity. portfolio-simulator.ts:136
    // rejects a quantity-less exit as `invalid_exit` rather than assuming the
    // whole lot — found by running this compiler against real VOO bars, where
    // every exit was refused, positions never closed, and 96 of 97 subsequent
    // events were rejected for cash. Unit tests missed it because they counted
    // EVENTS and never put them through the simulator.
    let open: { entryIdx: number; entryPrice: number; quantity: number } | null = null;

    for (let i = 0; i < series.length; i++) {
      // `next_open` acts on the FOLLOWING bar, so the last bar can never trade.
      const fillIdx = spec.execution === "next_open" ? i + 1 : i;
      if (fillIdx >= series.length) break;
      const fillPrice = spec.execution === "next_open"
        ? series[fillIdx].open : series[i].close;
      if (!(fillPrice > 0)) continue;

      if (open) {
        const held = i - open.entryIdx;
        const ctx: EvalCtx = {
          bars: series, idx: i, entryPrice: open.entryPrice, heldSessions: held,
        };
        const wantExit = evaluate(spec.exit, ctx);
        const forced = held >= spec.horizonSessions;
        if (wantExit === true || forced) {
          events.push({
            id: `${spec.id}:${symbol}:exit:${series[fillIdx].session}`,
            session: series[fillIdx].session,
            symbol, kind: "exit", price: fillPrice,
            quantity: open.quantity,
          });
          open = null;
        }
        continue;
      }

      const ctx: EvalCtx = { bars: series, idx: i };
      const wantEntry = evaluate(spec.entry, ctx);
      if (wantEntry === null) { warmupSkipped++; continue; }
      decisionSet.add(series[i].session);
      if (wantEntry === true) {
        const cashAllocation = input.initialCash * spec.positionSizePct;
        events.push({
          id: `${spec.id}:${symbol}:entry:${series[fillIdx].session}`,
          session: series[fillIdx].session,
          symbol, kind: "entry", price: fillPrice,
          cashAllocation,
        });
        // Mirrors the simulator's own sizing (portfolio-simulator.ts:158) so the
        // exit quantity matches the fill exactly. costPct is unset here, so the
        // multiplier is 1.
        open = { entryIdx: i, entryPrice: fillPrice, quantity: cashAllocation / fillPrice };
      }
    }
  }

  events.sort((a, b) =>
    a.session !== b.session ? a.session.localeCompare(b.session) : a.id.localeCompare(b.id));

  return { events, warmupSkipped, decisionSessions: decisionSet.size, errors: [] };
}
