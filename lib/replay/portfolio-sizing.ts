// Offline conditional sizing experiment. No production or broker dependencies.
export type SizingTapeEvent =
  | { id: string; at: string; kind: "mark"; prices: Record<string, number> }
  | { id: string; at: string; kind: "entry"; entryId: string; symbol: string; sector: string;
      price: number; stop: number; stopObservedAt: string; entryStopVerified: boolean; tainted: boolean }
  | { id: string; at: string; kind: "exit"; entryId: string; price: number; originalFraction: number };

export interface SizingReplayPlan {
  market: "us" | "india";
  initialCash: number;
  endAt: string;
  equalWeightPct: number;
  riskBudgetPct: number;
  maxNamePct: number;
  maxSectorPct: number;
  maxGrossPct: number;
  additionalCostBps: number;
  maxMarkAgeHours: number;
}

type Position = { symbol: string; sector: string; originalQty: number; qty: number };
type Audit = { entryId: string; qty: number; notional: number; navBefore: number; reason: string };
export type SizingArm = {
  finalNav: number; returnPct: number; cash: number; tradedNotional: number;
  costs: number; sampledMaxDrawdownPct: number; entries: Audit[];
};
export type SizingReplayResult =
  | { status: "invalid"; reason: string; equalWeight: null; equalRisk: null }
  | { status: "diagnostic"; equalWeight: SizingArm; equalRisk: SizingArm; incrementalReturnPct: number };

function requireValid(ok: boolean, reason: string): asserts ok {
  if (!ok) throw new Error(reason);
}
const positive = (v: number) => Number.isFinite(v) && v > 0;
function instant(s: string): number {
  requireValid(typeof s === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(s), "Timestamp must include timezone");
  const t = Date.parse(s);
  requireValid(Number.isFinite(t), "Invalid timestamp");
  return t;
}

function validate(plan: SizingReplayPlan, tape: SizingTapeEvent[]) {
  requireValid(plan.market === "us" || plan.market === "india", "Invalid market");
  requireValid(positive(plan.initialCash) && positive(plan.maxMarkAgeHours), "Invalid cash or mark age");
  for (const v of [plan.equalWeightPct, plan.riskBudgetPct, plan.maxNamePct, plan.maxSectorPct, plan.maxGrossPct]) {
    requireValid(positive(v) && v <= 100, "Invalid allocation percentage");
  }
  requireValid(Number.isFinite(plan.additionalCostBps) && plan.additionalCostBps >= 0 && plan.additionalCostBps < 10000, "Invalid costs");
  const end = instant(plan.endAt);
  requireValid(tape.length > 0, "Empty evidence tape");
  let previous = -Infinity;
  const ids = new Set<string>();
  const entries = new Map<string, number>();
  for (const event of tape) {
    const time = instant(event.at);
    requireValid(time >= previous && time <= end, "Tape must be chronological and within cutoff");
    previous = time;
    requireValid(!!event.id && !ids.has(event.id), "Duplicate or missing event ID");
    ids.add(event.id);
    if (event.kind === "mark") {
      requireValid(Object.keys(event.prices).length > 0, "Empty mark event");
      for (const [symbol, price] of Object.entries(event.prices)) requireValid(!!symbol && positive(price), "Invalid mark");
    } else if (event.kind === "entry") {
      requireValid(!!event.entryId && !entries.has(event.entryId), "Duplicate entry ID");
      requireValid(!!event.symbol && !!event.sector, "Missing symbol or historical sector");
      requireValid(event.tainted === false, "Tainted or unverified entry");
      requireValid(event.entryStopVerified === true && positive(event.stop) && positive(event.price) && event.stop < event.price,
        "Missing or invalid original entry stop");
      requireValid(instant(event.stopObservedAt) <= time, "Future entry-stop evidence");
      entries.set(event.entryId, 0);
    } else if (event.kind === "exit") {
      requireValid(entries.has(event.entryId), "Exit before entry");
      requireValid(positive(event.price) && positive(event.originalFraction) && event.originalFraction <= 1, "Invalid exit");
      const total = entries.get(event.entryId)! + event.originalFraction;
      requireValid(total <= 1 + 1e-9, "Exit fractions exceed original position");
      entries.set(event.entryId, total);
    } else {
      throw new Error("Unknown event kind");
    }
  }
}

