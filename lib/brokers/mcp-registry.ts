// Config-driven MCP broker registry (READ-ONLY, Phase-1 snapshot brokers).
//
// This is the single place a future OAuth-MCP broker (E*TRADE, another US/India
// broker) is added: append one `McpBrokerConfig` entry to `MCP_BROKERS` and the
// generic driver (`lib/brokers/mcp-driver.ts`) + generic routes
// (`app/api/broker-mcp/[broker]/*`) + the Settings connect card render it with
// NO new code. There is deliberately NO order-placement surface here — every
// broker in this registry is a read-only accounts/positions/balances/quotes
// connection. Order-capable brokers (Robinhood) are NOT in this registry and
// keep their bespoke, deterministic order path.

export interface McpBrokerOAuth {
  authorizeUrl: string;   // OAuth 2.1 authorization_endpoint
  tokenUrl: string;       // token_endpoint
  registerUrl: string;    // dynamic client registration_endpoint (RFC 7591)
  scopes: string;         // space-delimited READ-ONLY scopes (never order:write)
  publicClient: boolean;  // true → token_endpoint_auth_method="none" (PKCE public client)
}

// Response field-name candidates. Each is an ordered list of keys tried in turn
// (dotted paths like "instrument.symbol" are supported) so a new broker's JSON
// shape maps onto our BrokerAccount without new parsing code.
export interface McpBrokerFields {
  accountId: string[];      // account identifier on a get_account_list row
  symbol: string[];         // ticker on a position / quote row
  qty: string[];            // share quantity on a position row
  avgCost: string[];        // average cost/price on a position row
  positionPrice: string[];  // fallback last/market price carried on a position row
  price: string[];          // current price on a get_stock_quotes row
  equity: string[];         // total/net account value on a get_account_balance row
  cash: string[];           // cash balance on a balance row
  buyingPower: string[];    // buying power on a balance row
  quoteSymbolKeys: string[]; // candidate arg names for the quotes tool's symbol input
}

export interface McpBrokerConfig {
  id: string;                 // stable slug, e.g. "webull" (also BrokerAccount.source)
  label: string;              // human label, e.g. "Webull"
  market: "us" | "india";
  currency: string;           // ISO currency for the Settings snapshot, e.g. "USD"
  mcpUrl: string;             // MCP JSON-RPC (StreamableHTTP) endpoint
  // redirect_uri path registered via DCR and used in authorize + token exchange.
  // Behaviour-neutral migration: Webull's already-registered client used
  // /api/webull/callback, so its callbackPath is pinned to that; new brokers use
  // the generic /api/broker-mcp/<id>/callback.
  callbackPath: string;
  clientName: string;         // DCR client_name
  protocolVersion: string;    // MCP-Protocol-Version header value
  oauth: McpBrokerOAuth;
  vaultProvider: string;      // api_key_vault.provider tag, e.g. "webull_mcp"
  vaultKeys: { clientId: string; access: string; refresh: string; expiry: string };
  tools: { accountList: string; positions: string; balance: string; quotes: string };
  fields: McpBrokerFields;

  // ── OPTIONAL Phase-2 ORDER surface (SHIPPED INERT) ─────────────────────────
  // These fields describe how to place/track/cancel orders on an order-capable
  // MCP broker. They are DELIBERATELY separate from the read-only `scopes`/`tools`
  // above so the read path is never coupled to the write path. Presence of these
  // fields does NOT enable orders — the order adapter (lib/brokers/adapters/
  // webull.ts) gates on a token + a strategy_config kill switch + a per-account
  // allowlist, ALL of which are off today. See that adapter for the full gate.
  //
  // `orderCapable` is a config-level marker only: leave false/undefined to keep
  // the broker order-inert even if the runtime flags were ever flipped on.
  orderCapable?: boolean;
  // Order scopes are ONLY used if/when the owner reconnects the broker with
  // orders explicitly enabled. The default read-only `scopes` above is unchanged.
  orderScopes?: string;
  // Tool names for the order lifecycle: preview (dry-run review), place (submit),
  // status (fetch a single order), cancel.
  orderTools?: { preview: string; place: string; status: string; cancel: string };
}

// ── Registry ────────────────────────────────────────────────────────────────
// Seeded with Webull using the exact values migrated from lib/webull-mcp.ts —
// same endpoints, scopes, tools, and vault keys (behaviour-neutral).
export const MCP_BROKERS: Record<string, McpBrokerConfig> = {
  webull: {
    id: "webull",
    label: "Webull",
    market: "us",
    currency: "USD",
    mcpUrl: "https://api.webull.com/mcp",
    // Pinned to the path the live Webull DCR client was registered with, so the
    // authorize redirect_uri + token-exchange redirect_uri still match exactly.
    callbackPath: "/api/webull/callback",
    clientName: "Kairos FinanceOS",
    protocolVersion: "2025-06-18",
    oauth: {
      authorizeUrl: "https://passport.webull.com/oauth2/ai-mcp/login",
      tokenUrl: "https://u1suserauth.webullfintech.com/api/userauth/oauth/token/token",
      registerUrl: "https://u1suserauth.webullfintech.com/api/userauth/oauth/client/register",
      // READ-ONLY Phase-1 scopes ONLY. order:write is intentionally omitted.
      scopes: "account:read market:read instrument:read",
      publicClient: true,
    },
    vaultProvider: "webull_mcp",
    vaultKeys: {
      clientId: "WEBULL_MCP_CLIENT_ID",
      access: "WEBULL_MCP_ACCESS_TOKEN",
      refresh: "WEBULL_MCP_REFRESH_TOKEN",
      expiry: "WEBULL_MCP_TOKEN_EXPIRES",
    },
    tools: {
      accountList: "get_account_list",
      positions: "get_account_positions",
      balance: "get_account_balance",
      quotes: "get_stock_quotes",
    },
    fields: {
      accountId: ["account_id", "account_number", "accountId", "id"],
      symbol: ["symbol", "ticker", "instrument.symbol"],
      qty: ["quantity", "qty", "shares", "position"],
      avgCost: ["cost_price", "average_cost", "average_price", "avg_price", "avg_cost"],
      positionPrice: ["last_price", "market_price"],
      price: ["last_price", "last_trade_price", "close", "current_price", "mark_price", "price"],
      // Webull get_account_balance returns total_net_liquidation_value (NLV) as the
      // account value + a nested account_currency_assets[0] with buying_power.
      equity: ["total_net_liquidation_value", "net_liquidation_value", "total_value", "net_liquidation", "net_asset_value", "total_market_value", "total_asset", "equity"],
      cash: ["total_cash_balance", "cash_balance", "cash", "settled_cash", "available_cash"],
      buyingPower: ["buying_power", "day_buying_power", "account_currency_assets.0.buying_power"],
      quoteSymbolKeys: ["symbols", "symbol", "tickers"],
    },
    // ── ORDER surface: intentionally ABSENT ───────────────────────────────────
    // The published Webull Cloud MCP is query-only — no order scopes, no place/
    // preview/cancel tools. Order tools were removed from this config on
    // 2026-07-17 after the "verified live" claim turned out to be false against
    // the real server. Do NOT re-add MCP write tools inferred from the separate
    // Trading API docs: Webull trading is a distinct, signed REST integration
    // (see features/webull-trading-api/), never the MCP. The read-only `scopes`
    // above are unchanged; `orderCapable:false` keeps this broker order-inert.
    orderCapable: false,
  },
};

export function getMcpBroker(id: string | undefined | null): McpBrokerConfig | undefined {
  if (!id) return undefined;
  return MCP_BROKERS[id];
}
