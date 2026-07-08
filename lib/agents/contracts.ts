// lib/agents/contracts.ts — A2A typed messaging contracts (Tier-4 #17)
//
// A single typed vocabulary for every agent-to-agent handoff in the pipeline:
//
//   ResearchAgent → (Signal)      → ValidationEngine
//   ValidationEngine → (Decision) → TraderAgent / PaperTrade
//   TraderAgent → (Fill)          → PositionMonitor / LearnerAgent
//   LearnerAgent → (Outcome)      → strategy mutation
//
// Why native (not Google's A2A SDK / protobuf): our agents are Next.js route
// handlers sharing one Postgres, not networked services needing service
// discovery + streaming RPC. The value we actually want from "A2A" is a STABLE,
// VERSIONED, VALIDATED message shape at each boundary so one agent can't silently
// hand the next a malformed payload. That's a typed contract + a runtime guard —
// which is this file. If agents ever split into separate deployables, these
// types are the wire schema to serialize.
//
// Every message carries an envelope (from/to/type/version/traceId/ts) so a
// handoff is self-describing and auditable end to end.

export const CONTRACT_VERSION = 1 as const;

export type AgentId =
  | "research"
  | "validation"
  | "trader"
  | "paper-trade"
  | "position-monitor"
  | "learner"
  | "theme-scout";

export type MessageType = "signal" | "decision" | "fill" | "outcome";

export type Market = "us" | "india";
export type Direction = "long" | "short" | "neutral";

/** Common envelope on every A2A message. */
export interface Envelope<T extends MessageType> {
  type: T;
  version: typeof CONTRACT_VERSION;
  from: AgentId;
  to: AgentId;
  /** Correlates all messages for one candidate across the pipeline. */
  traceId: string;
  /** ISO timestamp; producer stamps it. */
  ts: string;
}

// ---- Signal: Research → Validation -----------------------------------------
export interface SignalPayload {
  symbol: string;
  market: Market;
  direction: Direction;
  analystScore: number; // 0..100
  scores: {
    fundamental: number;
    technical: number;
    sentiment: number;
    macro: number;
    insider: number;
  };
  /** Which dimensions had real evidence (drives thin-evidence abstain). */
  includedDims: string[];
  discoverySource?: string | null;
  rationale?: string | null;
  signalId?: string | null;
}
export type SignalMessage = Envelope<"signal"> & { payload: SignalPayload };

// ---- Decision: Validation → Trader -----------------------------------------
export interface DecisionPayload {
  symbol: string;
  market: Market;
  action: "buy" | "sell" | "hold";
  direction: Direction;
  /** Position size as fraction of NAV (post-Kelly, post-caps). */
  sizeFraction: number;
  entryPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  /** Reasons the validation engine attached (approve/veto trail). */
  notes?: string[];
  signalId?: string | null;
}
export type DecisionMessage = Envelope<"decision"> & { payload: DecisionPayload };

// ---- Fill: Trader → Monitor/Learner ----------------------------------------
export interface FillPayload {
  symbol: string;
  market: Market;
  side: "buy" | "sell";
  qty: number;
  fillPrice: number;
  tradeId?: string | null;
  /** Learning-integrity stamp (mig 116/117). */
  tainted?: boolean;
  taintReason?: string | null;
}
export type FillMessage = Envelope<"fill"> & { payload: FillPayload };

// ---- Outcome: Learner ← closed trade ---------------------------------------
export interface OutcomePayload {
  symbol: string;
  market: Market;
  tradeId: string;
  outcome: "win" | "loss" | "breakeven";
  pnlPct: number | null;
  exitReason?: string | null;
}
export type OutcomeMessage = Envelope<"outcome"> & { payload: OutcomePayload };

export type A2AMessage =
  | SignalMessage
  | DecisionMessage
  | FillMessage
  | OutcomeMessage;

// ---- Envelope construction + runtime validation ----------------------------

let _seq = 0;
/** Deterministic-ish trace id without Date.now()/random (both banned in some
 *  contexts). Callers may pass their own (e.g. signal_id) for correlation. */
export function newTraceId(prefix = "trace"): string {
  _seq = (_seq + 1) % 1_000_000;
  return `${prefix}-${_seq.toString(36)}`;
}

export function envelope<T extends MessageType>(
  type: T,
  from: AgentId,
  to: AgentId,
  ts: string,
  traceId?: string
): Envelope<T> {
  return {
    type,
    version: CONTRACT_VERSION,
    from,
    to,
    traceId: traceId ?? newTraceId(type),
    ts,
  };
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Runtime guard for an inbound A2A message. Checks envelope + payload shape so a
 * consumer can reject a malformed handoff instead of trusting TypeScript (which
 * is erased at runtime). Returns collected errors, never throws.
 */
export function validateMessage(msg: unknown): ValidationResult {
  const errors: string[] = [];
  const m = msg as Partial<A2AMessage> & { payload?: Record<string, unknown> };

  if (!m || typeof m !== "object") return { ok: false, errors: ["not an object"] };
  if (m.version !== CONTRACT_VERSION)
    errors.push(`version mismatch: got ${String(m.version)}, expected ${CONTRACT_VERSION}`);
  if (!m.type) errors.push("missing type");
  if (!m.from) errors.push("missing from");
  if (!m.to) errors.push("missing to");
  if (!m.traceId) errors.push("missing traceId");
  if (!m.ts) errors.push("missing ts");
  const p = m.payload;
  if (!p || typeof p !== "object") {
    errors.push("missing payload");
    return { ok: errors.length === 0, errors };
  }
  if (typeof p.symbol !== "string" || !p.symbol) errors.push("payload.symbol required");

  switch (m.type) {
    case "signal":
      if (!isFiniteNum(p.analystScore)) errors.push("signal.analystScore must be finite");
      break;
    case "decision":
      if (!["buy", "sell", "hold"].includes(String(p.action)))
        errors.push("decision.action invalid");
      if (!isFiniteNum(p.sizeFraction) || (p.sizeFraction as number) < 0)
        errors.push("decision.sizeFraction must be >= 0 finite");
      break;
    case "fill":
      if (!isFiniteNum(p.qty) || (p.qty as number) <= 0)
        errors.push("fill.qty must be > 0");
      if (!isFiniteNum(p.fillPrice) || (p.fillPrice as number) <= 0)
        errors.push("fill.fillPrice must be > 0");
      break;
    case "outcome":
      if (!["win", "loss", "breakeven"].includes(String(p.outcome)))
        errors.push("outcome.outcome invalid");
      if (typeof p.tradeId !== "string") errors.push("outcome.tradeId required");
      break;
    default:
      errors.push(`unknown message type: ${String(m.type)}`);
  }

  return { ok: errors.length === 0, errors };
}
