// Pure logic for the live recommendation tracker and Guardian scorecard. No imports: used by the nightly job and unit tests.
//
// Everything here is measurement. Hypothetical entries use the price shown when the recommendation was issued and ignore slippage and
// liquidity. "Taken" is inferred from daily holdings snapshots (a quantity increase after the issue date), so it cannot see intraday
// round trips; the page says so.

export type Bar = { date: string; open: number; high: number; low: number; close: number };
export type Snap = { date: string; qty: number; avgCost: number | null; accountId: string };
export type RecKind = "buy_idea" | "guardian_stop" | "exit_signal";
export type RecStatus = "pending" | "taken" | "expired_unanswered" | "not_taken" | "followed" | "ignored" | "watching";

export const QTY_EPSILON = 1e-6;
/** A rise smaller than this in value is dividend/rounding drift, not a purchase. */
export const MIN_TAKEN_VALUE = 10;

const day = (iso: string) => iso.slice(0, 10);
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/** Last bar on or before `date`. */
export function barOnOrBefore(bars: Bar[], date: string): Bar | null {
  let found: Bar | null = null;
  for (const b of bars) if (b.date <= date) found = b; else break;
  return found;
}

/** Bars strictly after the issue date, in order. The issue session itself is excluded: the issue time inside it is unknown. */
export const barsAfter = (bars: Bar[], date: string) => bars.filter((b) => b.date > date);

export type ResponseInput = {
  kind: RecKind;
  issuedDate: string;
  horizonSessions: number;
  sessionsSince: number;
  qtySuggested: number | null;
  referencePrice?: number | null;
  /** buy_idea only: source proposal state */
  proposalStatus?: string | null;
  approvalExpired?: boolean;
  /** daily holdings snapshots for this symbol across accounts, ascending by date */
  snaps: Snap[];
  levelTouched?: boolean;
};
export type ResponseResult = { status: RecStatus; account: string | null; detail: string };

/** Largest quantity move (up for buys, down for sells) after the issue date, relative to the position at the issue date. */
export function holdingChange(snaps: Snap[], issuedDate: string): { account: string; delta: number } | null {
  const byAccount = new Map<string, Snap[]>();
  for (const s of snaps) (byAccount.get(s.accountId) ?? byAccount.set(s.accountId, []).get(s.accountId)!).push(s);
  let best: { account: string; delta: number } | null = null;
  for (const [account, list] of byAccount) {
    const before = [...list].reverse().find((s) => s.date <= issuedDate);
    // No pre-issue snapshot: the first snapshot is the baseline, so a position that already existed is not mistaken for a purchase.
    const baseline = before ?? list[0];
    for (const s of list) {
      if (s.date <= baseline.date) continue;
      const delta = s.qty - baseline.qty;
      if (!best || Math.abs(delta) > Math.abs(best.delta)) best = { account, delta };
    }
  }
  return best;
}

export function classifyResponse(i: ResponseInput): ResponseResult {
  const change = holdingChange(i.snaps, i.issuedDate);
  const inWindow = i.sessionsSince <= i.horizonSessions;
  if (i.kind === "buy_idea") {
    if (i.proposalStatus === "filled") return { status: "taken", account: null, detail: "Approved and filled through the proposal flow." };
    if (change && change.delta > QTY_EPSILON && (i.referencePrice == null || change.delta * i.referencePrice >= MIN_TAKEN_VALUE)) return { status: "taken", account: change.account, detail: `Holdings rose by ${round(change.delta)} shares after the idea (inferred from daily snapshots).` };
    if (i.proposalStatus === "rejected") return { status: "not_taken", account: null, detail: "Rejected." };
    if (i.proposalStatus === "pending_review" && i.approvalExpired) return { status: "expired_unanswered", account: null, detail: "The approval window closed with no decision, and no matching purchase appeared in holdings." };
    return inWindow
      ? { status: "pending", account: null, detail: "Approval window still open." }
      : { status: "not_taken", account: null, detail: "No matching purchase appeared in holdings within the horizon." };
  }
  const reduced = change && change.delta < -QTY_EPSILON;
  if (i.kind === "guardian_stop") {
    if (i.levelTouched) return reduced
      ? { status: "followed", account: change!.account, detail: `Stop level was reached and the position was reduced by ${round(-change!.delta)}.` }
      : { status: "ignored", account: null, detail: "Stop level was reached and the position was not reduced." };
    return { status: "watching", account: null, detail: "Stop level not reached yet." };
  }
  if (reduced) return { status: "followed", account: change!.account, detail: `Position reduced by ${round(-change!.delta)} after the signal.` };
  return inWindow
    ? { status: "pending", account: null, detail: "Horizon still open." }
    : { status: "ignored", account: null, detail: "No reduction followed within the horizon." };
}

