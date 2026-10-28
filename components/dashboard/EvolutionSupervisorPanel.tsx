import type { EvolutionSnapshot } from "@/lib/agents/evolution-supervisor";

const T = {
  surface: "#13151C", card: "#1A1D27", border: "#252836", text: "#ECEDEF",
  muted: "#9B9EA8", green: "#34D399", amber: "#FBBF24", red: "#F87171", accent: "#A5B4FC",
};

export default function EvolutionSupervisorPanel({
  snapshot,
  market,
}: {
  snapshot: EvolutionSnapshot | null;
  market: "us" | "india";
}) {
  const local = snapshot?.markets?.[market];
  const items = (snapshot?.queue ?? []).filter((item) => item.market === market || item.market === "shared").slice(0, 6);
  const color = snapshot?.state === "degraded" ? T.red : snapshot?.state === "attention" ? T.amber : T.green;
  const label = snapshot?.state === "degraded" ? "INPUTS DEGRADED" : snapshot?.state === "attention" ? "NEEDS ATTENTION" : snapshot ? "MONITORING" : "WAITING FOR FIRST CYCLE";

  return (
    <section aria-label="Evolution supervisor" style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14, padding: 18, marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ color: T.text, fontSize: 15, fontWeight: 700 }}>Evolution supervisor</div>
          <div style={{ color: T.muted, fontSize: 12, marginTop: 5, maxWidth: 780, lineHeight: 1.5 }}>
            Reviews safety first, then the challenger and shadow pipeline. It runs on the existing two-hour watchdog schedule; research and shadow learning continue independently of paper-entry accuracy brakes.
          </div>
        </div>
        <span style={{ color, background: `${color}18`, border: `1px solid ${color}44`, borderRadius: 999, padding: "5px 9px", fontSize: 10, fontWeight: 700, letterSpacing: ".04em" }}>{label}</span>
      </div>

      {snapshot ? <>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 16, color: T.muted, fontSize: 11 }}>
          <span>Checked {new Date(snapshot.checkedAt).toLocaleString()}</span>
          <span>{local?.awaitingValidation ?? 0} challenger(s) awaiting validation</span>
          <span>{local?.activeShadows ?? 0} active shadow(s)</span>
          <span>Auto-validation {local?.validationEnabled ? "on" : "off"}; shadow routing {local?.autoShadowEnabled ? "on" : "off"}</span>
        </div>
        {items.length ? <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
          {items.map((item) => <div key={item.key} style={{ display: "grid", gridTemplateColumns: "52px minmax(0,1fr)", gap: 10, background: T.card, border: `1px solid ${T.border}`, borderRadius: 9, padding: "10px 12px" }}>
            <span style={{ color: item.priority === "P0" ? T.red : item.priority === "P1" ? T.amber : T.accent, fontSize: 11, fontWeight: 800 }}>{item.priority}</span>
            <div>
              <div style={{ color: T.text, fontSize: 12, fontWeight: 600 }}>{item.title}</div>
              <div style={{ color: T.muted, fontSize: 11, marginTop: 3 }}>{item.nextAction}</div>
            </div>
          </div>)}
        </div> : <div style={{ color: T.green, fontSize: 12, marginTop: 14 }}>No actionable blockers in this snapshot. Shadow evidence can still be insufficient while labels mature.</div>}
      </> : <div style={{ color: T.muted, fontSize: 12, marginTop: 14 }}>No supervisor cycle has been recorded yet. The next scheduled watchdog run will publish its first snapshot.</div>}
    </section>
  );
}
