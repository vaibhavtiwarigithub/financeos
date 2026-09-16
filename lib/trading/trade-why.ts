// "Why" column on the Fundamentals page: turns what the PAPER trader recorded
// (pipeline_stage_events, decision_observations, paper_trades) into one plain-
// English verdict per market+symbol. Pure: no I/O, no clock unless passed in.
// Measurement of past decisions only — it never changes a decision.

export type TradeWhyOutcome = "bought" | "sold" | "not_bought" | "no_trade" | "unknown";

export interface TradeWhy {
  outcome: TradeWhyOutcome;
  headline: string;
  bullets: string[];
  at: string | null;
}

export interface StageEventRow {
  signal_id: string | null;
  stage: string;
  outcome: string;
  reason: string | null;
  detail?: any;
  created_at: string;
}

export interface ObservationRow {
  ts: string;
  analyst_score: number | string | null;
  direction: string | null;
  entry_eligible: boolean | null;
  score_threshold: number | string | null;
}

export interface TradeRowLite {
  side: "buy" | "sell";
  date: string;
  reason?: string | null;
}

/** Stages that decide whether a paper entry happens. */
export const TRADING_STAGES = [
  "execution", "portfolio_constructor", "reentry_gate", "existing_position_gate",
  "pyramid_gate", "sector_gate", "pricing", "trade_plan",
] as const;
// risk_plan, earnings_risk_shadow, correlation_shadow, capital_rotation and
// freshness are measurement/shadow rows: they never block a fill, so they are
// never presented as the reason.
const TRADING = new Set<string>(TRADING_STAGES);

const STALE_DAYS = 14;

const num = (s: string | undefined) => (s == null ? NaN : Number(s));
function pct(v: number | string): string {
  const n = Number(v);
  return Number.isFinite(n) ? `${Number(n.toFixed(2))}%` : `${v}%`;
}
const mmdd = (iso: string) => iso.slice(5, 10);

// ── Portfolio constructor clauses ────────────────────────────────────────────
interface Clause { kind: string; sector?: string; before?: number; after?: number; a?: number; b?: number; c?: number }

function parseClause(raw: string): Clause {
  const s = raw.trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^name_cap: ([\d.]+)% -> ([\d.]+)% \(existing ([\d.]+)%, cap ([\d.]+)%\)/)))
    return { kind: "name_cap", before: num(m[1]), after: num(m[2]), a: num(m[3]), c: num(m[4]) };
  if ((m = s.match(/^gross_cap: ([\d.]+)% -> ([\d.]+)% \(book\+candidates would be ([\d.]+)%, cap ([\d.]+)%\)/)))
    return { kind: "gross_cap", before: num(m[1]), after: num(m[2]), a: num(m[3]), c: num(m[4]) };
  if ((m = s.match(/^sector_cap\((.+?)\): ([\d.]+)% -> ([\d.]+)% \(sector total would be ([\d.]+)%, cap ([\d.]+)%\)/)))
    return { kind: "sector_cap", sector: m[1], before: num(m[2]), after: num(m[3]), a: num(m[4]), c: num(m[5]) };
  if ((m = s.match(/^stacked_bet\((.+?)\): ([\d.]+)% -> ([\d.]+)% \(sector already holds (\d+) positions\)/)))
    return { kind: "stacked_bet", sector: m[1], before: num(m[2]), after: num(m[3]), a: num(m[4]) };
  if ((m = s.match(/^vol_budget: ([\d.]+)% -> ([\d.]+)% \(est portfolio vol ([\d.]+)% > cap ([\d.]+)%\)/)))
    return { kind: "vol_budget", before: num(m[1]), after: num(m[2]), a: num(m[3]), c: num(m[4]) };
  if ((m = s.match(/^denied: scaled size ([\d.]+)% below minimum viable ([\d.]+)%/)))
    return { kind: "denied", after: num(m[1]), c: num(m[2]) };
  if (/non-finite/.test(s)) return { kind: "non_finite" };
  return { kind: "other" };
}

