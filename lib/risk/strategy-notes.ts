// Best-effort LLM prose for the daily holding-risk run — PROSE ONLY.
//
// Spec: features/holding-risk-daily/FEATURE_ARCHITECTURE.md ("Compute path" §2),
//       features/risk-sector-breach-allocation/FEATURE_ARCHITECTURE.md §7.
//
// THE INVARIANT: the deterministic score, posture, action, and sector-breach
// allocation are FIXED before this runs. The model is handed them as read-only
// context to explain in plain English, and its output can NEVER alter a number,
// a score, a posture, an action, or an allocation.
//
// That invariant is enforced by the TYPE, not by the prompt: `parseStrategyNotes`
// returns `Map<symbol, string>` and the caller writes it to exactly one nullable
// column (`strategy_note`). There is no code path by which model output reaches
// any other field. `parseStrategyNotes` is pure and exported so this is provable
// by test rather than by reading the prompt and trusting it:
//   - a non-string value (object/number/array/null) is DROPPED, never coerced;
//   - a key that was not one of the requested symbols is DROPPED, so the model
//     cannot invent a holding or smuggle a `risk_posture` / `trim_pct` key;
//   - unparseable/absent output yields an EMPTY map and never throws — prose is
//     optional and must never block or fail a deterministic row.

import { callLLM } from "@/lib/llm-router";
import type { HoldingRiskResult } from "@/lib/risk/holding-risk";

const MAX_NOTE_CHARS = 600;

export interface StrategyNoteItem {
  symbol: string;
  result: HoldingRiskResult;
  weightPct: number;    // fraction of NAV
  sector: string | null;
}

/**
 * PURE. Extract per-symbol prose from raw model output.
 *
 * Only string values, only for symbols we asked about. Everything else — nested
 * objects, numbers, unrequested keys, prototype pollution attempts — is dropped.
 * Never throws.
 */
export function parseStrategyNotes(raw: string | null | undefined, symbols: readonly string[]): Map<string, string> {
  const notes = new Map<string, string>();
  if (typeof raw !== "string" || !raw.trim()) return notes;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return notes;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return notes;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return notes;

  for (const symbol of symbols) {
    // Own-property only: a key like "__proto__"/"constructor" must not resolve
    // through the prototype chain into a note.
    if (!Object.prototype.hasOwnProperty.call(parsed, symbol)) continue;
    const v = (parsed as Record<string, unknown>)[symbol];
    if (typeof v !== "string") continue;   // objects/numbers/arrays/null: dropped, never coerced
    const trimmed = v.trim();
    if (!trimmed) continue;
    notes.set(symbol, trimmed.slice(0, MAX_NOTE_CHARS));
  }
  return notes;
}

/**
 * Batched, best-effort prose. Never throws; an LLM failure yields an empty map
 * and every deterministic row still publishes with a null note.
 */
export async function strategyNotes(
  market: "us" | "india",
  accountLabel: string,
  items: readonly StrategyNoteItem[],
): Promise<Map<string, string>> {
  if (!items.length) return new Map();

  const lines = items.map(it =>
    `- ${it.symbol} (${it.sector ?? "sector?"}, ${(it.weightPct * 100).toFixed(1)}% of NAV): ` +
    `score=${it.result.score ?? "n/a"} posture=${it.result.riskPosture} reason="${it.result.actionReason}"`,
  ).join("\n");

  const prompt =
    `Account: ${accountLabel} (${market.toUpperCase()}). Below is the DETERMINISTIC risk verdict for each holding — ` +
    `these numbers, postures, actions, and any trim sizes are FINAL and you must NOT change, override, or contradict them.\n\n` +
    `${lines}\n\n` +
    `Note: a sector being over its cap is a property of the SECTOR. The verdict above already decides whether ` +
    `THIS name was selected to absorb that breach and by how much. Never tell the owner to trim a name whose ` +
    `posture is hold, and never restate a trim size other than the one given.\n\n` +
    `For each symbol write ONE or TWO plain-English sentences a non-expert owner can act on: what the risk driver is, ` +
    `and what to watch next. Do not invent new numbers or recommend buying/selling beyond the stated posture. ` +
    `Respond ONLY as a JSON object mapping each symbol to its note string, e.g. {"AAPL":"...","MSFT":"..."}.`;

  try {
    const res = await callLLM({
      task: "summarize",
      prompt,
      systemPrompt: "You explain pre-computed risk verdicts in plain English. You never alter the numbers or the action.",
      agentLabel: "holding-risk",
      maxTokens: 1200,
    });
    return parseStrategyNotes(res?.text, items.map(i => i.symbol));
  } catch {
    // best-effort: prose is optional and must never block or fail the run
    return new Map();
  }
}
