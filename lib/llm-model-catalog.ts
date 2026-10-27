// Single source of truth for the owner-facing model picker and its API guard.
// IDs are provider API IDs, never display-only aliases.
export const DEEPSEEK_FLASH_RELEASE = {
  apiModel: "deepseek-flash",
  advertisedRelease: "DeepSeek-V4.1-Flash-1017",
  verifiedOn: "2026-10-27",
  verification: "provider_documented_alias",
  source: "https://api-docs.deepseek.com/updates/",
  catalogVersion: "deepseek_release_20261027",
} as const;

export function isDeepSeekFlashAlias(model: unknown): boolean {
  return typeof model === "string" && ["deepseek-flash","deepseek-v4-flash","deepseek-v4-flash-vision-exp","deepseek-chat","deepseek-reasoner"].includes(model);
}
export function advertisedModelLabel(model: string): string {
  return isDeepSeekFlashAlias(model) ? DEEPSEEK_FLASH_RELEASE.advertisedRelease : model;
}
/** Config metadata only: never add this mutable catalog to model evidence/prompts. */
export function providerAliasReleaseSnapshot(models: readonly string[]) {
  return models.some(isDeepSeekFlashAlias) ? {"deepseek-flash":{...DEEPSEEK_FLASH_RELEASE}} : {};
}
export function deepSeekCouncilReleasePeriod(run: any): string {
  const stamped=run?.config_snapshot?.provider_alias_releases?.["deepseek-flash"];
  if(stamped?.catalogVersion===DEEPSEEK_FLASH_RELEASE.catalogVersion
    && stamped.advertisedRelease===DEEPSEEK_FLASH_RELEASE.advertisedRelease
    && stamped.apiModel===DEEPSEEK_FLASH_RELEASE.apiModel
    && stamped.source===DEEPSEEK_FLASH_RELEASE.source
    && stamped.verifiedOn===DEEPSEEK_FLASH_RELEASE.verifiedOn
    && stamped.verification===DEEPSEEK_FLASH_RELEASE.verification)
    return "1017_provider_documented_20261027";
  // Research can be hours older than collection. Its decision_ts is not a
  // model-call timestamp and cannot identify an alias release period.
  const at=Date.parse(run?.created_at ?? "");
  if(!Number.isFinite(at))return "unknown_time_unverified";
  if(at<Date.parse("2026-10-17T00:00:00Z"))return "before_20261017_unverified";
  if(at<Date.parse("2026-10-18T00:00:00Z"))return "rollout_20261017_unverified";
  return "after_20261017_unverified";
}
/** Preserve paired samples; independent subscription scores need no API-release split. */
export function councilProviderReleaseSuffix(key: string,run: any): string {
  const base=key.split("|")[0];
  const member=base.startsWith("model:");
  const deepSeekMember=member&&isDeepSeekFlashAlias(base.split(":")[1]);
  const members=run?.config_snapshot?.participant_models;
  const usesFlash=(Array.isArray(members)&&members.some(isDeepSeekFlashAlias))
    || (Array.isArray(run?.api_model_ids)&&run.api_model_ids.some(isDeepSeekFlashAlias));
  const influenced= !member || (base.endsWith(":debated")&&Number(run?.config_snapshot?.debate_rounds)>0);
  return deepSeekMember || (usesFlash&&influenced) ? `|dsflash=${deepSeekCouncilReleasePeriod(run)}` : "";
}
export function councilSeriesReleaseLabel(key: string): string {
  const period=key.split("|dsflash=")[1]?.split("|")[0];
  const labels:Record<string,string>={
    "1017_provider_documented_20261027":"V4.1-Flash-1017 · provider-documented alias; exact response revision unverified",
    "before_20261017_unverified":"Before Oct 17 update · historical revision unverified",
    "rollout_20261017_unverified":"Oct 17 rollout day · historical revision unverified",
    "after_20261017_unverified":"After Oct 17 update · historical revision unverified",
    "unknown_time_unverified":"Unknown period · historical revision unverified",
  };
  if(period)return labels[period]??"Unknown release context";
  if(key.includes("model:deepseek-"))return "Legacy DeepSeek result · release periods not separated";
  return /^(composite|deterministic|blend):/.test(key) ? "DeepSeek release context not recorded" : "";
}

export const CONFIGURABLE_MODELS = [
  "deepseek-flash",
  "deepseek-v4-pro",
  "gpt-5.6-luna",
  "claude-sonnet-4-6",
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4.1",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "deepseek-r1-distill-llama-70b",
  "claude-haiku-4-5",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "grok-4-fast",
  "grok-4",
  "glm-4.5-air",
  "glm-4.6",
] as const;

export type ConfigurableModel = (typeof CONFIGURABLE_MODELS)[number];

// Groq's official shutdown schedule: https://console.groq.com/docs/deprecations
// These IDs are retired for standard/developer usage. Keep them in the legacy
// general-agent catalog, but do not offer them to the council.
export const COUNCIL_RETIRED_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "deepseek-r1-distill-llama-70b",
] as const;

export const COUNCIL_MODELS = CONFIGURABLE_MODELS.filter(
  (model) => !(COUNCIL_RETIRED_MODELS as readonly string[]).includes(model),
);

export type CouncilModel = (typeof COUNCIL_MODELS)[number];

export function isConfigurableModel(value: unknown): value is ConfigurableModel {
  return typeof value === "string" && (CONFIGURABLE_MODELS as readonly string[]).includes(value);
}

export function isCouncilModel(value: unknown): value is CouncilModel {
  return typeof value === "string" && (COUNCIL_MODELS as readonly string[]).includes(value);
}
