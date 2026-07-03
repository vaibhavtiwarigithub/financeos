// Shared pause check for all edge functions.
// Query strategy_config.app_paused before doing any work.
// Returns immediately if paused — agent writes nothing, costs nothing.

export async function checkPaused(supabase: any): Promise<{ paused: boolean; reason?: string }> {
  try {
    const { data } = await supabase
      .from("strategy_config")
      .select("app_paused")
      .limit(1)
      .single();
    if (data?.app_paused) return { paused: true, reason: "App paused via kill switch" };
  } catch {}
  return { paused: false };
}

export function pausedResponse(reason = "App paused via kill switch") {
  return new Response(
    JSON.stringify({ skipped: true, reason }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
