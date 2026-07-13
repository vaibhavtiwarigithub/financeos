// A3 / P0-3 acceptance: durable broker acknowledgment in executeApprovedOrder.
//
// The invariant under test: once the broker has ACCEPTED an order, broker_orders
// is the source of truth and the ACK MUST persist. If the post-submit DB update
// fails, the service must (a) retry DB-only, (b) NEVER resubmit to the broker,
// and (c) on persistent failure return { ok:false, status:202, needs_reconcile }
// carrying the known broker id — never { ok:true }.
//
// This exercises the REAL executeApprovedOrder (not re-implemented logic). Only
// its collaborators are faked: no live broker, no live network, no live Supabase.
// The scenario is driven at env:"paper" so the whole live-gate block is skipped
// and the test isolates exactly the submit → ACK-persist → outcome path.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getActiveBrokerForOrderMock: vi.fn(),
  isSymbolBlockedMock: vi.fn(),
  reportIssueMock: vi.fn(),
  liveOrdersAllowedMock: vi.fn((..._a: any[]) => true),
  autonomousWorkerAllowedMock: vi.fn((..._a: any[]) => false),
}));

vi.mock("@/lib/brokers/registry", () => ({
  getActiveBrokerForOrder: (...a: any[]) => h.getActiveBrokerForOrderMock(...a),
  getBroker: vi.fn(),
}));
vi.mock("@/lib/trading/symbol-policy", () => ({ isSymbolBlocked: (...a: any[]) => h.isSymbolBlockedMock(...a) }));
vi.mock("@/lib/system-health", () => ({ reportIssue: (...a: any[]) => h.reportIssueMock(...a) }));
vi.mock("@/lib/autonomy", () => ({
  liveOrdersAllowed: (...a: any[]) => h.liveOrdersAllowedMock(...a),
  autonomousWorkerAllowed: (...a: any[]) => h.autonomousWorkerAllowedMock(...a),
}));
// Collaborators the paper path never calls, but whose modules must resolve.
vi.mock("@/lib/kill-switches", () => ({ checkKillSwitches: vi.fn() }));
vi.mock("@/lib/risk/live-portfolio-gate", () => ({ checkLivePortfolioLimits: vi.fn() }));
vi.mock("@/lib/data/quotes", () => ({ getQuote: vi.fn() }));
vi.mock("@/lib/robinhood-mcp", () => ({ robinhoodHeldQty: vi.fn() }));
vi.mock("@/lib/kite", () => ({ getKiteHoldings: vi.fn() }));
vi.mock("@/lib/india-data", () => ({ isIndia: vi.fn(() => false), fetchIndiaQuote: vi.fn() }));

import { executeApprovedOrder } from "@/lib/trading/execute-order";
// Mocked collaborators the LIVE path calls — imported so the live test can set
// their return values (they resolve to the vi.fn() defined in the mocks above).
import { checkKillSwitches } from "@/lib/kill-switches";
import { getQuote } from "@/lib/data/quotes";

// ── Minimal chainable/thenable Supabase mock ──────────────────────────────────
// Records the terminal op per builder; a caller-supplied resolver produces the
// { data, error } (or { count }). rpc() is resolved separately.
type Q = { table: string; op: string; payload: any; filters: [string, any[]][] };