function constructorClauses(ev: StageEventRow): Clause[] {
  const list: string[] = Array.isArray(ev.detail?.adjustments)
    ? ev.detail.adjustments
    : String(ev.reason ?? "").replace(/^portfolio_constructor_denied:\s*/, "").split(/;\s*/);
  return list.filter(Boolean).map(parseClause);
}

function clauseBullet(c: Clause): string {
  const cut = c.before != null && c.before !== c.after ? `, so the size was cut from ${pct(c.before)} to ${pct(c.after!)}` : "";
  switch (c.kind) {
    case "name_cap": return `Single-stock limit is ${pct(c.c!)} of the portfolio${c.a ? ` (already held ${pct(c.a)})` : ""}${cut}.`;
    case "gross_cap": return `Invested limit is ${pct(c.c!)}; the holdings plus this buy would be ${pct(c.a!)}${cut}.`;
    case "sector_cap": return `${c.sector} would reach ${pct(c.a!)} of the portfolio against a ${pct(c.c!)} sector limit${cut}.`;
    case "stacked_bet": return `${c.sector} already holds ${c.a} positions${cut}.`;
    case "vol_budget": return `Estimated portfolio volatility ${pct(c.a!)} is above the ${pct(c.c!)} limit${cut}.`;
    case "denied": return `Final size ${pct(c.after!)} is below the ${pct(c.c!)} minimum trade size.`;
    case "non_finite": return "A sizing calculation returned an invalid number, so the order was blocked for safety.";
    default: return "Another portfolio limit reduced the size.";
  }
}

function constructorSentence(clauses: Clause[]): string {
  if (clauses.some((c) => c.kind === "non_finite")) return "a sizing calculation failed, so the order was blocked for safety.";
  const denied = clauses.find((c) => c.kind === "denied");
  const min = denied?.c ?? 0.5;
  const binding = clauses.find((c) => c.kind !== "denied" && c.after != null && c.after <= min && (c.before ?? 0) > min);
  const stacked = clauses.find((c) => c.kind === "stacked_bet");
  const phrase = (c: Clause): string => {
    switch (c.kind) {
      case "gross_cap": return `the portfolio is already at its ${pct(c.c!)} invested limit (this buy would take it to ${pct(c.a!)})`;
      case "sector_cap": return `${c.sector} is already at its ${pct(c.c!)} sector limit`;
      case "stacked_bet": return `${c.sector} already holds ${c.a} positions`;
      case "vol_budget": return `estimated portfolio volatility (${pct(c.a!)}) is above its ${pct(c.c!)} limit`;
      case "name_cap": return `this stock is already at its ${pct(c.c!)} single-stock limit`;
      default: return "a portfolio limit left no room";
    }
  };
  const parts: string[] = [];
  if (binding) parts.push(phrase(binding));
  if (stacked && stacked !== binding) parts.push(phrase(stacked));
  const lead = parts.length ? parts.join(" and ") : "portfolio limits left no room";
  return denied
    ? `${lead}, so the remaining room (${pct(denied.after!)}) is below the ${pct(denied.c!)} minimum trade size.`
    : `${lead}, so there was no room left.`;
}

// ── Research reasons ─────────────────────────────────────────────────────────
function researchSentence(reason: string): { passed: boolean; text: string; score?: string; threshold?: string } {
  let m: RegExpMatchArray | null;
  if ((m = reason.match(/^Eligible: long direction and score ([\d.]+) >= threshold ([\d.]+)/)))
    return { passed: true, text: `score ${m[1]} cleared threshold ${m[2]}`, score: m[1], threshold: m[2] };
  if ((m = reason.match(/^Rejected: score ([\d.]+) < threshold ([\d.]+)/)))
    return { passed: false, text: `score ${m[1]} is below the threshold ${m[2]}.` };
  if (/^Abstained: thesis response was missing a parseable direction/.test(reason))
    return { passed: false, text: "the research write-up had no readable direction, so the app abstained." };
  if ((m = reason.match(/^Abstained: thin evidence \((\d+)\/(\d+) usable dimensions\)/)))
    return { passed: false, text: `only ${m[1]} of ${m[2]} score dimensions had usable data, so the app abstained.` };
  if ((m = reason.match(/^Rejected: breakdown veto — (.+)$/)))
    return { passed: false, text: `the price just broke down sharply (${m[1]}).` };
  if ((m = reason.match(/^Abstained: reported earnings on (\d{4}-\d{2}-\d{2})/)))
    return { passed: false, text: `waiting for the first full trading day after earnings on ${m[1]}.` };
  if ((m = reason.match(/^Abstained: score passed but direction was (\w+)/)))
    return { passed: false, text: `the score passed but the direction was ${m[1]}; only a long direction can open a trade.` };
  return { passed: false, text: "research did not mark it eligible for a trade." };
}

