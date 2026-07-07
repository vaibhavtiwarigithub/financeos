// Route tasks to the right LLM. Claude for accuracy-critical, DeepSeek for cheap tasks.
// Langfuse observability: enabled when LANGFUSE_SECRET_KEY + LANGFUSE_PUBLIC_KEY are set in .env.local.
// No-ops gracefully if keys are absent — zero runtime impact.
import type Anthropic from "@anthropic-ai/sdk"

export type LLMTask = "research" | "chat" | "summarize" | "trade" | "evaluate" | "thesis" | "screen" | "optimize"

export interface LLMCallOpts {
  task: LLMTask
  prompt: string
  systemPrompt?: string
  model?: string        // override default routing
  symbol?: string
  agentLabel?: string   // "claude" | "deepseek" | "gemini"
  maxTokens?: number
  runId?: string
}

export interface LLMResult {
  text: string
  model: string
  tokensIn: number
  tokensOut: number
  costUsd: number
  durationMs: number
}

// Routing table — Groq Llama free for quick screening, Claude for accuracy-critical
const MODEL_ROUTING: Record<LLMTask, string> = {
  research:  "claude-sonnet-4-6",
  trade:     "claude-sonnet-4-6",
  evaluate:  "claude-sonnet-4-6",
  thesis:    "claude-sonnet-4-6",
  optimize:  "claude-haiku-4-5-20251001",
  screen:    "llama-3.3-70b-versatile",  // Groq free — fast screener pre-filter
  chat:      "deepseek-v4-flash",
  summarize: "deepseek-v4-flash",
}

// Cost per 1M tokens [input, output] in USD (Groq free tier = $0)
const PRICING: Record<string, [number, number]> = {
  "claude-sonnet-4-6":         [3.00,  15.00],
  "claude-haiku-4-5":          [0.25,   1.25],
  "claude-haiku-4-5-20251001": [0.25,   1.25],
  "claude-opus-4-8":           [5.00,  25.00],
  // DeepSeek deprecated chat(V3)/reasoner(R1) → V4 flash/pro (2026-07). Old
  // keys kept for historical llm_call_log rows. V4 prices below are estimates
  // mirroring the tier each replaces — verify against DeepSeek's price page.
  "deepseek-chat":             [0.07,   0.28],
  "deepseek-reasoner":         [0.55,   2.19],
  "deepseek-v4-flash":         [0.07,   0.28],
  "deepseek-v4-pro":           [0.55,   2.19],
  "gemini-2.5-flash":          [0.075,  0.30],
  "llama-3.3-70b-versatile":   [0,      0],
  "llama-3.1-8b-instant":      [0,      0],
  "mixtral-8x7b-32768":        [0,      0],
  "deepseek-r1-distill-llama-70b": [0,  0],
}

const GROQ_MODELS = new Set([
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "mixtral-8x7b-32768",
  "gemma2-9b-it",
  "deepseek-r1-distill-llama-70b",
])

// Lazy Langfuse singleton — created once per process, reused across calls.
// Returns null if keys not configured (graceful no-op).
let _langfuse: unknown = null
function getLangfuse() {
  if (_langfuse) return _langfuse as any
  const sk = process.env.LANGFUSE_SECRET_KEY
  const pk = process.env.LANGFUSE_PUBLIC_KEY
  if (!sk || !pk) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Langfuse } = require("langfuse")
    _langfuse = new Langfuse({ secretKey: sk, publicKey: pk, flushAt: 5, flushInterval: 10_000 })
  } catch { return null }
  return _langfuse as any
}