function makeClient(resolver: (q: Q) => any, rpcResolver: (name: string, args: any) => any) {
  const make = (table: string) => {
    const q: Q = { table, op: "select", payload: null, filters: [] };
    const chain: any = {
      select(..._a: any[]) { q.op = "select"; return chain; },
      insert(p: any) { q.op = "insert"; q.payload = p; return chain; },
      update(p: any) { q.op = "update"; q.payload = p; return chain; },
      upsert(p: any) { q.op = "upsert"; q.payload = p; return chain; },
      eq(...a: any[]) { q.filters.push(["eq", a]); return chain; },
      in(...a: any[]) { q.filters.push(["in", a]); return chain; },
      gte(...a: any[]) { q.filters.push(["gte", a]); return chain; },
      order(...a: any[]) { q.filters.push(["order", a]); return chain; },
      limit(...a: any[]) { q.filters.push(["limit", a]); return chain; },
      maybeSingle() { return Promise.resolve(resolver(q)); },
      single() { return Promise.resolve(resolver(q)); },
      then(res: any, rej: any) { return Promise.resolve(resolver(q)).then(res, rej); },
    };
    return chain;
  };
  return { from: (t: string) => make(t), rpc: (name: string, args: any) => Promise.resolve(rpcResolver(name, args)) };
}

const APPROVED_PROPOSAL = { id: 1, status: "approved", symbol: "AAPL", side: "buy", qty: 1, execution_mode: null, approval_expires_at: null };

function makeBroker() {
  return {
    id: "alpaca",
    market: "us",
    envs: ["paper", "live"],
    isConfigured: vi.fn(async () => true),
    submitOrder: vi.fn(async () => ({ ok: true, brokerOrderId: "BRK-123", raw: { state: "accepted" } })),
  };
}

// Build a resolver for the paper happy-path shape; `ackError(attempt)` decides
// whether each broker_orders UPDATE (the ACK) fails.
function makeResolver(ackError: (attempt: number) => any) {
  let ackAttempts = 0;
  const resolver = (q: Q) => {
    if (q.table === "trade_proposals") return { data: APPROVED_PROPOSAL, error: null };
    if (q.table === "broker_orders" && q.op === "select") {
      // idempotency active-order check (has an `in` filter) → none; else rate-limit count.
      if (q.filters.some((f) => f[0] === "in")) return { data: null, error: null };
      return { count: 0, error: null };
    }
    if (q.table === "broker_orders" && q.op === "update") {
      ackAttempts += 1;
      return { error: ackError(ackAttempts) };
    }
    if (q.table === "decision_journal") return { error: null };
    if (q.table === "strategy_config") return { data: null, error: null };
    return { data: null, error: null };
  };
  return { resolver, attempts: () => ackAttempts };
}

const rpcOk = (_name: string, _args: any) => ({ data: 555, error: null });
const OWNER = { kind: "owner" as const };

beforeEach(() => {
  vi.clearAllMocks();
  h.isSymbolBlockedMock.mockResolvedValue({ blocked: false });
  h.liveOrdersAllowedMock.mockReturnValue(true);
});

