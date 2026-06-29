// Route tasks to the right LLM. Claude for accuracy-critical, DeepSeek for cheap tasks.
export type LLMTask = "research" | "chat" | "summarize" | "trade" | "evaluate" | "thesis"

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

// Routing table
const MODEL_ROUTING: Record<LLMTask, string> = {
  research:  "claude-sonnet-4-6",
  trade:     "claude-sonnet-4-6",
  evaluate:  "claude-sonnet-4-6",
  thesis:    "claude-sonnet-4-6",
  chat:      "deepseek-chat",
  summarize: "deepseek-chat",
}

// Cost per 1M tokens [input, output] in USD
const PRICING: Record<string, [number, number]> = {
  "claude-sonnet-4-6":  [3.00, 15.00],
  "claude-haiku-4-5":   [0.25,  1.25],
  "deepseek-chat":      [0.07,  0.28],
  "deepseek-reasoner":  [0.55,  2.19],
  "gemini-2.5-flash":   [0.075, 0.30],
}

export async function callLLM(opts: LLMCallOpts): Promise<LLMResult> {
  const model = opts.model ?? MODEL_ROUTING[opts.task] ?? "claude-sonnet-4-6"
  const start = Date.now()
  let tokensIn = 0, tokensOut = 0, text = "", success = true, errorMsg = ""

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
    } else {
      throw new Error(`Unknown model: ${model}`)
    }
  } catch (err) {
    success = false
    errorMsg = String(err)
    throw err
  } finally {
    const durationMs = Date.now() - start
    const [inRate, outRate] = PRICING[model] ?? [0, 0]
    const costUsd = (tokensIn / 1_000_000 * inRate) + (tokensOut / 1_000_000 * outRate)
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
    const text = resp.content[0].type === "text" ? resp.content[0].text : ""
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
