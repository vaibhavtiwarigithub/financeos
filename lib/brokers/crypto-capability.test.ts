import { describe, expect, it } from "vitest";
import { assessCryptoBrokerCapability, CRYPTO_READ_TOOL_REQUIREMENTS } from "./crypto-capability";

describe("assessCryptoBrokerCapability", () => {
  it("requires every read contract and distinguishes advertised execution from permission", () => {
    const result = assessCryptoBrokerCapability([
      ...CRYPTO_READ_TOOL_REQUIREMENTS,
      "preview_crypto_order", "place_crypto_order", "cancel_crypto_order",
    ]);
    expect(result).toEqual({ readReady: true, previewAdvertised: true, orderAdvertised: true, cancelAdvertised: true, missingReadTools: [] });
  });

  it("does not treat an order tool alone as a usable crypto path", () => {
    const result = assessCryptoBrokerCapability(["place_crypto_order"]);
    expect(result.readReady).toBe(false);
    expect(result.missingReadTools).toHaveLength(CRYPTO_READ_TOOL_REQUIREMENTS.length);
  });
});
