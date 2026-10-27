"use client";

import type { PositionActivitySeries } from "@/lib/portfolio/position-history";
import { PAPER_BOOK_T } from "@/components/dashboard/PaperBookHeader";
import { fmtMoney } from "@/lib/format-money";

const T = PAPER_BOOK_T;
const WIDTH = 340, HEIGHT = 182, LEFT = 42, RIGHT = 8;
const shortDate = (v: string) => v.slice(5, 10);

export default function PositionActivityChart({ activity, currentQty, currency, loading }: {
  activity?: PositionActivitySeries; currentQty: number; currency: string; loading?: boolean;
}) {
  const events = activity?.status === "ready" ? activity.events : [];
  const plans = activity?.planPoints ?? [];
  const money = (value: number) => fmtMoney(value, currency === "₹" ? "india" : "us");
  const signedMoney = (n: number) => `${n >= 0 ? "+" : "−"}${money(Math.abs(n))}`;
  const qty = (n: number) => n.toLocaleString(undefined, { maximumSignificantDigits: 8 });
  const planDescription = (p: typeof plans[number]) => {
    const level = (n: number | null | undefined) => n == null ? "none" : money(n);
    const label = p.source === "baseline" ? "Recording started (current baseline)" : p.source === "position_created" ? "Position created / epoch started" : p.source === "current_snapshot" ? "Current observation" : "Recorded change";
    return `${label} · stop ${p.source === "recorded_change" ? `${level(p.previousStopLoss)} → ` : ""}${level(p.stopLoss)} · target ${p.source === "recorded_change" ? `${level(p.previousTarget)} → ` : ""}${level(p.target)}`;
  };
  const title = loading ? "Loading position history…"
    : activity?.status === "reconciliation_mismatch" ? "Activity hidden · fills do not reconcile to current shares"
    : "Activity unavailable · exact current-position trade history is incomplete";
  const pnl = events.reduce((sum, e) => sum + (e.realizedPnl ?? 0), 0);
  const hasSales = events.some(e => e.side === "sell");
  const hasPnl = events.filter(e => e.side === "sell").every(e => e.realizedPnl != null);
  const pointDescription = (e: typeof events[number]) => `${e.side.toUpperCase()} ${qty(e.quantity)} shares @ ${money(e.fillPrice)} · traded ${money(e.notional)} · ${qty(e.quantityAfter)} held · ${e.side === "buy" ? "No realized P/L on a buy" : e.realizedPnl == null ? "P/L unavailable" : `Gross realized P/L ${signedMoney(e.realizedPnl)}`}${e.reason ? ` · ${e.reason}` : ""}`;
  return <div style={{ marginTop: 8, paddingTop: 7, borderTop: `1px solid ${T.border}` }}>
    <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6, alignItems: "baseline" }}>
      <span style={{ fontSize: 10, color: T.textSub, letterSpacing: "0.04em" }}>POSITION LADDER · TRADES & EXIT PLAN</span>
      <span style={{ fontSize: 10, color: T.muted }}>{qty(currentQty)} held</span>
    </div>
    {!events.length ? <div style={{ padding: "12px 0", color: T.muted, fontSize: 10 }}>{title}</div> : <>
      {(() => {
        const times = [...events.map(e => Date.parse(e.at)), ...plans.map(p => Date.parse(p.at))].filter(Number.isFinite);
        const first = Math.min(...times), last = Math.max(...times), span = Math.max(last - first, 1);
        const x = (at: string) => LEFT + (Date.parse(at) - first) / span * (WIDTH - LEFT - RIGHT);
        const maxQty = Math.max(currentQty, ...events.map(e => e.quantityAfter), Number.EPSILON);
        const shareY = (n: number) => 22 + (1 - n / maxQty) * 37;
        const prices = [...events.map(e => e.fillPrice), ...plans.flatMap(p => [p.stopLoss, p.target])].filter((n): n is number => n != null && n > 0 && Number.isFinite(n));
        const minPrice = Math.min(...prices) * 0.97, maxPrice = Math.max(...prices) * 1.03;
        const priceY = (n: number) => 99 + (maxPrice - n) / Math.max(maxPrice - minPrice, 0.01) * 58;
        return <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`Position share ladder, ${events.length} trades, stop and target observations. ${hasSales && hasPnl ? `Gross realized P/L ${signedMoney(pnl)}.` : "No sale P/L available."}`} style={{ display: "block", width: "100%", height: "182px" }}>
          <text x="0" y="11" fill={T.muted} fontSize="8">Shares</text>
          <text x="0" y="27" fill={T.muted} fontSize="8">{qty(maxQty)}</text>
          <text x="24" y="62" fill={T.muted} fontSize="8">0</text>
          <line x1={LEFT} x2={WIDTH - RIGHT} y1="59" y2="59" stroke={T.muted} strokeDasharray="3 3" strokeWidth="0.6" />
          {events.slice(1).map((e, i) => <path key={`share-${i}`} d={`M${x(events[i].at)},${shareY(events[i].quantityAfter)} H${x(e.at)} V${shareY(e.quantityAfter)}`} fill="none" stroke={T.textSub} strokeWidth="1.5" />)}
          <line x1={x(events.at(-1)!.at)} x2={WIDTH - RIGHT} y1={shareY(currentQty)} y2={shareY(currentQty)} stroke={T.textSub} strokeWidth="1.5" />
          {events.map((e, i) => <g key={`trade-${i}`}>
            <line x1={x(e.at)} x2={x(e.at)} y1="65" y2="159" stroke={T.border} strokeDasharray="2 3" />
            <circle tabIndex={0} aria-label={`${new Date(e.at).toLocaleString()}: ${pointDescription(e)}`} cx={x(e.at)} cy={shareY(e.quantityAfter)} r="3" fill={e.side === "buy" ? T.green : T.red}><title>{`${new Date(e.at).toLocaleString()}: ${pointDescription(e)}`}</title></circle>
            {e.side === "sell" && e.realizedPnl != null && <text x={x(e.at)} y={i % 2 ? 76 : 86} textAnchor={x(e.at) > WIDTH - 65 ? "end" : "start"} fill={e.realizedPnl >= 0 ? T.green : T.red} fontSize="8">{signedMoney(e.realizedPnl)}</text>}
            <circle cx={x(e.at)} cy={priceY(e.fillPrice)} r="2" fill={T.textSub}><title>{`Fill ${money(e.fillPrice)}`}</title></circle>
          </g>)}
          <text x="0" y="96" fill={T.muted} fontSize="8">Price</text>
          <text x="0" y="106" fill={T.muted} fontSize="7">{money(maxPrice)}</text>
          <text x="0" y="158" fill={T.muted} fontSize="7">{money(minPrice)}</text>
          {(["stopLoss", "target"] as const).map(key => <g key={key}>
            {plans.map((p, i) => {
              const level = p[key], next = plans[i + 1], prior = plans[i - 1];
              if (level == null) return null;
              const color = key === "stopLoss" ? T.red : T.amber;
              return <g key={i}>
                {next && <line x1={x(p.at)} x2={x(next.at)} y1={priceY(level)} y2={priceY(level)} stroke={color} strokeWidth="1.5" strokeDasharray="4 2" />}
                {prior?.[key] != null && <line x1={x(p.at)} x2={x(p.at)} y1={priceY(prior[key]!)} y2={priceY(level)} stroke={color} strokeWidth="1.5" />}
                <rect tabIndex={0} aria-label={`${planDescription(p)} · ${new Date(p.at).toLocaleString()}`} x={x(p.at) - 2.5} y={priceY(level) - 2.5} width="5" height="5" fill={color}><title>{`${planDescription(p)} · ${new Date(p.at).toLocaleString()}`}</title></rect>
              </g>;
            })}
          </g>)}
          <text x={LEFT} y="178" fill={T.muted} fontSize="8">{shortDate(new Date(first).toISOString())}</text>
          <text x={WIDTH - RIGHT} y="178" textAnchor="end" fill={T.muted} fontSize="8">{shortDate(new Date(last).toISOString())}</text>
        </svg>;
      })()}
      <div style={{ fontSize: 10, color: T.textSub, lineHeight: 1.6 }}>
        <span style={{ color: T.green }}>● Buy</span> · <span style={{ color: T.red }}>● Sell / ■ Stop</span> · <span style={{ color: T.amber }}>■ Target</span> · grey dots = fill price<br />
        {hasSales && hasPnl ? `Gross realized P/L on sales: ${signedMoney(pnl)} (before fees/taxes).` : hasSales ? "Sale P/L unavailable." : "No sales yet; buys realize no P/L."}
      </div>
    </>}
    <div style={{ fontSize: 10, color: T.muted, lineHeight: 1.5, marginTop: 4 }}>
      {plans.length > 0 && <div style={{ color: T.textSub }}>Current stop: {plans.at(-1)!.stopLoss == null ? "none recorded" : money(plans.at(-1)!.stopLoss!)} · target: {plans.at(-1)!.target == null ? "none recorded" : money(plans.at(-1)!.target!)}</div>}
      {activity?.planHistoryStatus === "recorded" ? `Stop/target recording from ${plans[0] ? new Date(plans[0].at).toLocaleString() : "first saved observation"}. Earlier changes are unknown.`
        : activity?.planHistoryStatus === "truncated" ? "Stop/target history exceeds the display limit; only the latest window is shown."
        : activity?.planHistoryStatus === "unavailable" ? "Stop/target history could not be loaded. Current levels only; historical changes are unknown."
        : "Earlier stop/target changes were not recorded. Squares show current levels only, not their historical start dates."}
      {plans.at(-1)?.target == null ? " No active target recorded." : ""}
    </div>
    {events.length > 0 && <details style={{ marginTop: 6, fontSize: 10, color: T.textSub }}>
      <summary style={{ cursor: "pointer" }}>Trade and stop/target details</summary>
      <div style={{ maxHeight: 220, overflow: "auto", lineHeight: 1.6 }}>
        {[...events.map((e, i) => ({ at: e.at, key: `e${i}`, text: pointDescription(e) })), ...plans.map((p, i) => ({ at: p.at, key: `p${i}`, text: planDescription(p) }))].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map(row => <div key={row.key} style={{ padding: "5px 0", borderBottom: `1px solid ${T.border}` }}><strong>{new Date(row.at).toLocaleString()}</strong><div>{row.text}</div></div>)}
      </div>
    </details>}
  </div>;
}
