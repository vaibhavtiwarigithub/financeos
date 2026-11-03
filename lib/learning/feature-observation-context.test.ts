import {describe,expect,it,vi} from "vitest";
import {featureObservationContext,attachFeatureObservationContexts} from "./feature-observation-context";
import type {LabeledObservation} from "./dataset";

const observation=(id=1)=>({id,technical_score:0,fundamental_score:null,insider_score:50,availability_mask:{technical:true,fundamental:false,insider:false}} as unknown as LabeledObservation);
describe("point-in-time formula input quality",()=>{
  it("preserves a real zero and omits missing or unavailable neutral placeholders",()=>{
    expect(featureObservationContext(observation(),{technical:{rsi14:0},insider:{buys:0}})).toEqual({technical_score:0,"technical.rsi14":0,"evidence.technical.rsi14":0});
  });
  it("excludes structurally inapplicable dimensions even with an erroneous availability flag",()=>{
    expect(featureObservationContext(observation(),{dimension_applicability:{dimensions:{technical:{state:"not_applicable"}}},technical:{rsi14:50}})).toEqual({});
  });
  it("batches complete feature cohorts and scopes every read to the selected market",async()=>{
    const calls:number[][]=[]; const markets:string[]=[];
    const svc={from:()=>({select:()=>({eq:(_key:string,market:string)=>{markets.push(market);return {in:async(_key:string,ids:number[])=>{calls.push(ids);return {data:ids.map(id=>({id,features:{}})),error:null};}};}})})};
    const rows=await attachFeatureObservationContexts(svc,"india",Array.from({length:1001},(_,i)=>observation(i)));
    expect(calls.map(ids=>ids.length)).toEqual([500,500,1]);
    expect(markets).toEqual(["india","india","india"]);expect(rows).toHaveLength(1001);
  });
  it("refuses failed reads and missing members instead of analyzing a partial cohort",async()=>{
    const svc={from:()=>({select:()=>({eq:()=>({in:vi.fn().mockResolvedValue({data:[],error:null})})})})};
    await expect(attachFeatureObservationContexts(svc,"us",[observation()])).rejects.toThrow("incomplete");
  });
});
