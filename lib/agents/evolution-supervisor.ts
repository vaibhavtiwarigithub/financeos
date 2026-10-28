import { END, START, StateGraph } from "@/lib/agents/graph";

export type EvolutionPriority = "P0" | "P1" | "P2" | "P3";
export type EvolutionMarket = "us" | "india" | "shared";

export interface EvolutionQueueItem {
  key: string;
  priority: EvolutionPriority;
  market: EvolutionMarket;
  category: "safety" | "producer" | "validation" | "shadow";
  status: "blocked" | "failed" | "waiting" | "collecting";
  title: string;
  nextAction: string;
}

export interface EvolutionRunInput {
  agent_type: string;
  market?: string | null;
  status: string;
  started_at?: string | null;
}

export interface EvolutionAlertInput {
  issue_key?: string | null;
  severity?: string | null;
  category?: string | null;
  title?: string | null;
}

export interface EvolutionStrategyInput {
  id: number | string;
  market: string;
  state: string;
  version?: string | null;
  validation_experiment_id?: number | string | null;
}

export interface EvolutionAutomationInput {
  market: string;
  enabled: boolean;
  auto_shadow_enabled: boolean;
}

const EVOLUTION_STAGES = new Set([
  "research",
  "learner",
  "validation_sweep",
  "llm_council_evaluate",
  "dimension_diagnostics",
  "score_variants_evaluate",
  "label_maturation",
]);

export interface EvolutionSnapshot {
  version: "evolution-supervisor.v1";
  checkedAt: string;
  state: "reviewing" | "attention" | "degraded";
  queue: EvolutionQueueItem[];
  markets: Record<"us" | "india", {
    validationEnabled: boolean;
    autoShadowEnabled: boolean;
    awaitingValidation: number;
    activeShadows: number;
    latestRuns: Array<{ agent: string; status: string; startedAt: string | null }>;
  }>;
  graph: { path: string[]; steps: Array<{ node: string; ok: boolean; ms: number }> };
  readFailures: string[];
}

export function buildEvolutionQueue(input: {
  alerts: EvolutionAlertInput[];
  runs: EvolutionRunInput[];
  strategies: EvolutionStrategyInput[];
  automation: EvolutionAutomationInput[];
  markets: readonly ("us" | "india")[];
}): EvolutionQueueItem[] {
  const queue: EvolutionQueueItem[] = [];
  const seen = new Set<string>();
  const push = (item: EvolutionQueueItem) => {
    if (!seen.has(item.key)) {
      seen.add(item.key);
      queue.push(item);
    }
  };

  for (const alert of input.alerts) {
    const severity = String(alert.severity ?? "").toLowerCase();
    const key = String(alert.issue_key ?? "").trim();
    if (!key || !["critical", "error", "warn", "warning"].includes(severity)) continue;
    const category = String(alert.category ?? "").toLowerCase();
    const market = marketFromText(`${key} ${category}`);
    const critical = severity === "critical" || severity === "error";
    const safety = critical || /data|integrity|database|security|broker|execution/.test(category);
    push({
      key: `alert:${key}`,
      priority: safety ? "P0" : "P1",
      market,
      category: "safety",
      status: critical ? "blocked" : "waiting",
      title: cleanText(alert.title, "Open system alert"),
      nextAction: "Resolve the underlying alert condition and verify it with a fresh check.",
    });
  }

  // The newest run per agent/market is authoritative. An old failure followed
  // by a clean run is recovery history, not an active supervisor blocker.
  const latest = new Map<string, EvolutionRunInput>();
  for (const run of input.runs) {
    const market = normalizeMarket(run.market);
    const key = `${run.agent_type}:${market}`;
    const existing = latest.get(key);
    if (!existing || timestamp(run.started_at) > timestamp(existing.started_at)) latest.set(key, run);
  }

  for (const [key, run] of latest) {
    if (!isFailure(run.status)) continue;
    const [agent, marketRaw] = key.split(":");
    push({
      key: `run:${key}`,
      priority: isDataProducer(agent) ? "P0" : "P1",
      market: marketRaw === "us" || marketRaw === "india" ? marketRaw : "shared",
      category: "producer",
      status: "failed",
      title: `${humanize(agent)} latest run failed`,
      nextAction: "Inspect the recorded run error; allow one natural retry after the dependency is corrected.",
    });
  }

  const automationByMarket = new Map(input.automation.map((row) => [normalizeMarket(row.market), row]));
  for (const market of input.markets) {
    const policy = automationByMarket.get(market);
    const versions = input.strategies.filter((row) => normalizeMarket(row.market) === market);
    const waiting = versions.filter((row) =>
      row.state === "challenger" && row.validation_experiment_id == null,
    );
    const shadows = versions.filter((row) => row.state === "shadow_paper");

    if (waiting.length) {
      push({
        key: `validation:${market}`,
        priority: "P2",
        market,
        category: "validation",
        status: policy?.enabled ? "waiting" : "blocked",
        title: `${waiting.length} ${market.toUpperCase()} challenger${waiting.length === 1 ? "" : "s"} awaiting validation`,
        nextAction: policy?.enabled
          ? "The approved deterministic validation sweep owns this work; no paper-entry win-rate gate applies."
          : "Review the per-market validation setting; the supervisor will not enable it.",
      });
    }

    if (shadows.length) {
      push({
        key: `shadow:${market}`,
        priority: "P3",
        market,
        category: "shadow",
        status: "collecting",
        title: `${shadows.length} ${market.toUpperCase()} shadow challenger${shadows.length === 1 ? "" : "s"} collecting evidence`,
        nextAction: "Keep collecting matched forward evidence; do not promote from immature or negative results.",
      });
    }
  }

  const rank: Record<EvolutionPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return queue.sort((a, b) => rank[a.priority] - rank[b.priority]
    || a.market.localeCompare(b.market) || a.key.localeCompare(b.key)).slice(0, 40);
}

