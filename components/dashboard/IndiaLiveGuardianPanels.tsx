"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import GuardianOutcomeScorecard from "./GuardianOutcomeScorecard";
import type { GuardianOutcomePayload } from "@/types";

const T = { card: "#1A1D27", surface: "#13151C", border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280", green: "#34D399", red: "#F87171", amber: "#FBBF24", accent: "#818CF8" };

type Holding = { symbol: string; qty: number };
type Protection = { state: "covered" | "unprotected" | "partial" | "overcovered" | "review" | "unknown"; reason: string; triggerId?: string; expiresAt?: string | null; protectedQty?: number; stopPrice?: number | null; targetPrice?: number | null };
type GuardianPayload = { asOf?: string; holdingsAvailable?: boolean; gttAvailable?: boolean; error?: string; positions?: Array<{ symbol: string; qty: number; averagePrice: number | null; protection: Protection }> };

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 20, marginBottom: 20 }}>
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 420px", minWidth: 0 }}>
        <div style={{ color: T.text, fontWeight: 750, fontSize: 15 }}>{title}</div>
        <div style={{ color: T.sub, fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>{subtitle}</div>
      </div>
      <span style={{ color: T.amber, background: "#2D1B00", padding: "4px 8px", borderRadius: 6, fontSize: 10, fontWeight: 800, letterSpacing: ".06em", whiteSpace: "nowrap", flexShrink: 0 }}>READ-ONLY · KITE</span>
    </div>
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
  return <Panel title="Manual Trade Guardian" subtitle="India · Read-only coverage check for current Kite delivery holdings, including positions you entered manually. It reads Kite’s active GTT book; it does not create, change, arm, cancel, or monitor orders.">
    <div style={{ marginTop: 12, padding: "10px 12px", background: "#2D1B00", border: `1px solid ${T.amber}33`, borderRadius: 8, color: T.amber, fontSize: 12, lineHeight: 1.5 }}>
      Kite GTT exits are limit-child orders, not guaranteed stop-market fills. A gap through the stop can leave the sell unfilled. This panel reports broker-visible GTTs only; it is not a software-stop alert service.
    </div>
    {error && <div role="alert" style={{ color: T.red, fontSize: 12, marginTop: 10 }}>{error}{data?.holdingsAvailable === false && <> · <a href="/api/kite/login" style={{ color: T.accent }}>Reconnect Kite</a> to load holdings and GTT coverage.</>}</div>}
    {loading ? <div style={{ color: T.muted, fontSize: 12, marginTop: 12 }}>Checking Kite holdings and GTTs…</div> : data && <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12, color: T.sub, fontSize: 12 }}>
        {data.holdingsAvailable === false
          ? <span style={{ color: T.amber }}>Holdings unavailable · GTT coverage unknown</span>
          : <><span>{positions.length} delivery position(s)</span><span>·</span><span style={{ color: T.green }}>{covered} exact-quantity GTT coverage</span><span>·</span><span style={{ color: uncovered ? T.amber : T.sub }}>{uncovered} need attention / not verified</span></>}
        {data.asOf && <span style={{ marginLeft: "auto", color: T.muted }}>Read {new Date(data.asOf).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span>}
      </div>
      {!data.gttAvailable && data.holdingsAvailable !== false && <div style={{ color: T.amber, fontSize: 12, marginTop: 10 }}>GTT status could not be verified from Kite. Positions are shown as unknown, not assumed protected. {data.error}</div>}
      {data.holdingsAvailable === false ? <div style={{ color: T.amber, fontSize: 12, marginTop: 12 }}>Guardian cannot assess coverage until Kite holdings are available.</div> : positions.length === 0 ? <div style={{ color: T.muted, fontSize: 12, marginTop: 12 }}>No positive-quantity Kite delivery holdings to check.</div> : <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
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
type Scorecard = { error?: string; asOf: string; lookbackDays: number; observationCount: number; truncated: boolean; summary: Array<{ horizon: number; n: number; meanExcessPct: number | null; hitRatePct: number | null }>; rows: Recommendation[]; semantics: string; guardianOutcomes?: GuardianOutcomePayload };

export function IndiaRecommendationsGuardianScorecard({ holdings, holdingsKnown }: { holdings: Holding[]; holdingsKnown: boolean }) {
  const [data, setData] = useState<Scorecard | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(true);
  const [filter, setFilter] = useState<"all" | "held" | "not_held" | "unmatured">("all");
  const [sort, setSort] = useState<"recent" | "score" | "excess">("recent");
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
  const h10 = data?.summary.find((item) => item.horizon === 10);
  const scorecardRows = latestBySymbol
    .filter((row) => {
      const symbol = row.symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
      const held = heldSymbols.has(symbol);
      if (filter === "held") return holdingsKnown && held;
      if (filter === "not_held") return holdingsKnown && !held;
      if (filter === "unmatured") return !row.labels.some((label) => label.horizon === 10 || label.horizon === 5 || label.horizon === 2);
      return true;
    })
    .sort((a, b) => {
      if (sort === "recent") return Date.parse(b.researchedAt) - Date.parse(a.researchedAt);
      const aValue = sort === "score" ? a.score : a.labels.find((label) => label.horizon === 10)?.excessPct;
      const bValue = sort === "score" ? b.score : b.labels.find((label) => label.horizon === 10)?.excessPct;
      if (aValue == null && bValue == null) return Date.parse(b.researchedAt) - Date.parse(a.researchedAt);
      if (aValue == null) return 1;
      if (bValue == null) return -1;
      return bValue - aValue;
    });
  const metric = (label: string, value: string, detail?: string, color = T.text) => <div key={label} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 12px", minWidth: 0 }}>
    <div style={{ color: T.muted, fontSize: 11 }}>{label}</div><div style={{ color, fontSize: 18, fontWeight: 750, marginTop: 2 }}>{value}</div>{detail && <div style={{ color: T.sub, fontSize: 11, marginTop: 2 }}>{detail}</div>}
  </div>;
  const filters = [
    { id: "all" as const, label: "All researched" }, { id: "held" as const, label: "Currently held" },
    { id: "not_held" as const, label: "Not currently held" }, { id: "unmatured" as const, label: "Outcome not mature" },
  ];
  const columns = ["Date", "Symbol / score", "Dimensions", "Reference", "Holding", "Matured outcome vs NIFTY 50"];
  return <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 20, marginBottom: 20 }}>
    <style>{`.india-rec-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}.india-rec-table{display:none}.india-rec-cards{display:grid;gap:8px}@media(min-width:760px){.india-rec-table{display:block;overflow-x:auto}.india-rec-cards{display:none}}`}</style>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
      <div>
        <div style={{ color: T.text, fontWeight: 750, fontSize: 15 }}>Recommendations & Guardian scorecard</div>
        <div style={{ color: T.sub, fontSize: 12, marginTop: 4, maxWidth: 760, lineHeight: 1.5 }}>
          Entry-eligible India research observations and matured outcomes versus NIFTY 50. These are research observations—not Kite orders. Current holdings do not prove that you bought a recommendation when issued.
          {data?.asOf ? ` Updated ${new Date(data.asOf).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}.` : ""}
        </div>
      </div>
      <button onClick={() => setOpen((value) => !value)} style={{ background: "transparent", color: T.sub, border: `1px solid ${T.border}`, borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer" }}>{open ? "Collapse" : "Expand"}</button>
    </div>
    {error && <div role="alert" style={{ color: T.red, fontSize: 12, marginTop: 12 }}>{error}</div>}
    {!data && !error && <div style={{ color: T.muted, fontSize: 12, marginTop: 12 }}>Loading India research outcomes…</div>}
    {data && open && <>
      {data.guardianOutcomes && <GuardianOutcomeScorecard data={data.guardianOutcomes} />}
      <div className="india-rec-grid" style={{ marginTop: 14 }}>
        {metric("Eligible observations", data.observationCount.toLocaleString("en-IN"), `last ${data.lookbackDays} days`)}
        {metric("Latest symbols shown", String(latestBySymbol.length), holdingsKnown ? `${latestBySymbol.filter((row) => heldSymbols.has(row.symbol.replace(/\.(NS|BO)$/i, "").toUpperCase())).length} held now` : "holding status unavailable")}
        {metric("Matured h10 outcomes", String(h10?.n ?? 0), "NIFTY-relative labels")}
        {metric("Mean h10 excess", PCT(h10?.meanExcessPct), "vs NIFTY 50", h10?.meanExcessPct == null ? T.muted : h10.meanExcessPct >= 0 ? T.green : T.red)}
        {metric("h10 positive excess", RATE(h10?.hitRatePct), "descriptive hit rate", h10?.hitRatePct == null ? T.muted : h10.hitRatePct >= 50 ? T.green : T.red)}
      </div>
      <div style={{ color: T.muted, fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>{data.observationCount.toLocaleString("en-IN")} eligible observations · as of {new Date(data.asOf).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}. Daily observations overlap; descriptive averages are not inferential IC or t-stat evidence. {data.semantics}</div>
      {data.truncated && <div style={{ color: T.amber, fontSize: 11, marginTop: 5 }}>This read is capped at the 2,000 most recent eligible observations; aggregates cover only that window.</div>}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 16 }}>
        {filters.map((item) => <button key={item.id} onClick={() => setFilter(item.id)} style={{ background: filter === item.id ? T.accent : "transparent", color: filter === item.id ? "#fff" : T.sub, border: `1px solid ${T.border}`, borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}>{item.label}</button>)}
        <select aria-label="Sort India scorecard" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} style={{ marginLeft: "auto", background: T.surface, color: T.sub, border: `1px solid ${T.border}`, borderRadius: 6, padding: "4px 8px", fontSize: 12 }}>
          <option value="recent">Most recent</option><option value="score">Highest score</option><option value="excess">Best h10 excess</option>
        </select>
      </div>
      {scorecardRows.length === 0 ? <div style={{ color: T.muted, fontSize: 12, marginTop: 14 }}>No India observations match this filter.</div> : <>
        <div className="india-rec-table" style={{ marginTop: 12 }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead><tr style={{ borderBottom: `1px solid ${T.border}` }}>{columns.map((column, index) => <th key={column} style={{ textAlign: index === 0 || index === 1 || index === 2 || index === 4 ? "left" : "right", padding: "6px 8px", fontWeight: 600, whiteSpace: "nowrap", color: T.muted }}>{column}</th>)}</tr></thead>
          <tbody>{scorecardRows.map((row) => {
            const label = row.labels.find((item) => item.horizon === 10) ?? row.labels.find((item) => item.horizon === 5) ?? row.labels.find((item) => item.horizon === 2);
            const symbol = row.symbol.replace(/\.(NS|BO)$/i, "");
            const held = heldSymbols.has(symbol.toUpperCase());
            return <tr key={row.id} style={{ borderTop: `1px solid ${T.border}`, color: T.text }}>
              <td style={{ padding: "8px", whiteSpace: "nowrap", color: T.muted }}>{new Date(row.researchedAt).toLocaleDateString("en-IN")}</td>
              <td style={{ padding: "8px", fontWeight: 700 }}>{symbol} <span style={{ color: T.accent }}>· {row.score ?? "—"}</span></td>
              <td style={{ padding: "8px", color: T.sub, whiteSpace: "nowrap" }}>F {row.dimensions.fundamental ?? "—"} · T {row.dimensions.technical ?? "—"} · S {row.dimensions.sentiment ?? "—"} · M {row.dimensions.macro ?? "—"} · I {row.dimensions.insider ?? "—"}</td>
              <td style={{ padding: "8px", textAlign: "right", whiteSpace: "nowrap" }}>{INR(row.referencePrice)}</td>
              <td style={{ padding: "8px", color: !holdingsKnown ? T.amber : held ? T.green : T.muted, whiteSpace: "nowrap" }}>{!holdingsKnown ? "Unknown" : held ? "Held now" : "Not held"}</td>
              <td style={{ padding: "8px", textAlign: "right", color: label?.excessPct == null ? T.muted : label.excessPct >= 0 ? T.green : T.red, whiteSpace: "nowrap" }}>{label ? `h${label.horizon} · ${PCT(label.symbolReturnPct)} symbol · ${PCT(label.niftyReturnPct)} NIFTY · ${PCT(label.excessPct)} excess` : "No matured outcome"}</td>
            </tr>;
          })}</tbody>
        </table></div>
        <div className="india-rec-cards" style={{ marginTop: 12 }}>{scorecardRows.map((row) => {
          const label = row.labels.find((item) => item.horizon === 10) ?? row.labels.find((item) => item.horizon === 5) ?? row.labels.find((item) => item.horizon === 2);
          const symbol = row.symbol.replace(/\.(NS|BO)$/i, "");
          const held = heldSymbols.has(symbol.toUpperCase());
          return <div key={row.id} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}><div><span style={{ color: T.text, fontWeight: 750 }}>{symbol}</span> <span style={{ color: T.accent }}>score {row.score ?? "—"}</span> <span style={{ color: !holdingsKnown ? T.amber : held ? T.green : T.muted, fontSize: 10 }}>{!holdingsKnown ? "HOLDING UNKNOWN" : held ? "HELD NOW" : "NOT HELD"}</span></div><span style={{ color: T.muted, fontSize: 11 }}>{new Date(row.researchedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span></div>
            <div style={{ color: T.muted, fontSize: 10, marginTop: 5 }}>Ref {INR(row.referencePrice)} · {row.scoringVersion ?? "score version unavailable"}</div>
            <div style={{ color: T.sub, fontSize: 11, marginTop: 6 }}>F {row.dimensions.fundamental ?? "—"} · T {row.dimensions.technical ?? "—"} · S {row.dimensions.sentiment ?? "—"} · M {row.dimensions.macro ?? "—"} · I {row.dimensions.insider ?? "—"}</div>
            <div style={{ color: label?.excessPct == null ? T.muted : label.excessPct >= 0 ? T.green : T.red, fontSize: 11, fontWeight: 650, marginTop: 7 }}>{label ? `Matured h${label.horizon}: ${PCT(label.symbolReturnPct)} symbol · ${PCT(label.niftyReturnPct)} NIFTY · ${PCT(label.excessPct)} excess` : "Outcome not mature"}</div>
          </div>;
        })}</div>
      </>}
    </>}
  </section>;
}
