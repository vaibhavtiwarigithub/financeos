import type { SignableRequest } from "@/lib/brokers/webull-trade/signing";

// Webull's published worked example. These are not Kairos credentials.
export const TEST_APP_SECRET = "0f50a2e853334a9aae1a783bee120c1f";
export const BASE_REQUEST: SignableRequest = {
  method: "POST",
  path: "/trade/place_order",
  host: "api.webull.com",
  query: { a1: "webull", a2: 123, a3: "xxx", q1: "yyy" },
  body: '{"k1":123,"k2":"this is the api request body","k3":true,"k4":{"foo":[1,2]}}',
  appKey: "776da210ab4a452795d74e726ebd74b6",
  nonce: "48ef5afed43d4d91ae514aaeafbc29ba",
  timestamp: "2022-01-04T03:55:31Z",
};
export const BASE_SIGNATURE = "kvlS6opdZDhEBo5jq40nHYXaLvM=";
export const BASE_CANONICAL = "%2Ftrade%2Fplace_order%26a1%3Dwebull%26a2%3D123%26a3%3Dxxx%26host%3Dapi.webull.com%26q1%3Dyyy%26x-app-key%3D776da210ab4a452795d74e726ebd74b6%26x-signature-algorithm%3DHMAC-SHA1%26x-signature-nonce%3D48ef5afed43d4d91ae514aaeafbc29ba%26x-signature-version%3D1.0%26x-timestamp%3D2022-01-04T03%3A55%3A31Z%26E296C96787E1A309691CEF3692F5EEDD";
export const MUTATIONS: { name: string; req: SignableRequest }[] = [
  { name: "path", req: { ...BASE_REQUEST, path: "/trade/cancel_order" } },
  { name: "host", req: { ...BASE_REQUEST, host: "api.sandbox.webull.com" } },
  { name: "body", req: { ...BASE_REQUEST, body: BASE_REQUEST.body!.replace("123", "124") } },
  { name: "query", req: { ...BASE_REQUEST, query: { ...BASE_REQUEST.query, q1: "changed" } } },
  { name: "nonce", req: { ...BASE_REQUEST, nonce: "58ef5afed43d4d91ae514aaeafbc29ba" } },
  { name: "timestamp", req: { ...BASE_REQUEST, timestamp: "2022-01-04T03:55:32Z" } },
];
