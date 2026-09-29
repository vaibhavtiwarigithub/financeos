import { describe, expect, it } from "vitest";
import { classifyInternationalReplayProducerOutcome } from "@/lib/allocation/international-replay-producer";

describe("international-allocation producer outcome classification", () => {
  it("classifies an immutable attribution conflict as blocked and preserves its reason", () => {
    expect(classifyInternationalReplayProducerOutcome({
      httpStatus: 503, trigger: "cron_authenticated",
      body: { error: "Conflicting immutable attribution already exists for this program/version/session.", attributionState: "invalid" },
    })).toMatchObject({
      status: "blocked", observedSession: null,
      blockers: ["Conflicting immutable attribution already exists for this program/version/session."],
      details: { httpStatus: 503, attributionState: "invalid", trigger: "cron_authenticated" },
    });
  });

  it("keeps infrastructure failures as errors and policy refusals as blocked", () => {
    expect(classifyInternationalReplayProducerOutcome({ httpStatus: 503, trigger: "owner_manual", body: { error: "database unavailable" } }).status).toBe("error");
    expect(classifyInternationalReplayProducerOutcome({ httpStatus: 409, trigger: "owner_manual", body: { error: "policy unavailable" } }).status).toBe("blocked");
  });
});
