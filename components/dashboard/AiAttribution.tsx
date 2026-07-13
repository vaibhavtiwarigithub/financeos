// AiAttribution — a compact "who answered" chip for Mentor AI responses.
// Shows the agent surface + a friendly LLM model label, plus a subtle hint
// about whether the answer came from a multi-step tool-using agent loop or a
// single grounded call. Purely presentational; safe to render anywhere.

const T = {
  card: "#1A1D27",
  border: "#252836",
  text: "#ECEDEF",
  textSub: "#9B9EA8",
  muted: "#6B7280",
  accent: "#6366F1",
};

// Friendly model labels — fall back to the raw id for anything unmapped.
const MODEL_LABELS: Record<string, string> = {
  "deepseek-reasoner": "DeepSeek Reasoner",
  "deepseek-chat": "DeepSeek Chat",
  "claude-sonnet-4-6": "Claude Sonnet",
  "claude-haiku-4-5": "Claude Haiku",
  "gpt-4o": "GPT-4o",
  "gpt-4o-mini": "GPT-4o mini",
  "gpt-4.1": "GPT-4.1",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "grok-4": "Grok 4",
  "grok-4-fast": "Grok 4 fast",
  "glm-4.6": "GLM-4.6",
  "glm-4.5-air": "GLM-4.5 Air",
  "llama-3.3-70b-versatile": "Llama 3.3 70B",
};

const AGENT_EMOJI: Record<string, string> = {
  "Ask the Agent": "🧠",
  "AI Coach": "🎓",
  "Judgment Coach": "⚖️",
  "Market Thesis": "🔬",
};

function friendlyModel(model: string): string {
  return MODEL_LABELS[model] ?? model;
}

export default function AiAttribution({
  agent,
  model,
  agentKind,
  toolsUsed,
  steps,
}: {
  agent: string;
  model: string;
  agentKind?: "agent-loop" | "grounded";
  toolsUsed?: string[];
  steps?: number;
}) {
  if (!agent || !model) return null;

  const emoji = AGENT_EMOJI[agent] ?? "🤖";
  const modelLabel = friendlyModel(model);
  const toolCount = toolsUsed?.length ?? 0;

  // Subtle suffix telling the user HOW the answer was produced.
  let suffix = "";
  if (agentKind === "agent-loop") {
    suffix = toolCount > 0 ? ` · ${toolCount} tool${toolCount === 1 ? "" : "s"}` : " · agent";
  } else if (agentKind === "grounded") {
    suffix = " · grounded";
  }

  // Honest tooltip.
  let tip = `Answered by the ${agent} surface running ${modelLabel}.`;
  if (agentKind === "agent-loop") {
    if (toolCount > 0) {
      tip += ` It queried your data with ${toolCount} tool${toolCount === 1 ? "" : "s"}`;
      tip += steps != null ? ` across ${steps} step${steps === 1 ? "" : "s"}.` : ".";
    } else {
      tip += " It ran as a multi-step tool-using agent.";
    }
  } else if (agentKind === "grounded") {
    tip += " A single grounded call over your real data — no tool loop.";
  }

  return (
    <span
      title={tip}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        fontSize: "10.5px",
        fontWeight: 600,
        lineHeight: 1,
        padding: "3px 8px",
        borderRadius: "6px",
        background: T.card,
        border: `1px solid ${T.border}`,
        color: T.textSub,
        whiteSpace: "nowrap",
        verticalAlign: "middle",
      }}
    >
      <span style={{ fontSize: "11px" }}>{emoji}</span>
      <span style={{ color: T.text }}>{agent}</span>
      <span style={{ color: T.muted }}>·</span>
      <span style={{ color: T.accent }}>{modelLabel}</span>
      {suffix && <span style={{ color: T.muted }}>{suffix}</span>}
    </span>
  );
}
