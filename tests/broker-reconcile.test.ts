import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────────
// submitRobinhoodOrder's ONLY external deps are createServiceClient (Supabase)
// and global fetch (the MCP JSON-RPC wire). We mock both so the REAL function
// runs end-to-end against a controlled transport — no live network, no live
// Supabase, and no real order is ever placed.
const h = vi.hoisted(() => ({
  // Vault contents getValidAccessToken() reads: a present, non-expired token so
  // the code takes the happy "already connected" path (no token-endpoint fetch).
  vault: {
    ROBINHOOD_MCP_ACCESS_TOKEN: "test-access-token",
    ROBINHOOD_MCP_TOKEN_EXPIRY: new Date(Date.now() + 3600_000).toISOString(),
  } as Record<string, string>,
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => {
    const vault = h.vault;
    // Minimal chainable stub covering vaultGet's from(...).select(...).eq(...).maybeSingle()
    const makeBuilder = (table: string) => {
      let keyName: string | null = null;
      const builder: any = {
        select: () => builder,
        eq: (col: string, val: string) => { if (col === "key_name") keyName = val; return builder; },
        in: () => builder,
        limit: () => builder,
        maybeSingle: async () =>
          table === "api_key_vault" && keyName && keyName in vault
            ? { data: { key_value: vault[keyName] }, error: null }
            : { data: null, error: null },
        update: () => builder,
      };
      return builder;
    };
    return { from: (table: string) => makeBuilder(table) };
  },
}));

// Health reporting hits Supabase — no-op it so the token path stays pure.
vi.mock("@/lib/system-health", () => ({
  reportIssue: async () => {},
  resolveIssue: async () => {},
}));

import { submitRobinhoodOrder } from "@/lib/robinhood-mcp";

// ── Fake MCP transport ────────────────────────────────────────────────────────
// A JSON-RPC place tool whose inputSchema buildArgsFromSchema can fully fill.
const PLACE_TOOL = {
  name: "place_equity_order",
  inputSchema: {
    type: "object",
    properties: {
      symbol: { type: "string" },
      side: { type: "string", enum: ["buy", "sell"] },
      quantity: { type: "string" },
      order_type: { type: "string", enum: ["market", "limit"] },
      account_number: { type: "string" },
      time_in_force: { type: "string", enum: ["gfd"] },
    },
    required: ["symbol", "side", "quantity", "account_number"],
  },
};

// Build a Response-shaped object mcpRpc understands (ok/status/headers.get/text).
function mcpResponse(
  reqBody: any,
  opts: { status?: number; result?: any; error?: any; emptyBody?: boolean } = {}
) {
  const status = opts.status ?? 200;
  const payload: any = { jsonrpc: "2.0", id: reqBody.id };
  if (opts.error) payload.error = opts.error;
  else payload.result = opts.result ?? {};
  const text = opts.emptyBody ? "" : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => {
        const n = name.toLowerCase();
        if (n === "mcp-session-id") return "test-session-1";
        if (n === "content-type") return "application/json";
        return null;
      },
    },
    text: async () => text,
    json: async () => (text ? JSON.parse(text) : {}),
  } as unknown as Response;
}

// Install a fetch that walks the real flow: initialize → initialized notif →
// tools/list → tools/call(place_equity_order). `placeResponder` decides the
// place outcome. `placeCalls` records every actual submit so a test can assert
// the submit path was reached exactly once (no double-submit / no auto-retry).
function installFetch(placeResponder: (reqBody: any) => Response) {
  const placeCalls: any[] = [];
  const fetchMock = vi.fn(async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    switch (body.method) {
      case "initialize":
        return mcpResponse(body, { result: { protocolVersion: "2025-06-18", capabilities: {} } });
      case "notifications/initialized":
        return mcpResponse(body, { result: {} });
      case "tools/list":
        return mcpResponse(body, { result: { tools: [PLACE_TOOL] } });
      case "tools/call": {
        const name = body.params?.name;
        if (name === "place_equity_order") {
          placeCalls.push(body.params?.arguments);
          return placeResponder(body);
        }
        throw new Error(`unexpected tools/call: ${name}`);
      }
      default:
        throw new Error(`unexpected MCP method: ${body.method}`);
    }
  });
  vi.stubGlobal("fetch", fetchMock);
  return { placeCalls, fetchMock };
}

