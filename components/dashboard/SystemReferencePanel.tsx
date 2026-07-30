"use client";

import { useMemo, useState } from "react";
import { BookOpen, Download, ExternalLink, FileText, Network } from "lucide-react";
import { SYSTEM_REFERENCE_DOCUMENTS, type SystemReferenceDocument } from "@/lib/system-reference/registry";

const T = {
  surface: "#13151C", card: "#1A1D27", border: "#252836", text: "#ECEDEF",
  textSub: "#9B9EA8", muted: "#6B7280", accent: "#6366F1", green: "#34D399",
};

const CATEGORIES: SystemReferenceDocument["category"][] = ["Orientation", "Architecture chapters", "Decisions", "Feature designs"];

export default function SystemReferencePanel() {
  const [selectedId, setSelectedId] = useState("architecture");
  const selected = useMemo(
    () => SYSTEM_REFERENCE_DOCUMENTS.find((document) => document.id === selectedId) ?? SYSTEM_REFERENCE_DOCUMENTS[0],
    [selectedId],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "18px 20px", display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", color: T.text, fontSize: 16, fontWeight: 700 }}><BookOpen size={17} /> System Reference</div>
          <div style={{ marginTop: 6, color: T.textSub, fontSize: 12, lineHeight: 1.55, maxWidth: 760 }}>
            Curated architecture, decision, and feature records. This is owner-only and intentionally separate from the trading surface.
          </div>
        </div>
        <a href="/dashboard/agents#agent-flow-architecture" style={{ display: "inline-flex", alignItems: "center", gap: 7, color: T.text, border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 10px", textDecoration: "none", fontSize: 12, fontWeight: 600 }}>
          <Network size={14} /> Live agent topology
        </a>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(230px, 0.8fr) minmax(0, 2fr)", gap: 16, alignItems: "start" }}>
        <aside style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, padding: 10 }}>
          {CATEGORIES.map((category) => {
            const documents = SYSTEM_REFERENCE_DOCUMENTS.filter((document) => document.category === category);
            if (!documents.length) return null;
            return <div key={category} style={{ marginBottom: 10 }}>
              <div style={{ color: T.muted, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", padding: "8px 9px 5px" }}>{category}</div>
              {documents.map((document) => <button key={document.id} onClick={() => setSelectedId(document.id)} style={{ width: "100%", textAlign: "left", border: 0, borderRadius: 5, padding: "9px", cursor: "pointer", background: document.id === selected.id ? T.card : "transparent", color: document.id === selected.id ? T.text : T.textSub, fontSize: 12, lineHeight: 1.3 }}>
                {document.title}
              </button>)}
            </div>;
          })}
        </aside>

        <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "20px" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: T.text, fontSize: 15, fontWeight: 700 }}><FileText size={16} /> {selected.title}</div>
              <div style={{ color: T.textSub, fontSize: 12, marginTop: 7, lineHeight: 1.55 }}>{selected.description}</div>
              <code style={{ display: "inline-block", color: T.muted, fontSize: 11, marginTop: 10 }}>{selected.path}</code>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <a href={`/api/system-reference/${selected.id}`} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 6, border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 10px", color: T.text, textDecoration: "none", fontSize: 12, fontWeight: 600 }}><ExternalLink size={14} /> Open</a>
              <a href={`/api/system-reference/${selected.id}?download=1`} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: 0, borderRadius: 6, padding: "8px 10px", background: T.accent, color: "#fff", textDecoration: "none", fontSize: 12, fontWeight: 700 }}><Download size={14} /> Download</a>
            </div>
          </div>
          <div style={{ marginTop: 22, borderTop: `1px solid ${T.border}`, paddingTop: 16, color: T.textSub, fontSize: 12, lineHeight: 1.65 }}>
            The canonical document remains the file itself. Operational diagrams are not duplicated here: use the live topology below this page, which renders from <code>public/agent-diagrams/system-map.json</code> and has its own drift test.
          </div>
        </section>
      </div>
    </div>
  );
}
