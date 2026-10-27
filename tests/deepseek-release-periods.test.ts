import {describe,it,expect} from "vitest";
import {DEEPSEEK_FLASH_RELEASE,advertisedModelLabel,isConfigurableModel,providerAliasReleaseSnapshot,councilSeriesReleaseLabel} from "@/lib/llm-model-catalog";
import {councilVersionedSeriesKey,COUNCIL_PREDICTION_VERSION} from "@/lib/llm-council/core";
const run=(date:string,stamped=false)=>({created_at:date,decision_ts:"2026-09-01T00:00:00Z",prompt_version:`council-v1:${COUNCIL_PREDICTION_VERSION}`,
  config_snapshot:{participant_models:["deepseek-flash"],debate_rounds:0,...(stamped?{provider_alias_releases:providerAliasReleaseSnapshot(["deepseek-flash"])}:{})}});
describe("DeepSeek advertised release provenance",()=>{
  it("keeps the API ID separate from the advertised weights name",()=>{
    expect(advertisedModelLabel("deepseek-flash")).toBe("DeepSeek-V4.1-Flash-1017");
    expect(isConfigurableModel("deepseek-flash")).toBe(true);
    expect(isConfigurableModel("DeepSeek-V4.1-Flash-1017")).toBe(false);
    expect(advertisedModelLabel("deepseek-v4-pro")).toBe("deepseek-v4-pro");
  });
  it("snapshots documentation rather than claiming a response-pinned model",()=>{
    const data=providerAliasReleaseSnapshot(["deepseek-flash"]);
    expect(data["deepseek-flash"]).toEqual(DEEPSEEK_FLASH_RELEASE);
    expect(providerAliasReleaseSnapshot(["claude-sonnet-4-6"])).toEqual({});
    expect(data["deepseek-flash"]?.verification).toBe("provider_documented_alias");
  });
  it("never pools pre-update, rollout day, post-update, unknown-time or newly stamped forecasts",()=>{
    const key="model:deepseek-flash:independent";
    const keys=[run("2026-10-16T23:59:59Z"),run("2026-10-17T12:00:00Z"),run("2026-10-18T00:00:00Z"),run("bad"),run("2026-10-27T12:00:00Z",true)].map(r=>councilVersionedSeriesKey(key,r));
    expect(new Set(keys).size).toBe(5);
    expect(keys.every(k=>k.includes(`method=${COUNCIL_PREDICTION_VERSION}`))).toBe(true);
    expect(keys.slice(0,4).every(k=>councilSeriesReleaseLabel(k).includes("unverified"))).toBe(true);
    expect(councilSeriesReleaseLabel(keys[4])).toContain("exact response revision unverified");
  });
  it("keeps composite, baseline and blend on the exact same release period",()=>{
    const r=run("2026-10-27T12:00:00Z",true);
    const keys=["composite:median","deterministic:analyst_score_paired","blend:equal_weight_50_50_paired"].map(k=>councilVersionedSeriesKey(k,r));
    expect(new Set(keys.map(k=>k.split("|dsflash=")[1])).size).toBe(1);
    expect(keys.every(k=>k.includes("|dsflash="))).toBe(true);
  });
  it("uses collection time, never stale research time, for historical periods",()=>{
    const key=councilVersionedSeriesKey("model:deepseek-flash:independent",run("2026-10-20T12:00:00Z"));
    expect(key).toContain("after_20261017_unverified");
    expect(councilVersionedSeriesKey("model:deepseek-flash:independent",{decision_ts:"2026-10-20T12:00:00Z"})).toContain("unknown_time_unverified");
  });
  it("uses actual API fallbacks as composite context and preserves independent subscription series",()=>{
    const r=run("2026-10-27T12:00:00Z");
    expect(councilVersionedSeriesKey("model:claude-sonnet-4-6:subscription:independent",r)).not.toContain("dsflash=");
    expect(councilVersionedSeriesKey("model:claude-sonnet-4-6:subscription:debated",{...r,config_snapshot:{...r.config_snapshot,debate_rounds:1}})).toContain("dsflash=");
    expect(councilVersionedSeriesKey("composite:median",{...r,config_snapshot:{},api_model_ids:["deepseek-flash"]})).toContain("dsflash=");
    expect(councilVersionedSeriesKey("model:test-model:independent",{})).toBe("model:test-model:independent");
  });
});
