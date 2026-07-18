// ============================================================================
// GOLDEN signing fixtures for webull_trade (frozen constants).
// ----------------------------------------------------------------------------
// These are frozen expected HMAC-SHA1 hex signatures for a fixed input vector.
// The signing test proves:
//   (a) signRequest() reproduces BASE_SIGNATURE exactly (deterministic);
//   (b) mutating method / path / body / query / nonce / timestamp yields a
//       DIFFERENT signature (mutation-sensitive), so verifySignature() fails.
// The secret below is a throwaway TEST value — NOT a real Webull credential.
//
// RECONCILIATION NOTE: these vectors freeze THIS repo's canonical layout
// (buildCanonicalRequest). Before the first live/sandbox call, reconcile the
// layout against the current official Webull signing docs; if it differs, update
// buildCanonicalRequest and regenerate these constants in the same change.
// ============================================================================

import type { SignableRequest } from "@/lib/brokers/webull-trade/signing";

export const TEST_APP_SECRET = "test-app-secret-DO-NOT-USE";

export const BASE_REQUEST: SignableRequest = {
  method: "POST",
  path: "/trade/v1/order/place",
  query: { symbol: "AAPL", side: "BUY" },
  body: JSON.stringify({
    account_id: "WBACCT1",
    symbol: "AAPL",
    side: "BUY",
    order_type: "MARKET",
    quantity: 2,
    time_in_force: "DAY",
    session: "CORE",
    client_order_id: "kai0abc",
  }),
  appKey: "test-app-key",
  nonce: "11111111-1111-1111-1111-111111111111",
  timestamp: "1752800000000",
};

export const BASE_SIGNATURE = "bb8c955756bb3114c6e51b70a4aad8615efb3053";

// Expected canonical request string for BASE_REQUEST (newline-joined).
export const BASE_CANONICAL =
  "POST\n" +
  "/trade/v1/order/place\n" +
  "side=BUY&symbol=AAPL\n" +
  '{"account_id":"WBACCT1","symbol":"AAPL","side":"BUY","order_type":"MARKET","quantity":2,"time_in_force":"DAY","session":"CORE","client_order_id":"kai0abc"}\n' +
  "test-app-key\n" +
  "11111111-1111-1111-1111-111111111111\n" +
  "1752800000000";

// Each mutation and its (different) expected signature.
export const MUTATIONS: { name: string; req: SignableRequest; signature: string }[] = [
  { name: "method", req: { ...BASE_REQUEST, method: "GET" }, signature: "2c68021fb029f6bed10d5760b80f9657b721045f" },
  { name: "path", req: { ...BASE_REQUEST, path: "/trade/v1/order/cancel" }, signature: "e73e3e80e4cceff691646c8d1e9114624a144291" },
  { name: "body", req: { ...BASE_REQUEST, body: BASE_REQUEST.body!.replace('"quantity":2', '"quantity":20') }, signature: "8f38d414a0432d7d17b8c8eb50a9b0c08a824789" },
  { name: "query", req: { ...BASE_REQUEST, query: { symbol: "AAPL", side: "SELL" } }, signature: "6674a6d37df40ec53f35539a2c1335948817fd35" },
  { name: "nonce", req: { ...BASE_REQUEST, nonce: "22222222-2222-2222-2222-222222222222" }, signature: "7c7d7b787b247276f356d7422e3598fc12d5fcf9" },
  { name: "timestamp", req: { ...BASE_REQUEST, timestamp: "1752800000001" }, signature: "024c019e51d4db3e558fe124c3657560ad2132a1" },
];
