"use client";

import { useEffect, useState } from "react";

const T = {
  surface: "#13151C", card: "#1A1D27", border: "#252836", text: "#ECEDEF",
  textSub: "#9B9EA8", muted: "#6B7280", accent: "#6366F1", accentBg: "#1E1F3A",
  green: "#34D399", red: "#F87171", amber: "#FBBF24", blue: "#60A5FA",
};

function today() { return new Date().toISOString().slice(0, 10); }
function badge(terminal: string) {
  if (terminal === "filled") return { label: "FILLED", color: T.green };
  if (terminal.startsWith("rejected_")) return { label: terminal.replace("rejected_", "REJECTED · ").replaceAll("_", " "), color: T.red };
  if (terminal.startsWith("pending_")) return { label: terminal.replace("pending_", "PENDING · ").replaceAll("_", " "), color: T.amber };
  if (terminal === "passed_research_no_downstream_data") return { label: "PASSED RESEARCH", color: T.blue };
  return { label: terminal.replaceAll("_", " ").toUpperCase(), color: T.muted };
}
function pretty(value: unknown): string {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value ?? "—");
}

export default function ResearchFunnel() {
  const [date, setDate] = useState(today());
  const [market, setMarket] = useState<"us" | "india">("us");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    setData(null); setError(""); setExpanded(new Set());
    fetch(`/api/agents/research-journal?date=${date}&market=${market}`)
      .then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); })
      .then(j => {
        if (!live) return;
        if (j.count === 0 && j.latest_available_date && j.latest_available_date !== date) {
          setDate(j.latest_available_date);
          return;
        }
        setData(j);
      })
      .catch(e => { if (live) setError(e?.message ?? String(e)); });
    return () => { live = false; };
  }, [date, market]);

  function toggle(symbol: string) {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(symbol)) next.delete(symbol); else next.add(symbol);
      return next;
    });
  }

  return (
    <div>
      <div style={{ display: "flex", gap: "10px", marginBottom: "10px", alignItems: "center", flexWrap: "wrap" }}>
        <input aria-label="Journal date" type="date" value={date} onChange={e => setDate(e.target.value)}
          style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "6px", color: T.text, padding: "8px 10px", fontSize: "13px" }} />
        <select aria-label="Journal market" value={market} onChange={e => setMarket(e.target.value as "us" | "india")}
          style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "6px", color: T.text, padding: "8px 10px", fontSize: "13px" }}>
          <option value="us">US</option><option value="india">India</option>
        </select>
        {data && <span style={{ fontSize: "12px", color: T.muted }}>{data.count} symbol{data.count === 1 ? "" : "s"} scored</span>}
      </div>
      <div style={{ color: T.muted, fontSize: "11px", marginBottom: "16px" }}>
        Showing the latest completed research date automatically when the selected day has no run. Times and dates follow the selected market.
      </div>

      {error ? <div style={{ color: T.red, fontSize: "13px" }}>Research journal unavailable: {error.slice(0, 180)}</div>
        : !data ? <div style={{ color: T.muted, fontSize: "13px" }}>Loading…</div>
        : data.count === 0 ? (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "24px", color: T.muted, textAlign: "center" }}>
            No research observations exist for {market === "india" ? "India" : "US"} yet.
          </div>
        ) : (
          <div style={{ display: "grid", gap: "10px" }}>
            {data.symbols.map((s: any) => {
              const b = badge(s.terminal); const open = expanded.has(s.symbol);
              return (
                <section key={s.symbol} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px", overflow: "hidden" }}>
                  <button type="button" aria-expanded={open} onClick={() => toggle(s.symbol)} style={{ width: "100%", background: "transparent", border: 0, color: T.text, padding: "13px 16px", cursor: "pointer", textAlign: "left" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "14px", alignItems: "center", flexWrap: "wrap" }}>
                      <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                        <span style={{ fontSize: "15px", fontWeight: 800 }}>{open ? "▾" : "▸"} {s.symbol}</span>
                        <span style={{ fontSize: "12px", color: T.textSub }}>score {s.analyst_score} / threshold {s.score_threshold}</span>
                        <span style={{ fontSize: "11px", color: s.direction === "long" ? T.green : T.amber }}>{String(s.direction).toUpperCase()}</span>
                        {s.run_count > 1 && <span style={{ fontSize: "10px", color: T.muted }}>{s.run_count} runs · latest shown</span>}
                      </div>
                      <span style={{ fontSize: "10px", fontWeight: 700, padding: "3px 9px", borderRadius: "5px", color: b.color, border: `1px solid ${b.color}55`, background: `${b.color}16` }}>{b.label}</span>
                    </div>
                    <div style={{ marginTop: "7px", fontSize: "12px", color: T.textSub, lineHeight: 1.5 }}><b>Why researched:</b> {s.selection.reason}</div>
                    <div style={{ marginTop: "3px", fontSize: "12px", color: s.entry_eligible ? T.green : T.amber, lineHeight: 1.5 }}><b>Decision:</b> {s.decision.reason}</div>
                  </button>

                  {open && <div style={{ borderTop: `1px solid ${T.border}`, padding: "14px 16px 18px" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: "10px", marginBottom: "14px" }}>
                      <div style={{ background: T.surface, padding: "12px", borderRadius: "8px" }}>
                        <div style={{ color: T.muted, fontSize: "10px", textTransform: "uppercase", marginBottom: "6px" }}>Investment thesis</div>
                        <div style={{ color: T.textSub, fontSize: "12px", lineHeight: 1.55 }}>{s.thesis.summary || "No narrative thesis was recorded; the deterministic evidence remains below."}</div>
                      </div>
                      <div style={{ background: T.surface, padding: "12px", borderRadius: "8px" }}>
                        <div style={{ color: T.muted, fontSize: "10px", textTransform: "uppercase", marginBottom: "6px" }}>Eligibility gates</div>
                        {s.decision.checks.map((c: any) => <div key={c.name} style={{ fontSize: "12px", color: c.passed ? T.green : T.red, marginBottom: "4px" }}>{c.passed ? "✓" : "✕"} {c.name}: {c.detail}</div>)}
                        <div style={{ fontSize: "11px", color: T.muted, marginTop: "7px" }}>Evidence confidence: {s.evidence_confidence == null ? "not recorded" : `${Math.round(s.evidence_confidence * 100)}%`} · scoring {s.scoring_version ?? "legacy"}</div>
                      </div>
                    </div>

                    <div style={{ color: T.muted, fontSize: "10px", textTransform: "uppercase", marginBottom: "7px" }}>Score construction</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "8px", marginBottom: "14px" }}>
                      {Object.entries(s.dimensions).map(([dim, d]: [string, any]) => (
                        <div key={dim} style={{ background: T.surface, border: `1px solid ${d.state === "ok" ? T.border : T.amber + "55"}`, borderRadius: "8px", padding: "10px", opacity: d.state === "inapplicable" ? 0.6 : 1 }}>
                          <div style={{ color: T.muted, fontSize: "10px", textTransform: "uppercase" }}>{dim} · {d.state}</div>
                          <div style={{ color: T.text, fontSize: "17px", fontWeight: 800, margin: "3px 0" }}>{d.score ?? "—"}</div>
                          <div style={{ color: T.textSub, fontSize: "10px" }}>weight {Math.round((d.weight ?? 0) * 100)}% · contributes {d.contribution ?? 0} pts</div>
                          {d.note && <div style={{ color: T.muted, fontSize: "10px", marginTop: "5px", lineHeight: 1.4 }}>{d.note}</div>}
                          {Object.keys(d.evidence ?? {}).length > 0 && <div style={{ color: T.muted, fontSize: "10px", marginTop: "5px", lineHeight: 1.4 }}>
                            {Object.entries(d.evidence).map(([k, v]) => `${k.replaceAll("_", " ")}: ${pretty(v)}`).join(" · ")}
                          </div>}
                        </div>
                      ))}
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: "10px", marginBottom: "14px" }}>
                      <div><div style={{ color: T.green, fontSize: "10px", textTransform: "uppercase", marginBottom: "5px" }}>Catalysts / supporting evidence</div>
                        {s.thesis.catalysts.length ? s.thesis.catalysts.map((x: string, i: number) => <div key={i} style={{ color: T.textSub, fontSize: "12px", marginBottom: "3px" }}>+ {x}</div>) : <div style={{ color: T.muted, fontSize: "12px" }}>No catalyst list recorded.</div>}
                      </div>
                      <div><div style={{ color: T.red, fontSize: "10px", textTransform: "uppercase", marginBottom: "5px" }}>Risks / counter-evidence</div>
                        {s.counter_evidence.length ? s.counter_evidence.map((x: string, i: number) => <div key={i} style={{ color: T.textSub, fontSize: "12px", marginBottom: "3px" }}>− {x}</div>) : <div style={{ color: T.muted, fontSize: "12px" }}>No material counter-evidence recorded.</div>}
                      </div>
                    </div>

                    <div style={{ color: T.muted, fontSize: "10px", textTransform: "uppercase", marginBottom: "6px" }}>Pipeline audit trail</div>
                    {s.stages.length ? s.stages.map((st: any, i: number) => <div key={i} style={{ fontSize: "12px", color: st.outcome === "rejected" ? T.red : st.outcome === "filled" ? T.green : T.textSub, marginBottom: "3px" }}><b>{st.stage}</b> → {st.outcome}{st.reason ? `: ${st.reason}` : ""}</div>)
                      : <div style={{ color: T.muted, fontSize: "12px" }}>No downstream stage event was recorded for this historical signal.</div>}
                  </div>}
                </section>
              );
            })}
          </div>
        )}
    </div>
  );
}
