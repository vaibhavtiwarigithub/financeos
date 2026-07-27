export type InternationalAllocationPolicyRead = {
  policy: {
    id: string;
    core_symbol: string;
    construction: "broad_core" | "developed_emerging_split";
    status: "observe" | "shadow" | "paper" | "live";
    target_pct: number | null;
    deadband_pct: number | null;
  };
  snapshot: {
    source_name: string;
    source_url: string;
    source_as_of: string | null;
    retrieved_at: string;
    coverage_pct: number;
    quality: "complete" | "partial" | "stale" | "unavailable";
    exposure: Record<string, unknown>;
  } | null;
  assessment: {
    assessed_at: string;
    us_paper_invested_value: number;
    recognized_international_value: number;
    recognized_international_pct: number | null;
    assessment_status: "disabled_no_target" | "hold" | "below_band" | "above_band" | "unavailable";
    reason: string;
    observation_kind: "p1_manual" | "p2_weekly";
    shadow_week: string | null;
  } | null;
};

// Server/BFF only. Tables are RLS deny-by-default and browser roles have no
// grants. A missing P1 migration degrades to null so the existing portfolio page
// remains available during an uneven deploy.
export async function loadInternationalAllocationPolicy(supabase: any): Promise<InternationalAllocationPolicyRead | null> {
  try {
    const { data: policy } = await supabase
      .from("international_allocation_policies")
      .select("id, core_symbol, construction, status, target_pct, deadband_pct")
      .eq("policy_key", "us_non_us_broad_core_v1")
      .maybeSingle();
    if (!policy) return null;

    const [{ data: snapshot }, { data: assessment }] = await Promise.all([
      supabase.from("fund_exposure_snapshots")
        .select("source_name, source_url, source_as_of, retrieved_at, coverage_pct, quality, exposure")
        .eq("policy_id", policy.id)
        .order("retrieved_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase.from("international_allocation_assessments")
        .select("assessed_at, us_paper_invested_value, recognized_international_value, recognized_international_pct, assessment_status, reason, observation_kind, shadow_week")
        .eq("policy_id", policy.id)
        .order("assessed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    return { policy, snapshot: snapshot ?? null, assessment: assessment ?? null } as InternationalAllocationPolicyRead;
  } catch {
    return null;
  }
}
