import crypto from "crypto";
import type { BrokerInstrumentCapability, BrokerPreflightInput } from "./adapter-types";

export function capability(input: BrokerPreflightInput, base: {
  broker: string; market: "us" | "india"; source: string; allowed: boolean;
  active?: boolean; buyAllowed?: boolean; sellAllowed?: boolean; closeOnly?: boolean;
  canonicalSymbol?: string | null; instrumentId?: string | null; fractionalAllowed?: boolean;
  lotSize?: number | null; tickSize?: number | null; reasonCode?: string | null; raw?: unknown;
  ttlMs?: number;
}): BrokerInstrumentCapability {
  const checkedAt = new Date();
  const stable = JSON.stringify({ broker: base.broker, accountId: input.accountId, env: input.env, symbol: input.symbol,
    side: input.side, qty: input.qty, type: input.type, source: base.source, raw: base.raw ?? null });
  return {
    broker: base.broker, accountId: input.accountId, env: input.env, market: base.market,
    requestedSymbol: input.symbol, canonicalSymbol: base.canonicalSymbol ?? null, instrumentId: base.instrumentId ?? null,
    side: input.side, orderType: input.type, allowed: base.allowed, active: base.active ?? false,
    buyAllowed: base.buyAllowed ?? false, sellAllowed: base.sellAllowed ?? false, closeOnly: base.closeOnly ?? false,
    fractionalAllowed: base.fractionalAllowed ?? false, lotSize: base.lotSize ?? null, tickSize: base.tickSize ?? null,
    checkedAt: checkedAt.toISOString(), expiresAt: new Date(checkedAt.getTime() + (base.ttlMs ?? 60_000)).toISOString(),
    source: base.source, reasonCode: base.reasonCode ?? null,
    rawFingerprint: crypto.createHash("sha256").update(stable).digest("hex"),
  };
}

export function unsupportedCapability(broker: string, market: "us" | "india", input: BrokerPreflightInput, reason: string) {
  return capability(input, { broker, market, source: `${broker}_unsupported`, allowed: false, reasonCode: reason });
}

export function capabilityUsable(c: BrokerInstrumentCapability, input: BrokerPreflightInput, now = new Date()): { ok: true } | { ok: false; reason: string } {
  if (c.broker.trim() === "" || c.accountId !== input.accountId || c.env !== input.env) return { ok: false, reason: "broker_context_mismatch" };
  if (c.requestedSymbol.toUpperCase() !== input.symbol.toUpperCase() || c.side !== input.side || c.orderType !== input.type) return { ok: false, reason: "order_context_mismatch" };
  if (!c.rawFingerprint || Date.parse(c.checkedAt) > now.getTime() || Date.parse(c.expiresAt) <= now.getTime()) return { ok: false, reason: "stale_or_invalid_evidence" };
  if (!c.active || !c.allowed) return { ok: false, reason: c.reasonCode ?? "broker_denied" };
  if (input.side === "buy" && !c.buyAllowed) return { ok: false, reason: "buy_not_allowed" };
  if (input.side === "sell" && !c.sellAllowed) return { ok: false, reason: "sell_not_allowed" };
  if (c.lotSize == null || c.lotSize <= 0 || Math.abs(input.qty / c.lotSize - Math.round(input.qty / c.lotSize)) > 1e-6) return { ok: false, reason: "invalid_lot_size" };
  return { ok: true };
}

/**
 * `candidate_probe` is discovery evidence only.  It must never be mixed with
 * the last-mile execution observations that can eventually qualify the broker
 * enforcement shadow.  Defaulting preserves every existing order-path caller.
 */
export function preflightRow(
  c: BrokerInstrumentCapability,
  proposalId: number | null,
  purpose: "execution_attempt" | "candidate_probe" = "execution_attempt",
) {
  return {
    proposal_id: proposalId, broker: c.broker, broker_account_id: c.accountId, broker_env: c.env, market: c.market,
    requested_symbol: c.requestedSymbol, canonical_symbol: c.canonicalSymbol, instrument_id: c.instrumentId,
    side: c.side, order_type: c.orderType, allowed: c.allowed, active: c.active, buy_allowed: c.buyAllowed,
    sell_allowed: c.sellAllowed, close_only: c.closeOnly, fractional_allowed: c.fractionalAllowed,
    lot_size: c.lotSize, tick_size: c.tickSize, checked_at: c.checkedAt, expires_at: c.expiresAt,
    source: c.source, reason_code: c.reasonCode, raw_fingerprint: c.rawFingerprint, enforcement_mode: "shadow", purpose,
  };
}
