"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock3, Database, RefreshCw, ShieldCheck } from "lucide-react";
import type { ShadowProgramStatus } from "@/lib/shadows/status";
import type { ShadowLifecycle } from "@/lib/shadows/registry";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#2B2F3D",
  text: "#ECEDEF", textSub: "#A8ABB6", muted: "#727786", accent: "#7C83FD",
  green: "#34D399", red: "#F87171", yellow: "#FBBF24", blue: "#60A5FA",
};

type ApiResponse = {
  generatedAt: string;
  summary: { total: number; collecting: number; readyForReview: number; blockedOrIdle: number; trackedCalls7d: number };
  programs: ShadowProgramStatus[];
};
type LifecycleFilter = "all" | "active" | "review" | "blocked" | "off";
type MarketFilter = "all" | "us" | "india";

const LIFECYCLE_META: Record<ShadowLifecycle, { label: string; color: string }> = {
  collecting: { label: "Collecting", color: T.blue },
  ready_for_review: { label: "Ready for review", color: T.green },
  blocked: { label: "Blocked", color: T.red },
  armed: { label: "Armed", color: T.yellow },
  paper_active: { label: "Paper active", color: T.green },
  idle: { label: "Idle", color: T.yellow },
  off: { label: "Off", color: T.muted },
};
const BENEFIT_META = {
  benefited: { label: "Benefited", color: T.green },
  promising: { label: "Promising", color: T.green },
  mixed: { label: "Mixed", color: T.yellow },
  not_beneficial: { label: "Not beneficial", color: T.red },
  insufficient: { label: "Insufficient evidence", color: T.yellow },
  operational_only: { label: "Operational proof only", color: T.blue },
};

function useIsMobile(breakpoint = 900) {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [breakpoint]);
  return mobile;
}

