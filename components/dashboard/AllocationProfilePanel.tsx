"use client";
import { useEffect,useState,useRef } from "react";
import { useMarket } from "@/lib/market-context";
import { ALLOCATION_BUCKETS,ALLOCATION_LABELS,ALLOCATION_PROFILES,defaultAllocation,validateAllocation,type AllocationPolicy,type AllocationProfile } from "@/lib/allocation/profiles";
const T={card:"#1A1D27",surface:"#13151C",border:"#252836",text:"#ECEDEF",sub:"#9B9EA8",accent:"#818CF8",red:"#F87171",green:"#34D399",amber:"#FBBF24"};
export default function AllocationProfilePanel(){
  const {market}=useMarket();
  const currentMarket=useRef(market);currentMarket.current=market;
  const [draft,setDraft]=useState<AllocationPolicy|null>(null),[snapshot,setSnapshot]=useState<any>(null),[message,setMessage]=useState(""),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  useEffect(()=>{let active=true;setDraft(null);setSnapshot(null);setMessage("");
    fetch(`/api/settings/risk-profile?section=allocation&market=${market}`,{cache:"no-store"}).then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error??"Load failed");return d;})
      .then(d=>{if(active){setDraft(d.policy);setRevision(d.policy.revision);setSnapshot(d.snapshot);if(d.snapshotError)setMessage(d.snapshotError);}})
      .catch(e=>{if(active)setMessage(e.message);});return()=>{active=false;};},[market]);
  async function save(reset=false){if(!draft)return;setBusy(true);setMessage("");try{
    const r=await fetch("/api/settings/risk-profile",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"allocation_policy",market,profile:draft.profile,enabled:draft.enabled,expectedRevision:revision,targets:draft.targets,leveragedMaxPct:draft.leveragedMaxPct,reset})});
    const d=await r.json();if(!r.ok)throw Error(d.error??"Save failed");if(currentMarket.current!==market)return;setDraft(d.policy);setRevision(d.policy.revision);setMessage(`${market.toUpperCase()} allocation saved · revision ${d.policy.revision}. Applies to future paper entries, not forced sales.`);
  }catch(e){if(currentMarket.current===market)setMessage(e instanceof Error?e.message:"Save failed");}finally{setBusy(false);}}
  const input={background:T.surface,color:T.text,border:`1px solid ${T.border}`,borderRadius:6,padding:8,width:"100%"};
  const invalid=draft?validateAllocation(draft,market):null;
  return <section aria-label="Portfolio allocation profiles" style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:"clamp(14px,4vw,24px)",marginBottom:20,color:T.sub,fontSize:12,lineHeight:1.6}}>
    <h3 style={{color:T.text,margin:"0 0 8px"}}>Portfolio allocation · {market.toUpperCase()} paper</h3>
    <p>Strategic targets for future buys and top-ups. Other risk gates can shrink or refuse a trade. No preset is proven to beat S&amp;P 500 or NIFTY 50; a balanced mix can trade lower drawdown for lower bull-market return.</p>
    {!draft?<div role="status">{message||"Loading allocation…"}</div>:<>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:12,marginBottom:12}}>
        <label>Allocation profile<select aria-label="Allocation profile" value={draft.profile} disabled={busy} style={input} onChange={e=>setDraft({...defaultAllocation(market,e.target.value as AllocationProfile),enabled:draft.enabled,revision})}>{ALLOCATION_PROFILES.map(p=><option key={p} value={p}>{p[0].toUpperCase()+p.slice(1)}</option>)}</select></label>
        <label>Leveraged maximum %<input aria-label="Allocation leveraged maximum" type="number" min={0} max={market==="us"?5:0} step={0.5} value={draft.leveragedMaxPct} disabled={busy||market==="india"} style={input} onChange={e=>setDraft({...draft,leveragedMaxPct:Number(e.target.value)})}/></label>
      </div>
      <label><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={e=>setDraft({...draft,enabled:e.target.checked})}/> Apply these strategic targets to future paper entries</label>
      <div style={{overflowX:"auto",margin:"12px 0"}}><table style={{width:"100%",borderCollapse:"collapse",textAlign:"left"}}><thead><tr>{["Bucket","Target %","Current %","Gap (points)"].map(t=><th key={t} style={{padding:6,color:T.text}}>{t}</th>)}</tr></thead><tbody>{ALLOCATION_BUCKETS.map(bucket=>{const current=snapshot?.rows?.find((row:any)=>row.bucket===bucket)?.currentPct;return <tr key={bucket}><td style={{padding:6}}>{ALLOCATION_LABELS[bucket]}</td><td style={{padding:6,width:90}}><input aria-label={`${ALLOCATION_LABELS[bucket]} target`} type="number" min={0} max={100} step={0.5} value={draft.targets[bucket]} disabled={busy} style={input} onChange={e=>setDraft({...draft,targets:{...draft.targets,[bucket]:Number(e.target.value)}})}/></td><td style={{padding:6}}>{current==null?"Unavailable":current.toFixed(1)}</td><td style={{padding:6}}>{current==null?"—":(draft.targets[bucket]-current).toFixed(1)}</td></tr>;})}</tbody></table></div>
      <div>Total: {ALLOCATION_BUCKETS.reduce((sum,key)=>sum+draft.targets[key],0).toFixed(1)}% · {draft.version} · saved revision {revision}</div>
      <p>Tactical cash and leveraged positions share one budget; leverage is not added on top. {market==="us"?"The combined hard ceiling remains 5% of NAV. Existing cash-reserve protection requires at least 5% in this shared bucket.":"India has no enabled leveraged sleeve."} Oil/commodity funds are not the same as energy shares; gold miners are equities, not bullion. Core ETFs and sector funds can overlap the same underlying stocks.</p>
      <p>Eight total names and the per-name cap still apply. Small targets, whole-share rounding, missing eligible instruments or stricter limits may prevent a target being filled. Changing the profile does not reset a kill switch, enable live trading, change research formulas or automatically buy a benchmark ETF.</p>
      {market==="india"&&draft.targets.bonds>20&&<p style={{color:T.amber}}>Only one liquid/bond ETF is currently in the reviewed allocation seed list. A bond target above the 20% name cap needs additional approved funds before it can be filled. The app will retain cash rather than exceed a cap.</p>}
      {market==="india"&&<p>No approved India oil/commodity fund is configured, so its target must stay at 0%.</p>}
      {snapshot?.unknown?.length>0&&<div style={{color:T.amber}}>Unclassified/unpriced holdings: {snapshot.unknown.join(", ")}. Current weights are withheld.</div>}
      {invalid&&<div role="alert" style={{color:T.red}}>{invalid}</div>}
      {message&&<div role="status" style={{color:message.includes("saved")?T.green:T.amber,margin:"10px 0"}}>{message}</div>}
      <div style={{display:"flex",gap:10,flexWrap:"wrap",marginTop:12}}><button onClick={()=>save()} disabled={busy||!!invalid} style={{...input,width:"auto",background:T.accent,color:T.surface,cursor:"pointer"}}>Save {market.toUpperCase()} allocation</button><button onClick={()=>save(true)} disabled={busy} style={{...input,width:"auto",cursor:"pointer"}}>Reset &amp; save {draft.profile} defaults</button></div>
      <p>Evidence: <a href="https://investor.vanguard.com/investor-resources-education/education/model-portfolio-allocation" target="_blank" rel="noreferrer" style={{color:T.accent}}>Vanguard historical allocation</a> · <a href="https://www.gold.org/goldhub/research/why-gold-2026-anchor-indian-portfolios" target="_blank" rel="noreferrer" style={{color:T.accent}}>India gold study (industry-sponsored)</a> · <a href="https://arxiv.org/abs/2609.07946" target="_blank" rel="noreferrer" style={{color:T.accent}}>Stock/bond/gold preprint</a>. Preset weights are starting points, not backtested Kairos results.</p>
    </>}
  </section>;
}
