import { describe, expect, it } from "vitest";
import { brokerAccountDisplayLabel, maskedAccountId } from "@/lib/brokers/account-label";

describe("broker account display labels", () => {
  it("shows the stored human name with broker and only a masked account suffix", () => {
    const label = brokerAccountDisplayLabel({ broker: "robinhood", accountId: "605420660", nickname: "Agentic" });
    expect(label).toBe("Agentic · Robinhood ••••0660");
    expect(label).not.toContain("605420660");
  });

  it("keeps distinct Robinhood account names distinguishable", () => {
    expect(brokerAccountDisplayLabel({ broker: "robinhood", accountId: "965848641", nickname: "Trading" }))
      .toBe("Trading · Robinhood ••••8641");
    expect(brokerAccountDisplayLabel({ broker: "robinhood", accountId: "991989781", nickname: "Autopilot" }))
      .toBe("Autopilot · Robinhood ••••9781");
  });

  it("sanitizes untrusted nicknames and falls back to a masked broker label", () => {
    expect(brokerAccountDisplayLabel({ broker: "robinhood", accountId: "5QZ42862", nickname: "  Default\nAccount  " }))
      .toBe("Default Account · Robinhood ••••2862");
    expect(brokerAccountDisplayLabel({ broker: "robinhood", accountId: "116781169200", nickname: null }))
      .toBe("Robinhood ••••9200");
    expect(maskedAccountId("116781169200")).toBe("••••9200");
  });
});
