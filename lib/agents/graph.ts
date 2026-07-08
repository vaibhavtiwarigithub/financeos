// lib/agents/graph.ts — declarative agent orchestration graph (Tier-4 #15)
//
// A minimal, typed StateGraph runner modeling the LangGraph pattern natively:
// nodes are pure-ish async steps `(state) => Partial<state>`; edges wire them in
// order; conditional edges route on the accumulated state. run() threads a
// single shared state object through the graph, merging each node's output, and
// traces every step.
//
// Why native (not @langchain/langgraph): LangGraph's value is (1) a declarative
// node/edge model, (2) shared state threading, (3) conditional routing, (4) a
// checkpoint/observability seam. All four are ~120 lines against our own types —
// and a native runner avoids dragging LangChain's runtime + its transitive deps
// into a Next.js serverless bundle, keeps cold starts small, and lets state be a
// plain object we already know how to persist to Postgres. If we ever need
// durable checkpointing or human-in-the-loop interrupts, this seam is where a
// checkpointer plugs in (see `onStep`).
//
// This orchestrator is the composition layer; the existing cron routes remain
// the entry points. A route can build a graph from its steps to get ordering,
// conditional routing, and per-step tracing for free instead of hand-wiring
// imperative calls.

export const START = "__start__" as const;
export const END = "__end__" as const;

export type NodeId = string;

/** A node transforms shared state and returns a partial patch to merge. */
export type NodeFn<S> = (state: S) => Promise<Partial<S>> | Partial<S>;

/** Conditional edge: given the merged state, return the next node id (or END). */
export type Router<S> = (state: S) => NodeId | typeof END;

interface StepTrace {
  node: NodeId;
  ms: number;
  ok: boolean;
  err?: string;
}

export interface GraphRunResult<S> {
  state: S;
  path: NodeId[];
  steps: StepTrace[];
  ok: boolean;
}

export interface GraphRunOpts<S> {
  /** Called after every node with the step trace + current state (checkpoint seam). */
  onStep?: (trace: StepTrace, state: S) => void | Promise<void>;
  /** Hard cap on node executions to guarantee termination. Default 100. */
  maxSteps?: number;
  /** If true, a throwing node aborts the run; else it's recorded and routing continues. */
  stopOnError?: boolean;
}

export class StateGraph<S extends Record<string, unknown>> {
  private nodes = new Map<NodeId, NodeFn<S>>();
  private edges = new Map<NodeId, NodeId | typeof END>();
  private conditional = new Map<NodeId, Router<S>>();
  private entry: NodeId | null = null;

  addNode(id: NodeId, fn: NodeFn<S>): this {
    if (id === START || id === END) throw new Error(`reserved node id: ${id}`);
    if (this.nodes.has(id)) throw new Error(`duplicate node: ${id}`);
    this.nodes.set(id, fn);
    return this;
  }

  /** Static edge from → to. Use END as `to` to finish after `from`. */
  addEdge(from: NodeId, to: NodeId | typeof END): this {
    if (from === START) {
      this.entry = to;
      return this;
    }
    this.edges.set(from, to);
    return this;
  }

  /** Conditional edge: after `from`, `router(state)` picks the next node. */
  addConditionalEdge(from: NodeId, router: Router<S>): this {
    this.conditional.set(from, router);
    return this;
  }

  setEntry(id: NodeId): this {
    this.entry = id;
    return this;
  }

  private next(from: NodeId, state: S): NodeId | typeof END {
    const router = this.conditional.get(from);
    if (router) return router(state);
    return this.edges.get(from) ?? END;
  }

  async run(initial: S, opts: GraphRunOpts<S> = {}): Promise<GraphRunResult<S>> {
    const { onStep, maxSteps = 100, stopOnError = true } = opts;
    if (!this.entry) throw new Error("graph has no entry (addEdge(START, ...))");

    let state = { ...initial };
    const path: NodeId[] = [];
    const steps: StepTrace[] = [];
    let cursor: NodeId | typeof END = this.entry;
    let ok = true;

    for (let i = 0; i < maxSteps && cursor !== END; i++) {
      const fn = this.nodes.get(cursor);
      if (!fn) throw new Error(`no such node: ${cursor}`);
      path.push(cursor);

      const startedAt = performanceNow();
      let trace: StepTrace;
      try {
        const patch = await fn(state);
        state = { ...state, ...patch };
        trace = { node: cursor, ms: performanceNow() - startedAt, ok: true };
      } catch (e) {
        ok = false;
        trace = {
          node: cursor,
          ms: performanceNow() - startedAt,
          ok: false,
          err: e instanceof Error ? e.message : String(e),
        };
        steps.push(trace);
        if (onStep) await onStep(trace, state);
        if (stopOnError) break;
        // else fall through to routing off current (possibly unchanged) state
        cursor = this.next(cursor, state);
        continue;
      }

      steps.push(trace);
      if (onStep) await onStep(trace, state);
      cursor = this.next(cursor, state);
    }

    return { state, path, steps, ok };
  }
}

// performance.now() is available in the Next.js server runtime; guard for any
// environment lacking it. Avoids Date.now() (banned in workflow scripts and
// noisy for deterministic tests) while still giving relative timings.
function performanceNow(): number {
  try {
    return typeof performance !== "undefined" && performance.now
      ? performance.now()
      : 0;
  } catch {
    return 0;
  }
}