function fmtNumber(value: number | null) {
  return value == null ? "Not metered" : new Intl.NumberFormat("en-US").format(value);
}
function fmtDate(value: string | null) {
  if (!value) return "No evidence yet";
  return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function etaLabel(program: ShadowProgramStatus) {
  if (program.progress.target != null && program.progress.completed >= program.progress.target) return "Evidence floor met";
  if (program.progress.estimatedDays == null) return "No defensible ETA";
  return `About ${program.progress.estimatedDays} day${program.progress.estimatedDays === 1 ? "" : "s"}`;
}

function StatusPill({ label, color }: { label: string; color: string }) {
  return <span style={{
    display: "inline-flex", alignItems: "center", minHeight: "24px", padding: "3px 8px",
    borderRadius: "6px", border: `1px solid ${color}55`, color, background: `${color}12`,
    fontSize: "11px", fontWeight: 700,
  }}>{label}</span>;
}
function SectionLabel({ icon, text }: { icon: React.ReactNode; text: string }) {
  return <div style={{
    display: "flex", alignItems: "center", gap: "6px", color: T.muted, fontSize: "11px",
    fontWeight: 750, textTransform: "uppercase", marginBottom: "7px",
  }}>{icon}{text}</div>;
}
function TextBlock({ label, text }: { label: string; text: string }) {
  return <div>
    <div style={{ color: T.muted, fontSize: "11px", fontWeight: 750, textTransform: "uppercase", marginBottom: "5px" }}>{label}</div>
    <div style={{ color: T.textSub, fontSize: "12px", lineHeight: 1.55 }}>{text}</div>
  </div>;
}
function ProgressBar({ program }: { program: ShadowProgramStatus }) {
  const target = program.progress.target;
  const pct = target == null ? null : Math.min(100, Math.round((program.progress.completed / Math.max(1, target)) * 100));
  return <div>
    <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", marginBottom: "7px" }}>
      <span style={{ color: T.text, fontSize: "13px", fontWeight: 650 }}>
        {fmtNumber(program.progress.completed)}{target == null ? "" : ` / ${fmtNumber(target)}`} {program.progress.unit}
      </span>
      <span style={{ color: T.textSub, fontSize: "12px" }}>{etaLabel(program)}</span>
    </div>
    {pct != null && <div style={{ height: "6px", background: T.surface, borderRadius: "3px", overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", background: pct >= 100 ? T.green : T.accent }} />
    </div>}
    <div style={{ color: T.muted, fontSize: "12px", marginTop: "7px" }}>
      {program.progress.ratePerDay == null ? "No observed collection rate" : `${program.progress.ratePerDay.toFixed(2)} per day over ${program.progress.windowDays} days`}
    </div>
    {program.progress.secondary && <div style={{ color: T.textSub, fontSize: "12px", marginTop: "5px" }}>
      Secondary gate: {program.progress.secondary.completed} / {program.progress.secondary.target} {program.progress.secondary.unit}
    </div>}
  </div>;
}

function ProgramPanel({ program, mobile }: { program: ShadowProgramStatus; mobile: boolean }) {
  const lifecycle = LIFECYCLE_META[program.lifecycle];
  const benefit = BENEFIT_META[program.benefitVerdict];
  return <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", overflow: "hidden", opacity: program.available ? 1 : 0.72 }}>
    <div style={{
      padding: mobile ? "16px" : "18px 20px", display: "flex", justifyContent: "space-between",
      alignItems: "flex-start", gap: "16px", borderBottom: `1px solid ${T.border}`,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <h2 style={{ fontSize: "17px", lineHeight: 1.3, margin: 0, color: T.text }}>{program.name}</h2>
          <StatusPill label={lifecycle.label} color={lifecycle.color} />
          <StatusPill label={benefit.label} color={benefit.color} />
        </div>
        <div style={{ color: T.muted, fontSize: "12px", marginTop: "7px" }}>
          {program.category} · {program.markets.map((market) => market.toUpperCase()).join(" + ")} · Owner: {program.owner}
        </div>
      </div>
      <div style={{ color: T.textSub, fontSize: "12px", whiteSpace: "nowrap" }}>Latest: {fmtDate(program.latestAt)}</div>
    </div>

    <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "minmax(0, 1.25fr) minmax(280px, .75fr)" }}>
      <div style={{ padding: mobile ? "16px" : "18px 20px", borderRight: mobile ? "none" : `1px solid ${T.border}` }}>
        <div style={{ color: T.text, fontSize: "14px", lineHeight: 1.55 }}>{program.purpose}</div>
        <div style={{ marginTop: "16px", display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr", gap: "14px 20px" }}>
          <TextBlock label="What it gives the app" text={program.productBenefit} />
          <TextBlock label="What it gives the trader" text={program.traderBenefit} />
          <TextBlock label="Current influence" text={program.currentInfluence} />
          <TextBlock label="Maximum allowed influence" text={program.maximumInfluence} />
        </div>
        <div style={{ marginTop: "16px", paddingTop: "14px", borderTop: `1px solid ${T.border}` }}>
          <TextBlock label="Observed benefit" text={program.benefitEvidence} />
        </div>
      </div>
      <div style={{ padding: mobile ? "16px" : "18px 20px", display: "flex", flexDirection: "column", gap: "17px" }}>
        <div><SectionLabel icon={<Activity size={14} />} text="Evidence progress" /><ProgressBar program={program} /></div>
        <div>
          <SectionLabel icon={<Database size={14} />} text="Provider calls" />
          <div style={{ color: T.text, fontSize: "13px", lineHeight: 1.55 }}>
            {program.calls.mode === "tracked"
              ? `${fmtNumber(program.calls.recorded)} ledger rows · ${fmtNumber(program.calls.networkAttempts)} network · ${fmtNumber(program.calls.cacheHits)} cache hits`
              : program.calls.mode === "zero_incremental" ? "Zero incremental provider calls"
                : program.calls.mode === "not_applicable" ? "Not applicable" : "Not fully metered"}
          </div>
          <div style={{ color: T.muted, fontSize: "12px", lineHeight: 1.5, marginTop: "4px" }}>{program.calls.note}</div>
        </div>
        <div>
          <SectionLabel icon={<Clock3 size={14} />} text="Schedule" />
          <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
            {!program.schedules.length && <span style={{ color: T.muted, fontSize: "12px" }}>Triggered inside another agent flow</span>}
            {program.schedules.map((schedule) => <div key={schedule.job} style={{ color: schedule.active ? T.textSub : T.muted, fontSize: "12px", lineHeight: 1.4 }}>
              <span style={{ color: schedule.active ? T.green : T.muted }}>●</span>{" "}
              {schedule.job} · {schedule.active ? schedule.schedule ?? "active" : "not scheduled"}
            </div>)}
          </div>
        </div>
      </div>
    </div>
    <div style={{
      padding: mobile ? "16px" : "16px 20px", display: "grid",
      gridTemplateColumns: mobile ? "1fr" : "minmax(0, 1fr) minmax(0, 1fr)",
      gap: "16px 24px", borderTop: `1px solid ${T.border}`, background: T.surface,
    }}>
      <div>
        <SectionLabel icon={<ShieldCheck size={14} />} text="Activation gate and safety" />
        <div style={{ color: T.textSub, fontSize: "12px", lineHeight: 1.55 }}>{program.activationGate}</div>
        <div style={{ color: T.muted, fontSize: "12px", lineHeight: 1.55, marginTop: "5px" }}>{program.safetyBoundary}</div>
      </div>
      <div>
        <SectionLabel icon={<AlertTriangle size={14} />} text="What remains" />
        {program.blockers.map((blocker) => <div key={blocker} style={{ color: T.textSub, fontSize: "12px", lineHeight: 1.5, marginBottom: "3px" }}>• {blocker}</div>)}
        <div style={{ color: T.accent, fontSize: "12px", lineHeight: 1.5, marginTop: "7px" }}>Next: {program.nextAction}</div>
      </div>
    </div>
  </section>;
}

export default function UpgradePathPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [lifecycle, setLifecycle] = useState<LifecycleFilter>("all");
  const [market, setMarket] = useState<MarketFilter>("all");
  const mobile = useIsMobile();

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/upgrade-path", { cache: "no-store" });
      if (!response.ok) throw new Error(`Status request failed (${response.status})`);
      setData(await response.json());
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Status request failed");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const filtered = useMemo(() => (data?.programs ?? []).filter((program) => {
    const marketMatch = market === "all" || program.markets.includes(market);
    const lifecycleMatch = lifecycle === "all"
      || (lifecycle === "active" && ["collecting", "paper_active", "armed"].includes(program.lifecycle))
      || (lifecycle === "review" && program.lifecycle === "ready_for_review")
      || (lifecycle === "blocked" && ["blocked", "idle"].includes(program.lifecycle))
      || (lifecycle === "off" && program.lifecycle === "off");
    return marketMatch && lifecycleMatch;
  }), [data, lifecycle, market]);

  return <main style={{ minHeight: "100vh", background: T.bg, color: T.text, padding: mobile ? "18px 14px 36px" : "24px 28px 48px" }}>
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "18px", marginBottom: "20px" }}>
      <div>
        <div style={{ color: T.accent, fontSize: "11px", fontWeight: 800, textTransform: "uppercase", marginBottom: "7px" }}>Research governance</div>
        <h1 style={{ fontSize: mobile ? "24px" : "28px", lineHeight: 1.2, margin: 0, letterSpacing: 0 }}>Upgrade Path</h1>
        <p style={{ color: T.textSub, fontSize: "13px", lineHeight: 1.55, margin: "8px 0 0", maxWidth: "780px" }}>
          Live evidence, cost, benefit and activation boundaries for every registered shadow, paper experiment and dormant upgrade path.
        </p>
      </div>
      <button type="button" onClick={load} title="Refresh status" aria-label="Refresh status" style={{
        width: "36px", height: "36px", borderRadius: "6px", border: `1px solid ${T.border}`,
        background: T.card, color: T.text, display: "grid", placeItems: "center", cursor: "pointer", flexShrink: 0,
      }}><RefreshCw size={16} /></button>
    </header>

    {data && <section style={{
      display: "grid", gridTemplateColumns: mobile ? "repeat(2, minmax(0, 1fr))" : "repeat(5, minmax(0, 1fr))",
      border: `1px solid ${T.border}`, borderRadius: "8px", overflow: "hidden", marginBottom: "16px",
    }}>
      {[
        ["Programs", data.summary.total], ["Active", data.summary.collecting],
        ["Review ready", data.summary.readyForReview], ["Blocked / idle", data.summary.blockedOrIdle],
        ["Tracked calls · 7d", data.summary.trackedCalls7d],
      ].map(([label, value], index) => <div key={String(label)} style={{
        padding: "14px 16px", background: T.surface,
        borderRight: index === 4 || (mobile && index % 2 === 1) ? "none" : `1px solid ${T.border}`,
        borderBottom: mobile && index < 4 ? `1px solid ${T.border}` : "none",
      }}>
        <div style={{ fontSize: "20px", fontWeight: 750, color: T.text }}>{value}</div>
        <div style={{ fontSize: "11px", color: T.muted, marginTop: "4px", textTransform: "uppercase" }}>{label}</div>
      </div>)}
    </section>}

    <section style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
      {([
        ["all", "All"], ["active", "Active"], ["review", "Review ready"], ["blocked", "Blocked / idle"], ["off", "Off"],
      ] as const).map(([value, label]) => <button key={value} type="button" onClick={() => setLifecycle(value)} style={{
        border: `1px solid ${lifecycle === value ? T.accent : T.border}`, borderRadius: "6px",
        background: lifecycle === value ? `${T.accent}1F` : T.surface, color: lifecycle === value ? T.text : T.textSub,
        padding: "7px 10px", fontSize: "12px", cursor: "pointer",
      }}>{label}</button>)}
      <select aria-label="Filter by market" value={market} onChange={(event) => setMarket(event.target.value as MarketFilter)} style={{
        marginLeft: mobile ? 0 : "auto", border: `1px solid ${T.border}`, borderRadius: "6px",
        background: T.surface, color: T.text, padding: "7px 30px 7px 10px", fontSize: "12px",
      }}>
        <option value="all">All markets</option><option value="us">US</option><option value="india">India</option>
      </select>
      {data && <span style={{ color: T.muted, fontSize: "11px" }}>Updated {fmtDate(data.generatedAt)} · auto-refreshes every minute</span>}
    </section>

    {error && <div style={{
      border: `1px solid ${T.red}66`, color: T.red, background: `${T.red}10`,
      borderRadius: "8px", padding: "12px 14px", marginBottom: "16px", fontSize: "13px",
    }}>{error}. Existing values remain visible where available.</div>}

    {loading && !data ? <div style={{ color: T.textSub, padding: "40px 0" }}>Loading live evidence ledgers...</div> : <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {filtered.map((program) => <ProgramPanel key={program.id} program={program} mobile={mobile} />)}
      {!filtered.length && <div style={{ border: `1px solid ${T.border}`, borderRadius: "8px", padding: "30px", textAlign: "center", color: T.muted }}>No programs match these filters.</div>}
    </div>}

    <footer style={{ marginTop: "18px", color: T.muted, fontSize: "11px", lineHeight: 1.5 }}>
      <CheckCircle2 size={13} style={{ verticalAlign: "-2px", marginRight: "5px" }} />
      Read-only governance surface. Activation remains a separate owner-reviewed change.
    </footer>
  </main>;
}
