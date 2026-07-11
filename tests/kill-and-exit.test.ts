// Tests 8/9/10 from the kill-switch / protective-exit fix prompt, exercised
// against the REAL exported functions (no re-implemented logic):
//
//   Test 8  — a partial fill followed by a second exit-monitor run cannot
//             oversell. Driven through the real `runLiveExitMonitor`: the
//             pending-SELL-proposal, active-SELL-order, and 23505 idempotency
//             guards each short-circuit before a duplicate SELL is submitted.
//   Test 9  — an auto-disable / kill switch blocks a BUY while still allowing a
//             protective SELL. Two real functions: (a) the real
//             `checkKillSwitches` trips and auto-disables trading; (b) the real
//             `/api/broker/orders/sync` POST cancels the resting BUY but leaves
//             the resting protective SELL untouched.
//   Test 10 — cancel-on-kill only ever cancels `side==="buy"` resting orders
//             (never a protective SELL), and reconciles a cancel/fill race (an
//             order that filled mid-sweep is recorded filled, not canceled).
//
// Everything external is mocked: no real order is ever placed or canceled, no
// live network, no live Supabase. The functions under test are the real ones;
// only their collaborators (Supabase client, broker adapter, kill-switch
// collaborator for the route, quote/exec collaborators for the monitor) are
// faked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mock handles (referenced inside vi.mock factories) ────────────────
const h = vi.hoisted(() => ({
  ksMock: vi.fn(),
  createServiceMock: vi.fn(),
  getBrokerMock: vi.fn(),
  fetchAlpacaMock: vi.fn(),
  kiteHoldingsMock: vi.fn(),
  verifyCronMock: vi.fn(),
  emitAlertMock: vi.fn(),
  execMock: vi.fn(),
  quoteMock: vi.fn(),
  indiaQuoteMock: vi.fn(),
  marketOpenMock: vi.fn(),
}));

vi.mock("@/lib/kill-switches", () => ({ checkKillSwitches: (...a: any[]) => h.ksMock(...a) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: (...a: any[]) => h.createServiceMock(...a) }));
vi.mock("@/lib/brokers/registry", () => ({
  getBroker: (...a: any[]) => h.getBrokerMock(...a),
  getActiveBrokerForOrder: vi.fn(),
}));
vi.mock("@/lib/brokers/alpaca", () => ({ fetchAlpacaAccount: (...a: any[]) => h.fetchAlpacaMock(...a) }));
vi.mock("@/lib/kite", () => ({ getKiteHoldings: (...a: any[]) => h.kiteHoldingsMock(...a) }));
vi.mock("@/lib/auth/cron", () => ({ verifyCronSecret: (...a: any[]) => h.verifyCronMock(...a) }));
vi.mock("@/lib/alerts/emit", () => ({ emitAlert: (...a: any[]) => h.emitAlertMock(...a) }));
vi.mock("@/lib/system-health", () => ({ reportIssue: vi.fn(), resolveIssue: vi.fn() }));
vi.mock("@/lib/trading/execute-order", () => ({ executeApprovedOrder: (...a: any[]) => h.execMock(...a) }));
vi.mock("@/lib/data/quotes", () => ({ getQuote: (...a: any[]) => h.quoteMock(...a) }));
vi.mock("@/lib/india-data", () => ({
  fetchIndiaQuote: (...a: any[]) => h.indiaQuoteMock(...a),
  isIndia: vi.fn(() => false),
}));
vi.mock("@/lib/trading/market-calendar", () => ({ isMarketOpenLive: (...a: any[]) => h.marketOpenMock(...a) }));

import { POST } from "@/app/api/broker/orders/sync/route";

// ── A tiny fake Supabase query builder ────────────────────────────────────────
// Every filter method records [method, args] and returns the same chainable,
// thenable object; a caller-supplied `resolver(q)` produces { data, error }.
// This lets a test assert that the code under test applied the exact predicate
// (e.g. `.eq("side","buy")`) rather than trusting a hand-picked return value.
type Query = { table: string; op: string; payload: any; filters: [string, any[]][]; _single: null | "maybe" | "single" };
type Resolver = (q: Query) => { data: any; error: any };