export type Mark = {
  sessionsSince: number; lastPrice: number | null; symbolReturnPct: number | null; benchmarkReturnPct: number | null; excessPct: number | null;
  pnlPct: number | null; pnlBasis: "actual" | "hypothetical" | null; levelTouched: boolean | null; levelTouchedOn: string | null; pnlIfLevelPct: number | null;
};

/**
 * Mark one recommendation against the symbol's and SPY's closes. `held` (taken positions) gives the actual P/L from the account's average
 * cost; otherwise P/L is hypothetical from the reference price. A level is "touched" when a post-issue session low (stop) / high (sell
 * target) reaches it.
 */
export function markRecommendation(args: {
  kind: RecKind; issuedDate: string; referencePrice: number | null; levelPrice: number | null;
  bars: Bar[]; spyBars: Bar[]; held?: { avgCost: number; qty: number } | null;
}): Mark {
  const after = barsAfter(args.bars, args.issuedDate);
  const last = after[after.length - 1] ?? null;
  const ref = args.referencePrice;
  const issueSpy = barOnOrBefore(args.spyBars, args.issuedDate);
  const lastSpy = args.spyBars[args.spyBars.length - 1] ?? null;
  const ret = (to: number | null | undefined, from: number | null | undefined) => (to != null && from != null && from > 0 ? round(((to / from) - 1) * 100) : null);
  const symbolReturnPct = last ? ret(last.close, ref) : null;
  const benchmarkReturnPct = last && issueSpy && lastSpy ? ret(lastSpy.close, issueSpy.close) : null;
  let levelTouched: boolean | null = null; let levelTouchedOn: string | null = null; let pnlIfLevelPct: number | null = null;
  if (args.levelPrice != null && args.levelPrice > 0) {
    levelTouched = false;
    const isStop = args.kind === "guardian_stop";
    for (const b of after) {
      if (isStop ? b.low <= args.levelPrice : b.high >= args.levelPrice) { levelTouched = true; levelTouchedOn = b.date; break; }
    }
    if (levelTouched && ref != null) pnlIfLevelPct = ret(args.levelPrice, ref);
  }
  let pnlPct: number | null = null; let pnlBasis: Mark["pnlBasis"] = null;
  if (args.held && last) { pnlPct = ret(last.close, args.held.avgCost); pnlBasis = "actual"; }
  else if (symbolReturnPct != null) { pnlPct = symbolReturnPct; pnlBasis = "hypothetical"; }
  return {
    sessionsSince: after.length, lastPrice: last ? last.close : null, symbolReturnPct, benchmarkReturnPct,
    excessPct: symbolReturnPct != null && benchmarkReturnPct != null ? round(symbolReturnPct - benchmarkReturnPct) : null,
    pnlPct, pnlBasis, levelTouched, levelTouchedOn, pnlIfLevelPct,
  };
}

// ---------- Guardian stop-rule arms (shadow; never applied) ----------

export type ArmId = "none" | "fixed_7" | "atr_2_8" | "fixed_12";
export const ARMS: ReadonlyArray<{ id: ArmId; label: string }> = [
  { id: "none", label: "No stop (hold to horizon)" },
  { id: "fixed_7", label: "Fixed stop 7% below entry (current mandate)" },
  { id: "atr_2_8", label: "2.8 x ATR(14) below entry" },
  { id: "fixed_12", label: "Fixed stop 12% below entry" },
];

export function atr14(bars: Bar[], issuedDate: string): number | null {
  const prior = bars.filter((b) => b.date <= issuedDate).slice(-15);
  if (prior.length < 15) return null;
  let sum = 0;
  for (let i = 1; i < prior.length; i++) {
    const p = prior[i - 1].close; const b = prior[i];
    sum += Math.max(b.high - b.low, Math.abs(b.high - p), Math.abs(b.low - p));
  }
  return sum / 14;
}

function stopFor(arm: ArmId, entry: number, atr: number | null): number | null {
  if (arm === "fixed_7") return entry * 0.93;
  if (arm === "fixed_12") return entry * 0.88;
  if (arm === "atr_2_8") return atr == null ? null : entry - 2.8 * atr;
  return null;
}