describe("A3 durable broker acknowledgment", () => {
  it("ACK persist fails on all 3 attempts → 202 needs_reconcile, broker NOT resubmitted", async () => {
    const broker = makeBroker();
    h.getActiveBrokerForOrderMock.mockResolvedValue({ ok: true, broker });
    const { resolver, attempts } = makeResolver(() => ({ message: "db unavailable" }));
    const svc = makeClient(resolver, rpcOk);

    const res = await executeApprovedOrder(svc, { proposalId: 1, env: "paper" }, OWNER);

    expect(res.ok).toBe(false);
    expect((res as any).status).toBe(202);
    expect((res as any).needs_reconcile).toBe(true);
    expect((res as any).broker_order_id).toBe("BRK-123"); // known id is surfaced
    expect((res as any).order_id).toBe(555);
    // The broker was hit exactly once — a failed ACK must never re-place the order.
    expect(broker.submitOrder).toHaveBeenCalledTimes(1);
    // Bounded DB-only retry: exactly 3 persist attempts, no more.
    expect(attempts()).toBe(3);
    // A CRITICAL alert carrying the known broker id was raised.
    expect(h.reportIssueMock).toHaveBeenCalledTimes(1);
    const alert = h.reportIssueMock.mock.calls[0][0];
    expect(alert.severity).toBe("critical");
    expect(String(alert.issueKey)).toContain("order-ack-persist-failed");
  });

  it("ACK persist succeeds on the 2nd attempt (transient) → ok:true, one broker submit", async () => {
    const broker = makeBroker();
    h.getActiveBrokerForOrderMock.mockResolvedValue({ ok: true, broker });
    const { resolver, attempts } = makeResolver((n) => (n < 2 ? { message: "transient" } : null));
    const svc = makeClient(resolver, rpcOk);

    const res = await executeApprovedOrder(svc, { proposalId: 1, env: "paper" }, OWNER);

    expect(res.ok).toBe(true);
    expect((res as any).order_id).toBe(555);
    expect((res as any).broker_order_id).toBe("BRK-123");
    expect(broker.submitOrder).toHaveBeenCalledTimes(1);
    expect(attempts()).toBe(2); // stopped retrying once it succeeded
    expect(h.reportIssueMock).not.toHaveBeenCalled();
  });

  it("ACK persists first try → ok:true, no reconcile alert", async () => {
    const broker = makeBroker();
    h.getActiveBrokerForOrderMock.mockResolvedValue({ ok: true, broker });
    const { resolver, attempts } = makeResolver(() => null);
    const svc = makeClient(resolver, rpcOk);

    const res = await executeApprovedOrder(svc, { proposalId: 1, env: "paper" }, OWNER);

    expect(res.ok).toBe(true);
    expect(broker.submitOrder).toHaveBeenCalledTimes(1);
    expect(attempts()).toBe(1);
    expect(h.reportIssueMock).not.toHaveBeenCalled();
  });

  it("broker submit itself fails → 502, no ACK attempts, no false success", async () => {
    const broker = makeBroker();
    broker.submitOrder = vi.fn(async () => ({ ok: false, error: "broker rejected", needsReconcile: false })) as any;
    h.getActiveBrokerForOrderMock.mockResolvedValue({ ok: true, broker });
    // Any broker_orders update here is the failure-path status write, not an ACK.
    const { resolver, attempts } = makeResolver(() => null);
    const svc = makeClient(resolver, rpcOk);

    const res = await executeApprovedOrder(svc, { proposalId: 1, env: "paper" }, OWNER);

    expect(res.ok).toBe(false);
    expect((res as any).status).toBe(502);
    expect(broker.submitOrder).toHaveBeenCalledTimes(1);
    // Codex A3/#5: the broker-reject path writes broker_orders exactly ONCE — the
    // failure-status write — and never enters the ACK retry loop. A count > 1
    // here would mean a rejected order was wrongly ACK-retried or resubmitted.
    expect(attempts()).toBe(1);
  });
});

// ── LIVE-path durable-ACK coverage ────────────────────────────────────────────
// Codex A3/#5 flagged that the ACK tests only exercised env:"paper", so the whole
// live-gate block (kill switches, portfolio, notional cap, account resolution,
// budget reservation) was never crossed on the way into the ACK loop, and the
// CRITICAL reconcile alert's *detail* (broker id + broker_orders row) was never
// asserted. This drives the REAL live path with every gate mocked to pass, then
// fails the ACK persist on all 3 attempts and asserts the 202 outcome AND that
// the alert carries the known broker id.

const LIVE_PROPOSAL = {
  id: 2,
  status: "approved",
  symbol: "AAPL",
  side: "buy",
  qty: 1,
  execution_mode: null,
  approval_expires_at: null,
  signal_id: null,          // quality gate is bypassed via acceptLowQuality
  price_at_proposal: null,  // no proposal price → drift check is skipped
};

// Superset row: resolveTradingAccount reads active_account_us; the live-cfg gate
// reads trading_enabled* / autonomy_level / caps. Both select from strategy_config
// and the mock can't distinguish by columns, so one row must satisfy both.
const LIVE_CFG = {
  active_account_us: "ACC-US",
  active_account_india: null,
  trading_enabled: true,
  trading_enabled_us: true,
  trading_enabled_india: true,
  robinhood_mcp_enabled: false,
  autonomy_level: "L3_live_manual",
  max_order_notional_usd: 100000,
  max_order_notional: 100000,
  max_daily_notional_usd: 1000000,
  max_daily_notional_inr: null,
  max_daily_trades: 100,
};

