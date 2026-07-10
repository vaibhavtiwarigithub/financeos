// lib/deepseek-agent.ts
// DeepSeek-based research agent.
// Routes the analysis step through DeepSeek (cheap model) for chat/summarize tasks.
// All signals tagged agent_label='deepseek' in DB for comparison vs Claude signals.

import { callLLM } from "@/lib/llm-router";
import { createServiceClient } from "@/lib/supabase/service";

export interface ResearchResult {
  symbol: string;
  direction: "long" | "short" | "hold";
  analystScore: number;
  rationale: string;
  source: string;
  // Extended fields from DeepSeek analysis — not persisted to DB, returned to caller
  confidence: number;
  risks: string;
  strategyTags: string[];
}

// Alpha Vantage response shapes (only the fields we use)
interface CompanyOverviewResponse {
  PERatio?: string;
  PEGRatio?: string;
  EPS?: string;
  RevenueGrowthYOY?: string;
  QuarterlyRevenueGrowthYOY?: string;
  ProfitMargin?: string;
  "52WeekHigh"?: string;
  "52WeekLow"?: string;
  Note?: string;
  Information?: string;
}

interface RSIResponse {
  "Technical Analysis: RSI"?: Record<string, { RSI: string }>;
  Note?: string;
  Information?: string;
}

interface DeepSeekAnalysis {
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  analyst_score: number;
  thesis: string;
  risks: string;
  strategy_tags: string[];
}

function actionToDirection(action: string): "long" | "short" | "hold" {
  if (action === "BUY") return "long";
  if (action === "SELL") return "short";
  return "hold";
}

async function fetchCompanyOverview(
  symbol: string,
  apiKey: string
): Promise<CompanyOverviewResponse> {
  const url = `https://www.alphavantage.co/query?function=COMPANY_OVERVIEW&symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Alpha Vantage COMPANY_OVERVIEW ${resp.status} for ${symbol}`);
  }
  return (await resp.json()) as CompanyOverviewResponse;
}

async function fetchRSI(
  symbol: string,
  apiKey: string
): Promise<number | null> {
  const url = `https://www.alphavantage.co/query?function=RSI&symbol=${encodeURIComponent(symbol)}&interval=daily&time_period=14&series_type=close&apikey=${apiKey}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Alpha Vantage RSI ${resp.status} for ${symbol}`);
  }
  const data = (await resp.json()) as RSIResponse;
  const series = data["Technical Analysis: RSI"];
  if (!series) return null;
  const latestDate = Object.keys(series)[0];
  if (!latestDate) return null;
  const rsiStr = series[latestDate]?.RSI;
  const rsiVal = rsiStr ? parseFloat(rsiStr) : NaN;
  return isNaN(rsiVal) ? null : rsiVal;
}

function parseDeepSeekResponse(text: string): DeepSeekAnalysis {
  // Strip markdown code fences if present
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as Partial<DeepSeekAnalysis>;
    const action = (parsed.action ?? "HOLD").toUpperCase() as "BUY" | "SELL" | "HOLD";
    return {
      action: ["BUY", "SELL", "HOLD"].includes(action) ? action : "HOLD",
      confidence:
        typeof parsed.confidence === "number"
          ? Math.min(100, Math.max(0, parsed.confidence))
          : 50,
      analyst_score:
        typeof parsed.analyst_score === "number"
          ? Math.min(100, Math.max(0, parsed.analyst_score))
          : 50,
      thesis: typeof parsed.thesis === "string" ? parsed.thesis : "No thesis provided.",
      risks: typeof parsed.risks === "string" ? parsed.risks : "Unknown risks.",
      strategy_tags: Array.isArray(parsed.strategy_tags) ? parsed.strategy_tags : [],
    };
  } catch {
    // Fallback on parse error
    return {
      action: "HOLD",
      confidence: 50,
      analyst_score: 50,
      thesis: "Unable to parse DeepSeek response.",
      risks: "Data quality or parsing issue.",
      strategy_tags: [],
    };
  }
}

/**
 * Run DeepSeek-based research for a single symbol.
 * 1. Fetches fundamentals + RSI from Alpha Vantage
 * 2. Sends prompt to DeepSeek via callLLM (cheap summarize task)
 * 3. Writes signal to agent_signals with agent_label='deepseek'
 * 4. Returns ResearchResult
 */
export async function runDeepSeekResearch(symbol: string): Promise<ResearchResult> {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) {
    throw new Error("ALPHA_VANTAGE_API_KEY is not set");
  }

  // 1. Fetch fundamentals and RSI in parallel
  const [overview, rsi] = await Promise.all([
    fetchCompanyOverview(symbol, apiKey),
    fetchRSI(symbol, apiKey),
  ]);

  // Check for API rate-limit responses
  if (overview.Note || overview.Information) {
    throw new Error(
      `Alpha Vantage rate limit or error for ${symbol}: ${overview.Note ?? overview.Information}`
    );
  }

  const pe = overview.PERatio ?? "N/A";
  const peg = overview.PEGRatio ?? "N/A";
  const eps = overview.EPS ?? "N/A";
  const revGrowth = overview.QuarterlyRevenueGrowthYOY ?? overview.RevenueGrowthYOY ?? "N/A";
  const margin = overview.ProfitMargin ?? "N/A";
  const high52 = overview["52WeekHigh"] ?? "N/A";
  const low52 = overview["52WeekLow"] ?? "N/A";
  const rsiDisplay = rsi !== null ? rsi.toFixed(1) : "N/A";

  // 2. Build prompt for DeepSeek
  const prompt = `You are a stock analyst. Analyze this data for ${symbol} and return ONLY valid JSON (no markdown):
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": 0-100,
  "analyst_score": 0-100,
  "thesis": "1-2 sentence rationale",
  "risks": "1 sentence key risk",
  "strategy_tags": ["Momentum"|"Value"|"GARP"|"Quality"|"Trend Follow"|"Mean Revert"|"CANSLIM-Lite"]
}

Data: PE=${pe}, PEG=${peg}, EPS=${eps}, Revenue growth YOY=${revGrowth}%, Profit margin=${margin}%, RSI(14)=${rsiDisplay}, 52w range: ${low52}-${high52}

Rules: BUY only if RSI<70 and fundamentals support growth. SELL if RSI>80 or deteriorating margins. HOLD otherwise. Confidence reflects data quality.`;

  // 3. Call DeepSeek via LLM router
  const llmResult = await callLLM({
    task: "summarize",
    prompt,
    model: "deepseek-v4-flash",
    symbol,
    agentLabel: "deepseek",
  });

  // 4. Parse JSON response
  const analysis = parseDeepSeekResponse(llmResult.text);
  const direction = actionToDirection(analysis.action);

  // 5. Write to agent_signals — map to existing schema columns
  const svc = createServiceClient();
  await svc.from("agent_signals").insert({
    symbol,
    direction,
    analyst_score: analysis.analyst_score,
    conviction: analysis.confidence,
    rationale: analysis.thesis,
    agent_label: "deepseek",
    agent_type: "deepseek-research",
    status: "advisory",
    score_source: "llm_advisory",   // P0: structural gate — excluded from paper/live signal consumption
  });

  return {
    symbol,
    direction,
    analystScore: analysis.analyst_score,
    rationale: analysis.thesis,
    source: "deepseek",
    confidence: analysis.confidence,
    risks: analysis.risks,
    strategyTags: analysis.strategy_tags,
  };
}