export async function callLLM(opts: LLMCallOpts): Promise<LLMResult> {
  const model = opts.model ?? MODEL_ROUTING[opts.task] ?? "claude-sonnet-4-6"
  const start = Date.now()
  let tokensIn = 0, tokensOut = 0, text = "", success = true, errorMsg = ""

  const lf = getLangfuse()
  const trace = lf?.trace({
    name: `llm-${opts.task}`,
    userId: opts.agentLabel ?? "kairos",
    metadata: { symbol: opts.symbol, runId: opts.runId, task: opts.task },
  })
  const generation = trace?.generation({
    name: opts.task,
    model,
    input: opts.systemPrompt
      ? [{ role: "system", content: opts.systemPrompt }, { role: "user", content: opts.prompt }]
      : [{ role: "user", content: opts.prompt }],
  })

  try {
    if (model.startsWith("claude")) {
      const result = await callClaude(model, opts.prompt, opts.systemPrompt, opts.maxTokens)
      text = result.text
      tokensIn = result.tokensIn
      tokensOut = result.tokensOut
    } else if (model.startsWith("deepseek")) {
      const result = await callDeepSeek(model, opts.prompt, opts.systemPrompt, opts.maxTokens)
      text = result.text
      tokensIn = result.tokensIn
      tokensOut = result.tokensOut
    } else if (GROQ_MODELS.has(model)) {
      const result = await callGroq(model, opts.prompt, opts.systemPrompt, opts.maxTokens)
      text = result.text
      tokensIn = result.tokensIn
      tokensOut = result.tokensOut
    } else {
      throw new Error(`Unknown model: ${model}`)
    }
  } catch (err) {
    success = false
    errorMsg = String(err)
    generation?.end({ level: "ERROR", statusMessage: errorMsg })
    throw err
  } finally {
    const durationMs = Date.now() - start
    const [inRate, outRate] = PRICING[model] ?? [0, 0]
    const costUsd = (tokensIn / 1_000_000 * inRate) + (tokensOut / 1_000_000 * outRate)
    if (success) {
      generation?.end({
        output: text,
        usage: { inputTokens: tokensIn, outputTokens: tokensOut },
        metadata: { costUsd, durationMs },
      })
    }
    lf?.flushAsync?.().catch?.(() => {})
    await logCall({
      model,
      task: opts.task,
      tokensIn,
      tokensOut,
      costUsd,
      durationMs,
      success,
      errorMsg,
      symbol: opts.symbol,
      agentLabel: opts.agentLabel ?? "claude",
      runId: opts.runId,
    }).catch(() => {})
  }

  const durationMs = Date.now() - start
  const [inRate, outRate] = PRICING[model] ?? [0, 0]
  const costUsd = (tokensIn / 1_000_000 * inRate) + (tokensOut / 1_000_000 * outRate)
  return { text, model, tokensIn, tokensOut, costUsd, durationMs }
}

async function callClaude(
  model: string,
  prompt: string,
  system?: string,
  maxTokens = 4096
): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  // Use Anthropic SDK directly (server-side, uses ANTHROPIC_API_KEY env).
  // Falls back to claude-exec subprocess if SDK not available or API key missing.
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk")
    const client = new Anthropic()
    const messages: { role: "user" | "assistant"; content: string }[] = [
      { role: "user", content: prompt },
    ]
    const resp = await client.messages.create({
      model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages,
    })
    const textBlock = resp.content.find(b => b.type === "text")
    const text = textBlock && textBlock.type === "text" ? textBlock.text : ""
    return { text, tokensIn: resp.usage.input_tokens, tokensOut: resp.usage.output_tokens }
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string }
    if (e?.status === 401 || e?.message?.includes("API key")) {
      // execClaude only accepts a single prompt string — prepend system prompt inline
      const { execClaude, parseClaudeOutput, parseTokenUsage } = await import("@/lib/claude-exec")
      const combinedPrompt = system ? `${system}\n\n${prompt}` : prompt
      const stdout = await execClaude(combinedPrompt)
      const text = parseClaudeOutput(stdout)
      const usage = parseTokenUsage(stdout)
      return { text, tokensIn: usage.input, tokensOut: usage.output }
    }
    throw err
  }
}

async function callDeepSeek(
  model: string,
  prompt: string,
  system?: string,
  maxTokens = 4096
): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not set")

  const messages: { role: string; content: string }[] = []
  if (system) messages.push({ role: "system", content: system })
  messages.push({ role: "user", content: prompt })

  const resp = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(120_000),
  })

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`DeepSeek ${resp.status}: ${errText.slice(0, 200)}`)
  }

  const data = await resp.json()
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    tokensIn: data.usage?.prompt_tokens ?? 0,
    tokensOut: data.usage?.completion_tokens ?? 0,
  }
}

