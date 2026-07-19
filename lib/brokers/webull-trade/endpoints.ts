// webull_trade — request paths (host is supplied by the credential/env).
// Confirmed against the official Webull Trading API reference on 2026-07-19.
// They are path constants only; all network access remains in transport.ts.
export const paths = {
  tokenCheck: "/openapi/auth/token/check",
  accountList: "/openapi/account/list",
  preview: "/openapi/trade/order/preview",
  place: "/openapi/trade/order/place",
  detail: "/openapi/trade/order/detail",
  open: "/openapi/trade/order/open",
  cancel: "/openapi/trade/order/cancel",
} as const;
