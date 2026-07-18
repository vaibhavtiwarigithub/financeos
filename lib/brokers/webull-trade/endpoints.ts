// webull_trade — request paths (host is supplied by the credential/env).
// RECONCILIATION NOTE: confirm these exact paths against the current official
// Webull Trading API docs during the entitlement/sandbox step. They are path
// CONSTANTS only — no request is made against them in this module or any test.
export const paths = {
  place: "/trade/v1/order/place",
  status: "/trade/v1/order/query",
  cancel: "/trade/v1/order/cancel",
} as const;