function makeClient(resolver: Resolver) {
  const build = (table: string) => {
    const q: Query = { table, op: "select", payload: null, filters: [], _single: null };
    const chain = (name: string) => (...args: any[]) => { q.filters.push([name, args]); return api; };
    const api: any = {
      select: (...a: any[]) => { q.filters.push(["select", a]); return api; },
      insert: (v: any) => { q.op = "insert"; q.payload = v; return api; },
      update: (v: any) => { q.op = "update"; q.payload = v; return api; },
      upsert: (v: any) => { q.op = "upsert"; q.payload = v; return api; },
      delete: () => { q.op = "delete"; return api; },
      eq: chain("eq"), neq: chain("neq"), in: chain("in"), gte: chain("gte"),
      lte: chain("lte"), gt: chain("gt"), lt: chain("lt"), not: chain("not"),
      is: chain("is"), order: chain("order"), limit: chain("limit"),
      maybeSingle: () => { q._single = "maybe"; return Promise.resolve(resolver(q)); },
      single: () => { q._single = "single"; return Promise.resolve(resolver(q)); },
      then: (onF: any, onR: any) => Promise.resolve(resolver(q)).then(onF, onR),
    };
    return api;
  };
  return { from: (t: string) => build(t), rpc: (..._a: any[]) => Promise.resolve({ data: null, error: null }) };
}

const eqOf = (q: Query, col: string): any => q.filters.find(([m, a]) => m === "eq" && a[0] === col)?.[1]?.[1];
const inOf = (q: Query, col: string): any => q.filters.find(([m, a]) => m === "in" && a[0] === col)?.[1]?.[1];

