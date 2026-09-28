export type ProducerRunState = "collected" | "blocked" | "error";

export interface ProducerRunFinish {
  status: ProducerRunState;
  expectedSession?: string | null;
  observedSession?: string | null;
  blockers?: string[];
  details?: Record<string, unknown>;
}

/** Normalize an HTTP collector result without confusing it with P&L evidence. */
export async function producerOutcomeFromResponse(
  response: Response,
  evidenceType: string,
): Promise<ProducerRunFinish> {
  const payload = await response.clone().json().catch(() => ({})) as Record<string, unknown>;
  const results = Array.isArray(payload.results) ? payload.results : [];
  // asOfDate can mean "collector wall-clock day" rather than an observed market
  // session. Only a field explicitly named observedSession may populate this.
  const observedSession = typeof payload.observedSession === "string" ? payload.observedSession : null;
  const resultStates = results.reduce<Record<string, number>>((counts, result) => {
    const row = result && typeof result === "object" ? result as Record<string, unknown> : {};
    const state = typeof row.status === "string" ? row.status : "unspecified";
    counts[state] = (counts[state] ?? 0) + 1;
    return counts;
  }, {});
  const commonDetails = {
    evidenceType,
    httpStatus: response.status,
    persisted: payload.persisted === true,
    asOfDate: typeof payload.asOfDate === "string" ? payload.asOfDate : null,
    resultCount: results.length,
    resultStates,
    performanceAttribution: "not_produced_by_this_collector",
  };

  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : `Collector returned HTTP ${response.status}`;
    return {
      status: response.status >= 500 ? "error" : "blocked",
      observedSession,
      blockers: [message],
      details: commonDetails,
    };
  }
  if (results.length === 0) {
    return {
      status: "blocked",
      observedSession,
      blockers: ["Collector completed without producing any market-local result rows."],
      details: commonDetails,
    };
  }
  const explicitFailures = results.flatMap((result) => {
    const row = result && typeof result === "object" ? result as Record<string, unknown> : {};
    const state = typeof row.status === "string" ? row.status.toLowerCase() : "";
    if (!["error", "failed", "invalid", "stale", "blocked"].includes(state)) return [];
    const message = typeof row.error === "string" ? row.error
      : typeof row.reason === "string" ? row.reason
      : `${state} result returned by collector`;
    return [`${state}: ${message}`];
  });
  const payloadFailure = payload.success === false || payload.ok === false
    ? (Array.isArray(payload.errors) && payload.errors.length
      ? payload.errors.map((error) => typeof error === "string" ? error : JSON.stringify(error))
      : [typeof payload.error === "string" ? payload.error : "Collector explicitly reported success=false."])
    : [];
  const blockers = [...new Set([...payloadFailure, ...explicitFailures])];
  if (blockers.length) {
    const hasExecutionFailure = results.some((result) => {
      const state = result && typeof result === "object" ? (result as Record<string, unknown>).status : null;
      return typeof state === "string" && (state.toLowerCase() === "error" || state.toLowerCase() === "failed");
    });
    return {
      status: hasExecutionFailure ? "error" : "blocked",
      observedSession,
      blockers,
      details: commonDetails,
    };
  }
  if (payload.persisted !== true) {
    return {
      status: "blocked",
      observedSession,
      blockers: ["Collector returned result rows but did not confirm persistence; this is not verified collection."],
      details: commonDetails,
    };
  }
  return { status: "collected", observedSession, details: commonDetails };
}

/**
 * Persist the operational outcome of one Upgrade Path collector invocation.
 * This ledger is not scientific evidence; only the attribution/snapshot
 * append-only ledgers can support performance claims.
 */
export async function runWithProducerHealth<T>(input: {
  client: any;
  programId: string;
  market: "us" | "india";
  triggerSource: "cron_authenticated" | "owner_manual";
  codeVersion: string | null;
  work: () => Promise<{ value: T; outcome: ProducerRunFinish }>;
}): Promise<T> {
  const runKey = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const { data: started, error: startError } = await input.client
    .from("upgrade_path_producer_runs")
    .insert({
      program_id: input.programId,
      market: input.market,
      run_key: runKey,
      trigger_source: input.triggerSource,
      status: "running",
      code_version: input.codeVersion,
    })
    .select("id")
    .single();
  if (startError || !started?.id) {
    throw new Error(`Could not persist Upgrade Path producer start: ${startError?.message ?? "missing run id"}`);
  }

  const finish = async (outcome: ProducerRunFinish) => {
    const { error } = await input.client
      .from("upgrade_path_producer_runs")
      .update({
        status: outcome.status,
        expected_session: outcome.expectedSession ?? null,
        observed_session: outcome.observedSession ?? null,
        blockers: outcome.blockers ?? [],
        details: outcome.details ?? {},
        finished_at: new Date().toISOString(),
      })
      .eq("id", started.id);
    if (error) throw new Error(`Could not persist Upgrade Path producer outcome: ${error.message}`);
  };

  try {
    const result = await input.work();
    await finish(result.outcome);
    return result.value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await finish({ status: "error", blockers: [message], details: { error: message } });
    } catch (writeError) {
      const persistMessage = writeError instanceof Error ? writeError.message : String(writeError);
      throw new Error(`${message}; additionally, ${persistMessage}`);
    }
    throw error;
  }
}
