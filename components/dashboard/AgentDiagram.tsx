"use client";
import React, { useEffect, useRef, useState } from "react";

const T = {
  bg: "#0D0F14", card: "#13151C", border: "#1E2130",
  accent: "#6366F1", text: "#E2E8F0", muted: "#64748B",
  green: "#34D399", red: "#F87171", amber: "#FBBF24", blue: "#60A5FA",
};

const STATUS_META: Record<string, { fill: string; stroke: string; color: string; label: string }> = {
  active:  { fill: "#0d2218", stroke: "#34D399", color: "#34D399", label: "active" },
  new:     { fill: "#0d1228", stroke: "#60A5FA", color: "#60A5FA", label: "new" },
  changed: { fill: "#2a1010", stroke: "#F87171", color: "#F87171", label: "changed" },
  removed: { fill: "#181818", stroke: "#4B5563", color: "#6B7280", label: "removed" },
};

interface DiagramNode {
  label: string;
  description: string;
  addedAt: string;
  addReason: string;
  status: "active" | "new" | "changed" | "removed";
  changedAt: string | null;
  changeReason: string | null;
  removedAt: string | null;
  removeReason: string | null;
}

interface DiagramData {
  agentId: string;
  agentLabel: string;
  diagram: string;
  nodes: Record<string, DiagramNode>;
  history: Array<{ date: string; event: string; nodeId: string; label: string; reason: string }>;
}

const zoomBtnStyle: React.CSSProperties = {
  padding: "3px 8px", fontSize: 11, cursor: "pointer", borderRadius: 4,
  border: "1px solid #1E2130", background: "#13151C", color: "#E2E8F0",
};

