// Single source of truth for the owner-facing model picker and its API guard.
// IDs are provider API IDs, never display-only aliases.
export const CONFIGURABLE_MODELS = [
  "deepseek-flash",
  "deepseek-v4-pro",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "deepseek-r1-distill-llama-70b",
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "grok-4-fast",
  "grok-4",
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4.1",
  "glm-4.5-air",
  "glm-4.6",
] as const;

export type ConfigurableModel = (typeof CONFIGURABLE_MODELS)[number];

export function isConfigurableModel(value: unknown): value is ConfigurableModel {
  return typeof value === "string" && (CONFIGURABLE_MODELS as readonly string[]).includes(value);
}
