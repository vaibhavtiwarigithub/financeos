"use client";
import { useState, useEffect, useCallback, Fragment } from "react";
import PageHeader from "@/components/dashboard/PageHeader";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", accentBg: "#1E1F3A",
  green: "#34D399", greenBg: "#052E16", red: "#F87171", redBg: "#3B0000",
  amber: "#FBBF24", amberBg: "#2A1A00", purple: "#A78BFA", cyan: "#22D3EE", cyanBg: "#082F33",
};

interface Job {
  name: string;
  agent: string;
  time: string;
  days: "Weekdays" | "Friday" | "Daily";
  runner: string;
  editable: boolean;
  description: string;
  handoff: string | null;
  agentRunsType: string | null;
  last_run: string | null;
  last_status: string | null;
}

// --- Next-run computation (browser local time) -------------------------------
// Schedule times in lib/schedule.ts are US-Eastern. This is a human-facing
// estimate, not a trigger.
//
// IMPORTANT: ET is EDT (UTC-4) roughly mid-March to early November and EST
// (UTC-5) the rest of the year. A hardcoded -4h offset is wrong for ~4 months
// a year and silently shifts every computed slot by an hour — for US-Eastern
// users this can make a "next run" candidate land in the past (e.g. a 4-hour
// stale-check slot appearing to already have happened, showing "in -57m").
// Derive the ET offset for a given moment from the Intl API instead of
// hardcoding one.
function etOffsetMin(d: Date): number {
  // en-US "shortOffset" gives e.g. "GMT-4" / "GMT-5" for America/New_York,
  // correctly reflecting EDT vs EST for the given instant.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  }).formatToParts(d);
  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  const m = tzPart.match(/GMT([+-]\d+)/);
  const hours = m ? parseInt(m[1], 10) : -5;
  return hours * 60;
}

function localOffsetMin(d: Date) {
  return -d.getTimezoneOffset();
}

// Parse the FIRST "h:mm AM/PM" out of a time string. Returns minutes-after-midnight ET.
function parseETMinutes(time: string): number | null {
  const m = time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const pm = /pm/i.test(m[3]);
  if (h === 12) h = 0;
  if (pm) h += 12;
  return h * 60 + min;
}

function dayAllowed(days: Job["days"], dow: number): boolean {
  if (days === "Daily") return true;
  if (days === "Friday") return dow === 5;
  return dow >= 1 && dow <= 5; // Weekdays
}

// Interval jobs: return the next slot from now.
function nextIntervalRun(job: Job, now: Date): Date | null {
  // proposal-reminder: every 15 min, weekdays 9am-5pm ET
  if (/every\s*15\s*min/i.test(job.time)) {
    const cur = new Date(now);
    for (let i = 0; i < 14; i++) {
      const dow = cur.getDay();
      if (dayAllowed(job.days, dow)) {
        // find next :00/:15/:30/:45 within 9:00-17:00 ET window
        for (let slot = 9 * 60; slot <= 17 * 60; slot += 15) {
          const cand = etSlotToLocal(cur, slot);
          if (cand > now) return cand;
        }
      }
      cur.setDate(cur.getDate() + 1);
      cur.setHours(0, 0, 0, 0);
    }
    return null;
  }
  // stale-check: every 4 hours, all days — next 4h boundary in ET.
  // Walk forward day-by-day (like the 15-min branch above) instead of only
  // checking "today" and falling back to a single hardcoded midnight slot —
  // that fallback was the source of the "next run in the past" bug when the
  // day's last slot had already passed.
  if (/every\s*4\s*hour/i.test(job.time)) {
    const cur = new Date(now);
    for (let i = 0; i < 3; i++) {
      for (let slot = 0; slot < 24 * 60; slot += 4 * 60) {
        const cand = etSlotToLocal(cur, slot);
        if (cand > now) return cand;
      }
      cur.setDate(cur.getDate() + 1);
      cur.setHours(0, 0, 0, 0);
    }
    return null;
  }
  return null;
}

// Convert an ET minutes-after-midnight on the calendar day of `ref` into a local Date.
function etSlotToLocal(ref: Date, etMinutes: number): Date {
  const d = new Date(ref);
  d.setHours(0, 0, 0, 0);
  // shift from ET wall-clock to local: local = ET + (localOffset - etOffset)
  const shift = localOffsetMin(d) - etOffsetMin(d);
  return new Date(d.getTime() + (etMinutes + shift) * 60_000);
}