type GraphState = {
  alerts: EvolutionAlertInput[];
  runs: EvolutionRunInput[];
  strategies: EvolutionStrategyInput[];
  automation: EvolutionAutomationInput[];
  markets: readonly ("us" | "india")[];
  queue: EvolutionQueueItem[];
};

function createSupervisorGraph() {
  return new StateGraph<GraphState>()
    .addNode("safety_and_producers", (state) => ({
      queue: buildEvolutionQueue({
        alerts: state.alerts,
        runs: state.runs,
        strategies: [],
        automation: [],
        markets: state.markets,
      }),
    }))
    .addNode("approved_challengers_and_shadows", (state) => ({
      queue: [...state.queue, ...buildEvolutionQueue({
        alerts: [], runs: [], strategies: state.strategies,
        automation: state.automation, markets: state.markets,
      })],
    }))
    .addNode("deduplicate_and_prioritize", (state) => {
      const unique = new Map<string, EvolutionQueueItem>();
      for (const item of state.queue) if (!unique.has(item.key)) unique.set(item.key, item);
      const sorted = [...unique.values()].sort((a, b) => {
        const order: Record<EvolutionPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
        return order[a.priority] - order[b.priority] || a.market.localeCompare(b.market) || a.key.localeCompare(b.key);
      });
      return { queue: sorted.slice(0, 40) };
    })
    .addEdge(START, "safety_and_producers")
    .addEdge("safety_and_producers", "approved_challengers_and_shadows")
    .addEdge("approved_challengers_and_shadows", "deduplicate_and_prioritize")
    .addEdge("deduplicate_and_prioritize", END);
}

/** Read-only lifecycle supervision; only its compact operational snapshot is written. */
export async function runEvolutionSupervisor(supabase: any, now = new Date()): Promise<EvolutionSnapshot> {
  const checkedAt = now.toISOString();
  const cutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
  const [alertsRes, runsRes, strategiesRes, automationRes] = await Promise.all([
    supabase.from("agent_alerts").select("issue_key,severity,category,title")
      .eq("resolved", false).in("severity", ["critical", "warn"]).order("created_at", { ascending: false }).limit(100),
    supabase.from("agent_runs").select("agent_type,market,status,started_at")
      .gte("started_at", cutoff).order("started_at", { ascending: false }).limit(300),
    supabase.from("strategy_versions").select("id,market,state,version,validation_experiment_id")
      .in("state", ["challenger", "shadow_paper"]).order("created_at", { ascending: false }).limit(100),
    supabase.from("strategy_validation_automation").select("market,enabled,auto_shadow_enabled")
      .in("market", ["us", "india"]),
  ]);

  const readFailures = [
    alertsRes.error && "open_health_alerts",
    runsRes.error && "recent_agent_runs",
    strategiesRes.error && "challenger_lifecycle",
    automationRes.error && "validation_policy",
  ].filter((value): value is string => Boolean(value));
  const graph = await createSupervisorGraph().run({
    alerts: alertsRes.data ?? [],
    runs: runsRes.data ?? [],
    strategies: strategiesRes.data ?? [],
    automation: automationRes.data ?? [],
    markets: ["us", "india"],
    queue: [],
  }, { maxSteps: 4 });

  const latestRuns = new Map<string, EvolutionRunInput>();
  for (const run of runsRes.data ?? []) {
    const market = normalizeMarket(run.market);
    const key = `${run.agent_type}:${market}`;
    if (!latestRuns.has(key)) latestRuns.set(key, run);
  }
  const strategies = (strategiesRes.data ?? []) as EvolutionStrategyInput[];
  const automation = (automationRes.data ?? []) as EvolutionAutomationInput[];
  const automationByMarket = new Map(automation.map((row) => [normalizeMarket(row.market), row]));
  const markets = {
    us: marketSummary("us", strategies, automationByMarket, latestRuns),
    india: marketSummary("india", strategies, automationByMarket, latestRuns),
  };

  const queue = [...graph.state.queue];
  if (readFailures.length) {
    queue.unshift({
      key: "supervisor:read_failure",
      priority: "P0",
      market: "shared",
      category: "safety",
      status: "failed",
      title: "Evolution supervisor could not verify all inputs",
      nextAction: "Restore the failed read source and confirm a later supervisor cycle succeeds.",
    });
  }

  return {
    version: "evolution-supervisor.v1",
    checkedAt,
    state: readFailures.length ? "degraded" : queue.some((item) => item.priority === "P0" || item.priority === "P1") ? "attention" : "reviewing",
    queue: queue.slice(0, 40),
    markets,
    graph: {
      path: graph.path,
      steps: graph.steps.map((step) => ({ node: step.node, ok: step.ok, ms: Math.round(step.ms) })),
    },
    readFailures,
  };
}

