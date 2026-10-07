"use client";

import { useMemo, useState } from "react";
import type { RotationActivityEvent, RotationStatus } from "@/lib/agents/rotation-status";

const T = {
  card: "#1A1D27", surface: "#13151C", border: "#252836", text: "#ECEDEF",
  textSub: "#9B9EA8", muted: "#6B7280", accent: "#818CF8", green: "#34D399",
  red: "#F87171", amber: "#FBBF24", greenBg: "#052E16", redBg: "#3B0000", amberBg: "#2D1B00",
};

function currency(value: number | null, market: "us" | "india"): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(market === "india" ? "en-IN" : "en-US", {
    style: "currency", currency: market === "india" ? "INR" : "USD", maximumFractionDigits: 2,
  }).format(value);
}

function numeric(value: unknown): number | null {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function pct(value: unknown): string {
  const result = numeric(value);
  return result == null ? "—" : `${result.toFixed(2)}%`;
}

function executorLabel(executor: RotationStatus["executor"]): string {
  switch (executor) {
    case "disabled": return "PAPER EXECUTION OFF";
    case "keys_missing": return "PAPER SWITCH ON · EXECUTOR INERT";
    case "armed_blocked": return "PAPER ARMED · P1 BLOCKED";
    case "armed_ready": return "PAPER ARMED · LATEST P1 READY";
  }
}

function statusColor(status: string): string {
  if (status === "paper_executed") return T.green;
  if (status === "planned") return T.accent;
  return T.amber;
}

function EventDetails({ event, market }: { event: RotationActivityEvent; market: "us" | "india" }) {
  const mapping = event.scoreToReturn;
  const correlation = event.candidateCorrelation;
  const pairCount = numeric(correlation?.pairCount);
  const expectedPairCount = numeric(correlation?.expectedPairCount);
  const independent = numeric(mapping?.independentSessions);
  const requiredIndependent = numeric(mapping?.requiredIndependentSessions);
  const p1Summary = event.p1Ready === true ? "P1 contract passed for this recorded evaluation."
    : event.p1Ready === false ? "P1 contract blocked this evaluation."
    : "Legacy decision: P1 readiness was not recorded.";

  return (
    <div style={{ borderTop: `1px solid ${T.border}`, marginTop: "12px", paddingTop: "12px", display: "grid", gap: "12px" }}>
      <div>
        <div style={{ color: T.text, fontSize: "11px", fontWeight: 700, marginBottom: "5px" }}>Decision reason</div>
        <div style={{ color: T.textSub, fontSize: "12px", marginBottom: "6px" }}>{event.reason?.replaceAll("_", " ") ?? "No reason string recorded."}</div>
        <div style={{ color: event.p1Ready === true ? T.green : event.p1Ready === false ? T.amber : T.muted, fontSize: "11px", marginBottom: "6px" }}>{p1Summary}</div>
        {event.blockers.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: "18px", color: T.amber, fontSize: "12px", lineHeight: 1.65 }}>
            {event.blockers.map((blocker, index) => <li key={`${index}-${blocker}`}>{blocker.replaceAll("_", " ")}</li>)}
          </ul>
        ) : !event.p1ContractRecorded ? (
          <div style={{ color: T.muted, fontSize: "11px" }}>No P1 blocker contract was stored; absence of blockers is not a pass.</div>
        ) : event.p1Ready === false ? (
          <div style={{ color: T.amber, fontSize: "11px" }}>The contract is blocked but contains no blocker detail.</div>
        ) : null}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "10px" }}>
        <div style={{ background: T.surface, borderRadius: "7px", padding: "10px" }}>
          <div style={{ color: T.muted, fontSize: "10px", textTransform: "uppercase", marginBottom: "5px" }}>Score-to-return evidence</div>
          {mapping ? (
            <div style={{ color: T.textSub, fontSize: "11px", lineHeight: 1.55 }}>
              <div>Status: {String(mapping.status ?? "unavailable")}</div>
              <div>Horizon: {numeric(mapping.horizonDays) ?? "—"} sessions</div>
              <div>Distinct sessions: {numeric(mapping.distinctSessions) ?? "—"}</div>
              <div>Independent sessions: {independent ?? "—"}/{requiredIndependent ?? "—"}</div>
              <div>Mean candidate edge: {pct(mapping.meanEdgePct)}</div>
              <div>Lower confidence edge: {pct(mapping.lowerConfidenceEdgePct)}</div>
              <div>t-statistic: {numeric(mapping.tStatistic)?.toFixed(2) ?? "—"}</div>
            </div>
          ) : <div style={{ color: T.muted, fontSize: "11px" }}>No score-to-return evidence stored.</div>}
        </div>

        <div style={{ background: T.surface, borderRadius: "7px", padding: "10px" }}>
          <div style={{ color: T.muted, fontSize: "10px", textTransform: "uppercase", marginBottom: "5px" }}>Portfolio gates</div>
          <div style={{ color: T.textSub, fontSize: "11px", lineHeight: 1.55 }}>
            <div>Prior persistence runs: {event.persistencePriorRuns ?? "—"}/{event.persistenceRequiredPriorRuns ?? "—"}</div>
            <div>Monthly turnover used: {pct(event.monthlyTurnoverUsedPct)}</div>
            <div>Proposed turnover: {pct(event.proposedTurnoverPct)}</div>
            <div>Exact tax-lot evidence: {event.exactTaxLot?.available === true ? "available" : event.exactTaxLot?.available === false ? "unavailable" : "not recorded"}</div>
            <div>Post-swap constructor: {event.postSwapAllowed == null ? "unavailable" : event.postSwapAllowed ? "passed" : "blocked"}</div>
          </div>
        </div>

        <div style={{ background: T.surface, borderRadius: "7px", padding: "10px" }}>
          <div style={{ color: T.muted, fontSize: "10px", textTransform: "uppercase", marginBottom: "5px" }}>Candidate correlation</div>
          {correlation ? (
            <div style={{ color: T.textSub, fontSize: "11px", lineHeight: 1.55 }}>
              <div>Status: {String(correlation.status ?? "unavailable")}</div>
              <div>Covered pairs: {pairCount ?? "—"}/{expectedPairCount ?? "—"}</div>
              <div>Highest absolute correlation: {numeric(correlation.maxAbsCorrelation)?.toFixed(2) ?? "—"}</div>
              {Boolean(correlation.maxCorrelationSymbol) && <div>Closest holding: {String(correlation.maxCorrelationSymbol)}</div>}
            </div>
          ) : <div style={{ color: T.muted, fontSize: "11px" }}>No correlation result stored.</div>}
        </div>
      </div>

      {event.postSwapAdjustments.length > 0 && (
        <div>
          <div style={{ color: T.text, fontSize: "11px", fontWeight: 700, marginBottom: "5px" }}>Post-swap constructor adjustments</div>
          <ul style={{ margin: 0, paddingLeft: "18px", color: T.textSub, fontSize: "11px", lineHeight: 1.55 }}>
            {event.postSwapAdjustments.map((adjustment, index) => <li key={`${index}-${adjustment}`}>{adjustment}</li>)}
          </ul>
        </div>
      )}
      <div style={{ color: T.muted, fontSize: "10px", lineHeight: 1.5 }}>
        Proposed amounts are not fills. This ledger does not claim realized or missed P&amp;L; later price-path comparisons must be labeled counterfactual.
      </div>
    </div>
  );
}