function nextRun(job: Job, now: Date): Date | null {
  const interval = nextIntervalRun(job, now);
  if (interval) return interval;
  const etMin = parseETMinutes(job.time);
  if (etMin == null) return null;
  const cur = new Date(now);
  for (let i = 0; i < 14; i++) {
    const dow = cur.getDay();
    if (dayAllowed(job.days, dow)) {
      const cand = etSlotToLocal(cur, etMin);
      if (cand > now) return cand;
    }
    cur.setDate(cur.getDate() + 1);
    cur.setHours(0, 0, 0, 0);
  }
  return null;
}

const fmtTime = (s: string | null) =>
  s == null ? "—" : new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function fmtNext(d: Date | null): string {
  if (!d) return "—";
  const now = Date.now();
  let diff = d.getTime() - now;
  // Defensive floor: a "next run" must never render as a past time. If
  // upstream computation ever yields a stale candidate, treat it as "due now"
  // rather than showing a confusing negative countdown like "in -57m".
  if (diff < 0) diff = 0;
  const mins = Math.round(diff / 60_000);
  let rel: string;
  if (mins < 1) rel = "due now";
  else if (mins < 60) rel = `in ${mins}m`;
  else if (mins < 24 * 60) rel = `in ${Math.round(mins / 60)}h`;
  else rel = `in ${Math.round(mins / (24 * 60))}d`;
  return `${d.toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit" })} · ${rel}`;
}

