// webull_trade — signing fixtures match; mutations fail (spec Failure Test 6 + 13).
import { describe, it, expect } from "vitest";
import {
  buildCanonicalRequest,
  signRequest,
  verifySignature,
  isTimestampFresh,
  freshNonce,
  buildSignatureHeaders,
  HEADER,
  DEFAULT_MAX_SKEW_MS,
} from "@/lib/brokers/webull-trade/signing";
import {
  BASE_REQUEST,
  BASE_SIGNATURE,
  BASE_CANONICAL,
  MUTATIONS,
  TEST_APP_SECRET,
} from "./fixtures/webull-trade-signing.golden";

describe("webull_trade signing — golden fixtures", () => {
  it("builds the exact canonical request", () => {
    expect(buildCanonicalRequest(BASE_REQUEST)).toBe(BASE_CANONICAL);
  });

  it("reproduces the golden signature deterministically", () => {
    expect(signRequest(BASE_REQUEST, TEST_APP_SECRET)).toBe(BASE_SIGNATURE);
    // stable across repeated calls
    expect(signRequest(BASE_REQUEST, TEST_APP_SECRET)).toBe(BASE_SIGNATURE);
  });

  it("verifies a correct signature", () => {
    expect(verifySignature(BASE_REQUEST, TEST_APP_SECRET, BASE_SIGNATURE)).toBe(true);
  });

  it("every mutation (method/path/body/query/nonce/timestamp) changes the signature and fails verification of the base", () => {
    for (const m of MUTATIONS) {
      const sig = signRequest(m.req, TEST_APP_SECRET);
      expect(sig, `mutation ${m.name} must differ from base`).not.toBe(BASE_SIGNATURE);
      // A request signed after mutation cannot verify against the base signature.
      expect(verifySignature(m.req, TEST_APP_SECRET, BASE_SIGNATURE)).toBe(false);
    }
  });

  it("rejects an empty/short/wrong-length signature without throwing", () => {
    expect(verifySignature(BASE_REQUEST, TEST_APP_SECRET, "")).toBe(false);
    expect(verifySignature(BASE_REQUEST, TEST_APP_SECRET, "deadbeef")).toBe(false);
    expect(verifySignature(BASE_REQUEST, TEST_APP_SECRET, BASE_SIGNATURE + "00")).toBe(false);
  });

  it("a wrong secret does not verify", () => {
    expect(verifySignature(BASE_REQUEST, "wrong-secret", BASE_SIGNATURE)).toBe(false);
  });

  it("query canonicalization is order-independent", () => {
    const a = signRequest({ ...BASE_REQUEST, query: { a1: "webull", a2: 123, a3: "xxx", q1: "yyy" } }, TEST_APP_SECRET);
    const b = signRequest({ ...BASE_REQUEST, query: { q1: "yyy", a3: "xxx", a2: 123, a1: "webull" } }, TEST_APP_SECRET);
    expect(a).toBe(b);
    expect(a).toBe(BASE_SIGNATURE);
  });

  it("does not embed the secret in the signature output", () => {
    const sig = signRequest(BASE_REQUEST, TEST_APP_SECRET);
    expect(sig).not.toContain(TEST_APP_SECRET);
    expect(Buffer.from(sig, "base64")).toHaveLength(20);
  });

  it("fresh nonce is unique per call", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(freshNonce());
    expect(seen.size).toBe(500);
  });

  it("timestamp skew guard fails closed outside the window", () => {
    const now = 1752800000000;
    expect(isTimestampFresh(new Date(now).toISOString(), now)).toBe(true);
    expect(isTimestampFresh(new Date(now - DEFAULT_MAX_SKEW_MS).toISOString(), now)).toBe(true);
    expect(isTimestampFresh(new Date(now - DEFAULT_MAX_SKEW_MS - 1).toISOString(), now)).toBe(false);
    expect(isTimestampFresh(new Date(now + DEFAULT_MAX_SKEW_MS + 1).toISOString(), now)).toBe(false);
    expect(isTimestampFresh("not-a-number", now)).toBe(false);
    expect(isTimestampFresh("Infinity", now)).toBe(false);
  });

  it("signature headers carry algorithm/version and the computed signature, never the secret", () => {
    const headers = buildSignatureHeaders(BASE_REQUEST, TEST_APP_SECRET);
    expect(headers[HEADER.signature]).toBe(BASE_SIGNATURE);
    expect(headers[HEADER.algorithm]).toBe("HMAC-SHA1");
    expect(headers[HEADER.version]).toBe("1.0");
    expect(headers[HEADER.apiVersion]).toBe("v2");
    expect(headers[HEADER.appKey]).toBe(BASE_REQUEST.appKey);
    expect(JSON.stringify(headers)).not.toContain(TEST_APP_SECRET);
  });
});