// ── Single trading-stage rejection ───────────────────────────────────────────
function rejectionSentence(ev: StageEventRow, chain: StageEventRow[]): { text: string; bullets: string[] } {
  const reason = String(ev.reason ?? "");
  const d = ev.detail ?? {};
  const bullets: string[] = [];
  const constructorRej = chain.find((e) => e.stage === "portfolio_constructor" && e.outcome === "rejected");
  const deferred = chain.find((e) => e.stage === "portfolio_constructor" && e.outcome === "deferred");
  if (d.rotReason === "execute_disabled") bullets.push("Swapping out a weaker holding is switched off, so nothing was sold to make room.");

  let m: RegExpMatchArray | null;
  if (reason === "portfolio_constructor_no_room" || ev.stage === "portfolio_constructor" && ev.outcome === "rejected") {
    const clauses = constructorRej ? constructorClauses(constructorRej) : [];
    return { text: clauses.length ? constructorSentence(clauses) : "portfolio limits left no room.", bullets: [...clauses.map(clauseBullet), ...bullets] };
  }
  if ((m = reason.match(/^max_open_names \((\d+)\)/)) || reason === "max_open_names_rotation_candidate") {
    const cap = m?.[1] ?? deferred?.detail?.cap ?? d.cap;
    const current = deferred?.detail?.current ?? d.current;
    if (current != null && cap != null) bullets.unshift(`Open positions: ${current} of ${cap}.`);
    bullets.push("It can be bought on a later run if a holding exits while this signal is still fresh.");
    return { text: `the portfolio already holds the maximum number of open positions${cap != null ? ` (${cap})` : ""}.`, bullets };
  }
  if (reason === "reentry_cooldown") return { text: "it was sold within the last 3 trading days (re-entry cooldown).", bullets };
  if (reason === "open_alpha_position_exists" || reason === "rpc_fill_denied:existing_open_position")
    return { text: "a paper position is already open (one entry per stock).", bullets };
  if (reason === "pyramid_gate") return { text: "the existing position is at a loss, and the app never averages down.", bullets };
  if (reason === "daily_paper_notional_cap") {
    if (d.cap != null) bullets.unshift(`Already bought ${Math.round(Number(d.spentToday ?? 0))} today; this order ${Math.round(Number(d.totalCost ?? 0))}; daily limit ${Math.round(Number(d.cap))}.`);
    return { text: "today's paper buying limit was reached.", bullets };
  }
  if (/^insufficient_cash/.test(reason)) return { text: "there was not enough paper cash for this order.", bullets };
  if (reason === "sector_cap") {
    return { text: `${d.sector ?? "its sector"} already holds the maximum${d.max != null ? ` ${d.max}` : ""} positions per sector.`, bullets };
  }
  if (ev.stage === "pricing") return { text: "no usable live price was available, so no order was placed.", bullets };
  return { text: "a paper-trading safety check stopped the order.", bullets };
}

function finish(outcome: TradeWhyOutcome, label: string, sentence: string, at: string, bullets: string[], now: Date): TradeWhy {
  const stale = now.getTime() - new Date(at).getTime() > STALE_DAYS * 86_400_000;
  const headline = stale
    ? `As of ${mmdd(at)}: ${label.toLowerCase()} — ${sentence}`
    : `${label} ${mmdd(at)}: ${sentence}`;
  return { outcome, headline, bullets, at };
}

