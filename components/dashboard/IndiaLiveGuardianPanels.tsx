"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";

const T = { card: "#1A1D27", surface: "#13151C", border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280", green: "#34D399", red: "#F87171", amber: "#FBBF24", accent: "#818CF8" };

type Holding = { symbol: string; qty: number };
type Protection = { state: "covered" | "unprotected" | "partial" | "overcovered" | "review" | "unknown"; reason: string; triggerId?: string; expiresAt?: string | null; protectedQty?: number; stopPrice?: number | null; targetPrice?: number | null };
type GuardianPayload = { asOf?: string; holdingsAvailable?: boolean; gttAvailable?: boolean; error?: string; positions?: Array<{ symbol: string; qty: number; averagePrice: number | null; protection: Protection }> };

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 20, marginBottom: 16 }}>
    <div style={{ color: T.text, fontWeight: 750, fontSize: 15 }}>{title}</div>
    <div style={{ color: T.sub, fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>{subtitle}</div>
    {children}
  </section>;
}

const INR = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "—" : `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const PCT = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
const RATE = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "—" : `${value.toFixed(1)}%`;
const STATE_COLOR: Record<Protection["state"], string> = { covered: T.green, unprotected: T.red, partial: T.amber, overcovered: T.red, review: T.amber, unknown: T.muted };
const STATE_LABEL: Record<Protection["state"], string> = { covered: "GTT COVERAGE MATCHED", unprotected: "NO ACTIVE SELL GTT", partial: "PARTIAL QUANTITY", overcovered: "QTY EXCEEDS HOLDING", review: "RECONCILE GTTs", unknown: "STATUS UNKNOWN" };

export function IndiaManualTradeGuardianPanel() {
  const [data, setData] = useState<GuardianPayload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    fetch("/api/live-portfolio/india-guardian", { cache: "no-store" })
      .then(async (response) => { const body = await response.json(); if (!response.ok) { if (active) setData(body); throw new Error(body.error ?? `Guardian status unavailable (${response.status})`); } return body; })
      .then((body) => { if (active) setData(body); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Guardian status unavailable"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const positions = data?.positions ?? [];
  const covered = positions.filter((position) => position.protection.state === "covered").length;
  const uncovered = positions.filter((position) => position.protection.state !== "covered").length;
  return <Panel title="Manual Trade Guardian · India / Kite" subtitle="Read-only coverage check for current Kite delivery holdings, including positions you entered manually. It reads Kite’s active GTT book; it does not create, change, arm, cancel, or monitor orders.">
    <div style={{ marginTop: 12, padding: "10px 12px", background: "#2D1B00", border: `1px solid ${T.amber}33`, borderRadius: 8, color: T.amber, fontSize: 12, lineHeight: 1.5 }}>
      Kite GTT exits are limit-child orders, not guaranteed stop-market fills. A gap through the stop can leave the sell unfilled. This panel reports broker-visible GTTs only; it is not a software-stop alert service.
    </div>
    {error && <div role="alert" style={{ color: T.red, fontSize: 12, marginTop: 10 }}>{error}{data?.holdingsAvailable === false && <> · <a href="/api/kite/login" style={{ color: T.accent }}>Reconnect Kite</a> to load holdings and GTT coverage.</>}</div>}
    {loading ? <div style={{ color: T.muted, fontSize: 12, marginTop: 12 }}>Checking Kite holdings and GTTs…</div> : data && <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12, color: T.sub, fontSize: 12 }}>
        <span>{data.holdingsAvailable === false ? "Holdings unavailable" : `${positions.length} delivery position(s)`}</span><span>·</span><span style={{ color: T.green }}>{covered} exact-quantity GTT coverage</span><span>·</span><span style={{ color: uncovered ? T.amber : T.sub }}>{uncovered} need attention / not verified</span>
        {data.asOf && <span style={{ marginLeft: "auto", color: T.muted }}>Read {new Date(data.asOf).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span>}
      </div>
      {!data.gttAvailable && <div style={{ color: T.amber, fontSize: 12, marginTop: 10 }}>GTT status could not be verified from Kite. Positions are shown as unknown, not assumed protected. {data.error}</div>}
      {data.holdingsAvailable === false ? <div style={{ color: T.amber, fontSize: 12, marginTop: 12 }}>Holdings are unavailable, so Guardian coverage cannot be assessed. Reconnect Kite and refresh this page.</div> : positions.length === 0 ? <div style={{ color: T.muted, fontSize: 12, marginTop: 12 }}>No positive-quantity Kite delivery holdings to check.</div> : <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        {positions.map((position) => {
          const p = position.protection; const color = STATE_COLOR[p.state];
          return <div key={position.symbol} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 9, padding: "11px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div><div style={{ color: T.text, fontWeight: 700, fontSize: 13 }}>{position.symbol.replace(/\.(NS|BO)$/i, "")} <span style={{ color: T.sub, fontWeight: 400 }}>· {position.qty} shares · avg {INR(position.averagePrice)}</span></div><div style={{ color: T.sub, fontSize: 11, marginTop: 4 }}>{p.reason}{p.triggerId ? ` · GTT ${p.triggerId}` : ""}{p.expiresAt ? ` · expires ${new Date(p.expiresAt).toLocaleDateString("en-IN")}` : ""}</div></div>
            <div style={{ textAlign: "right", fontSize: 11, color }}><strong>{STATE_LABEL[p.state]}</strong>{p.stopPrice != null && <div style={{ color: T.sub, marginTop: 3 }}>Stop trigger {INR(p.stopPrice)}{p.targetPrice != null ? ` · target ${INR(p.targetPrice)}` : ""}</div>}</div>
          </div>;
        })}
      </div>}
    </>}
  </Panel>;
}

type IndiaLabel = { horizon: number; symbolReturnPct: number | null; niftyReturnPct: number | null; excessPct: number | null; maturedAt: string };
type Recommendation = { id: number; symbol: string; researchedAt: string; score: number | null; direction: string; referencePrice: number | null; dimensions: Record<string, number | null>; action: string; scoringVersion: string | null; labels: IndiaLabel[] };
type Scorecard = { error?: string; asOf: string; lookbackDays: number; observationCount: number; truncated: boolean; summary: Array<{ horizon: number; n: number; meanExcessPct: number | null; hitRatePct: number | null }>; rows: Recommendation[]; semantics: string };

export function IndiaRecommendationsGuardianScorecard({ holdings, holdingsKnown }: { holdings: Holding[]; holdingsKnown: boolean }) {
  const [data, setData] = useState<Scorecard | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    fetch("/api/live-portfolio/india-recommendations", { cache: "no-store" })
      .then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error ?? `India scorecard unavailable (${response.status})`); return body; })
      .then((body) => { if (active) setData(body); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "India scorecard unavailable"); });
    return () => { active = false; };
  }, []);
  const heldSymbols = useMemo(() => new Set(holdings.filter((h) => h.qty > 0).map((h) => h.symbol.replace(/\.(NS|BO)$/i, "").toUpperCase())), [holdings]);
  const latestBySymbol = useMemo(() => {
    const bySymbol = new Map<string, Recommendation>();
    for (const row of data?.rows ?? []) if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, row);
    return [...bySymbol.values()].slice(0, 20);
  }, [data]);
  return <Panel title="Recommendations & Guardian scorecard · India" subtitle="Entry-eligible deterministic India research observations and their matured outcomes versus NIFTY 50. These are research recommendations—not Kite orders. The current-holding badge is not proof that you bought the recommendation when issued.">
    {error && <div role="alert" style={{ color: T.red, fontSize: 12, marginTop: 10 }}>{error}</div>}
    {!data && !error && <div style={{ color: T.muted, fontSize: 12, marginTop: 12 }}>Loading India research outcomes…</div>}
    {data && <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 8, marginTop: 14 }}>
        {data.summary.map((item) => <div key={item.horizon} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 12px" }}>
          <div style={{ color: T.muted, fontSize: 10, textTransform: "uppercase" }}>h{item.horizon} · NIFTY-relative</div>
          <div style={{ color: item.meanExcessPct == null ? T.muted : item.meanExcessPct >= 0 ? T.green : T.red, fontWeight: 750, fontSize: 15, marginTop: 3 }}>{PCT(item.meanExcessPct)}</div>
          <div style={{ color: T.sub, fontSize: 10, marginTop: 3 }}>n={item.n} matured · hit {RATE(item.hitRatePct)}</div>
        </div>)}
      </div>
      <div style={{ color: T.muted, fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>{data.observationCount} eligible observations in the last {data.lookbackDays} days · as of {new Date(data.asOf).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}. Daily observations overlap; these descriptive averages are not independent-sample IC or t-stat evidence. {data.semantics}</div>
      {data.truncated && <div style={{ color: T.amber, fontSize: 11, marginTop: 5 }}>This read is capped at the 2,000 most recent eligible observations; aggregate statistics are limited to that window.</div>}
      {latestBySymbol.length === 0 ? <div style={{ color: T.muted, fontSize: 12, marginTop: 12 }}>No India entry-eligible research observations in this window.</div> : <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        {latestBySymbol.map((row) => {
          const horizonLabel = row.labels.find((label) => label.horizon === 10) ?? row.labels.find((label) => label.horizon === 5) ?? row.labels.find((label) => label.horizon === 2);
          const symbol = row.symbol.replace(/\.(NS|BO)$/i, "");
          return <div key={row.id} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 9, padding: "10px 12px", display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <div><div style={{ color: T.text, fontWeight: 700, fontSize: 13 }}>{symbol} <span style={{ color: T.accent }}>score {row.score ?? "—"}</span> <span style={{ color: !holdingsKnown ? T.amber : heldSymbols.has(symbol.toUpperCase()) ? T.green : T.muted, fontSize: 10 }}>{!holdingsKnown ? "HOLDING STATUS UNKNOWN" : heldSymbols.has(symbol.toUpperCase()) ? "CURRENTLY HELD" : "NOT CURRENTLY HELD"}</span></div><div style={{ color: T.muted, fontSize: 10, marginTop: 3 }}>{new Date(row.researchedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })} · ref {INR(row.referencePrice)} · {row.scoringVersion ?? "score version unavailable"}</div><div style={{ color: T.sub, fontSize: 10, marginTop: 4 }}>F {row.dimensions.fundamental ?? "—"} · T {row.dimensions.technical ?? "—"} · S {row.dimensions.sentiment ?? "—"} · M {row.dimensions.macro ?? "—"} · I {row.dimensions.insider ?? "—"}</div></div>
            <div style={{ textAlign: "right", fontSize: 11 }}><div style={{ color: T.sub }}>{horizonLabel ? `Matured h${horizonLabel.horizon}` : "Outcome not mature"}</div><div style={{ color: horizonLabel?.excessPct == null ? T.muted : horizonLabel.excessPct >= 0 ? T.green : T.red, fontWeight: 700, marginTop: 3 }}>{horizonLabel ? `${PCT(horizonLabel.symbolReturnPct)} symbol · ${PCT(horizonLabel.niftyReturnPct)} NIFTY · ${PCT(horizonLabel.excessPct)} excess` : "No matured label"}</div></div>
          </div>;
        })}
      </div>}
    </>}
  </Panel>;
}
