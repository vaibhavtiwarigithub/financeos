import type { CSSProperties, ReactNode } from "react";
import { AlertCircle, Inbox } from "lucide-react";

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

export function PropertyPageFrame({
  eyebrow,
  title,
  description,
  action,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="property-page-frame" style={{ minHeight: "100%" }}>
      <header className="property-page-header" style={{ padding: "24px 28px 20px", borderBottom: `1px solid ${PT.border}`, display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "18px" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: PT.accent, fontSize: "10px", fontWeight: 800, letterSpacing: "0.1em" }}>{eyebrow.toUpperCase()}</div>
          <h1 style={{ color: PT.text, fontSize: "23px", lineHeight: 1.25, letterSpacing: 0, margin: "6px 0 5px" }}>{title}</h1>
          <p style={{ color: PT.textSub, fontSize: "12px", lineHeight: 1.55, margin: 0, maxWidth: "760px" }}>{description}</p>
        </div>
        {action}
      </header>
      {children}
      <style>{`
        @media (max-width: 720px) {
          .property-page-header { padding: 18px 16px 16px !important; align-items: flex-start !important; flex-direction: column !important; }
          .property-page-body { padding: 16px !important; }
          .property-two-column, .property-three-column { grid-template-columns: minmax(0, 1fr) !important; }
          .property-stat-row { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
          .property-table-header { display: none !important; }
          .property-table-row { grid-template-columns: minmax(0, 1fr) !important; gap: 6px !important; }
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
