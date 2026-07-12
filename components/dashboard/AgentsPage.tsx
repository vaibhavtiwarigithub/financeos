"use client";
import { useState, lazy, Suspense, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import AgentComparisonCard from "@/components/dashboard/AgentComparisonCard";
import PageHeader from "@/components/dashboard/PageHeader";
import AgentDiagram from "@/components/dashboard/AgentDiagram";
import InfoTooltip from "@/components/dashboard/InfoTooltip";
import ModelFreshnessCard from "@/components/dashboard/ModelFreshnessCard";
const SignalCharts = lazy(() => import("@/components/charts/SignalChartsWrapper"));
const StockModal = lazy(() => import("@/components/charts/StockModal"));
const MermaidChart = lazy(() => import("@/components/dashboard/MermaidChart"));

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24",
  greenBg: "#052E16", redBg: "#3B0000", amberBg: "#2D1B00",
};


const AGENTS = [
  { id: "research",     label: "ResearchAgent",  icon: "🔍", desc: "Analyzes stocks, writes signals",          apiPath: "/api/agents/research" },
  { id: "paper-trade",  label: "PaperTrader",    icon: "📄", desc: "Shadow-trades signals on $10k virtual",    apiPath: "/api/agents/paper-trade" },
  { id: "trader",       label: "TraderAgent",    icon: "⚡", desc: "Proposes real trades for approval",        apiPath: "/api/agents/trader" },
  { id: "learner",      label: "LearnerAgent",   icon: "🧠", desc: "Evaluates outcomes; proposes governed challengers", apiPath: "/api/agents/learner" },
  { id: "theme-scout",  label: "ThemeScout",     icon: "🎯", desc: "Finds AI/thematic watchlist candidates",   apiPath: "/api/agents/theme-scout" },
  { id: "deepseek",     label: "DeepSeek Research", icon: "🤖", desc: "Runs parallel research via DeepSeek LLM", apiPath: "/api/agents/deepseek-research" },
];

function pnlColor(n: number) { return n >= 0 ? T.green : T.red; }
function fmt(n: number, cur = "$") { return (n >= 0 ? "+" : "-") + cur + Math.abs(n).toFixed(2); }
function fmtPct(n: number) { return (n >= 0 ? "+" : "") + n.toFixed(2) + "%"; }