async function callGroq(
  model: string,
  prompt: string,
  system?: string,
  maxTokens = 4096
): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new Error("GROQ_API_KEY not set")

  const messages: { role: string; content: string }[] = []
  if (system) messages.push({ role: "system", content: system })
  messages.push({ role: "user", content: prompt })

  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(120_000),
  })

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Groq ${resp.status}: ${errText.slice(0, 200)}`)
  }

  const data = await resp.json()
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    tokensIn: data.usage?.prompt_tokens ?? 0,
    tokensOut: data.usage?.completion_tokens ?? 0,
  }
}

// ── Tool-use agent loop ──────────────────────────────────────────────────────

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface AgentLoopResult {
  text: string
  steps: number
  tokensIn: number
  tokensOut: number
  toolCalls: { name: string; args: Record<string, unknown>; result: string }[]
}

const AGENT_LOOP_TIMEOUT_MS = 120_000

/**
 * Run a tool-use agent loop. Dispatches by model provider:
 *   - Claude models  → Anthropic Messages tool-use loop (tool_use / tool_result blocks)
 *   - everything else → DeepSeek (OpenAI-compatible function calling)
 * The LLM can call tools in any order, multiple times, until it calls "finish"
 * or the model stops requesting tools.
 */
export async function runAgentLoop(opts: {
  model?: string
  systemPrompt: string
  initialMessage: string
  tools: ToolDef[]
  toolExecutor: (call: ToolCall) => Promise<string>
  maxIterations?: number
  task?: LLMTask
  agentLabel?: string
  runId?: string
  symbol?: string
}): Promise<AgentLoopResult> {
  const model = opts.model ?? "deepseek-v4-flash"
  const maxIter = opts.maxIterations ?? 12
  const start = Date.now()
  let result: AgentLoopResult | undefined
  let success = true, errorMsg = ""

  // Langfuse trace for the whole tool-loop. Previously only callLLM (single-shot
  // completions) was traced — the multi-step tool-calling agents (LearnerAgent,
  // MentorAgent) were invisible in Langfuse. This wraps the loop as one
  // generation span capturing the system prompt in, final text out, total
  // tokens, and the tool-call trail as metadata.
  const lf = getLangfuse()
  const trace = lf?.trace({
    name: `agent-loop-${opts.task ?? "agent"}`,
    userId: opts.agentLabel ?? "kairos",
    metadata: { symbol: opts.symbol, runId: opts.runId, task: opts.task, model },
  })
  const generation = trace?.generation({
    name: opts.task ?? "agent-loop",
    model,
    input: [{ role: "system", content: opts.systemPrompt }, { role: "user", content: opts.initialMessage }],
  })

  try {
    result = model.startsWith("claude")
      ? await runClaudeAgentLoop(opts, model, maxIter)
      : await runDeepSeekAgentLoop(opts, model, maxIter)
    return result
  } catch (err) {
    success = false
    errorMsg = String(err)
    generation?.end({ level: "ERROR", statusMessage: errorMsg })
    throw err
  } finally {
    // Record agent-loop usage in the central cost ledger (llm_call_log).
    // Without this, tool-loop agents (learner/research/mentor/…) are invisible
    // to /dashboard/admin/llm-history and total cost is undercounted.
    const durationMs = Date.now() - start
    const [inRate, outRate] = PRICING[model] ?? [0, 0]
    const tIn = result?.tokensIn ?? 0
    const tOut = result?.tokensOut ?? 0
    const costUsd = (tIn / 1_000_000 * inRate) + (tOut / 1_000_000 * outRate)
    if (success) {
      generation?.end({
        output: result?.text ?? "",
        usage: { inputTokens: tIn, outputTokens: tOut },
        metadata: { costUsd, durationMs, toolCalls: result?.toolCalls?.map(t => t.name) ?? [] },
      })
    }
    lf?.flushAsync?.().catch?.(() => {})
    logCall({
      model,
      task: opts.task ?? "agent-loop",
      tokensIn: tIn,
      tokensOut: tOut,
      costUsd,
      durationMs,
      success,
      errorMsg,
      symbol: opts.symbol,
      agentLabel: opts.agentLabel ?? "agent-loop",
      runId: opts.runId,
    }).catch(() => {})
  }
}

// ── Claude (Anthropic) tool-use loop ─────────────────────────────────────────
async function runClaudeAgentLoop(
  opts: { systemPrompt: string; initialMessage: string; tools: ToolDef[]; toolExecutor: (call: ToolCall) => Promise<string> },
  model: string,
  maxIter: number
): Promise<AgentLoopResult> {
  const { default: AnthropicSDK } = await import("@anthropic-ai/sdk")
  const client = new AnthropicSDK()

  const tools = opts.tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  }))

  // messages holds Anthropic content blocks (assistant tool_use, user tool_result)
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: opts.initialMessage },
  ]

  let totalIn = 0, totalOut = 0, steps = 0
  const callLog: AgentLoopResult["toolCalls"] = []

  for (let i = 0; i < maxIter; i++) {
    const resp = await client.messages.create(
      { model, max_tokens: 2048, system: opts.systemPrompt, tools, messages },
      { timeout: AGENT_LOOP_TIMEOUT_MS }
    )
    totalIn += resp.usage.input_tokens
    totalOut += resp.usage.output_tokens
    steps++

    messages.push({ role: "assistant", content: resp.content })

    const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    if (resp.stop_reason !== "tool_use" || toolUses.length === 0) {
      const textBlock = resp.content.find((b): b is Anthropic.TextBlock => b.type === "text")
      return { text: textBlock?.text ?? "", steps, tokensIn: totalIn, tokensOut: totalOut, toolCalls: callLog }
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    let finished: string | null = null
    for (const tu of toolUses) {
      const args = (tu.input ?? {}) as Record<string, unknown>
      let result = ""
      try {
        result = await opts.toolExecutor({ id: tu.id, name: tu.name, arguments: args })
      } catch (e) {
        result = `Error executing ${tu.name}: ${String(e)}`
      }
      callLog.push({ name: tu.name, args, result: result.slice(0, 500) })
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result })
      if (tu.name === "finish") finished = result
    }

    messages.push({ role: "user", content: toolResults })
    if (finished !== null) {
      return { text: finished, steps, tokensIn: totalIn, tokensOut: totalOut, toolCalls: callLog }
    }
  }

  const lastAssistant = [...messages].reverse().find(m => m.role === "assistant")
  const lastText = Array.isArray(lastAssistant?.content)
    ? (lastAssistant!.content.find((b: any) => b.type === "text") as any)?.text
    : lastAssistant?.content
  return { text: String(lastText ?? "max iterations reached"), steps, tokensIn: totalIn, tokensOut: totalOut, toolCalls: callLog }
}

// ── DeepSeek (OpenAI-compatible) tool-use loop ───────────────────────────────
async function runDeepSeekAgentLoop(
  opts: { systemPrompt: string; initialMessage: string; tools: ToolDef[]; toolExecutor: (call: ToolCall) => Promise<string> },
  model: string,
  maxIter: number
): Promise<AgentLoopResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not set — runAgentLoop requires DeepSeek for non-Claude models")

  const openAITools = opts.tools.map(t => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))

  const messages: { role: string; content: string | null; tool_call_id?: string; tool_calls?: unknown[] }[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.initialMessage },
  ]

  let totalIn = 0, totalOut = 0, steps = 0
  const callLog: AgentLoopResult["toolCalls"] = []

  for (let i = 0; i < maxIter; i++) {
    const resp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, tools: openAITools, tool_choice: "auto", max_tokens: 2048 }),
      signal: AbortSignal.timeout(AGENT_LOOP_TIMEOUT_MS),
    })

    if (!resp.ok) {
      const err = await resp.text()
      throw new Error(`DeepSeek tool-use ${resp.status}: ${err.slice(0, 300)}`)
    }

    const data = await resp.json()
    totalIn += data.usage?.prompt_tokens ?? 0
    totalOut += data.usage?.completion_tokens ?? 0
    steps++

    const choice = data.choices?.[0]
    const msg = choice?.message

    messages.push({ role: "assistant", content: msg?.content ?? null, tool_calls: msg?.tool_calls })

    if (!msg?.tool_calls || msg.tool_calls.length === 0 || choice?.finish_reason === "stop") {
      return { text: msg?.content ?? "", steps, tokensIn: totalIn, tokensOut: totalOut, toolCalls: callLog }
    }

    for (const tc of msg.tool_calls) {
      const fnName = tc.function?.name ?? ""
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(tc.function?.arguments ?? "{}") } catch { args = {} }

      let result = ""
      try {
        result = await opts.toolExecutor({ id: tc.id, name: fnName, arguments: args })
      } catch (e) {
        result = `Error executing ${fnName}: ${String(e)}`
      }

      callLog.push({ name: fnName, args, result: result.slice(0, 500) })
      messages.push({ role: "tool", content: result, tool_call_id: tc.id })

      if (fnName === "finish") {
        return { text: result, steps, tokensIn: totalIn, tokensOut: totalOut, toolCalls: callLog }
      }
    }
  }

  const lastMsg = messages.findLast(m => m.role === "assistant")
  return { text: String(lastMsg?.content ?? "max iterations reached"), steps, tokensIn: totalIn, tokensOut: totalOut, toolCalls: callLog }
}

// ── End tool-use loop ────────────────────────────────────────────────────────

async function logCall(d: {
  model: string
  task: string
  tokensIn: number
  tokensOut: number
  costUsd: number
  durationMs: number
  success: boolean
  errorMsg: string
  symbol?: string
  agentLabel?: string
  runId?: string
}) {
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  await svc.from("llm_call_log").insert({
    model: d.model,
    task_type: d.task,
    tokens_in: d.tokensIn,
    tokens_out: d.tokensOut,
    cost_usd: d.costUsd,
    duration_ms: d.durationMs,
    success: d.success,
    error_msg: d.errorMsg || null,
    symbol: d.symbol ?? null,
    agent_label: d.agentLabel ?? "claude",
    run_id: d.runId ?? null,
  })
}
