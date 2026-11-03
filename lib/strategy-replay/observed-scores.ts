import type {Bar} from "./compile";
import type {Predicate,RuleSpec,Indicator} from "./rule-spec";
import {getMarketDayStatus,researchSessionCloseAt} from "@/lib/trading/market-calendar";
import {featureObservationContext} from "@/lib/learning/feature-observation-context";
import type {LabeledObservation} from "@/lib/learning/dataset";

function observed(indicator:Indicator){return indicator.fn==="observed_score";}
export function needsObservedScores(spec:RuleSpec):boolean {
  const visit=(p:Predicate):boolean=>p.op==="cmp" ? observed(p.left) : p.op==="cmp2" ? observed(p.left)||observed(p.right)
    : p.op==="and"||p.op==="or" ? p.terms.some(visit) : p.op==="not" ? visit(p.term) : false;
  return visit(spec.entry)||visit(spec.exit);
}

/** Latest actual same-session observation available by the close; never backfills or forward-fills scores. */
export function alignObservedScores(market:"us"|"india",bars:Bar[],rows:any[]):Bar[] {
  const bySession=new Map<string,Bar["observation"]>();
  for(const row of [...rows].sort((a,b)=>String(a.ts).localeCompare(String(b.ts)) || Number(a.id)-Number(b.id))){
    const ts=Date.parse(row.ts);if(!Number.isFinite(ts) || row.market!==market)continue;
    const day=getMarketDayStatus(market,new Date(ts));
    const close=researchSessionCloseAt(market,day.localYmd);
    if(day.kind!=="trading_day" || close==null || ts>close)continue;
    const values=featureObservationContext(row as LabeledObservation,{dimension_applicability:row.dimension_applicability});
    if(typeof row.entry_eligible!=="boolean")continue;
    bySession.set(day.localYmd,{id:Number(row.id),ts:row.ts,market,session:day.localYmd,sessionCloseAt:close,codeVersion:row.code_version ?? null,values,baselineEntryEligible:row.entry_eligible});
  }
  return bars.map(bar=>({...bar,observation:bySession.get(bar.session)}));
}

export async function attachObservedScores(svc:any,market:"us"|"india",symbol:string,bars:Bar[],cache?:Map<string,any>):Promise<Bar[]> {
  if(!bars.length)return bars;
  const key=`observations:${market}:${symbol}:${bars[0].session}:${bars[bars.length-1].session}`;
  let rows=cache?.get(key);
  if(!rows){
    rows=[];
    for(let offset=0;offset<2500;offset+=500){
      const result=await svc.from("decision_observations")
        .select("id,ts,market,code_version,entry_eligible,fundamental_score,technical_score,sentiment_score,macro_score,insider_score,availability_mask,dimension_applicability:features->dimension_applicability")
        .eq("market",market).eq("symbol",symbol).gte("ts",`${bars[0].session}T00:00:00Z`)
        .lte("ts",`${bars[bars.length-1].session}T23:59:59.999Z`).order("ts").order("id").range(offset,offset+499);
      if(result.error)throw new Error("Recorded score history unavailable; historical dimensions cannot be reconstructed");
      rows.push(...result.data ?? []);
      if((result.data?.length ?? 0)<500)break;
      if(offset===2000)throw new Error("Recorded score history exceeds bounded cohort; partial comparison refused");
    }
    cache?.set(key,rows);
  }
  return alignObservedScores(market,bars,rows);
}
