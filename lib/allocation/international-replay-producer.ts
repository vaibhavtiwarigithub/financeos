export type InternationalReplayProducerOutcome = {
  status: "collected" | "blocked" | "error";
  observedSession: string | null;
  blockers: string[];
  details: {
    httpStatus: number;
    attributionState: string | null;
    shadowBookState: string | null;
    trigger: "cron_authenticated" | "owner_manual";
  };
};

/** A changed immutable result is a data-integrity refusal, not a transient producer crash. */
export function classifyInternationalReplayProducerOutcome(input: {
  httpStatus: number;
  body: Record<string, any>;
  trigger: "cron_authenticated" | "owner_manual";
}): InternationalReplayProducerOutcome {
  const { body, httpStatus, trigger } = input;
  const attributionState = typeof body?.attribution?.state === "string"
    ? body.attribution.state
    : typeof body?.attributionState === "string" ? body.attributionState : null;
  const shadowBookState = typeof body?.shadowBookSnapshot?.state === "string"
    ? body.shadowBookSnapshot.state : null;
  const observedSession = typeof body?.result?.endDate === "string"
    ? body.result.endDate
    : typeof body?.attribution?.asOfSession === "string" ? body.attribution.asOfSession
      : typeof body?.asOfSession === "string" ? body.asOfSession : null;
  const blockers: string[] = [];
  if (httpStatus >= 400) blockers.push(String(body?.error ?? `Replay returned HTTP ${httpStatus}`));
  if (attributionState === "invalid" || attributionState === "snapshot_write_failed") {
    blockers.push(String(body?.attribution?.reason ?? body?.error ?? "Immutable attribution validation refused this replay."));
  }
  const status = attributionState === "invalid" || attributionState === "snapshot_write_failed" || httpStatus === 409
    ? "blocked" : httpStatus >= 500 ? "error" : "collected";
  return { status, observedSession, blockers: [...new Set(blockers)], details: { httpStatus, attributionState, shadowBookState, trigger } };
}