function makeLiveResolver(ackError: (attempt: number) => any) {
  let ackAttempts = 0;
  const resolver = (q: Q) => {
    if (q.table === "trade_proposals") return { data: LIVE_PROPOSAL, error: null };
    if (q.table === "strategy_config") return { data: LIVE_CFG, error: null };
    if (q.table === "market_controls") return { data: { paused: false, trading_enabled: true }, error: null };
    if (q.table === "broker_accounts") return { data: { role: "trading" }, error: null };
    if (q.table === "broker_orders" && q.op === "select") {
      if (q.filters.some((f) => f[0] === "in")) return { data: null, error: null }; // idempotency
      return { count: 0, error: null }; // rate-limit count
    }
    if (q.table === "broker_orders" && q.op === "update") {
      ackAttempts += 1;
      return { error: ackError(ackAttempts) };
    }
    if (q.table === "decision_journal") return { error: null }; // risk-override audit
    if (q.table === "live_account_snapshots") return { data: null, error: null };
    return { data: null, error: null };
  };
  return { resolver, attempts: () => ackAttempts };
}

function makeLiveBroker() {
  return {
    id: "alpaca",
    market: "us",
    envs: ["paper", "live"],
    isConfigured: vi.fn(async () => true),
    submitOrder: vi.fn(async () => ({ ok: true, brokerOrderId: "BRK-LIVE-1", raw: { state: "accepted" } })),
  };
}

describe("A3 durable broker acknowledgment — LIVE path", () => {
  it("all live gates pass, broker ACCEPTS, ACK persist fails 3× → 202 needs_reconcile with broker id in result AND alert detail", async () => {
    const broker = makeLiveBroker();
    h.getActiveBrokerForOrderMock.mockResolvedValue({ ok: true, broker });
    // Live-only collaborators the paper path skipped — all mocked to pass.
    (checkKillSwitches as any).mockResolvedValue({ safe: true, sellAllowed: true });
    (getQuote as any).mockResolvedValue({ price: 100 });

    const { resolver, attempts } = makeLiveResolver(() => ({ message: "db unavailable" }));
    const svc = makeClient(resolver, rpcOk);

    const res = await executeApprovedOrder(
      svc,
      {
        proposalId: 2,
        env: "live",
        // Owner overrides so signal-quality (G1) and portfolio (G3) gates don't
        // need their own fixtures — the point of THIS test is the ACK loop, not
        // the gates. Both overrides are owner-only and audited.
        acceptLowQuality: true,
        acceptPortfolioRisk: true,
        overrideReason: "live-path durable-ACK coverage test",
      } as any,
      OWNER,
    );

    // Crossed the entire live gate and reached the ACK loop.
    expect(broker.submitOrder).toHaveBeenCalledTimes(1); // broker hit exactly once
    expect(attempts()).toBe(3);                          // bounded DB-only retry
    expect(res.ok).toBe(false);
    expect((res as any).status).toBe(202);
    expect((res as any).needs_reconcile).toBe(true);
    expect((res as any).order_id).toBe(555);
    expect((res as any).broker_order_id).toBe("BRK-LIVE-1"); // id surfaced in result

    // CRITICAL alert carries the known broker id in its DETAIL, not just the key —
    // this is what a human reconciler reads to find the accepted-but-unpersisted order.
    expect(h.reportIssueMock).toHaveBeenCalledTimes(1);
    const alert = h.reportIssueMock.mock.calls[0][0];
    expect(alert.severity).toBe("critical");
    expect(String(alert.issueKey)).toContain("order-ack-persist-failed");
    expect(String(alert.detail)).toContain("BRK-LIVE-1");
  });
});
