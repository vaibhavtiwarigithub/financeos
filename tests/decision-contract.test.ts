import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  attachDecisionContractRef,
  DECISION_CONTRACT_VERSION,
  decisionContractRef,
} from "@/lib/trading/decision-contract";

describe("cross-layer decision reference", () => {
  it("creates a stable market-scoped reference for the same source decision", () => {
    const research = decisionContractRef({
      signalId: "signal-123", market: "US", symbol: "aapl", stage: "research",
    });
    const execution = decisionContractRef({
      signalId: "signal-123", market: "us", symbol: "AAPL", stage: "execution",
    });

    expect(research).toEqual({
      version: DECISION_CONTRACT_VERSION,
      id: "us:signal-123",
      signal_id: "signal-123",
      market: "us",
      symbol: "AAPL",
      layer: "research",
      stage: "research",
    });
    expect(execution?.id).toBe(research?.id);
    expect(execution?.layer).toBe("execution");
  });

  it("keeps different markets separate and omits malformed/global events", () => {
    expect(decisionContractRef({ signalId: "s1", market: "india", symbol: "RELIANCE", stage: "proposal" })?.id)
      .toBe("india:s1");
    expect(decisionContractRef({ signalId: null, market: "us", symbol: "AAPL", stage: "research" })).toBeNull();
    expect(decisionContractRef({ signalId: "s1", market: "", symbol: "AAPL", stage: "research" })).toBeNull();
    expect(decisionContractRef({ signalId: "s1", market: "us", symbol: null, stage: "research" })).toBeNull();
    expect(decisionContractRef({ signalId: "s1", market: "us", symbol: "AAPL", stage: "unknown" })).toBeNull();
  });

  it("adds the reference without overwriting established audit detail", () => {
    const detail = attachDecisionContractRef({ sizedPct: 4.5, reason: "constructor passed" }, {
      signalId: "signal-123", market: "us", symbol: "AAPL", stage: "portfolio_constructor",
    });

    expect(detail).toMatchObject({
      sizedPct: 4.5,
      reason: "constructor passed",
      decision_contract_ref: {
        version: DECISION_CONTRACT_VERSION,
        id: "us:signal-123",
        signal_id: "signal-123",
        layer: "portfolio",
        stage: "portfolio_constructor",
      },
    });
  });

  it("leaves non-object legacy detail unchanged when no contract can be built", () => {
    expect(attachDecisionContractRef("legacy", {
      signalId: null, market: "us", symbol: "AAPL", stage: "execution",
    })).toBe("legacy");
  });

  it("wires the shared reference through canonical research, portfolio and live execution writers", () => {
    const research = readFileSync("lib/research-agent.ts", "utf8");
    const paper = readFileSync("app/api/agents/paper-trade/route.ts", "utf8");
    const proposals = readFileSync("app/api/agents/trader/route.ts", "utf8");
    const execution = readFileSync("lib/trading/execute-order.ts", "utf8");

    expect(research).toContain("decision_contract_ref: decisionContractRef");
    expect(paper).toContain("detail: attachDecisionContractRef(args.detail ?? null");
    expect(proposals).toContain("risk_check_reasons:  attachDecisionContractRef");
    expect(execution).toContain("decision_contract_ref: decisionContractRef");
  });
});