export default function CapitalRotationActivityPanel({ status, market }: {
  status: RotationStatus | null;
  market: "us" | "india";
}) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const events = status?.activity ?? [];
  const filteredEvents = useMemo(() => {
    const query = search.trim().toUpperCase();
    return events.filter(event => (filter === "all" || event.status === filter)
      && (!query || `${event.candidateSymbol} ${event.sourceSymbol ?? ""}`.toUpperCase().includes(query)));
  }, [events, filter, search]);

  const executorColor = status?.executor === "armed_ready" ? T.green
    : status?.executor === "disabled" ? T.muted : T.amber;
  const currencyCode = market === "india" ? "INR" : "USD";

  return (
    <section aria-label="Capital rotation activity" style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "clamp(14px, 3vw, 22px)", minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", flexWrap: "wrap", marginBottom: "16px" }}>
        <div>
          <h2 style={{ margin: 0, color: T.text, fontSize: "16px", fontWeight: 700 }}>Capital Rotation · {market === "india" ? "India" : "US"}</h2>
          <p style={{ color: T.textSub, fontSize: "12px", lineHeight: 1.5, margin: "6px 0 0" }}>
            Recent paper-rotation evaluations, proposed funding holdings, outcomes and gate evidence for this market.
          </p>
        </div>
        {status && <div style={{ display: "flex", gap: "7px", flexWrap: "wrap" }}>
          <span style={{ background: T.surface, color: executorColor, borderRadius: "6px", padding: "6px 9px", fontSize: "10px", fontWeight: 800 }}>
            {executorLabel(status.executor)}
          </span>
          <span style={{ background: status.liveRotationOff ? T.surface : T.redBg, color: status.liveRotationOff ? T.muted : T.red, borderRadius: "6px", padding: "6px 9px", fontSize: "10px", fontWeight: 800 }}>
            {status.liveRotationOff ? "LIVE ROTATION OFF" : "LIVE ROTATION FLAG ON"}
          </span>
        </div>}
      </div>

      {!status ? (
        <div role="status" style={{ color: T.amber, padding: "16px 0", fontSize: "13px" }}>Rotation activity is unavailable; the server could not load this market&apos;s ledger.</div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))", gap: "8px", marginBottom: "12px" }}>
            {[
              ["Recent decisions", status.eventCount], ["Planned", status.plannedCount],
              ["Paper executed", status.paperExecutedCount], ["P1-ready rows", status.p1ReadyCount],
              ["Latest decision", status.latestAt ? new Date(status.latestAt).toLocaleDateString() : "—"],
            ].map(([label, value]) => (
              <div key={String(label)} style={{ border: `1px solid ${T.border}`, background: T.surface, borderRadius: "7px", padding: "10px", minWidth: 0 }}>
                <div style={{ color: T.muted, fontSize: "10px", marginBottom: "5px" }}>{label}</div>
                <div style={{ color: T.text, fontWeight: 700, fontSize: "13px", overflowWrap: "anywhere" }}>{value}</div>
              </div>
            ))}
          </div>

          <div style={{ color: T.muted, fontSize: "10px", marginBottom: "12px", lineHeight: 1.5 }}>
            Showing up to 100 of the latest 250 logged paper-rotation events · proposed amounts in {currencyCode}. A configured switch does not bypass candidate evidence, tax-lot, turnover, constructor or correlation gates.
          </div>

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "12px" }}>
            <label style={{ color: T.muted, fontSize: "11px", display: "flex", alignItems: "center", gap: "7px" }}>
              Status
              <select aria-label="Filter rotation events by status" value={filter} onChange={event => setFilter(event.target.value)} style={{ background: T.surface, color: T.text, border: `1px solid ${T.border}`, borderRadius: "6px", padding: "7px 9px" }}>
                <option value="all">All</option><option value="planned">Planned</option><option value="rejected">Rejected</option><option value="paper_executed">Paper executed</option>
              </select>
            </label>
            <label style={{ color: T.muted, fontSize: "11px", display: "flex", alignItems: "center", gap: "7px", flex: "1 1 180px" }}>
              Symbol
              <input aria-label="Search rotation candidates and sources" value={search} onChange={event => setSearch(event.target.value)} placeholder="Candidate or proposed sale" style={{ minWidth: 0, flex: 1, background: T.surface, color: T.text, border: `1px solid ${T.border}`, borderRadius: "6px", padding: "7px 9px" }} />
            </label>
          </div>

          {filteredEvents.length === 0 ? (
            <div style={{ border: `1px dashed ${T.border}`, borderRadius: "8px", padding: "22px 12px", textAlign: "center", color: T.muted, fontSize: "12px" }}>
              {events.length === 0 ? "No rotation evaluations have been recorded for this market yet." : "No events match these filters."}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {filteredEvents.map(event => <RotationEventCard key={event.id} event={event} market={market} />)}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function RotationEventCard({ event, market }: { event: RotationActivityEvent; market: "us" | "india" }) {
  const color = statusColor(event.status);
  const date = new Date(event.createdAt);
  return (
    <details style={{ border: `1px solid ${T.border}`, borderRadius: "8px", padding: "12px", background: T.surface }}>
      <summary style={{ cursor: "pointer", listStyle: "none", display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "8px 12px", alignItems: "center" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "5px" }}>
            <strong style={{ color: T.text, fontSize: "14px" }}>{event.candidateSymbol}</strong>
            <span style={{ color: T.muted, fontSize: "11px" }}>funded by</span>
            <strong style={{ color: T.textSub, fontSize: "13px" }}>{event.sourceSymbol ?? "cash / no sale"}</strong>
            <span style={{ color, background: color === T.green ? T.greenBg : color === T.amber ? T.amberBg : "#1E1B4B", borderRadius: "4px", padding: "3px 6px", fontSize: "9px", fontWeight: 800 }}>{event.status.replaceAll("_", " ").toUpperCase()}</span>
          </div>
          <div style={{ color: T.muted, fontSize: "10px" }}>{Number.isNaN(date.getTime()) ? event.createdAt : date.toLocaleString()}</div>
        </div>
        <div style={{ textAlign: "right", minWidth: "115px" }}>
          <div style={{ color: T.muted, fontSize: "9px", textTransform: "uppercase", marginBottom: "3px" }}>Proposed buy</div>
          <div style={{ color: T.text, fontWeight: 700, fontSize: "12px" }}>{currency(event.buyNotional, market)}</div>
        </div>
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: "8px 18px", flexWrap: "wrap", color: T.textSub, fontSize: "11px" }}>
          <span>Candidate/source score: {event.candidateScore?.toFixed(0) ?? "—"} / {event.sourceScore?.toFixed(0) ?? "—"}</span>
          <span>Score edge: {event.scoreEdge == null ? "—" : `${event.scoreEdge > 0 ? "+" : ""}${event.scoreEdge}`}</span>
          <span>Proposed sale: {currency(event.sellNotional, market)}</span>
          <span>Turnover estimate: {currency(event.turnoverConsumed, market)}</span>
        </div>
      </summary>
      <EventDetails event={event} market={market} />
    </details>
  );
}
