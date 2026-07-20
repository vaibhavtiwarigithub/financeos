export interface JournalStageEvent {
  stage: string;
  outcome: string;
}

interface JournalTerminalInput {
  entryEligible: boolean;
  signalStatus?: string | null;
  events: JournalStageEvent[];
}

/**
 * Translate immutable pipeline events into a truthful current-state label.
 * A stage whose outcome is "passed" is complete; it must never be displayed
 * as pending at that same stage.
 */
export function resolveJournalTerminal(input: JournalTerminalInput): string {
  const { events, entryEligible, signalStatus } = input;
  if (events.length === 0) {
    return entryEligible ? "passed_research_no_downstream_data" : "rejected_research";
  }

  const last = events[events.length - 1];
  if (last.stage === "execution" && last.outcome === "filled") return "filled";
  if (last.outcome === "rejected") return `rejected_${last.stage}`;
  if (last.outcome === "expired") return "expired_not_traded";

  if (last.stage === "research" && last.outcome === "passed") {
    if (signalStatus === "weekend_staged") return "staged_awaiting_session";
    if (signalStatus === "revalidated" || signalStatus === "superseded") return "revalidated_superseded";
    if (signalStatus === "expired") return "expired_not_traded";
    if (signalStatus === "paper_traded") return "paper_traded_audit_gap";
    return "passed_research_awaiting_paper_gates";
  }

  if (["passed", "shrunk"].includes(last.outcome)) {
    return last.stage === "portfolio_constructor"
      ? "passed_portfolio_awaiting_execution"
      : `passed_${last.stage}_awaiting_downstream`;
  }

  return `pending_${last.stage}`;
}