/** Hypothetical trade: enter at `entry`, exit at the stop (or the open if it gaps through) or at the close of the horizon session. */
export function simulateArm(arm: ArmId, entry: number, atr: number | null, forward: Bar[], horizon: number): { retPct: number; stopped: boolean } | null {
  const window = forward.slice(0, horizon);
  if (window.length < horizon) return null;
  const stop = stopFor(arm, entry, atr);
  if (arm !== "none" && stop == null) return null;
  if (stop != null) {
    for (const b of window) {
      if (b.low <= stop) return { retPct: round(((Math.min(b.open, stop) / entry) - 1) * 100), stopped: true };
    }
  }
  return { retPct: round(((window[window.length - 1].close / entry) - 1) * 100), stopped: false };
}

export type ArmSummary = { id: ArmId; label: string; n: number; meanRetPct: number | null; stoppedShare: number | null; savedPts: number; costPts: number };

/**
 * Evaluate every arm on the SAME matured buy ideas (paired). savedPts/costPts: for trades the stop closed, how much better / worse the
 * stopped exit was than holding to the horizon, summed in percentage points.
 */
export function evaluateArms(ideas: Array<{ symbol: string; issuedDate: string; entry: number; bars: Bar[] }>, horizon: number): { sample: number; distinctSymbols: number; arms: ArmSummary[] } {
  const rows: Array<{ symbol: string; byArm: Partial<Record<ArmId, { retPct: number; stopped: boolean }>> }> = [];
  for (const idea of ideas) {
    const fwd = barsAfter(idea.bars, idea.issuedDate);
    const atr = atr14(idea.bars, idea.issuedDate);
    const hold = simulateArm("none", idea.entry, atr, fwd, horizon);
    if (!hold) continue;
    const byArm: Partial<Record<ArmId, { retPct: number; stopped: boolean }>> = { none: hold };
    for (const a of ARMS) if (a.id !== "none") { const r = simulateArm(a.id, idea.entry, atr, fwd, horizon); if (r) byArm[a.id] = r; }
    rows.push({ symbol: idea.symbol, byArm });
  }
  const arms: ArmSummary[] = ARMS.map((a) => {
    // Paired: only rows where this arm could be computed (ATR needs history), compared against hold on those same rows.
    const used = rows.filter((r) => r.byArm[a.id]);
    const n = used.length;
    const mean = n ? used.reduce((s, r) => s + r.byArm[a.id]!.retPct, 0) / n : null;
    let saved = 0; let cost = 0; let stopped = 0;
    for (const r of used) {
      const x = r.byArm[a.id]!;
      if (!x.stopped) continue;
      stopped += 1;
      const diff = x.retPct - r.byArm.none!.retPct;
      if (diff >= 0) saved += diff; else cost += -diff;
    }
    return { id: a.id, label: a.label, n, meanRetPct: mean == null ? null : round(mean, 3), stoppedShare: n ? round(stopped / n, 3) : null, savedPts: round(saved, 2), costPts: round(cost, 2) };
  });
  return { sample: rows.length, distinctSymbols: new Set(rows.map((r) => r.symbol)).size, arms };
}

export const MIN_ARM_SAMPLE = 30;

/** Plain-language daily note. Never claims a winner below the minimum sample; ideas overlap on the same names, so the sample is optimistic. */
export function revisionNote(ev: ReturnType<typeof evaluateArms>, horizon: number): string {
  const pct = (v: number | null) => (v == null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
  const none = ev.arms.find((a) => a.id === "none")!;
  if (ev.sample < MIN_ARM_SAMPLE) return `Insufficient evidence: ${ev.sample} matured ideas (${ev.distinctSymbols} symbols); need ${MIN_ARM_SAMPLE}. Guardian stop rule unchanged.`;
  const parts = ev.arms.filter((a) => a.id !== "none").map((a) => `${a.label}: avg ${pct(a.meanRetPct)} (stopped ${a.stoppedShare == null ? "n/a" : Math.round(a.stoppedShare * 100)}%, saved ${a.savedPts} pts, premature cost ${a.costPts} pts, n=${a.n})`);
  const best = ev.arms.filter((a) => a.meanRetPct != null).sort((x, y) => (y.meanRetPct as number) - (x.meanRetPct as number))[0];
  return `Over ${ev.sample} matured ideas (${ev.distinctSymbols} symbols, ${horizon}-session horizon, hypothetical entry at the proposal price): ${none.label} avg ${pct(none.meanRetPct)}. ${parts.join(". ")}. Highest average: ${best.label}. Ideas cluster on the same names, so treat this as descriptive. Shadow only; the live Guardian stop rule is unchanged.`;
}

export const todayUtc = (d = new Date()) => day(d.toISOString());