const ORDER = {
  account: "605420660",
  symbol: "AAPL",
  side: "buy" as const,
  qty: 10,
  type: "market" as const,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ── Test 5 — valid order reaches submit path exactly once (no double-submit) ──
describe("Test 5 — a valid order reaches the broker submit path exactly once", () => {
  it("places exactly one place_equity_order call and returns ok with a broker order id", async () => {
    const orderId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const { placeCalls } = installFetch((body) =>
      mcpResponse(body, {
        result: { content: [{ type: "text", text: JSON.stringify({ order: { id: orderId } }) }] },
      })
    );

    const res = await submitRobinhoodOrder(ORDER);

    expect(res.ok).toBe(true);
    expect(res.brokerOrderId).toBe(orderId);
    expect(res.needsReconcile).toBeUndefined();
    // The core "no double-submit" guarantee: submit path invoked exactly once.
    expect(placeCalls.length).toBe(1);
  });
});

// ── Test 7 — ambiguous submit result must set needsReconcile, never retry ─────
describe("Test 7 — an AMBIGUOUS submit result never triggers a retry/resubmit", () => {
  it("HTTP 5xx after send (transmitted, outcome unknown) -> needsReconcile, single submit, no ok", async () => {
    const { placeCalls } = installFetch((body) =>
      mcpResponse(body, { status: 500 }) // reached the server, outcome unconfirmable -> sent:true
    );

    const res = await submitRobinhoodOrder(ORDER);

    expect(res.ok).toBe(false);
    expect(res.needsReconcile).toBe(true);
    // Must NOT auto-resubmit an ambiguous place: submit path hit exactly once.
    expect(placeCalls.length).toBe(1);
    expect(res.brokerOrderId).toBeUndefined();
  });

  it("empty/unparseable body (ambiguous) -> needsReconcile, not a plain resubmittable failure", async () => {
    const { placeCalls } = installFetch((body) =>
      mcpResponse(body, { status: 200, emptyBody: true }) // parsed==null -> sent:true
    );

    const res = await submitRobinhoodOrder(ORDER);

    expect(res.ok).toBe(false);
    expect(res.needsReconcile).toBe(true);
    expect(placeCalls.length).toBe(1);
  });

  it("a DEFINITE server rejection (JSON-RPC error, sent:false) is a plain failure, NOT needsReconcile", async () => {
    // Contrast case: proves needsReconcile is reserved for genuinely ambiguous
    // outcomes. A definite rejection means nothing was placed -> safe plain fail.
    const { placeCalls } = installFetch((body) =>
      mcpResponse(body, { error: { code: -32000, message: "insufficient buying power" } })
    );

    const res = await submitRobinhoodOrder(ORDER);

    expect(res.ok).toBe(false);
    expect(res.needsReconcile).toBeFalsy();
    expect(placeCalls.length).toBe(1);
  });
});

// ── Test 13 — success with NO order id must be treated as needsReconcile ──────
describe("Test 13 — a broker place success with NO parseable order id -> needsReconcile", () => {
  it("returns needsReconcile (not ok) when the place response carries no trackable order id", async () => {
    const { placeCalls } = installFetch((body) =>
      mcpResponse(body, {
        // 200 OK, valid JSON-RPC result, but no order id anywhere to reconcile against.
        result: { content: [{ type: "text", text: JSON.stringify({ status: "received" }) }] },
      })
    );

    const res = await submitRobinhoodOrder(ORDER);

    expect(res.ok).toBe(false);
    expect(res.needsReconcile).toBe(true);
    expect(res.brokerOrderId).toBeUndefined();
    // Single submit — the ambiguous no-id outcome must never be blindly retried.
    expect(placeCalls.length).toBe(1);
  });
});

// ── Honest gap note ───────────────────────────────────────────────────────────
// The sync route (app/api/broker/orders/sync/route.ts) status-mapping and
// reconcile-vs-resubmit decision is a Next.js route handler that reads/writes
// broker_orders directly via Supabase and iterates the broker registry; its
// resubmit-vs-reconcile guarantee is enforced upstream (submitRobinhoodOrder,
// covered above) plus DB status transitions, not an isolatable pure helper.
describe.skip("sync route resubmit-vs-reconcile decision", () => {
  // TODO: not unit-isolatable — route handler couples Supabase reads/writes and
  // the broker registry; the needsReconcile contract it depends on is proven via
  // submitRobinhoodOrder (Tests 5/7/13) rather than by re-exercising the route.
  it("leaves needs-reconcile orders untouched instead of resubmitting", () => {});
});