export async function persistEvolutionSupervisor(
  supabase: any,
  snapshot: EvolutionSnapshot,
  triggerSource: "scheduled" | "manual" = "scheduled",
): Promise<boolean> {
  const summary = snapshot.state === "degraded"
    ? `Evolution supervisor degraded; ${snapshot.readFailures.length} input read(s) unavailable`
    : `Evolution supervisor ${snapshot.state}; ${snapshot.queue.length} prioritized item(s); US ${snapshot.markets.us.awaitingValidation} challenger(s) waiting, India ${snapshot.markets.india.awaitingValidation} waiting`;
  const { error } = await supabase.from("agent_runs").insert({
    agent_type: "evolution_supervisor",
    market: null,
    status: snapshot.state === "degraded" ? "error" : "done",
    trigger_source: triggerSource,
    symbols: [],
    signals_written: 0,
    tokens_input: 0,
    tokens_output: 0,
    result_summary: summary.slice(0, 500),
    workload_metrics: { supervisor: snapshot },
    started_at: snapshot.checkedAt,
    completed_at: new Date().toISOString(),
  });
  return !error;
}

function marketSummary(
  market: "us" | "india",
  strategies: EvolutionStrategyInput[],
  automation: Map<string, EvolutionAutomationInput>,
  runs: Map<string, EvolutionRunInput>,
) {
  const rows = strategies.filter((row) => normalizeMarket(row.market) === market);
  const policy = automation.get(market);
  const relevantRuns = [...runs.entries()]
    .filter(([key]) => (key.endsWith(`:${market}`) || key.endsWith(":shared"))
      && EVOLUTION_STAGES.has(key.slice(0, key.lastIndexOf(":"))))
    .map(([key, run]) => ({
      agent: key.slice(0, key.lastIndexOf(":")),
      status: String(run.status),
      startedAt: run.started_at ?? null,
    }))
    .sort((a, b) => a.agent.localeCompare(b.agent));
  return {
    validationEnabled: policy?.enabled === true,
    autoShadowEnabled: policy?.auto_shadow_enabled === true,
    awaitingValidation: rows.filter((row) => normalizeMarket(row.market) === market
      && row.state === "challenger" && row.validation_experiment_id == null).length,
    activeShadows: rows.filter((row) => normalizeMarket(row.market) === market && row.state === "shadow_paper").length,
    latestRuns: relevantRuns,
  };
}

function marketFromText(value: string): EvolutionMarket {
  const text = value.toLowerCase();
  if (/(^|[^a-z])india([^a-z]|$)|\.ns\b|\.bo\b/.test(text)) return "india";
  if (/(^|[^a-z])us([^a-z]|$)|robinhood|alpaca/.test(text)) return "us";
  return "shared";
}

function normalizeMarket(value: unknown): "us" | "india" | "shared" {
  return value === "us" || value === "india" ? value : "shared";
}

function isFailure(value: unknown): boolean {
  return ["error", "failed", "failure", "timeout"].includes(String(value ?? "").toLowerCase());
}

function isDataProducer(agent: string): boolean {
  return /research|price|label|benchmark|macro|corporate|quote|candle/i.test(agent);
}

function cleanText(value: unknown, fallback: string): string {
  const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 160);
  return text || fallback;
}

function timestamp(value: unknown): number {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
