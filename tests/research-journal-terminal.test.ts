import { describe, expect, it } from "vitest";
import { resolveJournalTerminal } from "@/lib/research/journal-terminal";

describe("Research Journal terminal state", () => {
  it("never calls a completed research pass pending research", () => {
    expect(resolveJournalTerminal({
      entryEligible: true,
      signalStatus: "pending",
      events: [{ stage: "research", outcome: "passed" }],
    })).toBe("passed_research_awaiting_paper_gates");
  });

  it("explains weekend staging and later revalidation", () => {
    const events = [{ stage: "research", outcome: "passed" }];
    expect(resolveJournalTerminal({ entryEligible: true, signalStatus: "weekend_staged", events }))
      .toBe("staged_awaiting_session");
    expect(resolveJournalTerminal({ entryEligible: true, signalStatus: "revalidated", events }))
      .toBe("revalidated_superseded");
  });

  it("preserves explicit research rejection and execution fill", () => {
    expect(resolveJournalTerminal({
      entryEligible: false,
      signalStatus: "pending",
      events: [{ stage: "research", outcome: "rejected" }],
    })).toBe("rejected_research");
    expect(resolveJournalTerminal({
      entryEligible: true,
      signalStatus: "paper_traded",
      events: [
        { stage: "research", outcome: "passed" },
        { stage: "execution", outcome: "filled" },
      ],
    })).toBe("filled");
  });

  it("does not call a passed portfolio stage pending portfolio", () => {
    expect(resolveJournalTerminal({
      entryEligible: true,
      signalStatus: "pending",
      events: [
        { stage: "research", outcome: "passed" },
        { stage: "portfolio_constructor", outcome: "passed" },
      ],
    })).toBe("passed_portfolio_awaiting_execution");
  });
});
