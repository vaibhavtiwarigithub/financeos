// Route tasks to the right LLM. Claude for accuracy-critical, DeepSeek for cheap tasks.
// Langfuse observability: enabled when LANGFUSE_SECRET_KEY + LANGFUSE_PUBLIC_KEY are set in .env.local.
// No-ops gracefully if keys are absent — zero runtime impact.
import type Anthropic from "@anthropic-ai/sdk"
import { reportIssue } from "@/lib/system-health"
import { getProviderKey } from "@/lib/llm-keys"

export type LLMTask = "research" | "chat" | "summarize" | "trade" | "evaluate" | "thesis" | "screen" | "optimize"

// ── Tier aliases (System Health / Model Resilience, Phase 3) ──────────────────
// A ROLE ("fast" / "reasoning" per provider) → the current concrete model. This
// is the ONE place to update when a provider renames or deprecates a model, so a
// rename is a one-line change here instead of editing every agent_config row.
// callLLM/runAgentLoop resolve a tier alias to its concrete model, so a caller
// (or an agent_config row) may store either a concrete id OR a tier name.
export const TIER_MODELS: Record<string, string> = {
  "fast":         "deepseek-chat",
  "reasoning":    "deepseek-reasoner",
  "claude-fast":  "claude-haiku-4-5-20251001",
  "claude-smart": "claude-sonnet-4-6",
}

// Legacy model ids that must resolve to a still-valid concrete model. The
// "deepseek-v4-flash/pro" ids were never valid DeepSeek API names — they return
// empty content — so any stored agent_config row or hardcoded ref that still
// carries them is transparently rewritten to the real API ids here. One place,
// no data migration required for correctness.
const LEGACY_ALIASES: Record<string, string> = {
  "deepseek-v4-flash": "deepseek-chat",
  "deepseek-v4-pro":   "deepseek-reasoner",
}

function resolveModel(model: string): string {
  return TIER_MODELS[model] ?? LEGACY_ALIASES[model] ?? model
}

// Same-tier sibling to fall back to when a model is deprecated/unavailable. The
// fallback is ALWAYS same-tier (comparable capability) — never a blind jump to
// "latest" — and is loudly, persistently flagged via the System Health funnel so
// a human reviews the swap. Keeps the flow from hard-breaking on a rename.
const SAME_TIER_FALLBACK: Record<string, string> = {
  "deepseek-chat":             "deepseek-reasoner",
  "deepseek-reasoner":         "deepseek-chat",
  "claude-sonnet-4-6":         "claude-haiku-4-5-20251001",
  "claude-haiku-4-5-20251001": "claude-sonnet-4-6",
  "claude-opus-4-8":           "claude-sonnet-4-6",
  // Gemini / Grok fall back to the DeepSeek reasoner (always-configured tier)
  // rather than hard-failing if their key is missing or the model is renamed.
  "gemini-2.5-flash":          "deepseek-reasoner",
  "gemini-2.5-pro":            "deepseek-reasoner",
  "grok-4":                    "deepseek-reasoner",
  "grok-4-fast":               "deepseek-chat",
  "gpt-4o":                    "deepseek-reasoner",
  "gpt-4.1":                   "deepseek-reasoner",
  "gpt-4o-mini":               "deepseek-chat",
  "gpt-4.1-mini":              "deepseek-chat",
  "glm-4.6":                   "deepseek-reasoner",
  "glm-4.5-air":               "deepseek-chat",
}

// Does this error mean "the model doesn't exist / is deprecated" (vs a transient
// network/rate error we should NOT paper over with a different model)?
function isModelUnavailable(err: unknown): boolean {
  const s = String((err as any)?.message ?? err).toLowerCase()
  return /model.*(not exist|not found|does not exist|deprecat|invalid)|invalid_model|not_found_error|unknown model|\b404\b|\b400\b/.test(s)
}

