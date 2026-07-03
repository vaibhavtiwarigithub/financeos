"use client";
import { useState, useRef, useEffect } from "react";

interface InfoTooltipProps {
  title: string;
  body: string;
  bullets?: string[];
  screenerParams?: { label: string; value: string }[];
  placement?: "top" | "bottom" | "left" | "right";
}

export default function InfoTooltip({
  title,
  body,
  bullets,
  screenerParams,
  placement = "bottom",
}: InfoTooltipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  const popoverStyle: React.CSSProperties = {
    position: "absolute",
    zIndex: 9000,
    width: "280px",
    background: "#1A1D27",
    border: "1px solid #252836",
    borderRadius: "10px",
    boxShadow: "0 8px 32px #000000AA",
    padding: "12px 14px",
    ...(placement === "bottom"
      ? { top: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)" }
      : placement === "top"
      ? { bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)" }
      : placement === "right"
      ? { top: "50%", left: "calc(100% + 6px)", transform: "translateY(-50%)" }
      : { top: "50%", right: "calc(100% + 6px)", transform: "translateY(-50%)" }),
  };

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title={title}
        style={{
          width: "16px",
          height: "16px",
          borderRadius: "50%",
          border: open ? "1px solid #6366F1" : "1px solid #252836",
          background: open ? "#1E1F3A" : "transparent",
          color: open ? "#6366F1" : "#6B7280",
          fontSize: "9px",
          fontWeight: 700,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          lineHeight: 1,
          flexShrink: 0,
          fontFamily: "serif",
          transition: "all 0.1s",
        }}
        aria-label={`Info: ${title}`}
      >
        i
      </button>

      {open && (
        <div style={popoverStyle}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: "#ECEDEF", marginBottom: "6px" }}>{title}</div>
          <div style={{ fontSize: "11px", color: "#9B9EA8", lineHeight: "1.6", marginBottom: bullets || screenerParams ? "8px" : 0 }}>
            {body}
          </div>
          {bullets && bullets.length > 0 && (
            <ul style={{ margin: "0 0 8px 0", padding: "0 0 0 14px", display: "flex", flexDirection: "column", gap: "3px" }}>
              {bullets.map((b, i) => (
                <li key={i} style={{ fontSize: "10px", color: "#9B9EA8", lineHeight: "1.5" }}>{b}</li>
              ))}
            </ul>
          )}
          {screenerParams && screenerParams.length > 0 && (
            <div style={{ borderTop: "1px solid #252836", paddingTop: "8px", marginTop: "4px" }}>
              <div style={{ fontSize: "9px", fontWeight: 700, color: "#6366F1", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "5px" }}>
                Screener Parameters
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                {screenerParams.map((p, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: "10px" }}>
                    <span style={{ color: "#6B7280" }}>{p.label}</span>
                    <span style={{ color: "#ECEDEF", fontFamily: "monospace" }}>{p.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