export default function AgentDiagram({ agentId }: { agentId: string }) {
  const [data, setData] = useState<DiagramData | null>(null);
  const [tab, setTab] = useState<"diagram" | "history">("diagram");
  const [selected, setSelected] = useState<{ id: string; node: DiagramNode } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1.0);
  const [rendering, setRendering] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const renderedRef = useRef<string | null>(null);

  const handleExport = () => {
    const svgEl = containerRef.current?.querySelector("svg");
    if (!svgEl) return;
    const blob = new Blob([svgEl.outerHTML], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${agentId}-diagram.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    setData(null);
    setError(null);
    setSelected(null);
    setZoom(1.0);
    renderedRef.current = null;
    if (containerRef.current) containerRef.current.innerHTML = "";
    fetch(`/agent-diagrams/${agentId}.json`)
      .then(r => r.ok ? r.json() : Promise.reject("not found"))
      .then(setData)
      .catch(() => setError("No diagram yet for this agent."));
  }, [agentId]);

  useEffect(() => {
    if (!data || tab !== "diagram" || !containerRef.current) return;
    if (renderedRef.current === agentId) return;

    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          themeVariables: {
            background: T.bg,
            primaryColor: "#1a1f2e",
            primaryTextColor: T.text,
            primaryBorderColor: T.border,
            lineColor: T.muted,
            edgeLabelBackground: T.card,
            fontSize: "13px",
          },
        });

        const classDefs = Object.entries(STATUS_META)
          .map(([s, m]) => `classDef ${s} fill:${m.fill},stroke:${m.stroke},color:${m.color},stroke-width:2px`)
          .join("\n");

        const classLines = Object.entries(data.nodes)
          .map(([id, n]) => `class ${id} ${n.status}`)
          .join("\n");

        const mmd = `${data.diagram}\n${classDefs}\n${classLines}`;
        const uid = `agd_${agentId.replace(/[^a-z0-9]/gi, "_")}_${Date.now()}`;
        setRendering(true);
        const { svg } = await mermaid.render(uid, mmd);
        if (cancelled || !containerRef.current) { setRendering(false); return; }

        containerRef.current.innerHTML = svg;
        renderedRef.current = agentId;
        setRendering(false);

        const svgEl = containerRef.current.querySelector("svg");
        if (!svgEl) return;
        svgEl.style.cssText = "width:100%;height:auto;max-height:560px;cursor:default";

        Object.keys(data.nodes).forEach(nodeId => {
          const els = svgEl.querySelectorAll(`[id*="flowchart-${nodeId}-"]`);
          els.forEach(el => {
            (el as HTMLElement).style.cursor = "pointer";
            el.addEventListener("click", e => {
              e.stopPropagation();
              setSelected({ id: nodeId, node: data.nodes[nodeId] });
            });
          });
        });
        svgEl.addEventListener("click", () => setSelected(null));
      } catch (err) {
        console.error("Mermaid render error", err);
        setRendering(false);
      }
    })();
    return () => { cancelled = true; };
  }, [data, tab, agentId]);

  if (error) return <div style={{ padding: 24, color: T.muted, fontSize: 13 }}>{error}</div>;
  if (!data) return <div style={{ padding: 24, color: T.muted, fontSize: 13 }}>Loading diagram…</div>;

  const tabBtn = (key: "diagram" | "history", label: string) => (
    <button onClick={() => setTab(key)} style={{
      padding: "5px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", borderRadius: 5,
      border: "none", background: tab === key ? T.accent : "transparent",
      color: tab === key ? "#fff" : T.muted,
    }}>{label}</button>
  );

  const eventIcon = (e: string) =>
    e === "add" ? { icon: "+", color: T.green } :
    e === "remove" ? { icon: "−", color: T.red } :
    { icon: "~", color: T.amber };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "8px 14px", borderBottom: `1px solid ${T.border}`, flexShrink: 0, gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {Object.entries(STATUS_META).map(([s, m]) => (
            <span key={s} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: m.color }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: m.fill,
                border: `1.5px solid ${m.stroke}`, display: "inline-block" }} />
              {m.label}
            </span>
          ))}
          <span style={{ fontSize: 10, color: T.muted }}>· click any node</span>
        </div>
        <div style={{ display: "flex", gap: 3 }}>
          {tabBtn("diagram", `Diagram (${Object.keys(data.nodes).length})`)}
          {tabBtn("history", `History (${data.history.length})`)}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden" }}>
        {tab === "diagram" && (
          <>
            <div style={{ flex: 1, overflow: "auto", overflowX: "auto", WebkitOverflowScrolling: "touch", padding: 12, position: "relative" }}>
              {/* Zoom toolbar */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, position: "sticky", top: 0, zIndex: 10, background: "#0D0F14", padding: "4px 0" }}>
                <button onClick={() => setZoom(z => Math.max(0.3, z - 0.15))} style={zoomBtnStyle}>−</button>
                <span style={{ fontSize: 11, color: "#64748B", minWidth: 40, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
                <button onClick={() => setZoom(z => Math.min(3.0, z + 0.15))} style={zoomBtnStyle}>+</button>
                <button onClick={() => setZoom(1.0)} style={zoomBtnStyle}>⊡ Fit</button>
                <button onClick={handleExport} style={{ ...zoomBtnStyle, marginLeft: "auto" }}>⬇ Export SVG</button>
              </div>
              <div ref={containerRef} style={{ transform: `scale(${zoom})`, transformOrigin: "top left", transition: "transform 0.1s" }} />
              {rendering && (
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center",
                  justifyContent: "center", background: "#0D0F1480", zIndex: 5, fontSize: 12, color: "#64748B" }}>
                  Rendering diagram…
                </div>
              )}
            </div>
            {selected && (
              <div style={{ width: 270, flexShrink: 0, borderLeft: `1px solid ${T.border}`,
                background: T.card, overflow: "auto", padding: 14, display: "flex",
                flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: T.text, lineHeight: 1.3 }}>
                    {selected.node.label}
                  </span>
                  <button onClick={() => setSelected(null)} style={{ background: "none", border: "none",
                    color: T.muted, cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 0 }}>×</button>
                </div>
                {(() => {
                  const m = STATUS_META[selected.node.status] ?? STATUS_META.active;
                  return (
                    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
                      background: m.fill, color: m.color, border: `1px solid ${m.stroke}`,
                      textTransform: "uppercase", alignSelf: "flex-start" }}>
                      {selected.node.status}
                    </span>
                  );
                })()}
                <p style={{ fontSize: 12, color: T.text, lineHeight: 1.6, margin: 0 }}>
                  {selected.node.description}
                </p>
                <div style={{ padding: "8px 10px", borderRadius: 6, background: "#0a1e14", border: "1px solid #1a3a24" }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: T.green, marginBottom: 4, letterSpacing: "0.05em" }}>
                    WHY ADDED · {selected.node.addedAt}
                  </div>
                  <div style={{ fontSize: 11, color: T.text, lineHeight: 1.5 }}>{selected.node.addReason}</div>
                </div>
                {selected.node.changedAt && (
                  <div style={{ padding: "8px 10px", borderRadius: 6, background: "#1e0a0a", border: "1px solid #3a1a1a" }}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: T.red, marginBottom: 4, letterSpacing: "0.05em" }}>
                      CHANGED · {selected.node.changedAt}
                    </div>
                    <div style={{ fontSize: 11, color: T.text, lineHeight: 1.5 }}>{selected.node.changeReason}</div>
                  </div>
                )}
                {selected.node.removedAt && (
                  <div style={{ padding: "8px 10px", borderRadius: 6, background: "#111", border: `1px solid ${T.border}` }}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: T.muted, marginBottom: 4, letterSpacing: "0.05em" }}>
                      REMOVED · {selected.node.removedAt}
                    </div>
                    <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.5 }}>{selected.node.removeReason}</div>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {tab === "history" && (
          <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              {[...data.history].reverse().map((h, i) => {
                const ev = eventIcon(h.event);
                return (
                  <div key={i} style={{ display: "flex", gap: 12, paddingBottom: 18, position: "relative" }}>
                    {i < data.history.length - 1 && (
                      <div style={{ position: "absolute", left: 14, top: 28, bottom: 0,
                        width: 1, background: T.border }} />
                    )}
                    <div style={{ width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
                      background: ev.color + "18", border: `2px solid ${ev.color}`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 14, fontWeight: 700, color: ev.color, lineHeight: 1 }}>
                      {ev.icon}
                    </div>
                    <div style={{ flex: 1, paddingTop: 3 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: T.text }}>{h.label}</span>
                        <span style={{ fontSize: 10, color: T.muted }}>{h.date}</span>
                      </div>
                      <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.5 }}>{h.reason}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