// Is this a missing-API-key error (SDK throws before any HTTP call)?
function isAuthMissing(err: unknown): boolean {
  const s = String((err as any)?.message ?? err).toLowerCase()
  return s.includes("resolve authentication") || s.includes("api key") || (err as any)?.status === 401
}

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
  // Anthropic prompt-caching breakdown. Non-zero only for Claude calls with cache_control.
  // cacheWriteTokens: charged at 1.25× input rate (first write fills the cache).
  // cacheReadTokens:  charged at 0.10× input rate (subsequent reads — the big saving).
  cacheWriteTokens: number
  cacheReadTokens: number
  costUsd: number
  durationMs: number
}

// Routing table — DEFAULTS ONLY. Per-flow model comes from the agent_config
// table (Settings → Agents → LLM Config) via getConfiguredModel and is passed as
// opts.model, which overrides this. These defaults are the fallback when a caller
// does NOT pass a model. Policy: default OFF Claude — hard-reasoning tasks use the
// DeepSeek reasoner (the "thinking" tier), cheap tasks use deepseek-chat. Claude
// is opt-in per flow from Settings, never a silent default.
const MODEL_ROUTING: Record<LLMTask, string> = {
  research:  "deepseek-reasoner",
  trade:     "deepseek-reasoner",
  evaluate:  "deepseek-reasoner",
  thesis:    "deepseek-reasoner",
  optimize:  "deepseek-chat",
  screen:    "deepseek-chat",
  chat:      "deepseek-chat",
  summarize: "deepseek-chat",
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
  "gemini-2.5-pro":            [1.25,  10.00],
  // xAI Grok — verify against x.ai pricing page; estimates below.
  "grok-4":                    [3.00,  15.00],
  "grok-4-fast":               [0.20,   0.50],
  // OpenAI + Zhipu GLM — verify against each provider's price page; estimates.
  "gpt-4o":                    [2.50,  10.00],
  "gpt-4o-mini":               [0.15,   0.60],
  "gpt-4.1":                   [2.00,   8.00],
  "gpt-4.1-mini":              [0.40,   1.60],
  "glm-4.6":                   [0.60,   2.20],
  "glm-4.5-air":               [0.20,   1.10],
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

// Price a model, falling back to its same-tier sibling's price when a new model
// has no PRICING entry yet — so cost logging never silently records $0 for a real
// call. Flags the gap once (dedup'd) so the price gets verified. Never throws.
function priceFor(model: string): [number, number] {
  if (PRICING[model]) return PRICING[model]
  const sib = SAME_TIER_FALLBACK[model]
  if (sib && PRICING[sib]) {
    reportIssue({
      issueKey: `pricing-unverified:${model}`,
      severity: "info", category: "models",
      title: `No pricing for ${model} — logging cost at ${sib}'s rate`,
      detail: `${model} has no PRICING entry, so llm_call_log is using ${sib}'s rate as an estimate. Add ${model} to PRICING in lib/llm-router.ts to make cost exact.`,
    }).catch(() => {})
    return PRICING[sib]
  }
  reportIssue({
    issueKey: `pricing-unverified:${model}`,
    severity: "info", category: "models",
    title: `No pricing for ${model} — cost logged as $0`,
    detail: `${model} has no PRICING entry and no known sibling, so its cost is logged as $0. Add it to PRICING in lib/llm-router.ts.`,
  }).catch(() => {})
  return [0, 0]
}

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

// ── Provider registry (plug-and-play) ────────────────────────────────────────
// Add a new LLM backend without touching this file:
//   import { registerLLMProvider } from "@/lib/llm-router";
//   registerLLMProvider(m => m.startsWith("gemini"), callGemini);
// Custom providers are tried BEFORE built-ins, so they can override any model.

type ProviderCallFn = (
  model: string,
  prompt: string,
  system: string | undefined,
  maxTokens: number,
) => Promise<{ text: string; tokensIn: number; tokensOut: number; cacheWriteTokens?: number; cacheReadTokens?: number }>

const _customProviders: Array<{ test: (m: string) => boolean; fn: ProviderCallFn }> = []

export function registerLLMProvider(test: (model: string) => boolean, fn: ProviderCallFn): void {
  _customProviders.push({ test, fn })
}

async function dispatchProvider(model: string, opts: LLMCallOpts): Promise<{ text: string; tokensIn: number; tokensOut: number; cacheWriteTokens?: number; cacheReadTokens?: number }> {
  // Custom providers take priority (last-registered wins among customs).
  for (let i = _customProviders.length - 1; i >= 0; i--) {
    if (_customProviders[i].test(model)) {
      return _customProviders[i].fn(model, opts.prompt, opts.systemPrompt, opts.maxTokens ?? 4096)
    }
  }
  // Built-in dispatch
  if (model.startsWith("claude")) return callClaude(model, opts.prompt, opts.systemPrompt, opts.maxTokens, opts.task)
  if (model.startsWith("deepseek")) return callDeepSeek(model, opts.prompt, opts.systemPrompt, opts.maxTokens)
  if (model.startsWith("gemini")) return callGemini(model, opts.prompt, opts.systemPrompt, opts.maxTokens)
  if (model.startsWith("grok")) return callGrok(model, opts.prompt, opts.systemPrompt, opts.maxTokens)
  if (model.startsWith("gpt") || /^o[134]/.test(model)) return callOpenAI(model, opts.prompt, opts.systemPrompt, opts.maxTokens)
  if (model.startsWith("glm")) return callGLM(model, opts.prompt, opts.systemPrompt, opts.maxTokens)
  if (GROQ_MODELS.has(model)) return callGroq(model, opts.prompt, opts.systemPrompt, opts.maxTokens)
  throw new Error(`Unknown model: ${model}`)
}

export async function callLLM(opts: LLMCallOpts): Promise<LLMResult> {
  // Resolve a tier alias ("fast"/"reasoning") to its concrete model.
  let model = resolveModel(opts.model ?? MODEL_ROUTING[opts.task] ?? "claude-sonnet-4-6")
  const start = Date.now()
  let tokensIn = 0, tokensOut = 0, cacheWriteTokens = 0, cacheReadTokens = 0, text = "", success = true, errorMsg = ""

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
    let result
    try {
      result = await dispatchProvider(model, opts)
    } catch (err) {
      // Graceful, LOUD fallback: a deprecated/unknown model swaps to its
      // same-tier sibling and raises a persistent System Health issue — the run
      // completes instead of hard-failing, and the swap is flagged for review.
      const fb = SAME_TIER_FALLBACK[model]
      if (isModelUnavailable(err) && fb && fb !== model) {
        await reportIssue({
          issueKey: `model-fallback:${model}`,
          severity: "warn", category: "models",
          title: `${model} unavailable — ran ${opts.agentLabel ?? opts.task} on ${fb} instead`,
          detail: `${model} failed as unavailable/deprecated (${String(err).slice(0, 160)}). Fell back to the same-tier model ${fb}. Update the model assignment (Agents → Model Config) or the TIER_MODELS map in lib/llm-router.ts.`,
        })
        model = fb
        result = await dispatchProvider(fb, opts)
      } else if (isAuthMissing(err) && !model.startsWith("deepseek")) {
        // Anthropic API key missing from env — fall back to DeepSeek so the run
        // doesn't hard-fail. Raises a persistent alert so the key gets re-added.
        const deepseekFb = SAME_TIER_FALLBACK[model] ?? "deepseek-chat"
        await reportIssue({
          issueKey: `provider-key-missing:${model}`,
          severity: "critical", category: "models",
          title: "ANTHROPIC_API_KEY missing — Claude calls falling back to DeepSeek",
          detail: `${model} auth failed: ${String(err).slice(0, 200)}. Add ANTHROPIC_API_KEY to Vercel environment variables and redeploy.`,
        })
        model = deepseekFb
        result = await dispatchProvider(deepseekFb, opts)
      } else {
        throw err
      }
    }
    text = result.text
    tokensIn = result.tokensIn
    tokensOut = result.tokensOut
    cacheWriteTokens = result.cacheWriteTokens ?? 0
    cacheReadTokens = result.cacheReadTokens ?? 0
  } catch (err) {
    success = false
    errorMsg = String(err)
    generation?.end({ level: "ERROR", statusMessage: errorMsg })
    throw err
  } finally {
    const durationMs = Date.now() - start
    const [inRate, outRate] = priceFor(model)
    // Cache write: 1.25× input rate. Cache read: 0.10× input rate.
    const costUsd = (tokensIn / 1_000_000 * inRate)
      + (cacheWriteTokens / 1_000_000 * inRate * 1.25)
      + (cacheReadTokens  / 1_000_000 * inRate * 0.10)
      + (tokensOut / 1_000_000 * outRate)
    if (success) {
      generation?.end({
        output: text,
        usage: { inputTokens: tokensIn, outputTokens: tokensOut },
        metadata: { costUsd, durationMs, cacheWriteTokens, cacheReadTokens },
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
  const [inRate, outRate] = priceFor(model)
  const costUsd = (tokensIn / 1_000_000 * inRate)
    + (cacheWriteTokens / 1_000_000 * inRate * 1.25)
    + (cacheReadTokens  / 1_000_000 * inRate * 0.10)
    + (tokensOut / 1_000_000 * outRate)
  return { text, model, tokensIn, tokensOut, cacheWriteTokens, cacheReadTokens, costUsd, durationMs }
}

// Tasks that benefit from Anthropic extended thinking when a Claude model is
// chosen. Reasoning-heavy work (research/trade/evaluate/thesis) gets a thinking
// budget; cheap/conversational tasks stay non-thinking to save latency + cost.
const THINKING_TASKS = new Set<LLMTask>(["research", "trade", "evaluate", "thesis"])

async function callClaude(
  model: string,
  prompt: string,
  system?: string,
  maxTokens = 4096,
  task?: LLMTask
): Promise<{ text: string; tokensIn: number; tokensOut: number; cacheWriteTokens: number; cacheReadTokens: number }> {
  // Use Anthropic SDK directly (server-side, uses ANTHROPIC_API_KEY env).
  // System prompt is sent with cache_control: { type: "ephemeral" } so repeated calls
  // with the same system prompt (ResearchAgent daily runs, briefings, etc.) hit the
  // cache and pay 0.10× input rate instead of 1×. Cache writes pay 1.25× once, then
  // every subsequent read is 10× cheaper. TTL: 5 minutes per Anthropic docs.
  //
  // NOTE: no local-CLI (execClaude/PowerShell) fallback on error. That path only
  // works on a Windows dev box and hard-crashes on Vercel Linux with
  // `spawn powershell.exe ENOENT`. On a 401/missing-key we let the error
  // propagate so callLLM's isAuthMissing handler swaps to DeepSeek instead.
  const { default: Anthropic } = await import("@anthropic-ai/sdk")
  // Vault-first key (Settings) → env fallback. undefined lets the SDK read env itself.
  const client = new Anthropic({ apiKey: (await getProviderKey("anthropic")) ?? undefined })
  const messages: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: prompt },
  ]
  // Extended thinking for reasoning tasks. budget must be < max_tokens, so bump
  // max_tokens to leave room for the visible answer on top of the thinking budget.
  const wantThinking = task != null && THINKING_TASKS.has(task)
  const thinkingBudget = 2048
  const effectiveMax = wantThinking ? Math.max(maxTokens, thinkingBudget + 1536) : maxTokens
  const resp = await client.messages.create({
    model,
    max_tokens: effectiveMax,
    ...(wantThinking ? { thinking: { type: "enabled" as const, budget_tokens: thinkingBudget } } : {}),
    ...(system ? { system: [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }] } : {}),
    messages,
  })
  const textBlock = resp.content.find(b => b.type === "text")
  const text = textBlock && textBlock.type === "text" ? textBlock.text : ""
  const u = resp.usage as typeof resp.usage & { cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
  return {
    text,
    tokensIn: u.input_tokens,
    tokensOut: u.output_tokens,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  }
}

async function callDeepSeek(
  model: string,
  prompt: string,
  system?: string,
  maxTokens = 4096
): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  const apiKey = await getProviderKey("deepseek")
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
  const choice = data.choices?.[0]
  const text = choice?.message?.content ?? ""
  if (!text) {
    // Empty `content` has two very different causes; distinguish them so a VALID
    // model isn't flagged as dead. deepseek-reasoner (R1) streams chain-of-thought
    // into `reasoning_content` and the answer into `content`; if the call is cut at
    // max_tokens mid-reasoning (finish_reason "length"), `content` is empty while
    // the model clearly responded. That is a transient truncation, NOT a bad model.
    // Only word the error with "invalid/not found" when the response is genuinely
    // empty — because callLLM's isModelUnavailable() keys on those words to raise
    // the persistent "model deprecated/unavailable" System Health alert. A truncated
    // reasoner reply still throws (so same-tier fallback fires for that one call) but
    // must NOT masquerade as a dead model and spam the health funnel.
    const reasoning = choice?.message?.reasoning_content ?? ""
    const finish = choice?.finish_reason ?? ""
    if (reasoning || finish === "length") {
      throw new Error(`DeepSeek model ${model} returned no answer content (finish_reason=${finish || "?"}, reasoning_len=${reasoning.length}) — transient truncation, retrying via same-tier fallback (raw: ${JSON.stringify(data).slice(0, 200)})`)
    }
    // Genuinely empty response (no content, no reasoning) — likely an invalid/renamed
    // model id. Keep the "invalid" wording so the unavailable-model alert fires.
    throw new Error(`DeepSeek model ${model} returned empty content — model may be invalid or not found (raw: ${JSON.stringify(data).slice(0, 200)})`)
  }
  return {
    text,
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
  const apiKey = await getProviderKey("groq")
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

// xAI Grok — OpenAI-compatible Chat Completions at api.x.ai.
async function callGrok(
  model: string,
  prompt: string,
  system?: string,
  maxTokens = 4096
): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  const apiKey = await getProviderKey("grok")
  if (!apiKey) throw new Error("XAI_API_KEY not set")

  const messages: { role: string; content: string }[] = []
  if (system) messages.push({ role: "system", content: system })
  messages.push({ role: "user", content: prompt })

  const resp = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Grok ${resp.status}: ${errText.slice(0, 200)}`)
  }
  const data = await resp.json()
  const text = data.choices?.[0]?.message?.content ?? ""
  if (!text) throw new Error(`Grok model ${model} returned empty content (raw: ${JSON.stringify(data).slice(0, 200)})`)
  return { text, tokensIn: data.usage?.prompt_tokens ?? 0, tokensOut: data.usage?.completion_tokens ?? 0 }
}

// Google Gemini — Generative Language API (different request/response shape).
async function callGemini(
  model: string,
  prompt: string,
  system?: string,
  maxTokens = 4096
): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  const apiKey = await getProviderKey("gemini")
  if (!apiKey) throw new Error("GEMINI_API_KEY not set")

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens },
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  }
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Gemini ${resp.status}: ${errText.slice(0, 200)}`)
  }
  const data = await resp.json()
  const text = (data.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("")
  if (!text) throw new Error(`Gemini model ${model} returned empty content (raw: ${JSON.stringify(data).slice(0, 200)})`)
  return {
    text,
    tokensIn: data.usageMetadata?.promptTokenCount ?? 0,
    tokensOut: data.usageMetadata?.candidatesTokenCount ?? 0,
  }
}

// OpenAI (ChatGPT) — standard Chat Completions.
async function callOpenAI(
  model: string,
  prompt: string,
  system?: string,
  maxTokens = 4096
): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  const apiKey = await getProviderKey("openai")
  if (!apiKey) throw new Error("OPENAI_API_KEY not set")

  const messages: { role: string; content: string }[] = []
  if (system) messages.push({ role: "system", content: system })
  messages.push({ role: "user", content: prompt })

  // Reasoning models (o1/o3/o4) use max_completion_tokens and reject temperature.
  const isReasoner = /^o[134]/.test(model)
  const body: Record<string, unknown> = { model, messages }
  body[isReasoner ? "max_completion_tokens" : "max_tokens"] = maxTokens

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`OpenAI ${resp.status}: ${errText.slice(0, 200)}`)
  }
  const data = await resp.json()
  const text = data.choices?.[0]?.message?.content ?? ""
  if (!text) throw new Error(`OpenAI model ${model} returned empty content (raw: ${JSON.stringify(data).slice(0, 200)})`)
  return { text, tokensIn: data.usage?.prompt_tokens ?? 0, tokensOut: data.usage?.completion_tokens ?? 0 }
}

