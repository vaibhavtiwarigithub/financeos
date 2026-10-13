// Plain-language verdict for the LLM event dimension, from one horizon's evaluation cells. Mirrors the registry decision rule:
// keep only if the partial IC (after composite and council) is positive with evidence AND the event score is not a copy of the council.

import { REDUNDANCY_CORRELATION } from "@/lib/llm-events/evaluate";

export interface VerdictCell {
  series_key: string;
  classification: string;
  mean_session_rank_ic: number | null;
  t_stat: number | null;
  qualifying_sessions: number;
}

export type EventVerdict =
  | { state: "collecting"; text: string }
  | { state: "redundant"; text: string }
  | { state: "no_incremental_value"; text: string }
  | { state: "adds_information"; text: string };

export function eventVerdict(cells: readonly VerdictCell[]): EventVerdict {
  const partial = cells.find((c) => c.series_key === "event:partial_vs_composite_council");
  const corr = cells.find((c) => c.series_key === "corr:event_vs_council");
  if (!partial || partial.classification !== "measured_descriptive" || partial.mean_session_rank_ic == null) {
    const n = partial?.qualifying_sessions ?? 0;
    return { state: "collecting", text: `Collecting evidence: ${n} qualifying sessions so far; a verdict needs at least 20 sessions and 12 effective windows at this horizon.` };
  }
  if (corr?.classification === "measured_descriptive" && corr.mean_session_rank_ic != null && Math.abs(corr.mean_session_rank_ic) >= REDUNDANCY_CORRELATION) {
    return { state: "redundant", text: `Redundant with the council (rank correlation ${corr.mean_session_rank_ic.toFixed(2)} >= ${REDUNDANCY_CORRELATION}). Retire the dimension.` };
  }
  if (partial.mean_session_rank_ic > 0 && partial.t_stat != null && partial.t_stat >= 2) {
    return { state: "adds_information", text: `Adds information beyond the composite and the council (partial IC ${partial.mean_session_rank_ic.toFixed(3)}, t ${partial.t_stat.toFixed(2)}). Eligible for challenger validation; still shadow-only.` };
  }
  return { state: "no_incremental_value", text: `No measurable information beyond the composite and the council (partial IC ${partial.mean_session_rank_ic.toFixed(3)}, t ${partial.t_stat == null ? "n/a" : partial.t_stat.toFixed(2)}). Retire the dimension.` };
}