function tradeWhy(t: TradeRowLite, now: Date): TradeWhy {
  if (t.side === "buy") return finish("bought", "Bought", "a paper position was opened.", t.date, [], now);
  const r = String(t.reason ?? "");
  let m: RegExpMatchArray | null;
  const text =
    (m = r.match(/^time_stop \((\d+) market days > (\d+)d/)) ? `held ${m[1]} market days, past the ${m[2]}-day holding limit.`
    : /^stop_hit/.test(r) ? "the price hit the stop-loss."
    : r === "partial_target" ? "part of the position was sold at the profit target."
    : /^direction_flip/.test(r) ? "research flipped the direction to short."
    : r === "capital_rotation" ? "it was sold to make room for a stronger candidate."
    : (m = r.match(/^score_below_exit_threshold_confirmed \(([\d.]+) < ([\d.]+)/)) ? `the score fell to ${m[1]}, below the exit threshold ${m[2]}.`
    : "the paper position was closed.";
  return finish("sold", "Sold", text, t.date, [], now);
}

/**
 * Newest DECISION wins. Sources, in order: trading-stage chain (grouped by
 * signal_id), research event, decision_observations row, last paper trade.
 * A paper trade newer than every decision overrides (e.g. a later exit).
 *
 * A passing re-score is not a decision: it annotates the recorded trading
 * verdict rather than replacing it, so a real rejection stays visible.
 */
export function explainTradeWhy(input: {
  market: string;
  events: StageEventRow[];
  observation?: ObservationRow | null;
  lastTrade?: TradeRowLite | null;
  now?: Date;
}): TradeWhy {
  const now = input.now ?? new Date();
  const cur = input.market === "india" ? "₹" : "$";
  const sorted = [...input.events].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const trading = sorted.filter((e) => TRADING.has(e.stage));
  const research = sorted.filter((e) => e.stage === "research");

  // Old records said the optional LLM thesis had no parseable direction. That
  // was never a money-path rule: deterministic score direction was already
  // present in the paired observation. Normalize the display from that
  // immutable evidence so an owner sees the actual decision reason.
  const normaliseResearchReason = (event: StageEventRow) => {
    const parsed = researchSentence(String(event.reason ?? ""));
    const observation = input.observation;
    if (!/^Abstained: thesis response was missing a parseable direction/.test(String(event.reason ?? "")) || !observation) return parsed;
    const score = observation.analyst_score == null ? NaN : Number(observation.analyst_score);
    const threshold = observation.score_threshold == null ? NaN : Number(observation.score_threshold);
    if (Number.isFinite(score) && Number.isFinite(threshold) && score < threshold) {
      return { passed: false, text: `score ${score} is below the threshold ${threshold}.` };
    }
    if (observation.direction && observation.direction !== "long") {
      return { passed: false, text: `the direction was ${observation.direction}; only a long direction can open a trade.` };
    }
    return parsed;
  };

  let decision: TradeWhy | null = null;

  const top = trading[0];
  if (top) {
    const chain = sorted.filter((e) => (top.signal_id ? e.signal_id === top.signal_id : e === top));
    const res = research.find((e) => top.signal_id && e.signal_id === top.signal_id);
    const rs = res ? normaliseResearchReason(res) : null;
    const fill = chain.find((e) => e.stage === "execution" && e.outcome === "filled");
    if (fill) {
      const bullets: string[] = [];
      const qp = String(fill.reason ?? "").match(/^([\d.]+) @ ([\d.]+)/);
      const rot = String(fill.reason ?? "").match(/^capital_rotation: sold (\S+)/);
      if (qp) bullets.push(`Filled ${Number(qp[1])} @ ${cur}${Number(qp[2]).toFixed(2)}.`);
      const sized = chain.find((e) => e.stage === "portfolio_constructor" && (e.outcome === "shrunk" || e.outcome === "passed") && /^Sized/.test(String(e.reason)));
      const sm = String(sized?.reason ?? "").match(/^Sized ([\d.]+)% \(proposed ([\d.]+)%\)/);
      if (sm) bullets.push(`Sized ${pct(sm[1])} of the portfolio (proposed ${pct(sm[2])}).`);
      if (sized?.outcome === "shrunk") bullets.push(...constructorClauses(sized).map(clauseBullet));
      const sentence = rot ? `sold ${rot[1]} to make room.`
        : rs?.passed ? `${rs.text} and there was room.` : "the paper trader filled the order.";
      decision = finish("bought", "Bought", sentence, fill.created_at, bullets, now);
    } else {
      const rej = chain.find((e) => e.outcome === "rejected" || e.outcome === "deferred");
      if (rej) {
        const { text, bullets } = rejectionSentence(rej, chain);
        if (rs?.passed) bullets.unshift(`Research: ${rs.text}.`);
        decision = finish("not_bought", "Not bought", text, chain[0].created_at, bullets, now);
      } else {
        decision = finish("unknown", "Sized", "the order was sized but no fill or rejection was recorded.", top.created_at, [], now);
      }
    }
  }

  const r = research[0];
  if (r && (!top || (r.signal_id !== top.signal_id && r.created_at > top.created_at))) {
    const rs = normaliseResearchReason(r);
    // A later research row is a RE-SCORE, not a decision, so it must not erase a
    // trading-stage verdict already recorded for this symbol. It was doing exactly
    // that: 9,619 real rejections across 113 symbols in 30 days (prod, 2026-09-15)
    // displayed as "the paper trader has not acted on this signal" because a newer
    // re-score outranked them. CORDSCABLE.NS was deferred at the name cap (15 of
    // 15) at 07:45 and re-scored at 15:08, and only the re-score was shown.
    //
    // A re-score that FAILS still supersedes: eligibility genuinely changed, and
    // "score is now below threshold" is the true current reason. The annotation
    // is bounded to the SAME day: a month-old rejection must not headline a fresh
    // re-score, which is the existing stale-chain contract.
    if (decision?.at && rs.passed && r.created_at.slice(0, 10) === decision.at.slice(0, 10)) {
      decision = {
        ...decision,
        bullets: [
          ...decision.bullets,
          `Re-scored ${mmdd(r.created_at)}: ${rs.text}. The verdict above is from the paper-trader run that actually looked at it.`,
        ],
      };
    } else {
      decision = rs.passed
        ? finish("no_trade", "Eligible", `${rs.text}, but the paper trader has not acted on this signal.`, r.created_at,
            ["A signal that is not traded on its market day expires.", "Other gates (open positions, sector, cash) run only when the paper trader picks it up."], now)
        : finish("no_trade", "No trade", rs.text, r.created_at, [], now);
    }
  }

  if (!decision && input.observation) {
    const o = input.observation;
    const score = o.analyst_score == null ? null : Number(o.analyst_score);
    const thr = o.score_threshold == null ? null : Number(o.score_threshold);
    const bullets = ["From the research decision record (no paper-trader event was logged for it)."];
    decision = o.entry_eligible
      ? finish("no_trade", "Eligible", `score ${score} cleared threshold ${thr}, but the paper trader has not acted on this signal.`, o.ts, bullets, now)
      : score != null && thr != null && score < thr
        ? finish("no_trade", "No trade", `score ${score} is below the threshold ${thr}.`, o.ts, bullets, now)
        : o.direction && o.direction !== "long"
          ? finish("no_trade", "No trade", `the direction was ${o.direction}; only a long direction can open a trade.`, o.ts, bullets, now)
          : finish("no_trade", "No trade", "research did not mark it eligible for a trade.", o.ts, bullets, now);
  }

  const t = input.lastTrade;
  if (t && (!decision || (t.date > (decision.at ?? "") && !(decision.outcome === "bought" && t.side === "buy")))) {
    return tradeWhy(t, now);
  }
  return decision ?? { outcome: "unknown", headline: "Not researched yet", bullets: [], at: null };
}