// A store-backed resolver that honours eq/in filters against real rows and
// mutates rows on update — used for the route so cancel/fill reconciliation and
// the side=buy filter emerge from the code, not from canned answers.
function storeResolver(store: Record<string, any[]>): Resolver {
  const matches = (row: any, filters: [string, any[]][]) => {
    for (const [m, a] of filters) {
      if (m === "eq" && row[a[0]] !== a[1]) return false;
      if (m === "in" && !a[1].includes(row[a[0]])) return false;
    }
    return true;
  };
  return (q) => {
    const rows = (store[q.table] ??= []);
    if (q.op === "insert") {
      const v = Array.isArray(q.payload) ? q.payload : [q.payload];
      rows.push(...v);
      return { data: q.payload, error: null };
    }
    const matched = rows.filter((r) => matches(r, q.filters));
    if (q.op === "update") {
      for (const r of matched) Object.assign(r, q.payload);
      const hasSelect = q.filters.some(([m]) => m === "select");
      return { data: hasSelect ? matched.map((r) => ({ id: r.id })) : null, error: null };
    }
    if (q._single) return { data: matched[0] ?? null, error: null };
    return { data: matched, error: null };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCronMock.mockReturnValue(true);
  h.fetchAlpacaMock.mockResolvedValue({ error: "skip-reconcile" });
  h.kiteHoldingsMock.mockResolvedValue({ ok: false });
  h.emitAlertMock.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8 — real runLiveExitMonitor: no duplicate / oversized SELL
// ─────────────────────────────────────────────────────────────────────────────
describe("Test 8 — exit monitor is idempotent: a partial fill + rerun cannot oversell", () => {
  const RECENT = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const DEFAULT_FILLS = [
    { symbol: "AAPL", side: "buy", filled_qty: 100, qty: 100, avg_fill_price: 100, created_at: RECENT, status: "filled" },
  ];

  // A filled BUY of 100 @ 100, current price 50 → a stop trigger fires; whether a
  // SELL is actually submitted then depends purely on the idempotency guards.
  function exitResolver(opts: { activeSell?: any; pendingSell?: any; insertErr?: any } = {}): Resolver {
    return (q) => {
      if (q.op === "rpc") return { data: null, error: null };
      if (q.table === "strategy_config") {
        return { data: { live_auto_enabled: true, app_paused: false, security_locked: false, active_account_us: "ACCT", active_account_india: null }, error: null };
      }
      if (q.table === "broker_orders") {
        if (eqOf(q, "status") === "filled") return { data: DEFAULT_FILLS, error: null };      // position reconstruction
        if (eqOf(q, "side") === "sell") return { data: opts.activeSell ?? null, error: null }; // active-SELL-order guard
        return { data: null, error: null };
      }
      if (q.table === "trade_proposals") {
        if (q.op === "insert") return { data: opts.insertErr ? null : { id: 1234 }, error: opts.insertErr ?? null };
        if (q.op === "update") return { data: null, error: null };
        return { data: opts.pendingSell ?? null, error: null };                                // pending-SELL-proposal guard
      }
      return { data: null, error: null };
    };
  }

  async function runMonitor(opts: { activeSell?: any; pendingSell?: any; insertErr?: any } = {}) {
    vi.resetModules();
    vi.stubEnv("AUTONOMOUS_LIVE_ENABLED", "true"); // read at module-eval in @/lib/autonomy
    h.quoteMock.mockResolvedValue({ price: 50, stale: false }); // below the 8% stop band
    h.marketOpenMock.mockImplementation((m: string) => ({ open: m === "us" }));
    h.execMock.mockResolvedValue({ ok: true });
    const { runLiveExitMonitor } = await import("@/lib/trading/live-exit-monitor");
    const svc = makeClient(exitResolver(opts)) as any;
    return runLiveExitMonitor(svc, "run-test-8");
  }

  afterEach(() => vi.unstubAllEnvs());

  it("submits exactly ONE SELL on a clean run (positive control — proves the path really reaches execution)", async () => {
    const r = await runMonitor(); // no existing sells anywhere
    expect(h.execMock).toHaveBeenCalledTimes(1);
    expect(h.execMock.mock.calls[0][1]).toMatchObject({ proposalId: 1234, env: "live" });
    expect(r.exits_submitted).toBe(1);
    expect(r.results[0].status).toBe("submitted");
  });

  it("does NOT submit a second SELL when a partially-filled live SELL is already resting (no oversell)", async () => {
    // The first run's SELL partially filled and is still resting at the broker.
    const r = await runMonitor({ activeSell: { id: 999 } });
    expect(h.execMock).not.toHaveBeenCalled();
    expect(r.exits_submitted).toBe(0);
    expect(r.results[0].status).toBe("skipped_duplicate");
    expect(r.results[0].error).toContain("active sell order 999");
  });

  it("does NOT submit when a pending/queued autonomous SELL proposal already exists", async () => {
    const r = await runMonitor({ pendingSell: { id: "prop-77" } });
    expect(h.execMock).not.toHaveBeenCalled();
    expect(r.results[0].status).toBe("skipped_duplicate");
    expect(r.results[0].error).toContain("prop-77");
  });

  it("treats a 23505 unique-violation on insert as a resolved duplicate (concurrent-run race)", async () => {
    const r = await runMonitor({ insertErr: { code: "23505", message: "duplicate key" } });
    expect(h.execMock).not.toHaveBeenCalled();
    expect(r.results[0].status).toBe("skipped_duplicate");
    expect(r.results[0].error).toContain("DB constraint");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 9a — real checkKillSwitches: an auto-disable trips and halts trading
// ─────────────────────────────────────────────────────────────────────────────
describe("Test 9a — real checkKillSwitches auto-disables on a breach (blocks new BUYs)", () => {
  it("trips daily_loss and writes trading_enabled=false (the auto-disable that blocks BUYs)", async () => {
    const writes: any[] = [];
    const resolver: Resolver = (q) => {
      if (q.op === "update") writes.push({ table: q.table, payload: q.payload });
      if (q.table === "strategy_config") {
        if (q.op === "update") return { data: null, error: null };
        return { data: { ks_daily_loss_pct: -20, ks_drawdown_pct: 25, ks_accuracy_pct: 40, live_auto_enabled: false, active_account_us: null, active_account_india: null }, error: null };
      }
      if (q.table === "paper_portfolio") return { data: { nav: 5000 }, error: null };            // down from 10k
      if (q.table === "paper_performance") return { data: [{ date: "2020-01-01", nav: 10000, market: "us" }], error: null };
      if (q.table === "paper_trades") return { data: [], error: null };
      if (q.table === "broker_orders") return { data: [], error: null };                          // no resting orders to flag
      return { data: null, error: null };
    };
    const svc = makeClient(resolver) as any;
    const real = await vi.importActual<typeof import("@/lib/kill-switches")>("@/lib/kill-switches");

    const res = await real.checkKillSwitches(svc, "us");

    expect(res.safe).toBe(false);
    expect(res.tripped).toBe("daily_loss");
    // Auto-disable side effect: strategy_config.trading_enabled flipped to false.
    expect(writes.some((w) => w.table === "strategy_config" && w.payload.trading_enabled === false)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 9b + Test 10 — real /api/broker/orders/sync POST: cancel-on-kill
// ─────────────────────────────────────────────────────────────────────────────
// One kill sweep over three resting live orders on a tripped market:
//   #1 bo1 buy  — FILLS during the poll (cancel/fill race)
//   #2 bo2 buy  — still resting → must be canceled
//   #3 bo3 sell — protective SELL → must NEVER be canceled
async function runKillSweep() {
  const store: Record<string, any[]> = {
    broker_orders: [
      { id: 1, symbol: "AAA", broker_order_id: "bo1", broker: "alpaca", broker_env: "live", market: "us", side: "buy", status: "submitted", qty: 10, filled_qty: 0 },
      { id: 2, symbol: "BBB", broker_order_id: "bo2", broker: "alpaca", broker_env: "live", market: "us", side: "buy", status: "submitted", qty: 5, filled_qty: 0 },
      { id: 3, symbol: "CCC", broker_order_id: "bo3", broker: "alpaca", broker_env: "live", market: "us", side: "sell", status: "submitted", qty: 7, filled_qty: 0 },
    ],
    decision_journal: [],
    trade_proposals: [],
  };
  const broker = {
    // bo1 reports filled mid-sweep → the race the reconciler must resolve.
    getOrder: vi.fn(async (id: string) =>
      id === "bo1" ? { ok: true, status: "filled", filledQty: 10, avgFillPrice: 100, raw: {} } : { ok: true, status: "submitted", raw: {} }),
    cancelOrder: vi.fn(async (_id: string, _mode: string) => ({ ok: true })),
  };
  h.getBrokerMock.mockReturnValue(broker);
  h.createServiceMock.mockReturnValue(makeClient(storeResolver(store)));
  // Kill switch tripped for US, clear for India.
  h.ksMock.mockImplementation((_svc: any, mkt: string) => (mkt === "us" ? { safe: false, reason: "US daily loss breach" } : { safe: true }));

  const res = await POST({} as any);
  const body = await res.json();
  return { body, store, broker };
}

describe("Test 9b — kill switch cancels the resting BUY but allows the protective SELL", () => {
  it("cancels the resting BUY (blocks exposure) while the protective SELL is left in place", async () => {
    const { body, store, broker } = await runKillSweep();

    const sell = store.broker_orders.find((o) => o.id === 3)!;
    const buy = store.broker_orders.find((o) => o.id === 2)!;

    expect(sell.status).toBe("submitted");   // protective SELL untouched → position stays protected
    expect(buy.status).toBe("canceled");      // resting BUY canceled → no new exposure
    // cancelOrder was never asked to cancel the SELL order.
    expect(broker.cancelOrder.mock.calls.some((c) => c[0] === "bo3")).toBe(false);
    expect(body.canceled).toContain("BBB #2");
    expect(body.canceled).not.toContain("CCC #3");
  });
});

describe("Test 10 — cancel-on-kill filters to side=buy and reconciles a cancel/fill race", () => {
  it("only side=buy resting orders are cancel candidates; the SELL is never a candidate", async () => {
    const { broker } = await runKillSweep();
    // Exactly one cancel attempt, and it was the still-resting BUY (bo2) — not
    // the SELL (bo3), not the raced order that already filled (bo1).
    expect(broker.cancelOrder).toHaveBeenCalledTimes(1);
    expect(broker.cancelOrder).toHaveBeenCalledWith("bo2", "live");
    expect(broker.cancelOrder.mock.calls.some((c) => c[0] === "bo3")).toBe(false);
    expect(broker.cancelOrder.mock.calls.some((c) => c[0] === "bo1")).toBe(false);
  });

  it("reconciles the cancel/fill race: an order that filled mid-sweep is recorded FILLED, not canceled", async () => {
    const { body, store } = await runKillSweep();
    const raced = store.broker_orders.find((o) => o.id === 1)!;
    expect(raced.status).toBe("filled");     // recorded as the real outcome
    expect(body.filled).toBe(1);
    expect(raced.status).not.toBe("canceled"); // never wrongly canceled after filling
    // The reconciled (now-filled) order is excluded from the cancel set.
    expect(body.canceled).not.toContain("AAA #1");
  });
});
