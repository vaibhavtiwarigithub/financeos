import { LABEL_ID_BATCH_SIZE, type LabeledObservation } from "./dataset";

export function featureObservationContext(row: LabeledObservation, raw: any): Record<string,number> {
  const ctx: Record<string,number> = {};
  for (const dimension of ["fundamental","technical","sentiment","macro","insider"] as const) {
    const applicability = raw?.dimension_applicability?.dimensions?.[dimension]?.state;
    if (row.availability_mask?.[dimension] !== true || applicability && applicability !== "applicable") continue;
    const score = row[`${dimension}_score`];
    if (score != null && Number.isFinite(score)) ctx[`${dimension}_score`] = score;
    for (const [key,value] of Object.entries(raw?.[dimension] ?? {})) {
      if (typeof value === "number" && Number.isFinite(value)) {
        ctx[`${dimension}.${key}`] = value;
        ctx[`evidence.${dimension}.${key}`] = value;
      }
    }
  }
  return ctx;
}

export async function attachFeatureObservationContexts(svc:any,market:"us"|"india",base:LabeledObservation[]) {
  const features = new Map<number,any>();
  for(let start=0;start<base.length;start+=LABEL_ID_BATCH_SIZE) {
    const ids=base.slice(start,start+LABEL_ID_BATCH_SIZE).map(row=>row.id);
    const result=await svc.from("decision_observations").select("id,features").eq("market",market).in("id",ids);
    if(result.error) throw new Error("Raw feature observation batch unavailable");
    for(const row of result.data ?? []) features.set(Number(row.id),row.features);
    if(ids.some(id=>!features.has(id))) throw new Error("Raw feature observation cohort is incomplete");
  }
  return base.map(row=>({...row,__ctx:featureObservationContext(row,features.get(row.id))}));
}
