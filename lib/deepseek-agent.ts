// lib/deepseek-agent.ts
// Skeleton for the DeepSeek-based research agent.
// Mirrors the Claude research agent logic but routes the analysis step through DeepSeek.
//
// TODO steps:
//   1. Set DEEPSEEK_API_KEY in .env.local
//   2. Install the DeepSeek SDK or use the OpenAI-compatible endpoint:
//        https://api.deepseek.com/v1  (model: "deepseek-chat" or "deepseek-reasoner")
//   3. Write the research prompt (mirrors the Claude prompt in lib/research-agent.ts).
//   4. Insert resulting signals with agent_label = 'deepseek' so comparison route picks them up.
//   5. Uncomment the import in app/api/agents/deepseek-research/route.ts.

export interface ResearchResult {
  symbol: string;
  direction: "long" | "short" | "hold";
  analystScore: number;
  rationale: string;
  source: string;
}

/**
 * Run DeepSeek-based research for a single symbol.
 * Replace this stub with real DeepSeek API calls + DB writes.
 */
export async function runDeepSeekResearch(
  _symbol: string
): Promise<ResearchResult> {
  throw new Error(
    "runDeepSeekResearch is not yet implemented — see lib/deepseek-agent.ts TODO comments"
  );
}
