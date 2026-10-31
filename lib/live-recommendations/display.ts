/** Counterfactual value difference for the suggested reduction quantity, versus continuing to hold it. */
export function hypotheticalReductionImpact(qty: number | null, signalPrice: number | null, lastPrice: number | null): number | null {
  if (qty == null || !Number.isFinite(qty) || qty <= 0 || signalPrice == null || !Number.isFinite(signalPrice) || signalPrice <= 0 || lastPrice == null || !Number.isFinite(lastPrice) || lastPrice <= 0) return null;
  return Math.round(qty * (signalPrice - lastPrice) * 100) / 100;
}

/** P/L value used by both the recommendation table cell and its P/L sort. */
export function displayedRecommendationPnl(row: {
  kind: string;
  pnlPct: number | null;
  levelTouched: boolean | null;
  pnlIfLevelPct: number | null;
}): number | null {
  return row.kind === "guardian_stop" && row.levelTouched === true
    ? row.pnlIfLevelPct
    : row.pnlPct;
}

export type ExitTriggerLevels = { target: number | null; stop: number | null; runnerStop: number | null };

/** Read the immutable price levels already written into the exit-ladder reason string. */
export function parseExitTriggerLevels(rationale: string | null): ExitTriggerLevels {
  const text = rationale ?? "";
  const capture = (pattern: RegExp) => {
    const match = text.match(pattern);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  return {
    target: capture(/target:\s*[0-9]+(?:\.[0-9]+)?\s*>=\s*\$?([0-9]+(?:\.[0-9]+)?)/i),
    stop: capture(/stop(?: hit intraday)?:\s*[0-9]+(?:\.[0-9]+)?\s*<=\s*\$?([0-9]+(?:\.[0-9]+)?)/i),
    runnerStop: capture(/runner protected at\s*\$?([0-9]+(?:\.[0-9]+)?)/i),
  };
}
