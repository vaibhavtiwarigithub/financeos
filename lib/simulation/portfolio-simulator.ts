export type SimulationMarket = "us" | "india";
export type SimulationCurrency = "USD" | "INR";

export interface SimulationPolicy {
  market: SimulationMarket;
  currency: SimulationCurrency;
  initialCash: number;
  maxOpenNames: number;
  allowFractionalShares: boolean;
  /** Positions already held at the replay boundary. Seeded without consuming
   * initialCash; costBasis is the boundary mark per share. */
  initialPositions?: SimulatedPosition[];
}

export interface SimulationEvent {
  id: string;
  session: string;
  symbol: string;
  kind: "entry" | "exit";
  price: number;
  quantity?: number;
  cashAllocation?: number;
  costPct?: number;
  /** An exit for a lot opened in the same session. Normal exits still execute
   * first; this one executes after entries so the ledger's causal order is
   * representable without weakening exit-first capital redeployment. */
  afterEntry?: boolean;
}

export interface SimulatedFill {
  eventId: string;
  session: string;
  symbol: string;
  kind: "entry" | "exit";
  quantity: number;
  price: number;
  gross: number;
  cost: number;
  cashAfter: number;
}

export interface SimulationRejection {
  eventId: string;
  reason:
    | "invalid_event"
    | "duplicate_event_id"
    | "invalid_exit"
    | "insufficient_cash"
    | "name_cap"
    | "fractional_not_allowed";
}

export interface SimulatedPosition {
  symbol: string;
  quantity: number;
  costBasis: number;
}

export interface PortfolioSimulationResult {
  market: SimulationMarket;
  currency: SimulationCurrency;
  initialCash: number;
  endingCash: number;
  positions: SimulatedPosition[];
  fills: SimulatedFill[];
  rejections: SimulationRejection[];
  realizedPnl: number;
}

function validMoney(value: number | undefined): value is number {
  return value != null && Number.isFinite(value) && value >= 0;
}

function sameSessionOrder(a: SimulationEvent, b: SimulationEvent): number {
  if (a.session !== b.session) return a.session.localeCompare(b.session);
  const phase = (e: SimulationEvent) => e.kind === "entry" ? 1 : e.afterEntry ? 2 : 0;
  const typeOrder = phase(a) - phase(b);
  if (typeOrder !== 0) return typeOrder;
  const symbolOrder = a.symbol.localeCompare(b.symbol);
  return symbolOrder || a.id.localeCompare(b.id);
}

/**
 * Deterministic market-local accounting simulator. It consumes predeclared events;
 * it never chooses trades or reads mutable application state.
 */
export function simulatePortfolio(
  policy: SimulationPolicy,
  events: SimulationEvent[],
): PortfolioSimulationResult {
  if (!Number.isFinite(policy.initialCash) || policy.initialCash < 0) {
    throw new Error("initialCash must be a non-negative finite number");
  }
  if (!Number.isInteger(policy.maxOpenNames) || policy.maxOpenNames < 1) {
    throw new Error("maxOpenNames must be a positive integer");
  }
  const requiredCurrency: SimulationCurrency = policy.market === "us" ? "USD" : "INR";
  if (policy.currency !== requiredCurrency) {
    throw new Error(`${policy.market} simulation must use ${requiredCurrency}`);
  }

  let cash = policy.initialCash;
  let realizedPnl = 0;
  const positions = new Map<string, SimulatedPosition>();
  for (const pos of policy.initialPositions ?? []) {
    if (!pos.symbol || !Number.isFinite(pos.quantity) || pos.quantity <= 0
      || !Number.isFinite(pos.costBasis) || pos.costBasis <= 0
      || positions.has(pos.symbol)) {
      throw new Error("initialPositions must contain unique symbols with positive quantity and costBasis");
    }
    if (!policy.allowFractionalShares && !Number.isInteger(pos.quantity)) {
      throw new Error("initialPositions violate whole-share policy");
    }
    positions.set(pos.symbol, { ...pos });
  }
  if (positions.size > policy.maxOpenNames) throw new Error("initialPositions exceed maxOpenNames");
  const fills: SimulatedFill[] = [];
  const rejections: SimulationRejection[] = [];
  const seen = new Set<string>();

  for (const event of [...events].sort(sameSessionOrder)) {
    if (seen.has(event.id)) {
      rejections.push({ eventId: event.id, reason: "duplicate_event_id" });
      continue;
    }
    seen.add(event.id);

    const costPct = event.costPct ?? 0;
    if (!event.id || !event.session || !event.symbol || !Number.isFinite(event.price) || event.price <= 0 || !validMoney(costPct)) {
      rejections.push({ eventId: event.id, reason: "invalid_event" });
      continue;
    }

    const current = positions.get(event.symbol);
    if (event.kind === "exit") {
      if (!current || !Number.isFinite(event.quantity) || event.quantity! <= 0 || event.quantity! > current.quantity) {
        rejections.push({ eventId: event.id, reason: "invalid_exit" });
        continue;
      }
      if (!policy.allowFractionalShares && !Number.isInteger(event.quantity)) {
        rejections.push({ eventId: event.id, reason: "fractional_not_allowed" });
        continue;
      }
      const quantity = event.quantity!;
      const gross = quantity * event.price;
      const cost = gross * costPct;
      cash += gross - cost;
      realizedPnl += (event.price - current.costBasis) * quantity - cost;
      const remaining = current.quantity - quantity;
      if (remaining <= 1e-12) positions.delete(event.symbol);
      else positions.set(event.symbol, { ...current, quantity: remaining });
      fills.push({ eventId: event.id, session: event.session, symbol: event.symbol, kind: "exit", quantity, price: event.price, gross, cost, cashAfter: cash });
      continue;
    }

    let quantity = event.quantity;
    if (quantity == null && event.cashAllocation != null && Number.isFinite(event.cashAllocation) && event.cashAllocation > 0) {
      quantity = event.cashAllocation / (event.price * (1 + costPct));
    }
    if (!Number.isFinite(quantity) || quantity! <= 0) {
      rejections.push({ eventId: event.id, reason: "invalid_event" });
      continue;
    }
    const entryQuantity = quantity!;
    if (!policy.allowFractionalShares && !Number.isInteger(entryQuantity)) {
      rejections.push({ eventId: event.id, reason: "fractional_not_allowed" });
      continue;
    }
    if (!current && positions.size >= policy.maxOpenNames) {
      rejections.push({ eventId: event.id, reason: "name_cap" });
      continue;
    }
    const gross = entryQuantity * event.price;
    const cost = gross * costPct;
    const total = gross + cost;
    if (total > cash + 1e-9) {
      rejections.push({ eventId: event.id, reason: "insufficient_cash" });
      continue;
    }
    cash -= total;
    if (current) {
      const newQuantity = current.quantity + entryQuantity;
      positions.set(event.symbol, {
        symbol: event.symbol,
        quantity: newQuantity,
        costBasis: ((current.costBasis * current.quantity) + total) / newQuantity,
      });
    } else {
      positions.set(event.symbol, { symbol: event.symbol, quantity: entryQuantity, costBasis: total / entryQuantity });
    }
    fills.push({ eventId: event.id, session: event.session, symbol: event.symbol, kind: "entry", quantity: entryQuantity, price: event.price, gross, cost, cashAfter: cash });
  }

  return {
    market: policy.market,
    currency: policy.currency,
    initialCash: policy.initialCash,
    endingCash: cash,
    positions: [...positions.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)),
    fills,
    rejections,
    realizedPnl,
  };
}
