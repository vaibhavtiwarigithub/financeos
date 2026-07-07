// Shared helper for advisory/on-demand features whose model should be
// user-configurable from Settings → Agents → LLM Config (agent_config table)
// instead of hardcoded — so a feature can be moved off Claude (or onto it,
// once ANTHROPIC_API_KEY is set) without a code change.
export async function getConfiguredModel(svc: any, agentName: string, fallback = "deepseek-v4-pro"): Promise<string> {
  try {
    const { data } = await svc.from("agent_config").select("model, enabled").eq("agent_name", agentName).maybeSingle();
    if (data && (data as any).enabled === false) return fallback; // disabled — still returns a safe default rather than blocking the caller
    return (data as any)?.model ?? fallback;
  } catch {
    return fallback;
  }
}