function dirBadge(d: string) {
  const up = d === "long" || d === "buy";
  return <span style={{ fontSize: "11px", fontWeight: 600, padding: "2px 8px", borderRadius: "4px", background: up ? T.greenBg : T.redBg, color: up ? T.green : T.red }}>{d.toUpperCase()}</span>;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function AgentsPage({ signals, weights, strategy, learningLog, paperPortfolio, paperPositions, paperTrades, paperPerf, agentRuns, market = "us" }: {
  signals: any[]; weights: any; strategy: any; learningLog: any[];
  paperPortfolio: any; paperPositions: any[]; paperTrades: any[]; paperPerf: any[];
  agentRuns?: Record<string, any[]>;
  market?: "us" | "india";
}) {
  const currency = market === "india" ? "₹" : "$";
  const supabase = createClient();
  const router = useRouter();
  const [tradingEnabled, setTradingEnabled] = useState(strategy?.trading_enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<string | null>(null);
  const [chartSymbol, setChartSymbol] = useState<string | null>(null);
  const [tab, setTab] = useState<"signals" | "paper" | "weights" | "log" | "architecture" | "backtest" | "brain" | "llm-config" | "learner-ctrl" | "weight-history" | "experiments" | "proposals">("paper");
  const [minScore, setMinScore] = useState<number>(strategy?.min_analyst_score ?? 70);
  const [maxPos, setMaxPos] = useState<number>(strategy?.max_position_pct ?? 5);
  const [maxTrades, setMaxTrades] = useState<number>(strategy?.max_daily_trades ?? 3);
  const [configSaving, setConfigSaving] = useState(false);
  const [configToast, setConfigToast] = useState("");
  const [expandedRuns, setExpandedRuns] = useState<string | null>(null);
  const [selectedDiagramAgent, setSelectedDiagramAgent] = useState("system-map");
  const [learnerRuns, setLearnerRuns] = useState<any[]>([]);
  const [learnerRunIdx, setLearnerRunIdx] = useState(0);
  const [agentConfigs, setAgentConfigs] = useState<any[]>([]);
  const [configUpdating, setConfigUpdating] = useState<string | null>(null);
  const [configUpdateToast, setConfigUpdateToast] = useState("");
  const [learnerConfig, setLearnerConfig] = useState<any[]>([]);
  const [weightHistory, setWeightHistory] = useState<any[]>([]);
  const [learnerCtrlSaving, setLearnerCtrlSaving] = useState<string | null>(null);
  const [learnerCtrlToast, setLearnerCtrlToast] = useState("");
  const [strategyVersions, setStrategyVersions] = useState<any[]>([]);
  const [proposals, setProposals] = useState<any[]>([]);
  const [backtestRunning, setBacktestRunning] = useState(false);
  const [validatingId, setValidatingId] = useState<number | null>(null);
  const [backtestResult, setBacktestResult] = useState<any | null>(null);
  const [proposalToast, setProposalToast] = useState("");
  // Settings-LLM Part 2 — provider API keys (masked status; keys never returned).
  const [providerKeys, setProviderKeys] = useState<{ provider: string; label: string; source: string; last4: string | null }[]>([]);
  const [pkInputs, setPkInputs] = useState<Record<string, string>>({});
  const [pkSaving, setPkSaving] = useState<string | null>(null);
  const [pkToast, setPkToast] = useState("");

  useEffect(() => {
    fetch("/api/agents/learner-brain").then(r => r.json()).then(d => { if (d.runs) setLearnerRuns(d.runs); }).catch(() => {});
    fetch("/api/agents/agent-config").then(r => r.json()).then(d => { if (d.configs) setAgentConfigs(d.configs); }).catch(() => {});
    fetch("/api/agents/provider-keys").then(r => r.json()).then(d => { if (d.providers) setProviderKeys(d.providers); }).catch(() => {});
    fetch("/api/agents/learner-controls").then(r => r.json()).then(d => {
      if (d.config) setLearnerConfig(d.config);
      if (d.history) setWeightHistory(d.history);
    }).catch(() => {});
    fetch("/api/strategies/versions").then(r => r.json()).then(d => { if (d.versions) setStrategyVersions(d.versions); }).catch(() => {});
    fetch("/api/agents/trader").then(r => r.json()).then(d => { if (d.proposals) setProposals(d.proposals); }).catch(() => {});
  }, []);

  async function updateLearnerConfig(dimension: string, field: string, value: unknown) {
    setLearnerCtrlSaving(dimension + "." + field);
    try {
      const r = await fetch("/api/agents/learner-controls", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dimension, [field]: value }) });
      if (r.ok) {
        setLearnerConfig(prev => prev.map(c => c.dimension === dimension ? { ...c, [field]: value } : c));
        setLearnerCtrlToast("Saved!");
        setTimeout(() => setLearnerCtrlToast(""), 2000);
      }
    } catch {}
    setLearnerCtrlSaving(null);
  }

  async function rollbackWeights(historyId: number) {
    if (!confirm("Roll back signal weights to this snapshot?")) return;
    try {
      const r = await fetch("/api/agents/learner-controls", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "rollback", history_id: historyId }) });
      const d = await r.json();
      if (d.success) { setLearnerCtrlToast("Weights rolled back!"); setTimeout(() => setLearnerCtrlToast(""), 3000); router.refresh(); }
      else setLearnerCtrlToast("Error: " + d.error);
    } catch {}
  }

  async function factoryResetWeights() {
    if (!confirm("Reset ALL signal weights to equal 0.20 each? This cannot be undone (old values will be saved to history).")) return;
    try {
      const r = await fetch("/api/agents/learner-controls", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "factory_reset" }) });
      const d = await r.json();
      if (d.success) { setLearnerCtrlToast("Factory reset done!"); setTimeout(() => setLearnerCtrlToast(""), 3000); router.refresh(); }
      else setLearnerCtrlToast("Error: " + d.error);
    } catch {}
  }

  async function updateAgentConfig(agent_name: string, field: string, value: unknown) {
    setConfigUpdating(agent_name);
    try {
      await fetch("/api/agents/agent-config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent_name, [field]: value }) });
      setAgentConfigs(prev => prev.map(c => c.agent_name === agent_name ? { ...c, [field]: value } : c));
      setConfigUpdateToast("Saved!");
      setTimeout(() => setConfigUpdateToast(""), 2000);
    } catch {}
    setConfigUpdating(null);
  }

  // Provider API keys — write-only. Save stores in the vault; the raw key is
  // never read back (only masked status is returned).
  async function saveProviderKey(provider: string) {
    const key = (pkInputs[provider] ?? "").trim();
    if (key.length < 8) { setPkToast("Key looks too short"); setTimeout(() => setPkToast(""), 2500); return; }
    setPkSaving(provider);
    try {
      const r = await fetch("/api/agents/provider-keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, key }) });
      const d = await r.json();
      if (r.ok && d.providers) { setProviderKeys(d.providers); setPkInputs(prev => ({ ...prev, [provider]: "" })); setPkToast("Key saved"); }
      else setPkToast(d.error ?? "Save failed");
    } catch { setPkToast("Save failed"); }
    setPkSaving(null);
    setTimeout(() => setPkToast(""), 2500);
  }
  async function clearProviderKey(provider: string) {
    if (!confirm(`Remove the ${provider} key from Settings and revert to the deployment's env var?`)) return;
    setPkSaving(provider);
    try {
      const r = await fetch(`/api/agents/provider-keys?provider=${encodeURIComponent(provider)}`, { method: "DELETE" });
      const d = await r.json();
      if (r.ok && d.providers) { setProviderKeys(d.providers); setPkToast("Reverted to env"); }
      else setPkToast(d.error ?? "Clear failed");
    } catch { setPkToast("Clear failed"); }
    setPkSaving(null);
    setTimeout(() => setPkToast(""), 2500);
  }

  async function saveStrategyConfig() {
    if (!strategy?.id) return;
    setConfigSaving(true);
    await supabase.from("strategy_config").update({
      min_analyst_score: minScore,
      max_position_pct: maxPos,
      max_daily_trades: maxTrades,
    } as any).eq("id", strategy.id);
    setConfigSaving(false);
    setConfigToast("Saved!");
    setTimeout(() => setConfigToast(""), 2000);
    router.refresh();
  }

  async function toggleTrading() {
    setSaving(true);
    const next = !tradingEnabled;
    await supabase.from("strategy_config").update({ trading_enabled: next }).eq("id", strategy?.id);
    setTradingEnabled(next);
    setSaving(false);
  }

  async function runAgent(id: string, apiPath: string | null) {
    if (!apiPath) { setRunResult("Not yet implemented."); return; }
    setRunning(id);
    setRunResult(null);

    if (id === "research") {
      // SSE streaming: show per-symbol progress live
      try {
        const res = await fetch(apiPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!res.ok || !res.body) {
          setRunResult(`Error: HTTP ${res.status}`);
          setRunning(null);
          return;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        const lines: string[] = [];
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const chunk of parts) {
            for (const line of chunk.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                const evt = JSON.parse(line.slice(6));
                if (evt.type === "symbols") lines.push(`Batch: ${evt.symbols?.join(", ")} (${evt.symbols?.length} symbols)`);
                else if (evt.type === "progress") { const tag = evt.isHeld ? "[HELD]" : evt.isEtf ? "[ETF]" : "[SCAN]"; lines.push(`${tag} Analyzing ${evt.symbol}...`); }
                else if (evt.type === "result") lines.push(`✓ ${evt.symbol}: ${evt.direction?.toUpperCase()} score=${evt.analystScore} (${evt.source})`);
                else if (evt.type === "error") lines.push(`✗ ${evt.symbol}: ${evt.error?.slice(0, 80)}`);
                else if (evt.type === "done") { lines.push(`Done — ${evt.processed} symbol(s).`); router.refresh(); }
                setRunResult(lines.join("\n"));
              } catch {}
            }
          }
        }
      } catch (e: any) {
        setRunResult("Error: " + e.message);
      }
      setRunning(null);
      return;
    }

    // All other agents: normal JSON POST
    try {
      const res = await fetch(apiPath, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const data = await res.json();
      if (data.error) {
        setRunResult(`Error: ${data.error}${data.detail ? "\n" + data.detail : ""}`);
      } else if (data.skipped) {
        setRunResult("Skipped: " + data.reason);
      } else {
        const count = data.processed ?? data.filled ?? data.closed ?? data.queued ?? 0;
        const errs = (data.results ?? []).filter((r: any) => r.error);
        const errDetail = errs.length ? `\n${errs.map((r: any) => `${r.symbol}: ${r.error}`).join("\n")}` : "";
        setRunResult(`Done — ${count} result(s).${errDetail}`);
        router.refresh();
      }
    } catch (e: any) {
      setRunResult("Error: " + e.message);
    }
    setRunning(null);
  }

  // Paper stats
  const startingNAV = 10000;
  const currentNAV = paperPortfolio?.nav ?? startingNAV;
  const totalPnl = currentNAV - startingNAV;
  const totalPnlPct = (totalPnl / startingNAV) * 100;
  const closedTrades = paperTrades.filter(t => t.closed_at);
  const wins = closedTrades.filter(t => t.outcome === "win").length;
  const losses = closedTrades.filter(t => t.outcome === "loss").length;
  const winRate = closedTrades.length ? Math.round((wins / closedTrades.length) * 100) : 0;
  const pendingSignals = signals.filter(s => s.status === "pending").length;

  return (
    <div style={{ color: T.text, fontFamily: "'Inter', sans-serif" }}>

      <PageHeader
        title="AI Agents"
        subtitle="Agent control center · research, trade, learn"
        cadence="daily"
        whatItDoes="Command center for all agents — ResearchAgent records evidence, PaperTrader tests eligible signals, and LearnerAgent evaluates outcomes and proposes governed challengers. Shows run health, paper portfolio, and the approval queue."
        whatToLookFor={[
          "ResearchAgent runs daily at 9 AM — scores your watchlist. Check Intelligence for results.",
          "PaperTrader requires an entry-eligible LONG decision and the configured evidence gates; score alone never authorizes a trade.",
          "Kill Switch disables live trading immediately — use if agent behavior looks wrong.",
          "Trade queue shows pending orders waiting for next PaperTrader cycle.",
        ]}
        actions={[{ label: saving ? "…" : tradingEnabled ? "⚡ Kill Switch" : "🔴 Enable Trading", onClick: toggleTrading }]}
      />
      <div style={{ padding: "0 clamp(12px, 4vw, 28px) 32px" }}>

      <ModelFreshnessCard />

      {/* Paper portfolio hero */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "16px", padding: "clamp(16px,4vw,24px)", marginBottom: "20px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "24px" }}>
        <div>
          <div style={{ fontSize: "11px", color: T.muted, marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Paper NAV</div>
          <div style={{ fontSize: "24px", fontWeight: 700 }}>{currency}{currentNAV.toFixed(0)}</div>
          <div style={{ fontSize: "12px", color: T.muted }}>started $10,000</div>
        </div>
        <div>
          <div style={{ fontSize: "11px", color: T.muted, marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Total P&L</div>
          <div style={{ fontSize: "24px", fontWeight: 700, color: pnlColor(totalPnl) }}>{fmt(totalPnl, currency)}</div>
          <div style={{ fontSize: "12px", color: pnlColor(totalPnlPct) }}>{fmtPct(totalPnlPct)}</div>
        </div>
        <div>
          <div style={{ fontSize: "11px", color: T.muted, marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Cash</div>
          <div style={{ fontSize: "24px", fontWeight: 700 }}>{currency}{(paperPortfolio?.cash_balance ?? 10000).toFixed(0)}</div>
          <div style={{ fontSize: "12px", color: T.muted }}>{paperPositions.length} position{paperPositions.length !== 1 ? "s" : ""}</div>
        </div>
        <div>
          <div style={{ fontSize: "11px", color: T.muted, marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Win Rate</div>
          <div style={{ fontSize: "24px", fontWeight: 700, color: winRate >= 60 ? T.green : winRate >= 40 ? T.amber : T.red }}>{closedTrades.length ? winRate + "%" : "—"}</div>
          <div style={{ fontSize: "12px", color: T.muted }}>{wins}W / {losses}L of {closedTrades.length}</div>
        </div>
        <div>
          <div style={{ fontSize: "11px", color: T.muted, marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Pending Signals</div>
          <div style={{ fontSize: "24px", fontWeight: 700, color: pendingSignals > 0 ? T.amber : T.muted }}>{pendingSignals}</div>
          <div style={{ fontSize: "12px", color: T.muted }}>awaiting agents</div>
        </div>
      </div>

      {/* Agent runner cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "12px", marginBottom: "20px" }}>
        {AGENTS.map(a => {
          const runKey = a.id === "paper-trade" ? "paper_trader" : a.id;
          const runs = agentRuns?.[runKey] ?? [];
          const lastRun = runs[0];
          const isExpanded = expandedRuns === a.id;
          return (
            <div key={a.id} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "16px" }}>
              <div style={{ fontSize: "20px", marginBottom: "6px" }}>{a.icon}</div>
              <div style={{ fontWeight: 600, fontSize: "13px", marginBottom: "3px" }}>{a.label}</div>
              <div style={{ fontSize: "11px", color: T.muted, marginBottom: "10px" }}>{a.desc}</div>
              <button
                onClick={() => runAgent(a.id, a.apiPath)}
                disabled={!!running}
                style={{ width: "100%", padding: "7px", background: running === a.id ? T.border : T.accent + "18", border: `1px solid ${T.accent}35`, borderRadius: "7px", color: running === a.id ? T.muted : T.accent, fontSize: "12px", fontWeight: 600, cursor: running ? "default" : "pointer" }}
              >
                {running === a.id ? "Running..." : "▶ Run"}
              </button>
              {/* Run history */}
              <div style={{ marginTop: "10px", borderTop: `1px solid ${T.border}`, paddingTop: "8px" }}>
                {lastRun ? (
                  <>
                    <div
                      onClick={() => setExpandedRuns(isExpanded ? null : a.id)}
                      style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", fontSize: "11px", color: T.textSub }}
                    >
                      <span>
                        <span style={{ color: lastRun.status === "error" ? T.red : T.green }}>●</span>
                        {" "}{timeAgo(lastRun.started_at)}
                        {lastRun.symbols?.length ? ` — ${lastRun.symbols.slice(0,3).join(", ")}${lastRun.symbols.length > 3 ? ` +${lastRun.symbols.length - 3}` : ""}` : ""}
                      </span>
                      <span style={{ color: T.muted }}>{isExpanded ? "▲" : "▼"}</span>
                    </div>
                    {isExpanded && (
                      <div style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "6px" }}>
                        {runs.map((r: any) => (
                          <div key={r.id} style={{ fontSize: "10px", color: T.muted, background: T.surface, borderRadius: "6px", padding: "6px 8px" }}>
                            <div style={{ display: "flex", justifyContent: "space-between" }}>
                              <span style={{ color: r.status === "error" ? T.red : r.status === "running" ? T.amber : T.green, fontWeight: 600 }}>{r.status.toUpperCase()}</span>
                              <span>{timeAgo(r.started_at)}</span>
                            </div>
                            {r.symbols?.length > 0 && <div style={{ marginTop: "2px", color: T.textSub }}>{r.symbols.join(", ")}</div>}
                            {r.result_summary && <div style={{ marginTop: "2px" }}>{r.result_summary}</div>}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ fontSize: "11px", color: T.muted }}>Never run</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Run result */}
      {runResult && (
        <div style={{ marginBottom: "16px", background: T.surface, border: `1px solid ${runResult.startsWith("Error") ? T.red : T.green}40`, borderRadius: "8px", padding: "10px 14px", fontSize: "12px", color: runResult.startsWith("Error") ? T.red : T.green, whiteSpace: "pre-wrap", fontFamily: "monospace", maxHeight: "120px", overflowY: "auto" }}>
          {runResult}
        </div>
      )}

      {/* Agent A/B Comparison */}
      <div style={{ marginBottom: "20px" }}>
        <AgentComparisonCard />
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: "4px", marginBottom: "16px", background: T.surface, padding: "4px", borderRadius: "10px", width: "fit-content", maxWidth: "100%", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
        {([
          { key: "paper", label: "Paper Trades" },
          { key: "signals", label: `Signals (${signals.length})` },
          { key: "weights", label: "Weights" },
          { key: "log", label: "Learning Log" },
          { key: "backtest", label: "Backtest" },
          { key: "architecture", label: "Architecture" },
          { key: "brain", label: "🧠 Learner Brain" },
          { key: "llm-config", label: "⚙ LLM Config" },
          { key: "learner-ctrl", label: "🎛 Learner Controls" },
          { key: "weight-history", label: "📜 Weight History" },
          { key: "experiments", label: "🔬 Experiments" },
          { key: "proposals", label: "⚡ Proposals" },
        ] as const).map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ padding: "7px 16px", borderRadius: "7px", border: "none", cursor: "pointer", fontSize: "12px", fontWeight: 500, background: tab === t.key ? T.card : "transparent", color: tab === t.key ? T.text : T.muted }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Paper trades tab */}
      {tab === "paper" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

          {/* Open positions */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
            <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "14px" }}>Open Positions</div>
            {paperPositions.length === 0 ? (
              <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "20px 0" }}>No open positions. Run PaperTrader to start shadow trading.</div>
            ) : (
              <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                <thead>
                  <tr style={{ color: T.muted }}>
                    {["Symbol", "Qty", "Avg Cost", "Current", "P&L", "P&L %"].map(h => (
                      <th key={h} style={{ padding: "5px 12px 8px 0", fontWeight: 500, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {paperPositions.map(p => {
                    const pnl = (p.current_price - p.avg_cost) * p.qty;
                    const pnlPct = ((p.current_price - p.avg_cost) / p.avg_cost) * 100;
                    return (
                      <tr key={p.id} style={{ borderTop: `1px solid ${T.border}` }}>
                        <td style={{ padding: "9px 12px 9px 0", fontWeight: 700 }}>{p.symbol}</td>
                        <td style={{ padding: "9px 12px 9px 0" }}>{p.qty}</td>
                        <td style={{ padding: "9px 12px 9px 0" }}>{currency}{p.avg_cost.toFixed(2)}</td>
                        <td style={{ padding: "9px 12px 9px 0" }}>{p.current_price ? currency + p.current_price.toFixed(2) : "—"}</td>
                        <td style={{ padding: "9px 12px 9px 0", fontWeight: 600, color: pnlColor(pnl) }}>{fmt(pnl, currency)}</td>
                        <td style={{ padding: "9px 0", color: pnlColor(pnlPct) }}>{fmtPct(pnlPct)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            )}
          </div>


          {/* Closed trades */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
            <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "14px" }}>Trade History</div>
            {paperTrades.length === 0 ? (
              <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "20px 0" }}>No paper trades yet.</div>
            ) : (
              <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                <thead>
                  <tr style={{ color: T.muted }}>
                    {["Symbol", "Side", "Qty", "Entry", "Exit", "P&L", "Outcome", "Date"].map(h => (
                      <th key={h} style={{ padding: "5px 12px 8px 0", fontWeight: 500, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {paperTrades.map(t => (
                    <tr key={t.id} style={{ borderTop: `1px solid ${T.border}` }}>
                      <td style={{ padding: "9px 12px 9px 0", fontWeight: 700 }}>{t.symbol}</td>
                      <td style={{ padding: "9px 12px 9px 0" }}>{dirBadge(t.order_side)}</td>
                      <td style={{ padding: "9px 12px 9px 0" }}>{t.qty}</td>
                      <td style={{ padding: "9px 12px 9px 0" }}>{currency}{t.fill_price?.toFixed(2)}</td>
                      <td style={{ padding: "9px 12px 9px 0" }}>{t.exit_price ? currency + t.exit_price.toFixed(2) : <span style={{ color: T.amber }}>Open</span>}</td>
                      <td style={{ padding: "9px 12px 9px 0", fontWeight: 600, color: t.realized_pnl != null ? pnlColor(t.realized_pnl) : T.muted }}>
                        {t.realized_pnl != null ? fmt(t.realized_pnl, currency) : "—"}
                      </td>
                      <td style={{ padding: "9px 12px 9px 0" }}>
                        {t.outcome ? (
                          <span style={{ fontSize: "11px", fontWeight: 600, padding: "2px 8px", borderRadius: "4px", background: t.outcome === "win" ? T.greenBg : t.outcome === "loss" ? T.redBg : T.amberBg, color: t.outcome === "win" ? T.green : t.outcome === "loss" ? T.red : T.amber }}>
                            {t.outcome}
                          </span>
                        ) : <span style={{ color: T.amber, fontSize: "11px" }}>open</span>}
                      </td>
                      <td style={{ padding: "9px 0", color: T.muted, fontSize: "11px" }}>{new Date(t.executed_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Signals tab */}
      {tab === "signals" && (
        <>
          {signals.length > 0 && (
            <Suspense fallback={null}>
              <SignalCharts signals={signals} />
            </Suspense>
          )}
        {/* Screener parameters transparency card */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
            <span style={{ fontWeight: 600, fontSize: "13px" }}>Screener Parameters</span>
            <span style={{ fontSize: "10px", color: T.muted, background: T.surface, padding: "2px 7px", borderRadius: "4px" }}>Auto-runs before each research cycle</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px,1fr))", gap: "16px" }}>
            <div>
              <div style={{ fontSize: "9px", fontWeight: 700, color: T.amber, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "6px" }}>Momentum Bucket (pass 1)</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                {[
                  ["Revenue growth", "> 15% YoY"],
                  ["Earnings growth", "> 10% YoY"],
                  ["RSI (checked per symbol)", "> 60 momentum"],
                  ["Price vs 50-day MA", "Price > MA (uptrend)"],
                  ["Market cap", "> $2B"],
                  ["Max candidates", "3 symbols added"],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: "11px" }}>
                    <span style={{ color: T.muted }}>{k}</span>
                    <span style={{ color: T.text, fontFamily: "monospace", fontSize: "10px" }}>{v}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontSize: "9px", fontWeight: 700, color: T.accent, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "6px" }}>Value Bucket (pass 2)</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                {[
                  ["P/E ratio", "0 < PE < 18"],
                  ["Market cap", "> $2B"],
                  ["FCF yield (checked)", "High FCF preference"],
                  ["Insider buying (checked)", "AV Form 4 + EDGAR"],
                  ["Total symbol cap", "10 per cycle (+4 metals)"],
                  ["Always included", "GLD, SLV, GDX, IAU"],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: "11px" }}>
                    <span style={{ color: T.muted }}>{k}</span>
                    <span style={{ color: T.text, fontFamily: "monospace", fontSize: "10px" }}>{v}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div style={{ marginTop: "10px", fontSize: "10px", color: T.muted, borderTop: `1px solid ${T.border}`, paddingTop: "8px" }}>
            Symbol sources in priority order: (1) Robinhood holdings → SELL signals allowed · (2) Active watchlist · (3) Screener candidates (long-only) · (4) Metals basket (always)
          </div>
        </div>

        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
          <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "14px" }}>
            Signals ({signals.length})
          </div>
          {signals.length === 0 ? (
            <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "30px 0" }}>No signals yet. Run ResearchAgent first.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>
              {signals.map(s => (
                <div key={s.id} style={{ borderTop: `1px solid ${T.border}`, padding: "12px 0" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: "10px", marginBottom: "6px" }}>
                    <span style={{ fontWeight: 700, fontSize: "14px", cursor: "pointer", color: T.accent, minWidth: "52px" }} onClick={() => setChartSymbol(s.symbol)}>{s.symbol} ↗</span>
                    {dirBadge(s.direction)}
                    <span style={{ fontWeight: 600, fontSize: "13px", color: (s.analyst_score ?? 0) >= 75 ? T.green : (s.analyst_score ?? 0) >= 50 ? T.amber : T.red, display: "inline-flex", alignItems: "center", gap: "4px" }}>
                      Score: {s.analyst_score ?? "—"}
                      <InfoTooltip title="Analyst Score" body="Composite 0–100 from 5 weighted dimensions. Threshold for proposal generation is set in Settings → Strategy." bullets={["≥ 75: strong buy candidate", "50–74: moderate — review thesis before approving", "< 50: no proposal generated"]} placement="right" />
                    </span>
                    <span style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "4px", background: s.status === "paper_traded" ? T.greenBg : s.status === "pending" ? T.amberBg : T.border, color: s.status === "paper_traded" ? T.green : s.status === "pending" ? T.amber : T.muted }}>
                      {s.status}
                    </span>
                    <span style={{ marginLeft: "auto", color: T.muted, fontSize: "11px", whiteSpace: "nowrap" }}>
                      {s.created_at ? new Date(s.created_at).toLocaleDateString() : "—"}
                    </span>
                  </div>
                  {s.rationale && (
                    <div style={{ fontSize: "12px", color: T.textSub, lineHeight: "1.6", paddingLeft: "62px" }}>
                      {s.rationale}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        {chartSymbol && (
          <Suspense fallback={null}>
            <StockModal symbol={chartSymbol} onClose={() => setChartSymbol(null)} />
          </Suspense>
        )}
        </>
      )}

      {/* Weights tab */}
      {tab === "weights" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px,1fr))", gap: "16px" }}>
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
            <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "16px" }}>Signal Weights</div>
            {weights ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {[
                  { label: "Fundamental", key: "fundamental_weight" },
                  { label: "Technical", key: "technical_weight" },
                  { label: "Sentiment", key: "sentiment_weight" },
                  { label: "Macro", key: "macro_weight" },
                  { label: "Insider", key: "insider_weight" },
                ].map(w => {
                  const val = Math.round((weights[w.key] ?? 0) * 100);
                  return (
                    <div key={w.key}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
                        <span style={{ fontSize: "13px", color: T.textSub }}>{w.label}</span>
                        <span style={{ fontSize: "13px", fontWeight: 600, color: T.accent }}>{val}%</span>
                      </div>
                      <div style={{ height: "4px", background: T.border, borderRadius: "2px" }}>
                        <div style={{ height: "4px", borderRadius: "2px", background: T.accent, width: `${val}%`, transition: "width 0.3s" }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : <div style={{ color: T.muted, fontSize: "13px" }}>No weights yet.</div>}
          </div>

          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <div style={{ fontWeight: 600, fontSize: "14px" }}>Strategy Config</div>
              {configToast && <span style={{ fontSize: "12px", color: T.green }}>{configToast}</span>}
            </div>
            {strategy ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                  <span style={{ color: T.textSub }}>Mode</span>
                  <span style={{ fontWeight: 500 }}>{strategy.mode}</span>
                </div>
                {[
                  { label: "Min score to trade", val: minScore, set: setMinScore, min: 0, max: 100 },
                  { label: "Max position %", val: maxPos, set: setMaxPos, min: 1, max: 25 },
                  { label: "Max trades/day", val: maxTrades, set: setMaxTrades, min: 1, max: 10 },
                ].map(f => (
                  <div key={f.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "13px" }}>
                    <span style={{ color: T.textSub }}>{f.label}</span>
                    <input
                      type="number"
                      value={f.val}
                      min={f.min}
                      max={f.max}
                      onChange={e => f.set(Number(e.target.value))}
                      style={{ width: "64px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "6px", color: T.text, fontSize: "13px", padding: "4px 8px", outline: "none", textAlign: "right" }}
                    />
                  </div>
                ))}
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                  <span style={{ color: T.textSub }}>Target accuracy</span>
                  <span style={{ fontWeight: 500 }}>{(strategy.target_30d_accuracy * 100).toFixed(0)}%</span>
                </div>
                <button
                  onClick={saveStrategyConfig}
                  disabled={configSaving}
                  style={{ marginTop: "4px", width: "100%", padding: "8px", background: T.accent, border: "none", borderRadius: "8px", color: "#fff", fontSize: "12px", fontWeight: 600, cursor: configSaving ? "not-allowed" : "pointer", opacity: configSaving ? 0.7 : 1 }}
                >
                  {configSaving ? "Saving..." : "Save Config"}
                </button>
              </div>
            ) : <div style={{ color: T.muted, fontSize: "13px" }}>No config.</div>}
          </div>
        </div>
      )}

      {/* Learning log tab */}
      {tab === "log" && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
          <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "14px" }}>Learning Log</div>
          {learningLog.length === 0 ? (
            <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "30px 0" }}>
              No learning events yet. LearnerAgent evaluates labeled outcomes and may propose a challenger; promotion remains validation- and governance-gated.
            </div>
          ) : learningLog.map(l => (
            <div key={l.id} style={{ borderTop: `1px solid ${T.border}`, padding: "12px 0" }}>
              <div style={{ fontSize: "13px" }}>{l.note}</div>
              <div style={{ fontSize: "11px", color: T.muted, marginTop: "3px" }}>{new Date(l.created_at).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}

      {/* Backtest tab */}
      {tab === "backtest" && (() => {
        if (signals.length === 0) {
          return (
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "40px 20px", textAlign: "center" }}>
              <div style={{ fontSize: "32px", marginBottom: "12px" }}>📊</div>
              <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "6px", color: T.text }}>No signals yet</div>
              <div style={{ fontSize: "13px", color: T.muted }}>Run ResearchAgent to generate signals. Backtest builds automatically.</div>
            </div>
          );
        }

        // Join signals with paper_trades by symbol + approximate date (within 3 days)
        type BacktestRow = {
          signalId: string;
          symbol: string;
          date: string;
          direction: string;
          score: number | null;
          entryPrice: number | null;
          targetPrice: number | null;
          exitPrice: number | null;
          actualPct: number | null;
          status: "hit" | "miss" | "open";
        };

        const rows: BacktestRow[] = signals.map(sig => {
          const sigDate = new Date(sig.created_at).getTime();
          // Find matching paper trade: same symbol, opened within ±3 days of signal
          const trade = paperTrades.find(t =>
            t.symbol === sig.symbol &&
            Math.abs(new Date(t.executed_at).getTime() - sigDate) < 3 * 86400000
          );

          const entryPrice = trade?.fill_price ?? null;
          const exitPrice = trade?.exit_price ?? null;
          const actualPct = entryPrice && exitPrice
            ? ((exitPrice - entryPrice) / entryPrice) * 100
            : null;

          let status: "hit" | "miss" | "open" = "open";
          if (trade?.outcome === "win") status = "hit";
          else if (trade?.outcome === "loss") status = "miss";
          else if (trade && trade.closed_at) status = actualPct !== null && actualPct > 0 ? "hit" : "miss";

          // Estimate target: entry × 1.15 (15% upside) — PaperTrader default
          const targetPrice = entryPrice ? entryPrice * 1.15 : null;

          return {
            signalId: sig.id,
            symbol: sig.symbol,
            date: sig.created_at,
            direction: sig.direction,
            score: sig.analyst_score ?? null,
            entryPrice,
            targetPrice,
            exitPrice,
            actualPct,
            status,
          };
        });

        const closed = rows.filter(r => r.status !== "open");
        const hits = rows.filter(r => r.status === "hit").length;
        const misses = rows.filter(r => r.status === "miss").length;
        const open = rows.filter(r => r.status === "open").length;
        const avgReturn = closed.length > 0 && closed.some(r => r.actualPct !== null)
          ? closed.filter(r => r.actualPct !== null).reduce((s, r) => s + r.actualPct!, 0) / closed.filter(r => r.actualPct !== null).length
          : null;

        const statusColor = (s: string) => s === "hit" ? T.green : s === "miss" ? T.red : T.amber;
        const statusBg = (s: string) => s === "hit" ? T.greenBg : s === "miss" ? T.redBg : T.amberBg;
        const statusLabel = (s: string) => s === "hit" ? "✓ Target" : s === "miss" ? "✗ Stop" : "⏳ Open";

        return (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {/* Stats row */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "12px" }}>
              {[
                { label: "Hit Rate", value: closed.length ? `${hits}/${closed.length}` : "—", sub: closed.length ? `${Math.round((hits / closed.length) * 100)}%` : "no closed trades", color: hits > misses ? T.green : T.muted },
                { label: "Misses", value: misses > 0 ? String(misses) : "0", sub: "hit stop or closed negative", color: misses > 0 ? T.red : T.muted },
                { label: "Open", value: String(open), sub: "signals still running", color: open > 0 ? T.amber : T.muted },
                { label: "Avg Return", value: avgReturn !== null ? (avgReturn >= 0 ? "+" : "") + avgReturn.toFixed(1) + "%" : "—", sub: "closed trades only", color: avgReturn !== null ? (avgReturn >= 0 ? T.green : T.red) : T.muted },
              ].map(stat => (
                <div key={stat.label} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "14px 16px" }}>
                  <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>{stat.label}</div>
                  <div style={{ fontSize: "22px", fontWeight: 700, color: stat.color }}>{stat.value}</div>
                  <div style={{ fontSize: "11px", color: T.muted, marginTop: "2px" }}>{stat.sub}</div>
                </div>
              ))}
            </div>

            {/* Signal accuracy table */}
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
              <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "4px" }}>Signal Accuracy · All Time</div>
              <div style={{ fontSize: "11px", color: T.muted, marginBottom: "16px" }}>
                Each signal matched to paper trade by symbol + date. Target estimated at entry ×1.15 (15% upside).
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", minWidth: "640px" }}>
                  <thead>
                    <tr style={{ color: T.muted }}>
                      {["Symbol", "Date", "Direction", "Score", "Entry", "Target", "Exit", "Actual %", "Result"].map(h => (
                        <th key={h} style={{ padding: "5px 12px 8px 0", fontWeight: 500, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left", whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => (
                      <tr key={row.signalId} style={{ borderTop: `1px solid ${T.border}` }}>
                        <td style={{ padding: "9px 12px 9px 0", fontWeight: 700 }}>{row.symbol}</td>
                        <td style={{ padding: "9px 12px 9px 0", color: T.muted, whiteSpace: "nowrap" }}>
                          {new Date(row.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </td>
                        <td style={{ padding: "9px 12px 9px 0" }}>
                          <span style={{ fontSize: "11px", fontWeight: 600, padding: "2px 7px", borderRadius: "4px", background: row.direction === "long" || row.direction === "buy" ? T.greenBg : T.redBg, color: row.direction === "long" || row.direction === "buy" ? T.green : T.red }}>
                            {row.direction.toUpperCase()}
                          </span>
                        </td>
                        <td style={{ padding: "9px 12px 9px 0", fontWeight: 600, color: (row.score ?? 0) >= 75 ? T.green : (row.score ?? 0) >= 60 ? T.amber : T.muted }}>
                          {row.score ?? "—"}
                        </td>
                        <td style={{ padding: "9px 12px 9px 0", fontFamily: "monospace" }}>
                          {row.entryPrice ? currency + row.entryPrice.toFixed(2) : <span style={{ color: T.muted }}>—</span>}
                        </td>
                        <td style={{ padding: "9px 12px 9px 0", fontFamily: "monospace", color: T.muted }}>
                          {row.targetPrice ? currency + row.targetPrice.toFixed(2) : <span style={{ color: T.muted }}>—</span>}
                        </td>
                        <td style={{ padding: "9px 12px 9px 0", fontFamily: "monospace" }}>
                          {row.exitPrice ? currency + row.exitPrice.toFixed(2) : <span style={{ color: T.amber }}>—</span>}
                        </td>
                        <td style={{ padding: "9px 12px 9px 0", fontWeight: 600, color: row.actualPct !== null ? (row.actualPct >= 0 ? T.green : T.red) : T.muted }}>
                          {row.actualPct !== null ? (row.actualPct >= 0 ? "+" : "") + row.actualPct.toFixed(1) + "%" : "—"}
                        </td>
                        <td style={{ padding: "9px 0" }}>
                          <span style={{ fontSize: "11px", fontWeight: 600, padding: "2px 8px", borderRadius: "4px", background: statusBg(row.status), color: statusColor(row.status), whiteSpace: "nowrap" }}>
                            {statusLabel(row.status)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Architecture tab */}
      {tab === "architecture" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

          {/* Section 1: Agent Pipeline */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px" }}>
            <div style={{ fontSize: "11px", color: T.accent, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "14px" }}>Section 1</div>
            <div style={{ fontWeight: 700, fontSize: "16px", marginBottom: "20px" }}>Agent Pipeline</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>

              {/* ResearchAgent */}
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "18px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
                  <span style={{ fontSize: "18px" }}>🔍</span>
                  <span style={{ fontWeight: 700, fontSize: "14px" }}>ResearchAgent</span>
                  <span style={{ fontSize: "11px", color: T.muted, background: T.card, border: `1px solid ${T.border}`, borderRadius: "4px", padding: "2px 8px" }}>Weekdays 9 AM</span>
                </div>
                <div style={{ fontSize: "13px", color: T.textSub, lineHeight: "1.7" }}>
                  Gathers symbols from two sources:
                </div>
                <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
                  <div style={{ fontSize: "13px", color: T.textSub, paddingLeft: "12px", borderLeft: `2px solid ${T.accent}` }}>
                    <span style={{ fontWeight: 600, color: T.text }}>1. Live Robinhood holdings</span> — account ••••8641 (read-only). These are highest priority — agent can output SELL signals on owned positions.
                  </div>
                  <div style={{ fontSize: "13px", color: T.textSub, paddingLeft: "12px", borderLeft: `2px solid ${T.green}` }}>
                    <span style={{ fontWeight: 600, color: T.text }}>2. Dual-bucket screener</span> — top 3 candidates/day:
                    <div style={{ marginTop: "6px", display: "flex", flexDirection: "column", gap: "4px", paddingLeft: "12px" }}>
                      <div><span style={{ color: T.amber, fontWeight: 600 }}>Momentum:</span> RSI &gt; 60, price &gt; 50-day MA, revenue acceleration, positive earnings revision</div>
                      <div><span style={{ color: T.green, fontWeight: 600 }}>Value:</span> P/E &lt; sector median, FCF yield, insider buying, analyst upgrades</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* PaperTrader */}
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "18px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
                  <span style={{ fontSize: "18px" }}>📄</span>
                  <span style={{ fontWeight: 700, fontSize: "14px" }}>PaperTrader</span>
                  <span style={{ fontSize: "11px", color: T.muted, background: T.card, border: `1px solid ${T.border}`, borderRadius: "4px", padding: "2px 8px" }}>Auto-chained after Research</span>
                </div>
                <div style={{ fontSize: "13px", color: T.textSub, lineHeight: "1.7", display: "flex", flexDirection: "column", gap: "4px" }}>
                  <div>Consumes <code style={{ background: T.card, padding: "1px 5px", borderRadius: "3px", fontSize: "12px", color: T.accent }}>agent_signals</code> only after direction, evidence-quality, risk, and eligibility gates pass. Score alone is insufficient.</div>
                  <div>Sizes within the active market/risk policy and records paper fills from deterministic market-data adapters; it does not ask an LLM for prices.</div>
                  <div>Long-only enforcement — no short positions on screener candidates.</div>
                </div>
              </div>

              {/* LearnerAgent */}
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "18px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
                  <span style={{ fontSize: "18px" }}>🧠</span>
                  <span style={{ fontWeight: 700, fontSize: "14px" }}>LearnerAgent</span>
                  <span style={{ fontSize: "11px", color: T.muted, background: T.card, border: `1px solid ${T.border}`, borderRadius: "4px", padding: "2px 8px" }}>Sundays 8 PM</span>
                </div>
                <div style={{ fontSize: "13px", color: T.textSub, lineHeight: "1.7", display: "flex", flexDirection: "column", gap: "4px" }}>
                  <div>Labels observations at defined horizons, evaluates calibration and outcomes, and proposes challengers. It cannot activate its own changes.</div>
                  <div>Writes 1-sentence outcome note per trade + batch summary to <code style={{ background: T.card, padding: "1px 5px", borderRadius: "3px", fontSize: "12px", color: T.accent }}>learning_log</code>.</div>
                  <div><span style={{ color: T.amber, fontWeight: 600 }}>Phase 0:</span> records outcomes only — weight mutation locked until 10+ closed trades.</div>
                </div>
              </div>

              {/* ThemeScout */}
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "18px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
                  <span style={{ fontSize: "18px" }}>🎯</span>
                  <span style={{ fontWeight: 700, fontSize: "14px" }}>ThemeScout</span>
                  <span style={{ fontSize: "11px", color: T.muted, background: T.card, border: `1px solid ${T.border}`, borderRadius: "4px", padding: "2px 8px" }}>On-demand / cron</span>
                </div>
                <div style={{ fontSize: "13px", color: T.textSub, lineHeight: "1.7", display: "flex", flexDirection: "column", gap: "4px" }}>
                  <div>Identifies thematic investing opportunities (AI infrastructure, energy transition, biotech, etc.) using LLM analysis of market trends.</div>
                  <div>Writes 3–5 symbol candidates with theme tag + rationale to watchlist. Symbols auto-expire after 7 days unless manually kept.</div>
                  <div><span style={{ color: "#a78bfa", fontWeight: 600 }}>AI Scout</span> badge in watchlist identifies ThemeScout additions.</div>
                </div>
              </div>

              {/* DeepSeek */}
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "18px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
                  <span style={{ fontSize: "18px" }}>🤖</span>
                  <span style={{ fontWeight: 700, fontSize: "14px" }}>DeepSeek Research</span>
                  <span style={{ fontSize: "11px", color: T.muted, background: T.card, border: `1px solid ${T.border}`, borderRadius: "4px", padding: "2px 8px" }}>Parallel to Claude</span>
                </div>
                <div style={{ fontSize: "13px", color: T.textSub, lineHeight: "1.7", display: "flex", flexDirection: "column", gap: "4px" }}>
                  <div>Runs the same research prompt through DeepSeek-R1 in parallel with Claude. Enables A/B comparison of signal quality across LLMs.</div>
                  <div>Results stored in <code style={{ background: T.card, padding: "1px 5px", borderRadius: "3px", fontSize: "12px", color: T.accent }}>agent_signals</code> with <code style={{ background: T.card, padding: "1px 5px", borderRadius: "3px", fontSize: "12px", color: T.accent }}>model = "deepseek"</code>.</div>
                  <div><span style={{ color: T.amber, fontWeight: 600 }}>Goal:</span> determine which LLM produces more accurate signals before increasing position size.</div>
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: Data Sources */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px" }}>
            <div style={{ fontSize: "11px", color: T.accent, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "14px" }}>Section 2</div>
            <div style={{ fontWeight: 700, fontSize: "16px", marginBottom: "20px" }}>Data Sources</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "12px" }}>
              {[
                {
                  name: "FinancialDatasets MCP",
                  icon: "📊",
                  used: "Fundamentals: PE, revenue, FCF, earnings, insider trades, institutional holdings",
                },
                {
                  name: "Alpha Vantage MCP",
                  icon: "📈",
                  used: "Technicals: RSI, EMA(50), news sentiment, earnings calendar",
                },
                {
                  name: "Robinhood MCP",
                  icon: "🏦",
                  used: "Live quotes (fill prices), equity positions, order placement",
                },
              ].map(src => (
                <div key={src.name} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px" }}>
                  <div style={{ fontSize: "22px", marginBottom: "8px" }}>{src.icon}</div>
                  <div style={{ fontWeight: 600, fontSize: "13px", marginBottom: "6px" }}>{src.name}</div>
                  <div style={{ fontSize: "12px", color: T.textSub, lineHeight: "1.6" }}>{src.used}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Section 3: Scoring Formula */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px" }}>
            <div style={{ fontSize: "11px", color: T.accent, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "14px" }}>Section 3</div>
            <div style={{ fontWeight: 700, fontSize: "16px", marginBottom: "20px" }}>Scoring Formula</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px,1fr))", gap: "16px" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "13px", marginBottom: "10px", color: T.textSub }}>analyst_score (0–100)</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "12px" }}>
                    <div style={{ fontWeight: 600, fontSize: "12px", color: T.text, marginBottom: "6px" }}>Stocks</div>
                    {["Fundamentals (PE, revenue growth, FCF yield)", "Technicals (RSI, EMA crossover)", "News sentiment", "Insider activity", "Earnings revision"].map(item => (
                      <div key={item} style={{ fontSize: "12px", color: T.textSub, display: "flex", alignItems: "flex-start", gap: "6px", marginTop: "4px" }}>
                        <span style={{ color: T.accent, flexShrink: 0, marginTop: "1px" }}>+</span>
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "12px" }}>
                    <div style={{ fontWeight: 600, fontSize: "12px", color: T.text, marginBottom: "6px" }}>ETFs</div>
                    {["Macro/sector momentum", "RSI/EMA crossover", "No fundamentals — ETFs don't have PE/FCF"].map(item => (
                      <div key={item} style={{ fontSize: "12px", color: T.textSub, display: "flex", alignItems: "flex-start", gap: "6px", marginTop: "4px" }}>
                        <span style={{ color: T.green, flexShrink: 0, marginTop: "1px" }}>+</span>
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: "13px", marginBottom: "10px", color: T.textSub }}>Action Thresholds</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {[
                    { range: "0 – 59", label: "No action", color: T.muted, bg: T.surface },
                    { range: "60 – 69", label: "PaperTrader fills paper trade", color: T.amber, bg: T.amberBg },
                    { range: "70+", label: "High conviction long", color: T.green, bg: T.greenBg },
                  ].map(t => (
                    <div key={t.range} style={{ background: t.bg, border: `1px solid ${t.color}30`, borderRadius: "8px", padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontWeight: 700, fontSize: "14px", color: t.color, fontFamily: "monospace" }}>{t.range}</span>
                      <span style={{ fontSize: "12px", color: t.color }}>{t.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Section 4: Phase 0 Constraints */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px" }}>
            <div style={{ fontSize: "11px", color: T.accent, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "14px" }}>Section 4</div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "20px" }}>
              <div style={{ fontWeight: 700, fontSize: "16px" }}>Phase 0 Constraints</div>
              <span style={{ fontSize: "11px", fontWeight: 600, padding: "3px 10px", borderRadius: "20px", background: T.amberBg, color: T.amber, border: `1px solid ${T.amber}40` }}>LOCKED</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px" }}>
              {[
                { icon: "🔒", label: "Long-only", detail: "Only BUY signals — no shorts on screener candidates" },
                { icon: "✅", label: "approval_required", detail: "All real trades need manual approval before execution" },
                { icon: "3️⃣", label: "Max 3 screener candidates/day", detail: "With $10k NAV and 10% sizing, max 10 positions total" },
                { icon: "⏳", label: "Weight mutation locked", detail: "Phase 1 unlocks only after 10+ closed paper trades" },
                { icon: "⚡", label: "TraderAgent account", detail: "Order placement only on agentic account ••••0660" },
                { icon: "🌊", label: "No explicit regime detection", detail: "Scoring adapts naturally — no bull/bear mode switching" },
              ].map(c => (
                <div key={c.label} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "14px", display: "flex", gap: "12px", alignItems: "flex-start" }}>
                  <span style={{ fontSize: "16px", flexShrink: 0 }}>{c.icon}</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: "13px", marginBottom: "3px" }}>{c.label}</div>
                    <div style={{ fontSize: "12px", color: T.textSub }}>{c.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>
      )}

      {/* Learner Brain tab — per-run Mermaid diagrams */}
      {tab === "brain" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {learnerRuns.length === 0 ? (
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "40px 20px", textAlign: "center" }}>
              <div style={{ fontSize: "32px", marginBottom: "12px" }}>🧠</div>
              <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "6px" }}>No learner runs yet</div>
              <div style={{ fontSize: "13px", color: T.muted }}>Run LearnerAgent — it will store a per-run reasoning diagram here.</div>
            </div>
          ) : (
            <>
              {/* Run selector */}
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                {learnerRuns.map((r, i) => (
                  <button key={r.id} onClick={() => setLearnerRunIdx(i)}
                    style={{ padding: "6px 14px", borderRadius: "8px", border: `1px solid ${learnerRunIdx === i ? T.accent : T.border}`, background: learnerRunIdx === i ? T.accent + "18" : "transparent", color: learnerRunIdx === i ? T.accent : T.muted, fontSize: "12px", cursor: "pointer", fontWeight: 500 }}>
                    {r.run_date}
                  </button>
                ))}
              </div>

              {(() => {
                const run = learnerRuns[learnerRunIdx];
                if (!run) return null;
                const hyps: any[] = run.hypotheses ?? [];
                const wm: any[] = run.weight_mutations ?? [];
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                    {/* Stats */}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "12px" }}>
                      {[
                        { label: "Run Date", value: run.run_date, color: T.text },
                        { label: "Signals Analyzed", value: run.signals_analyzed ?? 0, color: T.accent },
                        { label: "Trades Closed", value: run.trades_analyzed ?? 0, color: T.text },
                        { label: "Hypotheses", value: hyps.length, color: hyps.length > 0 ? T.amber : T.muted },
                        { label: "Weight Mutations", value: wm.length, color: wm.length > 0 ? T.green : T.muted },
                      ].map(s => (
                        <div key={s.label} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "14px 16px" }}>
                          <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "5px" }}>{s.label}</div>
                          <div style={{ fontSize: "22px", fontWeight: 700, color: s.color }}>{s.value}</div>
                        </div>
                      ))}
                    </div>

                    {/* Mermaid reasoning diagram */}
                    {run.mermaid_per_run && (
                      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
                        <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "14px" }}>Reasoning Diagram — {run.model_used ?? "DeepSeek"}</div>
                        <div style={{ fontSize: "11px", color: T.muted, marginBottom: "14px" }}>Generated by LearnerAgent tool-use loop. Shows actual query steps, correlations found, and decision path.</div>
                        <Suspense fallback={<div style={{ color: T.muted, fontSize: "12px" }}>Loading Mermaid…</div>}>
                          <MermaidChart chart={run.mermaid_per_run} />
                        </Suspense>
                        <details style={{ marginTop: "12px" }}>
                          <summary style={{ fontSize: "11px", color: T.muted, cursor: "pointer" }}>Raw Mermaid source</summary>
                          <pre style={{ marginTop: "8px", fontSize: "11px", color: T.textSub, background: T.surface, padding: "10px", borderRadius: "6px", overflowX: "auto", whiteSpace: "pre-wrap" }}>{run.mermaid_per_run}</pre>
                        </details>
                      </div>
                    )}

                    {/* Hypotheses */}
                    {hyps.length > 0 && (
                      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
                        <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "14px" }}>Hypotheses ({hyps.length})</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                          {hyps.map((h: any, i: number) => (
                            <div key={i} style={{ background: T.surface, borderRadius: "8px", padding: "12px 14px", borderLeft: `3px solid ${(h.confidence ?? 0) >= 0.7 ? T.green : T.amber}` }}>
                              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                                <span style={{ fontWeight: 600, fontSize: "13px" }}>{h.claim}</span>
                                <span style={{ fontSize: "11px", color: (h.confidence ?? 0) >= 0.7 ? T.green : T.amber, fontWeight: 600 }}>{Math.round((h.confidence ?? 0) * 100)}%</span>
                              </div>
                              {h.evidence && <div style={{ fontSize: "12px", color: T.textSub }}>{h.evidence}</div>}
                              {h.action && <div style={{ fontSize: "11px", color: T.muted, marginTop: "4px" }}>Action: {h.action}</div>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Weight mutations */}
                    {wm.length > 0 && (
                      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
                        <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "14px" }}>Weight Mutations ({wm.length})</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                          {wm.map((m: any, i: number) => (
                            <div key={i} style={{ background: T.surface, borderRadius: "8px", padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                              <div>
                                <span style={{ fontWeight: 600, fontSize: "13px", color: T.accent }}>{m.dimension}</span>
                                <span style={{ fontSize: "12px", color: T.textSub, marginLeft: "8px" }}>{m.reason}</span>
                              </div>
                              <div style={{ fontSize: "12px", fontFamily: "monospace", color: T.green }}>{m.old?.toFixed(3) ?? "?"} → {m.new?.toFixed(3) ?? "?"}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </>
          )}
        </div>
      )}

      {/* LLM Config tab — per-agent model selector */}
      {tab === "llm-config" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "14px" }}>Agent LLM Configuration</div>
                <div style={{ fontSize: "12px", color: T.muted, marginTop: "3px" }}>Change which LLM each agent uses — no code deploy needed</div>
              </div>
              {configUpdateToast && <span style={{ fontSize: "12px", color: T.green }}>{configUpdateToast}</span>}
            </div>
            {agentConfigs.length === 0 ? (
              <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "30px 0" }}>
                Apply migration 031 in Supabase dashboard first — creates the agent_config table.
              </div>
            ) : (
              <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "10px", minWidth: "560px" }}>
                {agentConfigs.map(cfg => (
                  <div key={cfg.agent_name} style={{ background: T.surface, borderRadius: "10px", padding: "14px 16px", display: "grid", gridTemplateColumns: "140px 1fr 80px 80px 100px", gap: "12px", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: "13px" }}>{cfg.agent_name}</div>
                      {cfg.notes && <div style={{ fontSize: "11px", color: T.muted, marginTop: "2px" }}>{cfg.notes}</div>}
                    </div>
                    <select
                      value={cfg.model}
                      onChange={e => updateAgentConfig(cfg.agent_name, "model", e.target.value)}
                      disabled={configUpdating === cfg.agent_name}
                      style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "6px", color: T.text, fontSize: "12px", padding: "5px 8px", outline: "none", cursor: "pointer" }}
                    >
                      <optgroup label="DeepSeek">
                        <option value="deepseek-chat">deepseek-chat (V3 — cheap)</option>
                        <option value="deepseek-reasoner">deepseek-reasoner (R1 — slower)</option>
                      </optgroup>
                      <optgroup label="Groq (Free)">
                        <option value="llama-3.3-70b-versatile">llama-3.3-70b-versatile</option>
                        <option value="llama-3.1-8b-instant">llama-3.1-8b-instant (fastest)</option>
                        <option value="deepseek-r1-distill-llama-70b">deepseek-r1-distill-llama-70b</option>
                      </optgroup>
                      <optgroup label="Claude (Paid)">
                        <option value="claude-haiku-4-5">claude-haiku-4-5 (fast/cheap)</option>
                        <option value="claude-sonnet-4-6">claude-sonnet-4-6 (best)</option>
                      </optgroup>
                    </select>
                    <div style={{ fontSize: "11px", color: T.muted, textAlign: "right" }}>
                      <div>tokens</div>
                      <input type="number" min={256} max={8192} step={256} value={cfg.max_tokens ?? 2048}
                        onChange={e => updateAgentConfig(cfg.agent_name, "max_tokens", Number(e.target.value))}
                        style={{ width: "72px", background: T.card, border: `1px solid ${T.border}`, borderRadius: "5px", color: T.text, fontSize: "12px", padding: "3px 6px", outline: "none", marginTop: "3px", textAlign: "right" }} />
                    </div>
                    <div style={{ fontSize: "11px", color: T.muted, textAlign: "right" }}>
                      <div>temp</div>
                      <input type="number" min={0} max={2} step={0.1} value={cfg.temperature ?? 0.3}
                        onChange={e => updateAgentConfig(cfg.agent_name, "temperature", Number(e.target.value))}
                        style={{ width: "56px", background: T.card, border: `1px solid ${T.border}`, borderRadius: "5px", color: T.text, fontSize: "12px", padding: "3px 6px", outline: "none", marginTop: "3px", textAlign: "right" }} />
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <span style={{ fontSize: "11px", color: T.muted }}>enabled</span>
                      <div
                        onClick={() => updateAgentConfig(cfg.agent_name, "enabled", !cfg.enabled)}
                        style={{ width: "36px", height: "20px", borderRadius: "10px", background: cfg.enabled ? T.accent : T.border, cursor: "pointer", position: "relative", transition: "background 0.2s" }}>
                        <div style={{ position: "absolute", top: "3px", left: cfg.enabled ? "18px" : "3px", width: "14px", height: "14px", borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              </div>
            )}
          </div>

          {/* Provider API keys — vault-backed, write-only, owner-gated */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px", marginBottom: "6px" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "14px" }}>Provider API Keys</div>
                <div style={{ fontSize: "12px", color: T.muted, marginTop: "3px" }}>Set a key here to override the deployment env var. Keys are stored encrypted and never shown again — only the last 4 digits.</div>
              </div>
              {pkToast && <span style={{ fontSize: "12px", color: T.green }}>{pkToast}</span>}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "12px" }}>
              {providerKeys.map(pk => {
                const srcColor = pk.source === "vault" ? T.green : pk.source === "env" ? T.muted : "#c0392b";
                const srcLabel = pk.source === "vault" ? `Settings ••${pk.last4}` : pk.source === "env" ? `env ••${pk.last4}` : "not set";
                return (
                  <div key={pk.provider} style={{ background: T.surface, borderRadius: "10px", padding: "14px 16px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px" }}>
                    <div style={{ minWidth: "150px", flex: "1 1 150px" }}>
                      <div style={{ fontWeight: 600, fontSize: "13px" }}>{pk.label}</div>
                      <div style={{ fontSize: "11px", color: srcColor, marginTop: "2px" }}>{srcLabel}</div>
                    </div>
                    <input
                      type="password"
                      autoComplete="new-password"
                      placeholder="Paste new key…"
                      value={pkInputs[pk.provider] ?? ""}
                      onChange={e => setPkInputs(prev => ({ ...prev, [pk.provider]: e.target.value }))}
                      style={{ flex: "2 1 200px", minWidth: "160px", background: T.card, border: `1px solid ${T.border}`, borderRadius: "6px", color: T.text, fontSize: "12px", padding: "7px 10px", outline: "none" }}
                    />
                    <button
                      onClick={() => saveProviderKey(pk.provider)}
                      disabled={pkSaving === pk.provider || !(pkInputs[pk.provider] ?? "").trim()}
                      style={{ background: T.accent, color: "#fff", border: "none", borderRadius: "6px", fontSize: "12px", fontWeight: 600, padding: "7px 14px", cursor: "pointer", opacity: pkSaving === pk.provider || !(pkInputs[pk.provider] ?? "").trim() ? 0.5 : 1 }}
                    >{pkSaving === pk.provider ? "Saving…" : "Save"}</button>
                    {pk.source === "vault" && (
                      <button
                        onClick={() => clearProviderKey(pk.provider)}
                        disabled={pkSaving === pk.provider}
                        style={{ background: "transparent", color: T.muted, border: `1px solid ${T.border}`, borderRadius: "6px", fontSize: "12px", padding: "7px 12px", cursor: "pointer" }}
                      >Clear</button>
                    )}
                  </div>
                );
              })}
              {providerKeys.length === 0 && (
                <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "16px 0" }}>Loading providers…</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Learner Controls tab */}
      {tab === "learner-ctrl" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "14px" }}>Learner Input Controls</div>
                <div style={{ fontSize: "12px", color: T.muted, marginTop: "3px" }}>Toggle which score dimensions LearnerAgent analyzes and can mutate. Disable a dimension to freeze it.</div>
              </div>
              {learnerCtrlToast && <span style={{ fontSize: "12px", color: T.green }}>{learnerCtrlToast}</span>}
            </div>
            {learnerConfig.length === 0 ? (
              <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "30px 0" }}>
                Apply migration 033 in Supabase dashboard — creates learner_config table.
              </div>
            ) : (
              <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", minWidth: "560px" }}>
                <div style={{ display: "grid", gridTemplateColumns: "180px 1fr 1fr 100px", gap: "10px", padding: "6px 12px", fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                  <div>Dimension</div><div>Learn From</div><div>Allow Mutation</div><div>Min Confidence</div>
                </div>
                {learnerConfig.map(cfg => (
                  <div key={cfg.dimension} style={{ background: T.surface, borderRadius: "10px", padding: "12px 16px", display: "grid", gridTemplateColumns: "180px 1fr 1fr 100px", gap: "10px", alignItems: "center" }}>
                    <div style={{ fontWeight: 600, fontSize: "13px", color: T.text }}>{cfg.dimension.replace("_score", "")}</div>
                    {/* Learn From toggle */}
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <div onClick={() => updateLearnerConfig(cfg.dimension, "learn_from", !cfg.learn_from)}
                        style={{ width: "36px", height: "20px", borderRadius: "10px", background: cfg.learn_from ? T.accent : T.border, cursor: "pointer", position: "relative" }}>
                        <div style={{ position: "absolute", top: "3px", left: cfg.learn_from ? "18px" : "3px", width: "14px", height: "14px", borderRadius: "50%", background: "#fff", transition: "left 0.15s" }} />
                      </div>
                      <span style={{ fontSize: "12px", color: cfg.learn_from ? T.text : T.muted }}>{cfg.learn_from ? "On" : "Off"}</span>
                    </div>
                    {/* Allow Mutation toggle */}
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <div onClick={() => updateLearnerConfig(cfg.dimension, "allow_mutation", !cfg.allow_mutation)}
                        style={{ width: "36px", height: "20px", borderRadius: "10px", background: cfg.allow_mutation ? T.green + "AA" : T.border, cursor: "pointer", position: "relative" }}>
                        <div style={{ position: "absolute", top: "3px", left: cfg.allow_mutation ? "18px" : "3px", width: "14px", height: "14px", borderRadius: "50%", background: "#fff", transition: "left 0.15s" }} />
                      </div>
                      <span style={{ fontSize: "12px", color: cfg.allow_mutation ? T.green : T.muted }}>{cfg.allow_mutation ? "Allowed" : "Frozen"}</span>
                    </div>
                    {/* Min Confidence */}
                    <input type="number" min={0.50} max={0.99} step={0.05} value={cfg.min_confidence ?? 0.70}
                      onBlur={e => updateLearnerConfig(cfg.dimension, "min_confidence", parseFloat(e.target.value))}
                      onChange={e => setLearnerConfig(prev => prev.map(c => c.dimension === cfg.dimension ? { ...c, min_confidence: parseFloat(e.target.value) } : c))}
                      disabled={learnerCtrlSaving === cfg.dimension + ".min_confidence"}
                      style={{ width: "80px", background: T.card, border: `1px solid ${T.border}`, borderRadius: "5px", color: T.text, fontSize: "12px", padding: "4px 8px", outline: "none", textAlign: "right" }} />
                  </div>
                ))}
              </div>
              </div>
            )}
          </div>

          {/* Learning Priors */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
            <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "6px" }}>Bayesian Priors</div>
            <div style={{ fontSize: "12px", color: T.muted, marginBottom: "14px" }}>Pre-seeded market principles that LearnerAgent reads as background context before analyzing any signals. Read-only — edit in Supabase if you want to add/remove.</div>
            <div style={{ background: T.surface, borderRadius: "8px", padding: "12px 14px", fontSize: "12px", color: T.textSub, fontStyle: "italic" }}>
              15 principles pre-seeded (insider buying reliability, RSI in downtrend, revenue acceleration, Fed rate / equity duration risk, yield curve inversion, momentum vs value regimes, etc.) from academic research (Seyhun 1986, Fama-French, O'Shaughnessy). Agent reads these as Bayesian context on every run — they bias initial hypotheses toward well-known market realities before empirical data accumulates.
            </div>
          </div>
        </div>
      )}

      {/* Weight History tab */}
      {tab === "weight-history" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "14px" }}>Signal Weight History</div>
                <div style={{ fontSize: "12px", color: T.muted, marginTop: "3px" }}>Snapshot saved before every mutation. Rollback to any prior state.</div>
              </div>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                {learnerCtrlToast && <span style={{ fontSize: "12px", color: T.green }}>{learnerCtrlToast}</span>}
                <button onClick={factoryResetWeights}
                  style={{ padding: "7px 14px", background: T.redBg, border: `1px solid ${T.red}40`, borderRadius: "7px", color: T.red, fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
                  ⚠ Factory Reset (0.20 each)
                </button>
              </div>
            </div>
            {weightHistory.length === 0 ? (
              <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "30px 0" }}>
                No weight history yet — LearnerAgent saves a snapshot before each mutation (migration 033 required).
              </div>
            ) : (
              <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", minWidth: "700px" }}>
                <div style={{ display: "grid", gridTemplateColumns: "110px 90px 80px 80px 80px 80px 80px 100px", gap: "8px", padding: "6px 12px", fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                  <div>Date</div><div>Trigger</div><div>Fund.</div><div>Tech.</div><div>Sent.</div><div>Macro</div><div>Insider</div><div>Action</div>
                </div>
                {weightHistory.map((h: any) => (
                  <div key={h.id} style={{ background: T.surface, borderRadius: "9px", padding: "10px 14px", display: "grid", gridTemplateColumns: "110px 90px 80px 80px 80px 80px 80px 100px", gap: "8px", alignItems: "center", fontSize: "12px" }}>
                    <div style={{ color: T.text, fontFamily: "monospace" }}>{h.run_date ?? h.snapshot_at?.slice(0, 10)}</div>
                    <div style={{ fontSize: "10px", color: T.muted }}>{h.trigger}</div>
                    <div style={{ fontFamily: "monospace", color: T.textSub }}>{h.fundamental_weight?.toFixed(3) ?? "—"}</div>
                    <div style={{ fontFamily: "monospace", color: T.textSub }}>{h.technical_weight?.toFixed(3) ?? "—"}</div>
                    <div style={{ fontFamily: "monospace", color: T.textSub }}>{h.sentiment_weight?.toFixed(3) ?? "—"}</div>
                    <div style={{ fontFamily: "monospace", color: T.textSub }}>{h.macro_weight?.toFixed(3) ?? "—"}</div>
                    <div style={{ fontFamily: "monospace", color: T.textSub }}>{h.insider_weight?.toFixed(3) ?? "—"}</div>
                    <button onClick={() => rollbackWeights(h.id)}
                      style={{ padding: "4px 10px", background: T.accent + "18", border: `1px solid ${T.accent}40`, borderRadius: "6px", color: T.accent, fontSize: "11px", fontWeight: 600, cursor: "pointer" }}>
                      ↩ Rollback
                    </button>
                  </div>
                ))}
                {weightHistory.length === 0 && (
                  <div style={{ color: T.muted, fontSize: "12px", textAlign: "center", padding: "20px 0" }}>Nothing yet. Run LearnerAgent to generate history.</div>
                )}
              </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Experiments tab */}
      {tab === "experiments" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* Strategy versions list */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "14px" }}>Strategy Versions</div>
                <div style={{ fontSize: "12px", color: T.muted, marginTop: "3px" }}>Champion/challenger governance — only one active champion at a time</div>
              </div>
              <button
                onClick={async () => {
                  setBacktestRunning(true);
                  setBacktestResult(null);
                  try {
                    const r = await fetch("/api/agents/backtest", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        date_from: new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0],
                        date_to: new Date().toISOString().split("T")[0],
                        score_threshold: strategy?.score_threshold ?? 60,
                        target_pct: strategy?.target_pct ?? 20,
                        stop_loss_pct: strategy?.stop_loss_pct ?? 7,
                        max_hold_days: 30,
                      }),
                    });
                    const d = await r.json();
                    setBacktestResult(d);
                  } catch (e: any) { setBacktestResult({ error: e.message }); }
                  setBacktestRunning(false);
                }}
                disabled={backtestRunning}
                style={{ padding: "7px 16px", background: backtestRunning ? T.border : T.accent + "18", border: `1px solid ${T.accent}35`, borderRadius: "7px", color: backtestRunning ? T.muted : T.accent, fontSize: "12px", fontWeight: 600, cursor: backtestRunning ? "default" : "pointer" }}
              >
                {backtestRunning ? "Running backtest…" : "▶ Run Backtest (90d)"}
              </button>
            </div>

            {strategyVersions.length === 0 ? (
              <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "30px 0" }}>
                Apply migration <a href="supabase/migrations/036_strategy_registry.sql" style={{ color: T.accent }}>036_strategy_registry.sql</a> to enable strategy versioning.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {strategyVersions.map((v: any) => (
                  <div key={v.id} style={{ background: T.surface, borderRadius: "10px", padding: "14px 16px", border: `1px solid ${v.is_champion ? T.accent + "50" : T.border}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                        <span style={{ fontWeight: 700, fontSize: "13px" }}>v{v.version}</span>
                        <span style={{ fontSize: "12px", color: T.muted }}>{v.name}</span>
                        {v.is_champion && <span style={{ fontSize: "10px", fontWeight: 700, padding: "2px 8px", borderRadius: "4px", background: T.accent + "18", color: T.accent }}>CHAMPION</span>}
                        <span style={{ fontSize: "10px", padding: "2px 8px", borderRadius: "4px", background: T.surface, border: `1px solid ${T.border}`, color: T.muted }}>{v.state}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        {/* Phase 2: validation gate status (see Decision — promotion is fail-closed on this) */}
                        {v.validation ? (
                          <span title={v.validation.fail_reason ?? ""} style={{ fontSize: "10px", fontWeight: 700, padding: "2px 8px", borderRadius: "4px", background: v.validation.passed ? T.accent + "18" : T.red + "18", color: v.validation.passed ? T.green : T.red }}>
                            {v.validation.passed ? "✓ VALIDATED" : "✗ NOT VALIDATED"} · p={v.validation.p_improvement?.toFixed(2) ?? "—"}
                          </span>
                        ) : !v.is_champion ? (
                          <button
                            disabled={validatingId === v.id}
                            onClick={async () => {
                              setValidatingId(v.id);
                              try {
                                await fetch("/api/validation/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challenger_id: v.id, market: v.market ?? "us" }) });
                                const d = await fetch("/api/strategies/versions").then(r => r.json());
                                if (d.versions) setStrategyVersions(d.versions);
                              } finally { setValidatingId(null); }
                            }}
                            style={{ fontSize: "10px", fontWeight: 700, padding: "2px 8px", borderRadius: "4px", background: T.surface, border: `1px solid ${T.border}`, color: T.muted, cursor: validatingId === v.id ? "default" : "pointer" }}
                          >{validatingId === v.id ? "Validating…" : "Validate"}</button>
                        ) : null}
                        <div style={{ fontSize: "11px", color: T.muted }}>{v.direction} · {v.horizon_days_min}–{v.horizon_days_max}d hold</div>
                      </div>
                    </div>
                    {/* Experiment runs for this version */}
                    {v.experiment_runs?.length > 0 && (
                      <div style={{ marginTop: "10px", borderTop: `1px solid ${T.border}`, paddingTop: "10px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: "8px" }}>
                        {[
                          { label: "Win Rate", val: v.experiment_runs[0]?.win_rate != null ? (v.experiment_runs[0].win_rate * 100).toFixed(0) + "%" : "—", color: (v.experiment_runs[0]?.win_rate ?? 0) >= 0.4 ? T.green : T.red },
                          { label: "Avg Return", val: v.experiment_runs[0]?.avg_return_pct != null ? (v.experiment_runs[0].avg_return_pct >= 0 ? "+" : "") + v.experiment_runs[0].avg_return_pct.toFixed(1) + "%" : "—", color: (v.experiment_runs[0]?.avg_return_pct ?? 0) >= 0 ? T.green : T.red },
                          { label: "Sharpe", val: v.experiment_runs[0]?.sharpe_ratio?.toFixed(2) ?? "—", color: (v.experiment_runs[0]?.sharpe_ratio ?? 0) >= 0.5 ? T.green : T.amber },
                          { label: "Drawdown", val: v.experiment_runs[0]?.max_drawdown_pct != null ? v.experiment_runs[0].max_drawdown_pct.toFixed(1) + "%" : "—", color: (v.experiment_runs[0]?.max_drawdown_pct ?? 99) < 25 ? T.green : T.red },
                          { label: "Gate", val: v.experiment_runs[0]?.gate_pass ? "✓ PASS" : "✗ FAIL", color: v.experiment_runs[0]?.gate_pass ? T.green : T.red },
                        ].map(m => (
                          <div key={m.label} style={{ textAlign: "center" }}>
                            <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "2px" }}>{m.label}</div>
                            <div style={{ fontSize: "14px", fontWeight: 700, color: m.color }}>{m.val}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Backtest result */}
          {backtestResult && (
            <div style={{ background: T.card, border: `1px solid ${backtestResult.error ? T.red : T.border}`, borderRadius: "12px", padding: "20px" }}>
              {backtestResult.error ? (
                <div style={{ color: T.red, fontSize: "13px" }}>Error: {backtestResult.error}</div>
              ) : (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
                    <div style={{ fontWeight: 600, fontSize: "14px" }}>Backtest Results</div>
                    <span style={{ fontSize: "11px", fontWeight: 700, padding: "3px 10px", borderRadius: "20px", background: backtestResult.gate_pass ? T.greenBg : T.redBg, color: backtestResult.gate_pass ? T.green : T.red, border: `1px solid ${backtestResult.gate_pass ? T.green : T.red}40` }}>
                      {backtestResult.gate_pass ? "✓ ELIGIBLE" : "✗ NOT ELIGIBLE"}
                    </span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: "12px" }}>
                    {[
                      { label: "Trades", val: backtestResult.total_trades ?? "—", color: T.text },
                      { label: "Win Rate", val: backtestResult.win_rate != null ? (backtestResult.win_rate * 100).toFixed(0) + "%" : "—", color: (backtestResult.win_rate ?? 0) >= 0.4 ? T.green : T.red },
                      { label: "Avg Return", val: backtestResult.avg_return_pct != null ? (backtestResult.avg_return_pct >= 0 ? "+" : "") + backtestResult.avg_return_pct.toFixed(1) + "%" : "—", color: (backtestResult.avg_return_pct ?? 0) >= 0 ? T.green : T.red },
                      { label: "Sharpe", val: backtestResult.sharpe_ratio?.toFixed(2) ?? "—", color: (backtestResult.sharpe_ratio ?? 0) >= 0.5 ? T.green : T.amber },
                      { label: "Drawdown", val: backtestResult.max_drawdown_pct != null ? backtestResult.max_drawdown_pct.toFixed(1) + "%" : "—", color: (backtestResult.max_drawdown_pct ?? 99) < 25 ? T.green : T.red },
                      { label: "Alpha vs SPY", val: backtestResult.alpha_pct != null ? (backtestResult.alpha_pct >= 0 ? "+" : "") + backtestResult.alpha_pct.toFixed(1) + "%" : "—", color: (backtestResult.alpha_pct ?? 0) >= 0 ? T.green : T.red },
                    ].map(m => (
                      <div key={m.label} style={{ background: T.surface, borderRadius: "8px", padding: "12px 14px" }}>
                        <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "4px" }}>{m.label}</div>
                        <div style={{ fontSize: "20px", fontWeight: 700, color: m.color }}>{m.val}</div>
                      </div>
                    ))}
                  </div>
                  {backtestResult.gate_reasons?.length > 0 && (
                    <div style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "4px" }}>
                      {backtestResult.gate_reasons.map((r: string, i: number) => (
                        <div key={i} style={{ fontSize: "12px", color: T.red, paddingLeft: "8px", borderLeft: `2px solid ${T.red}` }}>{r}</div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Proposals tab */}
      {tab === "proposals" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "14px" }}>Trade Proposals</div>
                <div style={{ fontSize: "12px", color: T.muted, marginTop: "3px" }}>Pending approval — expire 30 min from creation. Account ••••0650 only.</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                {proposalToast && <span style={{ fontSize: "12px", color: T.green }}>{proposalToast}</span>}
                <button
                  onClick={async () => {
                    try {
                      const r = await fetch("/api/agents/trader", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
                      const d = await r.json();
                      if (d.proposals?.length) { setProposals(prev => [...d.proposals, ...prev]); setProposalToast(`${d.created} new proposal(s)`); setTimeout(() => setProposalToast(""), 3000); }
                      else setProposalToast(d.reason ?? d.error ?? "No new proposals");
                      setTimeout(() => setProposalToast(""), 3000);
                    } catch {}
                  }}
                  style={{ padding: "7px 14px", background: T.accent + "18", border: `1px solid ${T.accent}35`, borderRadius: "7px", color: T.accent, fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
                >
                  ＋ Generate Proposals
                </button>
              </div>
            </div>

            {proposals.length === 0 ? (
              <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "40px 0" }}>
                <div style={{ fontSize: "28px", marginBottom: "10px" }}>⚡</div>
                No pending proposals. Click "Generate Proposals" or apply migration <a href="supabase/migrations/037_trader_proposals.sql" style={{ color: T.accent }}>037_trader_proposals.sql</a> first.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {proposals.map((p: any) => {
                  const expiresAt = new Date(p.approval_expires_at);
                  const expired = expiresAt < new Date();
                  const minutesLeft = Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 60000));
                  const priceDrift = p.current_price && p.price_at_proposal
                    ? Math.abs(p.current_price - p.price_at_proposal) / p.price_at_proposal
                    : 0;

                  return (
                    <div key={p.id} style={{ background: T.surface, borderRadius: "10px", padding: "16px", border: `1px solid ${expired ? T.muted : p.risk_check_pass ? T.border : T.red + "40"}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px" }}>
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px", flexWrap: "wrap" }}>
                            <span style={{ fontWeight: 700, fontSize: "16px" }}>{p.symbol}</span>
                            {dirBadge(p.side)}
                            <span style={{ fontWeight: 600, fontSize: "14px" }}>{p.qty} shares</span>
                            <span style={{ fontSize: "13px", color: T.muted }}>@ ${p.price_at_proposal?.toFixed(2)}</span>
                            <span style={{ fontSize: "12px", fontWeight: 600, padding: "2px 8px", borderRadius: "4px", background: p.status === "approved" ? T.greenBg : p.status === "pending_review" ? T.amberBg : T.border, color: p.status === "approved" ? T.green : p.status === "pending_review" ? T.amber : T.muted }}>
                              {p.status}
                            </span>
                          </div>
                          <div style={{ fontSize: "12px", color: T.textSub, maxWidth: "500px", lineHeight: "1.5" }}>{p.thesis?.slice(0, 200) ?? "No thesis"}{p.thesis?.length > 200 ? "…" : ""}</div>
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0, marginLeft: "16px" }}>
                          <div style={{ fontSize: "12px", color: T.muted, display: "flex", alignItems: "center", gap: "4px", justifyContent: "flex-end" }}>Score: <span style={{ fontWeight: 700, color: (p.analyst_score ?? 0) >= 70 ? T.green : T.amber }}>{p.analyst_score ?? "—"}</span><InfoTooltip title="Analyst Score" body="Composite score 0–100. Proposals with score above your Settings threshold are submitted for approval." placement="left" /></div>
                          <div style={{ fontSize: "11px", color: expired ? T.red : T.muted, marginTop: "2px" }}>
                            {expired ? "EXPIRED" : `Expires in ${minutesLeft}m`}
                          </div>
                          <div style={{ fontSize: "11px", color: T.muted, marginTop: "2px" }}>Est. ${p.estimated_value?.toFixed(0)} ({(p.pct_of_nav * 100).toFixed(1)}% NAV)</div>
                        </div>
                      </div>

                      {/* Risk check badges */}
                      {p.risk_check_reasons && (
                        <div style={{ marginTop: "10px", display: "flex", gap: "6px", flexWrap: "wrap" }}>
                          {Object.entries(p.risk_check_reasons).map(([k, v]: [string, any]) => (
                            <span key={k} style={{ fontSize: "10px", padding: "2px 7px", borderRadius: "4px", background: v.pass ? T.greenBg : T.redBg, color: v.pass ? T.green : T.red, fontWeight: 600 }}>
                              {v.pass ? "✓" : "✗"} {k}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Price drift warning */}
                      {priceDrift > 0.03 && (
                        <div style={{ marginTop: "8px", fontSize: "11px", color: T.amber, background: T.amberBg, padding: "5px 10px", borderRadius: "5px" }}>
                          ⚠ Price moved {(priceDrift * 100).toFixed(1)}% since proposal — review carefully before approving
                        </div>
                      )}

                      {/* Approve / Reject buttons */}
                      {p.status === "pending_review" && !expired && (
                        <div style={{ marginTop: "12px", display: "flex", gap: "8px" }}>
                          <button
                            onClick={async () => {
                              try {
                                const r = await fetch("/api/agents/trader", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve", proposal_id: p.id }) });
                                const d = await r.json();
                                if (d.success) {
                                  setProposals(prev => prev.map(pp => pp.id === p.id ? { ...pp, status: "approved" } : pp));
                                  setProposalToast(d.price_drift_warning ?? "Approved — open Robinhood to submit order");
                                } else setProposalToast("Error: " + (d.error ?? "unknown"));
                                setTimeout(() => setProposalToast(""), 4000);
                              } catch (e: any) { setProposalToast("Error: " + e.message); }
                            }}
                            style={{ padding: "7px 18px", background: T.greenBg, border: `1px solid ${T.green}40`, borderRadius: "7px", color: T.green, fontSize: "12px", fontWeight: 700, cursor: "pointer" }}
                          >
                            ✓ Approve
                          </button>
                          <button
                            onClick={async () => {
                              try {
                                const r = await fetch("/api/agents/trader", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reject", proposal_id: p.id, reason: "Rejected by user" }) });
                                const d = await r.json();
                                if (d.success) {
                                  setProposals(prev => prev.map(pp => pp.id === p.id ? { ...pp, status: "rejected" } : pp));
                                  setProposalToast("Rejected");
                                  setTimeout(() => setProposalToast(""), 2000);
                                }
                              } catch {}
                            }}
                            style={{ padding: "7px 14px", background: T.redBg, border: `1px solid ${T.red}40`, borderRadius: "7px", color: T.red, fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
                          >
                            ✗ Reject
                          </button>
                        </div>
                      )}

                      {/* Approved state — instruct user to submit via Robinhood */}
                      {p.status === "approved" && (
                        <div style={{ marginTop: "10px", fontSize: "12px", color: T.green, background: T.greenBg, padding: "8px 12px", borderRadius: "6px" }}>
                          ✓ Approved — submit via Robinhood MCP: <code style={{ background: T.card, padding: "1px 5px", borderRadius: "3px" }}>place_equity_order</code> on account 605420660
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Agent & Flow Architecture Section */}
      <div style={{ marginTop: 24, borderRadius: 12, border: "1px solid #1E2130", background: "#13151C", overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #1E2130", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#E2E8F0" }}>Agent &amp; Flow Architecture</span>
            <span style={{ fontSize: 10, color: "#64748B" }}>🤖 AI Agent = LLM reasons/decides · ⚙️ Flow = deterministic rules. Diagrams show current architecture (why each node exists).</span>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {[
              { id: "system-map", label: "System Map", kind: "map" },
              { id: "research-agent", label: "Research", kind: "ai" },
              { id: "deep-dive", label: "Deep-Dive", kind: "ai" },
              { id: "theme-scout", label: "ThemeScout", kind: "ai" },
              { id: "deepseek-agent", label: "DeepSeek", kind: "ai" },
              { id: "learner-agent", label: "LearnerAgent", kind: "ai" },
              { id: "macro-sentinel", label: "Macro Sentinel", kind: "ai" },
              { id: "paper-trader", label: "PaperTrader", kind: "flow" },
              { id: "position-monitor", label: "Position Monitor", kind: "flow" },
            ].map(a => (
              <button
                key={a.id}
                onClick={() => setSelectedDiagramAgent(a.id)}
                title={a.kind === "ai" ? "AI Agent — LLM reasons and decides" : a.kind === "map" ? "System Map — how every agent connects to the others" : "Flow — deterministic rules, no LLM decision"}
                style={{
                  padding: "4px 10px", fontSize: 11, fontWeight: 600, borderRadius: 5,
                  cursor: "pointer", border: "1px solid",
                  borderColor: selectedDiagramAgent === a.id ? "#6366F1" : a.kind === "map" ? "#6366F166" : "#1E2130",
                  background: selectedDiagramAgent === a.id ? "#6366F122" : "transparent",
                  color: selectedDiagramAgent === a.id ? "#6366F1" : a.kind === "map" ? "#818CF8" : "#64748B",
                }}
              >
                {a.kind === "ai" ? "🤖" : a.kind === "map" ? "🗺️" : "⚙️"} {a.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ height: 600 }}>
          <AgentDiagram agentId={selectedDiagramAgent} />
        </div>
      </div>
      </div>
    </div>
  );
}