export default function AutomationPanel() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // tick so relative "next run" refreshes without a manual reload
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/automation/schedule");
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Failed to load");
      setJobs(d.jobs ?? []);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  function toggle(name: string) {
    setExpanded((p) => { const n = new Set(p); n.has(name) ? n.delete(name) : n.add(name); return n; });
  }

  const now = new Date();

  const statusColor = (s: string | null) =>
    s == null ? T.muted : s === "error" ? T.red : s === "done" || s === "completed" ? T.green : T.amber;

  const th: React.CSSProperties = { textAlign: "left", fontSize: "10.5px", fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.04em", padding: "0 12px 8px", whiteSpace: "nowrap" };
  const td: React.CSSProperties = { fontSize: "12.5px", color: T.text, padding: "11px 12px", borderTop: `1px solid ${T.border}`, verticalAlign: "top" };

  return (
    <div style={{ color: T.text, fontFamily: "'Inter', sans-serif", minHeight: "100vh", background: T.bg }}>
      <PageHeader
        title="Automation"
        subtitle={`${jobs.length} scheduled jobs · Supabase pg_cron → Vercel`}
        whatItDoes="Every scheduled job in Kairos — what runs, when, where it runs, and what it feeds next. Jobs run in the CLOUD as Supabase pg_cron jobs (kairos-*) that POST to the Vercel deployment, so they fire even when your PC is off. This page mirrors that live pg_cron state from lib/schedule.ts."
        whatToLookFor={[
          "Next run — when each job fires next (computed from its schedule in your local time)",
          "Last run — the most recent agent_runs record for jobs that log one; briefs/reminders don't log runs",
          "Runner — jobs run in the cloud (Supabase pg_cron → Vercel) and survive your PC being off; only db-backup is local Windows Task Scheduler",
          "Expand a row to see the handoff — what the job feeds next in the pipeline",
        ]}
      />

      <div style={{ padding: "16px", maxWidth: "1080px" }}>
        {/* Read-only banner */}
        <div style={{ background: T.amberBg, border: `1px solid ${T.amber}44`, borderRadius: "10px", padding: "12px 14px", marginBottom: "18px", fontSize: "12.5px", color: T.amber, display: "flex", gap: "10px", alignItems: "flex-start" }}>
          <span style={{ fontSize: "14px", lineHeight: 1.2 }}>🔒</span>
          <span style={{ color: T.textSub }}>
            <b style={{ color: T.amber }}>Schedules are managed by Supabase pg_cron (cloud) and are read-only here.</b>{" "}
            To change any time, day, or interval, edit the pg_cron schedule in Supabase (see <code style={{ color: T.text, background: T.card, padding: "1px 5px", borderRadius: "4px", fontSize: "11.5px" }}>supabase/migrations/080_kairos_pg_cron_schedule.sql</code>) and keep <code style={{ color: T.text, background: T.card, padding: "1px 5px", borderRadius: "4px", fontSize: "11.5px" }}>lib/schedule.ts</code> in sync. Every <code style={{ color: T.text, background: T.card, padding: "1px 5px", borderRadius: "4px", fontSize: "11.5px" }}>kairos-*</code> job runs in the cloud (pg_cron → Vercel) and fires even when your PC is off; only db-backup remains local Windows Task Scheduler.
          </span>
        </div>

        <div style={{ display: "flex", gap: "8px", marginBottom: "16px", alignItems: "center" }}>
          <button onClick={load} style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.muted, borderRadius: "8px", padding: "6px 12px", fontSize: "12px", cursor: "pointer" }}>↻ Refresh</button>
          <span style={{ fontSize: "11px", color: T.muted }}>Next-run times are estimated in your local timezone from ET schedules.</span>
        </div>

        {error && <div style={{ background: T.redBg, border: `1px solid ${T.red}44`, borderRadius: "8px", padding: "12px", marginBottom: "16px", color: T.red, fontSize: "13px" }}>{error}</div>}

        {loading ? (
          <div style={{ textAlign: "center", color: T.muted, padding: "40px" }}>Loading…</div>
        ) : jobs.length === 0 ? (
          <div style={{ textAlign: "center", color: T.muted, padding: "40px" }}>No scheduled jobs.</div>
        ) : (
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "12px", overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "860px" }}>
                <thead>
                  <tr>
                    <th style={th}>Job</th>
                    <th style={th}>Schedule</th>
                    <th style={th}>Runner</th>
                    <th style={th}>Last run</th>
                    <th style={th}>Next run</th>
                    <th style={{ ...th, width: "38%" }}>Description</th>
                    <th style={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => {
                    const isOpen = expanded.has(job.name);
                    const next = nextRun(job, now);
                    return (
                      <Fragment key={job.name}>
                        <tr>
                          <td style={{ ...td, fontWeight: 700, whiteSpace: "nowrap" }}>
                            {job.name}
                            <div style={{ fontSize: "10.5px", color: T.muted, fontWeight: 400, marginTop: "2px" }}>{job.agent}</div>
                          </td>
                          <td style={{ ...td, whiteSpace: "nowrap" }}>
                            <div>{job.time}</div>
                            <div style={{ fontSize: "10.5px", color: T.muted, marginTop: "2px" }}>{job.days}</div>
                          </td>
                          <td style={{ ...td, whiteSpace: "nowrap" }}>
                            <span style={{ fontSize: "10.5px", fontWeight: 700, color: T.cyan, background: T.cyanBg, padding: "2px 8px", borderRadius: "5px", border: `1px solid ${T.cyan}33` }}>
                              {job.runner === "Windows Task Scheduler" ? "Windows (local)" : "pg_cron → Vercel"}
                            </span>
                          </td>
                          <td style={{ ...td, whiteSpace: "nowrap" }}>
                            {job.agentRunsType == null ? (
                              <span style={{ color: T.muted }}>not logged</span>
                            ) : (
                              <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                                <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: statusColor(job.last_status), flexShrink: 0 }} />
                                {fmtTime(job.last_run)}
                              </span>
                            )}
                          </td>
                          <td style={{ ...td, whiteSpace: "nowrap", color: T.accent }}>{fmtNext(next)}</td>
                          <td style={{ ...td, color: T.textSub, fontSize: "11.5px", lineHeight: 1.5 }}>{job.description}</td>
                          <td style={{ ...td, whiteSpace: "nowrap" }}>
                            <button onClick={() => toggle(job.name)} style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "5px", cursor: "pointer", border: `1px solid ${T.border}`, background: "transparent", color: T.muted }}>
                              {isOpen ? "▲" : "▼"}
                            </button>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={7} style={{ padding: "0 12px 14px", background: T.bg }}>
                              <div style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "11.5px", color: T.textSub, paddingTop: "10px" }}>
                                <div>
                                  <b style={{ color: T.muted }}>Handoff:</b>{" "}
                                  {job.handoff ? <span style={{ color: T.purple }}>{job.handoff}</span> : <span style={{ color: T.muted }}>terminal — feeds nothing downstream</span>}
                                </div>
                                <div><b style={{ color: T.muted }}>Editable in app:</b> no — edit scripts/register-tasks.ps1 and re-run it</div>
                                <div><b style={{ color: T.muted }}>Task path:</b> \Kairos\{job.name}</div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
