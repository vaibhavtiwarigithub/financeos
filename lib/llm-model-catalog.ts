// Manually curated allowlist for owner-facing API-model pickers. Keep this
// restricted to text-in/text-out models supported by lib/llm-router.ts; vendor
// /models endpoints also return embeddings, image, audio, retired, and
// account-inaccessible models. Review source links before changing this list.
export type CouncilEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export const COUNCIL_MODEL_IDS = [
  "deepseek-flash", "deepseek-v4-pro",
  "claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5-20251001",
  "gemini-3.8-flash", "gemini-3.1-pro-preview", "gemini-2.5-flash", "gemini-2.5-pro",
  "grok-4.7", "grok-4-fast", "grok-4",
  "gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra", "gpt-4o-mini", "gpt-4o", "gpt-4.1",
  "glm-4.5-air", "glm-4.6",
] as const;

export type CouncilModel = (typeof COUNCIL_MODEL_IDS)[number];
export type CouncilModelInfo = { id: CouncilModel; provider: string; efforts: readonly CouncilEffort[]; defaultEffort?: CouncilEffort; preview?: boolean };

export const COUNCIL_MODEL_CATALOG: readonly CouncilModelInfo[] = [
  { id: "deepseek-flash", provider: "DeepSeek", efforts: ["none", "low", "high", "max"], defaultEffort: "high" },
  { id: "deepseek-v4-pro", provider: "DeepSeek", efforts: ["none", "low", "high", "max"], defaultEffort: "high" },
  { id: "claude-sonnet-5", provider: "Anthropic", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
  { id: "claude-opus-5", provider: "Anthropic", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { id: "claude-haiku-4-5-20251001", provider: "Anthropic", efforts: [] },
  { id: "gemini-3.8-flash", provider: "Google", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { id: "gemini-3.1-pro-preview", provider: "Google", efforts: ["low", "medium", "high"], defaultEffort: "high", preview: true },
  { id: "gemini-2.5-flash", provider: "Google", efforts: [] },
  { id: "gemini-2.5-pro", provider: "Google", efforts: [] },
  { id: "grok-4.7", provider: "xAI", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
  { id: "grok-4-fast", provider: "xAI", efforts: [] },
  { id: "grok-4", provider: "xAI", efforts: [] },
  { id: "gpt-6-luna", provider: "OpenAI", efforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
  { id: "gpt-6.1-sol", provider: "OpenAI", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
  { id: "gpt-6-astra", provider: "OpenAI", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
  { id: "gpt-4o-mini", provider: "OpenAI", efforts: [] },
  { id: "gpt-4o", provider: "OpenAI", efforts: [] },
  { id: "gpt-4.1", provider: "OpenAI", efforts: [] },
  { id: "glm-4.5-air", provider: "Zhipu", efforts: [] },
  { id: "glm-4.6", provider: "Zhipu", efforts: [] },
] as const;

export const COUNCIL_MODELS = COUNCIL_MODEL_IDS;
export const CONFIGURABLE_MODELS = COUNCIL_MODELS;
export type ConfigurableModel = CouncilModel;

export function isConfigurableModel(value: unknown): value is ConfigurableModel {
  return typeof value === "string" && (COUNCIL_MODELS as readonly string[]).includes(value);
}

export function isCouncilModel(value: unknown): value is CouncilModel {
  return isConfigurableModel(value);
}

export function councilModelInfo(model: string) {
  return COUNCIL_MODEL_CATALOG.find((entry) => entry.id === model) ?? null;
}

export function supportedCouncilEfforts(model: string): readonly CouncilEffort[] {
  return councilModelInfo(model)?.efforts ?? [];
}

export function defaultCouncilEffort(model: string): CouncilEffort | null {
  return councilModelInfo(model)?.defaultEffort ?? null;
}

export function isValidCouncilEffort(model: string, effort: unknown): effort is CouncilEffort {
  return typeof effort === "string" && supportedCouncilEfforts(model).includes(effort as CouncilEffort);
}

// Provider-list documentation checked 2026-10-11. Subscription CLI models are
// deliberately not listed here: a membership login is not API access or billing.
export const COUNCIL_MODEL_SOURCE_URLS = {
  openai: "https://developers.openai.com/api/docs/models",
  anthropic: "https://docs.anthropic.com/en/docs/about-claude/model-deprecations",
  grok: "https://docs.x.ai/developers/models",
  google: "https://ai.google.dev/gemini-api/docs/models",
  deepseek: "https://api-docs.deepseek.com/api/list-models/",
} as const;