// Zhipu GLM — OpenAI-compatible Chat Completions.
async function callGLM(
  model: string,
  prompt: string,
  system?: string,
  maxTokens = 4096
): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  const apiKey = await getProviderKey("glm")
  if (!apiKey) throw new Error("GLM_API_KEY not set")

  const messages: { role: string; content: string }[] = []
  if (system) messages.push({ role: "system", content: system })
  messages.push({ role: "user", content: prompt })

  const resp = await fetch("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`GLM ${resp.status}: ${errText.slice(0, 200)}`)
  }
  const data = await resp.json()
  const text = data.choices?.[0]?.message?.content ?? ""
  if (!text) throw new Error(`GLM model ${model} returned empty content (raw: ${JSON.stringify(data).slice(0, 200)})`)
  return { text, tokensIn: data.usage?.prompt_tokens ?? 0, tokensOut: data.usage?.completion_tokens ?? 0 }
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
  let model = resolveModel(opts.model ?? "deepseek-v4-flash")
  // Tool loops have typed implementations only for Anthropic and DeepSeek.
  // Do not accidentally send another provider's model id to DeepSeek's API.
  if (!model.startsWith("claude") && !model.startsWith("deepseek")) {
    const requested = model
    model = SAME_TIER_FALLBACK[requested] ?? "deepseek-chat"
    await reportIssue({
      issueKey: `tool-loop-provider-fallback:${requested}`,
      severity: "warn", category: "models",
      title: `${requested} is not enabled for tool loops; using ${model}`,
      detail: `Single-shot calls support ${requested}, but runAgentLoop currently supports Claude and DeepSeek only.`,
    }).catch(() => {})
  }
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
    try {
      result = model.startsWith("claude")
        ? await runClaudeAgentLoop(opts, model, maxIter)
        : await runDeepSeekAgentLoop(opts, model, maxIter)
    } catch (err) {
      if (!model.startsWith("claude") || !isAuthMissing(err)) throw err
      const requested = model
      model = "deepseek-chat"
      await reportIssue({
        issueKey: `provider-key-missing:${requested}`,
        severity: "critical", category: "models",
        title: `${requested} credentials missing; tool loop fell back to DeepSeek`,
        detail: `${requested} auth failed: ${String(err).slice(0, 200)}. Add the Anthropic key in Settings or the deployment environment.`,
      }).catch(() => {})
      result = await runDeepSeekAgentLoop(opts, model, maxIter)
    }
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
    const [inRate, outRate] = priceFor(model)
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
  const client = new AnthropicSDK({ apiKey: (await getProviderKey("anthropic")) ?? undefined })

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

  const cachedSystemBlock = [{ type: "text" as const, text: opts.systemPrompt, cache_control: { type: "ephemeral" as const } }]

  for (let i = 0; i < maxIter; i++) {
    const resp = await client.messages.create(
      { model, max_tokens: 2048, system: cachedSystemBlock, tools, messages },
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
  const apiKey = await getProviderKey("deepseek")
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