function runArm(plan: SizingReplayPlan, tape: SizingTapeEvent[], mode: "equal" | "risk"): SizingArm {
  let cash = plan.initialCash, costs = 0, tradedNotional = 0;
  let peak = cash, maxDrawdown = 0;
  const positions = new Map<string, Position>();
  const marks = new Map<string, { price: number; at: number }>();
  const exited = new Map<string, number>();
  const entries: Audit[] = [];
  const rate = plan.additionalCostBps / 10000;
  const units = plan.market === "india" ? 1 : 1_000_000;
  const roundQty = (n: number) => {
    const scaled = n * units;
    // 0.5% / (1 - 95/100) can round just below ten shares. Correct only
    // floating-point noise, not a genuine shortfall in available cash.
    return Math.floor(scaled + Number.EPSILON * Math.max(1, scaled) * 8) / units;
  };
  function value(p: Position, at: number) {
    if (p.qty === 0) return 0;
    const mark = marks.get(p.symbol);
    requireValid(!!mark && mark.at <= at && at - mark.at <= plan.maxMarkAgeHours * 3600000,
      `Missing/stale mark for ${p.symbol}`);
    return p.qty * mark.price;
  }
  function nav(at: number) {
    return cash + [...positions.values()].reduce((sum, p) => sum + value(p, at), 0);
  }
  function sample(at: number) {
    const n = nav(at);
    requireValid(cash >= -1e-7 && Number.isFinite(n), "Invalid cash/NAV");
    peak = Math.max(peak, n);
    maxDrawdown = Math.max(maxDrawdown, (peak - n) / peak * 100);
    return n;
  }
  for (const event of tape) {
    const at = instant(event.at);
    if (event.kind === "mark") {
      for (const [symbol, price] of Object.entries(event.prices)) marks.set(symbol, { price, at });
    } else if (event.kind === "entry") {
      requireValid(![...positions.values()].some(p => p.symbol === event.symbol && p.qty > 0), "Top-ups require a separate experiment");
      marks.set(event.symbol, { price: event.price, at });
      const n = nav(at);
      const gross = n - cash;
      const sector = [...positions.values()].filter(p => p.sector === event.sector).reduce((s, p) => s + value(p, at), 0);
      const targetPct = mode === "equal" ? plan.equalWeightPct : plan.riskBudgetPct / (1 - event.stop / event.price);
      // Include transaction costs in post-trade exposure limits: NAV loses fees.
      const capacity = (pct: number, existing: number) => Math.max(0, (n * pct / 100 - existing) / (1 + rate * pct / 100));
      const spend = Math.max(0, Math.min(
        n * targetPct / 100, cash / (1 + rate), capacity(plan.maxNamePct, 0),
        capacity(plan.maxSectorPct, sector), capacity(plan.maxGrossPct, gross),
      ));
      const qty = roundQty(spend / event.price);
      const notional = qty * event.price;
      cash -= notional * (1 + rate);
      costs += notional * rate;
      tradedNotional += notional;
      positions.set(event.entryId, { symbol: event.symbol, sector: event.sector, originalQty: qty, qty });
      entries.push({ entryId: event.entryId, qty, notional, navBefore: n, reason: qty > 0 ? "allocated_with_caps" : "no_capacity_or_below_share_increment" });
    } else {
      const p = positions.get(event.entryId)!;
      const totalFraction = (exited.get(event.entryId) ?? 0) + event.originalFraction;
      exited.set(event.entryId, totalFraction);
      const qty = totalFraction >= 1 - 1e-9 ? p.qty : Math.min(p.qty, roundQty(p.originalQty * event.originalFraction));
      marks.set(p.symbol, { price: event.price, at });
      const notional = qty * event.price;
      p.qty = Math.max(0, p.qty - qty);
      cash += notional * (1 - rate);
      costs += notional * rate;
      tradedNotional += notional;
    }
    sample(at);
  }
  const finalNav = sample(instant(plan.endAt));
  return { finalNav, returnPct: (finalNav / plan.initialCash - 1) * 100, cash, tradedNotional, costs,
    sampledMaxDrawdownPct: maxDrawdown, entries };
}

export function replayPortfolioSizing(plan: SizingReplayPlan, tape: SizingTapeEvent[]): SizingReplayResult {
  try {
    validate(plan, tape);
    const equalWeight = runArm(plan, tape, "equal");
    const equalRisk = runArm(plan, tape, "risk");
    return { status: "diagnostic", equalWeight, equalRisk, incrementalReturnPct: equalRisk.returnPct - equalWeight.returnPct };
  } catch (error) {
    return { status: "invalid", reason: error instanceof Error ? error.message : String(error), equalWeight: null, equalRisk: null };
  }
}
