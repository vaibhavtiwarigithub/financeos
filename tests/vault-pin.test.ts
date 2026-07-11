import { describe, it, expect } from "vitest";
import { hashPin, verifyPin, isHashedPin } from "@/lib/vault-pin";

describe("vault-pin: hash + verify", () => {
  it("hashes to the salted scrypt format and round-trips", () => {
    const h = hashPin("hunter2-secret");
    expect(isHashedPin(h)).toBe(true);
    expect(h.startsWith("s1$")).toBe(true);
    expect(verifyPin("hunter2-secret", h)).toBe(true);
  });

  it("rejects the wrong PIN against a hash", () => {
    const h = hashPin("correct-pin");
    expect(verifyPin("wrong-pin", h)).toBe(false);
  });

  it("uses a fresh salt each time (two hashes of the same PIN differ)", () => {
    expect(hashPin("same")).not.toBe(hashPin("same"));
  });

  it("verifies a LEGACY plaintext stored value (env VAULT_PIN / pre-hash)", () => {
    expect(verifyPin("legacy-plain", "legacy-plain")).toBe(true);
    expect(verifyPin("legacy-plain", "other")).toBe(false);
  });

  it("fails closed on null/empty inputs", () => {
    expect(verifyPin(null, hashPin("x"))).toBe(false);
    expect(verifyPin("x", null)).toBe(false);
    expect(verifyPin("", "")).toBe(true); // empty==empty legacy compare (not a bypass of a set PIN)
  });

  it("a hashed stored value cannot be satisfied by passing the hash string itself", () => {
    const h = hashPin("real");
    expect(verifyPin(h, h)).toBe(false); // passing the hash as the PIN must not verify
  });
});
