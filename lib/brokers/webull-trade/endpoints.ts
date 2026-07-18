// webull_trade — request paths (host is supplied by the credential/env).
// RECONCILIATION NOTE: confirm these exact paths against the current official
// Webull Trading API docs during the entitlement/sandbox step. They are path
// CONSTANTS only — no request is made against them in this module or any test.
export const paths = {
  place: "/openapi/trade/order/place",
  detail: "/openapi/trade/order/detail",
  open: "/openapi/trade/order/open",
  cancel: "/openapi/trade/order/cancel",
} as const;
