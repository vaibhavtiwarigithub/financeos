"use client";

import { useEffect, useState } from "react";

const T = {
  surface: "#13151C", card: "#1A1D27", border: "#252836", text: "#ECEDEF",
  textSub: "#A7AAB4", muted: "#737987", accent: "#818CF8", green: "#34D399",
  red: "#F87171", amber: "#FBBF24", blue: "#60A5FA", ink: "#0C1017",
};

function today() { return new Date().toISOString().slice(0, 10); }
function titleCase(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, c => c.toUpperCase()); }
function percent(value: number) { return `${Math.round((value ?? 0) * 100)}%`; }
function pretty(value: unknown): string {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value ?? "—");
}
function terminalBadge(terminal: string) {
  if (terminal === "filled") return { label: "FILLED", color: T.green };
  if (terminal.startsWith("rejected_")) return { label: terminal.replace("rejected_", "REJECTED · ").replaceAll("_", " ").toUpperCase(), color: T.red };
  if (terminal.startsWith("pending_")) return { label: terminal.replace("pending_", "PENDING · ").replaceAll("_", " ").toUpperCase(), color: T.amber };
  if (terminal === "passed_research_no_downstream_data") return { label: "PASSED RESEARCH", color: T.blue };
  return { label: terminal.replaceAll("_", " ").toUpperCase(), color: T.muted };
}
function actionColor(action: string) {
  if (action.includes("EXIT") || action.includes("AVOID") || action.includes("BLOCKED")) return T.red;
  if (action.includes("HOLD") || action.includes("PAPER")) return T.green;
  return T.amber;
}
function formatDate(iso?: string | null) {
  if (!iso) return "Not recorded";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function MiniMetric({ label, value, color }: { label: string; value: string; color?: string }) {
  return <div style={{ minWidth: "112px", padding: "9px 11px", background: T.ink, border: `1px solid ${T.border}`, borderRadius: "8px" }}>
    <div style={{ color: T.muted, fontSize: "9px", letterSpacing: ".09em", textTransform: "uppercase", marginBottom: "3px" }}>{label}</div>
    <div style={{ color: color ?? T.text, fontSize: "13px", fontWeight: 750 }}>{value}</div>
  </div>;
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
        if (j.count === 0 && j.latest_available_date && j.latest_available_date !== date) { setDate(j.latest_available_date); return; }
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

  return <div>
    <div style={{ display: "flex", gap: "10px", marginBottom: "10px", alignItems: "center", flexWrap: "wrap" }}>
      <input aria-label="Journal date" type="date" value={date} onChange={e => setDate(e.target.value)}
        style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "7px", color: T.text, padding: "8px 10px", fontSize: "13px" }} />
      <select aria-label="Journal market" value={market} onChange={e => setMarket(e.target.value as "us" | "india")}
        style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "7px", color: T.text, padding: "8px 10px", fontSize: "13px" }}>
        <option value="us">US</option><option value="india">India</option>
      </select>
      {data && <span style={{ fontSize: "12px", color: T.muted }}>{data.count} symbols · latest decision per symbol</span>}
    </div>
    <div style={{ color: T.muted, fontSize: "11px", marginBottom: "16px" }}>
      Score measures the available evidence. Coverage shows how much applicable evidence was present. Confidence tells you how cautiously to read the conclusion.
    </div>

    {error ? <div style={{ color: T.red, fontSize: "13px" }}>Research journal unavailable: {error.slice(0, 180)}</div>
      : !data ? <div style={{ color: T.muted, fontSize: "13px" }}>Loading research decisions…</div>
      : data.count === 0 ? <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "24px", color: T.muted, textAlign: "center" }}>No research observations exist for this market yet.</div>
      : <div style={{ display: "grid", gap: "12px" }}>
        {data.symbols.map((s: any) => {
          const open = expanded.has(s.symbol);
          const terminal = terminalBadge(s.terminal);
          const ac = actionColor(s.novice.action);
          return <article key={s.symbol} style={{ background: T.card, border: `1px solid ${open ? T.accent + "77" : T.border}`, borderRadius: "12px", overflow: "hidden", boxShadow: open ? "0 18px 44px rgba(0,0,0,.22)" : "none" }}>
            <button type="button" aria-expanded={open} onClick={() => toggle(s.symbol)} style={{ width: "100%", background: "transparent", border: 0, color: T.text, padding: "16px", cursor: "pointer", textAlign: "left" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "14px", alignItems: "flex-start", flexWrap: "wrap" }}>
                <div>
                  <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontFamily: "Georgia, serif", fontSize: "20px", fontWeight: 700 }}>{open ? "▾" : "▸"} {s.symbol}</span>
                    <span style={{ color: T.muted, fontSize: "10px", border: `1px solid ${T.border}`, padding: "3px 7px", borderRadius: "999px" }}>{s.identity.asset_label}</span>
                    <span style={{ color: s.history.state === "new" ? T.blue : s.history.state === "holding" ? T.green : T.muted, fontSize: "10px", border: `1px solid currentColor`, padding: "3px 7px", borderRadius: "999px" }}>{titleCase(s.history.state)}</span>
                  </div>
                  <div style={{ marginTop: "7px", color: ac, fontWeight: 800, fontSize: "13px", letterSpacing: ".04em" }}>{s.novice.action}</div>
                  <div style={{ marginTop: "4px", color: T.muted, fontSize: "11px" }}>{s.identity.description}</div>
                </div>
                <div style={{ display: "flex", gap: "7px", flexWrap: "wrap" }}>
                  <MiniMetric label="Evidence score" value={`${s.analyst_score}/100`} />
                  <MiniMetric label="Coverage" value={`${percent(s.novice.evidence_coverage)} · ${s.novice.usable_dimensions}/${s.novice.applicable_dimensions}`} color={s.novice.evidence_coverage >= .8 ? T.green : T.amber} />
                  <MiniMetric label="Confidence" value={s.novice.confidence_label} color={s.novice.confidence_label === "High" ? T.green : T.amber} />
                </div>
              </div>
              <div style={{ marginTop: "12px", paddingTop: "11px", borderTop: `1px solid ${T.border}`, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px" }}>
                <div style={{ fontSize: "12px", color: T.textSub, lineHeight: 1.5 }}><span style={{ color: T.muted }}>WHY IT APPEARED</span><br />{s.selection.reason}</div>
                <div style={{ fontSize: "12px", color: T.textSub, lineHeight: 1.5 }}><span style={{ color: T.green }}>STRONGEST EVIDENCE</span><br />{s.novice.strongest_evidence}</div>
                <div style={{ fontSize: "12px", color: T.textSub, lineHeight: 1.5 }}><span style={{ color: T.red }}>MAIN GAP / RISK</span><br />{s.novice.main_risk}</div>
              </div>
              <div style={{ marginTop: "10px", color: T.textSub, fontSize: "12px" }}><b style={{ color: T.text }}>Next:</b> {s.novice.next_step}</div>
            </button>

            {open && <div style={{ borderTop: `1px solid ${T.border}`, padding: "16px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "12px", marginBottom: "12px" }}>
                <section style={{ background: T.surface, padding: "14px", borderRadius: "9px" }}>
                  <div style={{ color: T.muted, fontSize: "10px", letterSpacing: ".1em", textTransform: "uppercase", marginBottom: "7px" }}>Plain-English research view</div>
                  <div style={{ color: T.textSub, fontSize: "13px", lineHeight: 1.65 }}>{s.thesis.summary || "No narrative thesis was recorded. Use the deterministic evidence below."}</div>
                  {s.novice.technical_read.length > 0 && <div style={{ marginTop: "12px", paddingTop: "10px", borderTop: `1px solid ${T.border}` }}>
                    <div style={{ color: T.blue, fontSize: "10px", textTransform: "uppercase", marginBottom: "5px" }}>What the chart says</div>
                    {s.novice.technical_read.map((x: string, i: number) => <div key={i} style={{ color: T.textSub, fontSize: "12px", marginTop: "4px" }}>• {x}</div>)}
                  </div>}
                  <div style={{ marginTop: "10px", padding: "9px 10px", background: T.ink, borderRadius: "7px", color: T.textSub, fontSize: "11px", lineHeight: 1.5 }}><b style={{ color: T.amber }}>Hype check:</b> {s.novice.hype_read}</div>
                </section>
                <section style={{ background: T.surface, padding: "14px", borderRadius: "9px" }}>
                  <div style={{ color: T.muted, fontSize: "10px", letterSpacing: ".1em", textTransform: "uppercase", marginBottom: "7px" }}>History & status</div>
                  <div style={{ fontSize: "12px", color: T.textSub, lineHeight: 1.7 }}>First seen: <b style={{ color: T.text }}>{formatDate(s.history.first_seen)}</b></div>
                  <div style={{ fontSize: "12px", color: T.textSub, lineHeight: 1.7 }}>Recorded observations: <b style={{ color: T.text }}>{s.history.observations_in_window}{s.history.capped ? "+" : ""}</b></div>
                  <div style={{ fontSize: "12px", color: T.textSub, lineHeight: 1.7 }}>Previous score: <b style={{ color: T.text }}>{s.history.previous_score ?? "First observation"}</b></div>
                  {s.history.score_change != null && <div style={{ fontSize: "12px", color: s.history.score_change >= 0 ? T.green : T.red, lineHeight: 1.7 }}>Score change: <b>{s.history.score_change >= 0 ? "+" : ""}{s.history.score_change}</b></div>}
                  <div style={{ marginTop: "8px", fontSize: "10px", fontWeight: 700, color: terminal.color }}>{terminal.label}</div>
                </section>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "10px", marginBottom: "14px" }}>
                <section><div style={{ color: T.green, fontSize: "10px", textTransform: "uppercase", marginBottom: "6px" }}>Recorded catalysts / hypotheses</div>
                  {s.thesis.catalysts.length ? s.thesis.catalysts.map((x: string, i: number) => <div key={i} style={{ color: T.textSub, fontSize: "12px", marginBottom: "4px" }}>+ {x}</div>) : <div style={{ color: T.muted, fontSize: "12px" }}>No catalyst list was recorded.</div>}
                </section>
                <section><div style={{ color: T.red, fontSize: "10px", textTransform: "uppercase", marginBottom: "6px" }}>Risks / counter-evidence</div>
                  {s.counter_evidence.length ? s.counter_evidence.map((x: string, i: number) => <div key={i} style={{ color: T.textSub, fontSize: "12px", marginBottom: "4px" }}>− {x}</div>) : <div style={{ color: T.muted, fontSize: "12px" }}>No specific counter-evidence was recorded.</div>}
                </section>
              </div>

              <div style={{ color: T.muted, fontSize: "10px", letterSpacing: ".1em", textTransform: "uppercase", marginBottom: "7px" }}>Quant audit · how the available-evidence score was built</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "8px", marginBottom: "14px" }}>
                {Object.entries(s.dimensions).map(([dim, d]: [string, any]) => <div key={dim} style={{ background: T.surface, border: `1px solid ${d.state === "ok" ? T.border : T.amber + "44"}`, borderRadius: "8px", padding: "10px", opacity: d.state === "inapplicable" ? .68 : 1 }}>
                  <div style={{ color: T.muted, fontSize: "10px", textTransform: "uppercase" }}>{dim} · {d.state}</div>
                  <div style={{ color: T.text, fontSize: "17px", fontWeight: 800, margin: "3px 0" }}>{d.state === "inapplicable" || d.state === "missing" ? "Not used" : d.score ?? "—"}</div>
                  <div style={{ color: T.textSub, fontSize: "10px" }}>weight {Math.round((d.weight ?? 0) * 100)}% · contributes {d.contribution ?? 0} pts</div>
                  {d.note && <div style={{ color: T.muted, fontSize: "10px", marginTop: "5px", lineHeight: 1.4 }}>{d.note}</div>}
                  {d.state !== "inapplicable" && Object.keys(d.evidence ?? {}).length > 0 && <div style={{ color: T.muted, fontSize: "10px", marginTop: "5px", lineHeight: 1.45 }}>{Object.entries(d.evidence).map(([k, v]) => `${k.replaceAll("_", " ")}: ${pretty(v)}`).join(" · ")}</div>}
                </div>)}
              </div>

              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", padding: "10px 0", borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, marginBottom: "12px" }}>
                <span style={{ color: T.muted, fontSize: "11px", alignSelf: "center" }}>Verify externally:</span>
                {s.external_links.map((link: any) => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer" style={{ color: T.blue, fontSize: "11px", textDecoration: "none", border: `1px solid ${T.blue}44`, padding: "4px 8px", borderRadius: "6px" }}>{link.label} ↗</a>)}
              </div>

              <div style={{ color: T.muted, fontSize: "10px", textTransform: "uppercase", marginBottom: "6px" }}>Pipeline audit trail</div>
              {s.stages.length ? s.stages.map((st: any, i: number) => <div key={i} style={{ fontSize: "12px", color: st.outcome === "rejected" ? T.red : st.outcome === "filled" ? T.green : T.textSub, marginBottom: "3px" }}><b>{st.stage}</b> → {st.outcome}{st.reason ? `: ${st.reason}` : ""}</div>)
                : <div style={{ color: T.muted, fontSize: "12px" }}>No downstream event was recorded for this historical signal.</div>}
            </div>}
          </article>;
        })}
      </div>}
  </div>;
}
