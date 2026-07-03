"use client";
import { useEffect, useRef, useState } from "react";

export default function MermaidChart({ chart, className }: { chart: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!chart?.trim()) return;
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({ startOnLoad: false, theme: "dark", themeVariables: { primaryColor: "#6366F1", primaryTextColor: "#ECEDEF", lineColor: "#252836", edgeLabelBackground: "#13151C" } });
        const id = "mermaid-" + Math.random().toString(36).slice(2);
        const { svg: rendered } = await mermaid.render(id, chart);
        if (!cancelled) setSvg(rendered);
      } catch (e: any) {
        if (!cancelled) setErr(String(e?.message ?? e));
      }
    })();
    return () => { cancelled = true; };
  }, [chart]);

  if (err) return <div style={{ color: "#F87171", fontSize: "12px", padding: "12px", fontFamily: "monospace", background: "#3B0000", borderRadius: "8px" }}>Mermaid parse error: {err}</div>;
  if (!svg) return <div style={{ color: "#6B7280", fontSize: "12px", padding: "12px" }}>Rendering diagram…</div>;

  return <div ref={ref} className={className} dangerouslySetInnerHTML={{ __html: svg }} style={{ maxWidth: "100%", overflowX: "auto" }} />;
}
