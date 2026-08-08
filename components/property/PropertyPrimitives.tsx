"use client";

import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import { AlertCircle, CircleHelp, Inbox } from "lucide-react";

export const PT = {
  bg: "#0D0F14",
  surface: "#13151C",
  card: "#1A1D27",
  cardRaised: "#202430",
  border: "#2A2E3C",
  text: "#ECEDEF",
  textSub: "#A6AAB5",
  muted: "#737986",
  accent: "#34D399",
  blue: "#60A5FA",
  amber: "#FBBF24",
  red: "#F87171",
} as const;

export const fieldStyle: CSSProperties = {
  width: "100%",
  minHeight: "38px",
  boxSizing: "border-box",
  border: `1px solid ${PT.border}`,
  borderRadius: "6px",
  background: PT.bg,
  color: PT.text,
  padding: "8px 10px",
  fontSize: "12px",
  outline: "none",
};

export const buttonStyle: CSSProperties = {
  minHeight: "36px",
  border: 0,
  borderRadius: "6px",
  padding: "8px 12px",
  background: PT.accent,
  color: "#07120E",
  fontSize: "12px",
  fontWeight: 750,
  cursor: "pointer",
};

export type PropertyPageHelp = {
  whatItDoes: string;
  whatToLookFor: string[];
};

export function PropertyPageFrame({
  eyebrow,
  title,
  description,
  action,
  help,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
  help?: PropertyPageHelp;
  children: ReactNode;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <div className="property-page-frame" style={{ minHeight: "100%" }}>
      <header className="property-page-header" style={{ padding: "24px 28px 20px", borderBottom: `1px solid ${PT.border}`, display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "18px" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: PT.accent, fontSize: "10px", fontWeight: 800, letterSpacing: "0.1em" }}>{eyebrow.toUpperCase()}</div>
          <h1 style={{ color: PT.text, fontSize: "23px", lineHeight: 1.25, letterSpacing: 0, margin: "6px 0 5px" }}>{title}</h1>
          <p style={{ color: PT.textSub, fontSize: "12px", lineHeight: 1.55, margin: 0, maxWidth: "760px" }}>{description}</p>
        </div>
        {(action || help) ? <div style={{ display: "flex", gap: "8px", alignItems: "center", flexShrink: 0 }}>
          {action}
          {help ? <button type="button" title="What's on this page" aria-label={helpOpen ? "Hide page help" : "Show page help"} aria-expanded={helpOpen} onClick={() => setHelpOpen((open) => !open)} style={{ width: "34px", height: "34px", display: "inline-flex", alignItems: "center", justifyContent: "center", border: `1px solid ${helpOpen ? `${PT.accent}66` : PT.border}`, borderRadius: "6px", background: helpOpen ? `${PT.accent}18` : "transparent", color: helpOpen ? PT.accent : PT.textSub, cursor: "pointer" }}><CircleHelp size={15} /></button> : null}
        </div> : null}
      </header>
      {help && helpOpen ? <section aria-label="Page help" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: "18px", padding: "14px 28px", borderBottom: `1px solid ${PT.border}`, background: `${PT.accent}0C` }}>
        <div><div style={{ fontSize: "9px", fontWeight: 800, color: PT.accent, letterSpacing: "0.1em", marginBottom: "5px" }}>WHAT&apos;S HERE</div><div style={{ color: PT.textSub, fontSize: "11px", lineHeight: 1.55 }}>{help.whatItDoes}</div></div>
        <div><div style={{ fontSize: "9px", fontWeight: 800, color: PT.accent, letterSpacing: "0.1em", marginBottom: "5px" }}>WHAT TO LOOK FOR</div><ul style={{ margin: 0, paddingLeft: "15px", display: "grid", gap: "3px" }}>{help.whatToLookFor.map((item) => <li key={item} style={{ color: PT.textSub, fontSize: "11px", lineHeight: 1.45 }}>{item}</li>)}</ul></div>
      </section> : null}
      {children}
      <style>{`
        @media (max-width: 720px) {
          .property-page-frame { overflow-x: hidden !important; }
          .property-page-header { padding: 18px 16px 16px !important; align-items: flex-start !important; flex-direction: column !important; }
          .property-page-header > :last-child:not(:first-child) { width: 100% !important; justify-content: center !important; }
          .property-page-header > :last-child:not(:first-child) > button { flex: 0 0 34px; }
          [aria-label="Page help"] { grid-template-columns: minmax(0, 1fr) !important; padding: 14px 16px !important; }
          .property-page-body { padding: 16px !important; }
          .property-two-column, .property-three-column { grid-template-columns: minmax(0, 1fr) !important; }
          .property-stat-row { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
          .property-table-header { display: none !important; }
          .property-table-row { grid-template-columns: minmax(0, 1fr) !important; gap: 8px !important; padding: 14px !important; }
          .property-table-row > [data-label] { display: grid !important; grid-template-columns: minmax(88px, .42fr) minmax(0, 1fr); gap: 10px; align-items: baseline; min-width: 0; overflow-wrap: anywhere; }
          .property-table-row > [data-label]::before { content: attr(data-label); color: ${PT.muted}; font-size: 9px; font-weight: 800; }
          .property-chart { height: 250px !important; min-width: 0 !important; }
          .property-section-heading { align-items: flex-start !important; flex-direction: column !important; }
        }
        @media (max-width: 410px) {
          .property-stat-row { grid-template-columns: minmax(0, 1fr) !important; }
        }
      `}</style>
    </div>
  );
}

export function FieldLabel({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label style={{ display: "grid", gap: "6px", minWidth: 0 }}>
      <span style={{ color: PT.textSub, fontSize: "10px", fontWeight: 700 }}>{label}</span>
      {children}
      {hint ? <span style={{ color: PT.muted, fontSize: "9px", lineHeight: 1.4 }}>{hint}</span> : null}
    </label>
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div style={{ minHeight: "190px", display: "grid", placeItems: "center", padding: "24px", textAlign: "center" }}>
      <div>
        <Inbox size={22} color={PT.muted} style={{ marginBottom: "10px" }} />
        <div style={{ color: PT.text, fontSize: "13px", fontWeight: 700 }}>{title}</div>
        <div style={{ color: PT.muted, fontSize: "11px", lineHeight: 1.55, maxWidth: "390px", marginTop: "5px" }}>{detail}</div>
      </div>
    </div>
  );
}

export function LocalOnlyNotice({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", gap: "8px", alignItems: "flex-start", padding: "10px 12px", border: `1px solid ${PT.border}`, borderRadius: "6px", background: `${PT.blue}0C`, color: PT.textSub, fontSize: "10px", lineHeight: 1.5 }}>
      <AlertCircle size={14} color={PT.blue} style={{ flexShrink: 0, marginTop: "1px" }} />
      <span>{children}</span>
    </div>
  );
}

export function StatCell({ label, value, detail, tone = PT.text }: { label: string; value: string; detail?: string; tone?: string }) {
  return (
    <div style={{ padding: "15px 18px", minWidth: 0, borderRight: `1px solid ${PT.border}` }}>
      <div style={{ color: PT.muted, fontSize: "9px", fontWeight: 700 }}>{label}</div>
      <div style={{ color: tone, fontSize: "19px", fontWeight: 750, marginTop: "4px", overflowWrap: "anywhere" }}>{value}</div>
      {detail ? <div style={{ color: PT.textSub, fontSize: "9px", marginTop: "3px" }}>{detail}</div> : null}
    </div>
  );
}
