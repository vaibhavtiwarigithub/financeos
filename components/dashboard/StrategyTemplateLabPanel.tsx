"use client";

import { useCallback, useEffect, useState } from "react";
import { useMarket } from "@/lib/market-context";

const T = { card: "#1A1D27", surface: "#13151C", border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280", amber: "#FBBF24", red: "#F87171", green: "#34D399" };
type Config = { id: string; kind: string; state: string; template_ids: string[]; rule_version: string; trial_family_id: string; config_fingerprint: string; created_at: string };
type ReadState = { status: "ready" | "not_deployed" | "error"; configs: Config[]; message?: string };

export default function StrategyTemplateLabPanel() {
  const { market } = useMarket();
  const [state, setState] = useState<ReadState | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/strategies/template-shadows?market=${market}`, { cache: "no-store" });
      const body = await response.json();
      if (body.status === "not_deployed") {
        setState({ status: "not_deployed", configs: [], message: "The strategy-template shadow ledger is absent in production. No template shadows or matched strategy-vs-dimension portfolio results are being collected." });
      } else if (response.ok && body.status === "ready") {
        setState({ status: "ready", configs: Array.isArray(body.configs) ? body.configs : [] });
      } else {
        setState({ status: "error", configs: [], message: "Strategy lab status could not be read. Retry; this is not evidence that the queue is empty." });
      }
    } catch {
      setState({ status: "error", configs: [], message: "Strategy lab status could not be read. Check connection and retry; this is not evidence that the queue is empty." });
    } finally { setLoading(false); }
  }, [market, attempt]);
  useEffect(() => { void load(); }, [load]);

  const statusColor = state?.status === "ready" ? T.green : state?.status === "error" ? T.red : T.amber;
  return <section aria-labelledby="strategy-template-lab-title" style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: 20, marginBottom: 24 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
      <div>
        <h3 id="strategy-template-lab-title" style={{ color: T.text, fontSize: 16, margin: 0 }}>Strategy tournament · {market === "india" ? "India" : "US"}</h3>
        <p style={{ color: T.sub, fontSize: 12, lineHeight: 1.6, margin: "6px 0 0" }}>Separate from dimension scores. Approved challengers are meant to run on the same market cohort and compare net portfolio outcomes against the deterministic baseline. Strategy evidence cannot change scoring, positions, or orders.</p>
      </div>
      <button type="button" onClick={() => setAttempt((value) => value + 1)} disabled={loading} style={{ color: T.sub, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 6, padding: "7px 10px", cursor: loading ? "wait" : "pointer", fontSize: 12 }}>{loading ? "Checking…" : "Refresh status"}</button>
    </div>
    {!state ? <p style={{ color: T.muted, fontSize: 12, marginTop: 14 }}>Checking whether the shadow producer is deployed…</p> : <>
      <div role="status" style={{ marginTop: 14, padding: 12, background: T.surface, border: `1px solid ${statusColor}55`, borderRadius: 6, color: statusColor, fontSize: 12, lineHeight: 1.6 }}>
        <strong>{state.status === "ready" ? "Producer deployed" : state.status === "not_deployed" ? "Not collecting yet" : "Status unavailable"}</strong>{state.message ? ` — ${state.message}` : state.status === "ready" ? ` — ${state.configs.length} frozen configuration(s) recorded.` : ""}
      </div>
      {state.status === "ready" && state.configs.length > 0 && <div style={{ marginTop: 10 }}>
        {state.configs.map((config) => <div key={config.id} style={{ borderTop: `1px solid ${T.border}`, padding: "10px 0", color: T.sub, fontSize: 12 }}>
          <div style={{ color: T.text, fontWeight: 650 }}>{config.kind === "combination" ? "Predeclared combination" : "Template challenger"} · {config.state}</div>
          <div style={{ marginTop: 4 }}>Rule {config.rule_version} · family {config.trial_family_id} · registered {new Date(config.created_at).toLocaleDateString()}</div>
          <div style={{ color: T.muted, marginTop: 3, overflowWrap: "anywhere" }}>Config {config.config_fingerprint}</div>
        </div>)}
        <p style={{ color: T.muted, fontSize: 11, lineHeight: 1.5 }}>Configurations are not performance results. A measured verdict requires mature forward shadow outcomes and the paired net-portfolio replay gate.</p>
      </div>}
      {state.status === "ready" && state.configs.length === 0 && <p style={{ color: T.muted, fontSize: 12 }}>No frozen template challenger is registered for this market. This is a configuration count, not evidence that strategies have no predictive value.</p>}
    </>}
  </section>;
}
