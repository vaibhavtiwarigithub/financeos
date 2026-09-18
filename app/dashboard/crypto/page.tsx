import PageHeader from "@/components/dashboard/PageHeader";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

const T = {
  card: "#1A1D27", surface: "#13151C", border: "#252836", text: "#ECEDEF",
  textSub: "#9B9EA8", muted: "#6B7280", green: "#34D399", amber: "#FBBF24", red: "#F87171", accent: "#6366F1",
};

const usd = (value: unknown) => `$${Number(value ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const dateTime = (value: unknown) => value ? new Date(String(value)).toLocaleString() : "—";
const pct = (value: unknown) => `${Number(value ?? 0).toFixed(2)}%`;

function Card({ label, value, detail, color = T.text }: { label: string; value: string; detail: string; color?: string }) {
  return <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16 }}>
    <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: T.muted }}>{label}</div>
    <div style={{ marginTop: 7, fontSize: 22, fontWeight: 700, color }}>{value}</div>
    <div style={{ marginTop: 5, fontSize: 12, color: T.textSub, lineHeight: 1.45 }}>{detail}</div>
  </div>;
}

export default async function CryptoPage() {
  const supabase = createServiceClient();
  const [
    { data: pool }, { data: positions }, { data: trades }, { data: performance },
    { data: latestUniverse }, { data: shadows }, { data: strategies },
  ] = await Promise.all([
    supabase.from("paper_portfolio").select("nav,cash_balance,updated_at").eq("market", "crypto").maybeSingle(),
    supabase.from("paper_positions").select("symbol,qty,entry_price,current_price,stop_loss,price_target,updated_at").eq("market", "crypto").order("symbol"),
    supabase.from("paper_trades").select("id,outcome,realized_pnl,executed_at").eq("market", "crypto").order("executed_at", { ascending: false }).limit(100),
    supabase.from("paper_performance").select("date,nav,total_pnl_pct").eq("market", "crypto").order("date", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("crypto_universe_runs").select("id,observed_at,source,status,summary,error").order("observed_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("crypto_geometry_shadows").select("symbol,strategy_version,decision,refusal_reason,geometry,observed_at").order("observed_at", { ascending: false }).limit(20),
    supabase.from("crypto_strategy_versions").select("version,state,is_champion,created_at,notes").order("created_at", { ascending: false }).limit(10),
  ]);
  const { data: members } = latestUniverse?.id
    ? await supabase.from("crypto_universe_members").select("symbol,broker_tradeable,account_eligible,history_days,quote_observed_at,bid,ask,spread_pct,admitted,refusal_reason,raw").eq("run_id", latestUniverse.id).order("admitted", { ascending: false }).order("symbol").limit(60)
    : { data: [] as any[] };

  const closed = (trades ?? []).filter((trade: any) => trade.outcome != null);
  const winners = closed.filter((trade: any) => trade.outcome === "win").length;
  const realizedPnl = closed.reduce((sum: number, trade: any) => sum + Number(trade.realized_pnl ?? 0), 0);
  const latestShadowBySymbol = new Map<string, any>();
  for (const shadow of shadows ?? []) if (!latestShadowBySymbol.has(shadow.symbol)) latestShadowBySymbol.set(shadow.symbol, shadow);
  const summary: any = latestUniverse?.summary ?? {};
  const readiness = latestUniverse ? `${summary.broker_pairs ?? 0} broker pairs · ${summary.research_targets ?? 0} researched · ${summary.admitted ?? 0} eligible` : "Capability discovery not connected";

  return <div style={{ maxWidth: 1400 }}>
    <PageHeader
      title="Crypto Markets"
      subtitle="Separate 24/7 research and paper-trading book — never blended with equities"
      cadence="daily"
      whatItDoes="Shows the crypto paper book, deterministic research evidence, strategy shadows, and the exact blockers before any crypto order could be submitted."
      whatToLookFor={[
        "A tradeable quote and broker eligibility are hard gates; a high score cannot override either.",
        "Stops, targets, and size shown here are shadow evidence until they have enough paper outcomes.",
        "Live crypto is disabled: no broker order path is activated from this page.",
      ]}
    />
    <main style={{ padding: "0 28px 32px" }}>
      <div style={{ background: "#2D1B00", border: "1px solid #FBBF2444", color: "#FBBF24", borderRadius: 10, padding: "12px 14px", marginBottom: 16, fontSize: 13, lineHeight: 1.5 }}>
        <strong>Live crypto is deliberately disabled.</strong> Robinhood broker capability, quote freshness, order acknowledgement, and protective-order reconciliation must be evidenced before preview or live execution can be enabled.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 20 }}>
        <Card label="Paper NAV" value={usd(pool?.nav)} detail={`Marked ${dateTime(pool?.updated_at)}`} />
        <Card label="Paper cash" value={usd(pool?.cash_balance)} detail="Dedicated crypto pool only" />
        <Card label="Closed outcomes" value={String(closed.length)} detail={closed.length ? `${winners}/${closed.length} wins` : "Evidence still accumulating"} color={closed.length ? T.amber : T.muted} />
        <Card label="Realized P&L" value={usd(realizedPnl)} detail="Closed paper trades only" color={realizedPnl >= 0 ? T.green : T.red} />
        <Card label="Latest paper return" value={performance ? pct(performance.total_pnl_pct) : "—"} detail={performance ? `As of ${performance.date}` : "No performance snapshot yet"} />
        <Card label="Universe readiness" value={latestUniverse ? latestUniverse.status : "Not run"} detail={readiness} color={latestUniverse?.status === "done" ? T.green : T.amber} />
      </div>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 16, marginBottom: 16 }}>
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18 }}>
          <h2 style={{ margin: "0 0 12px", color: T.text, fontSize: 15 }}>Current paper positions</h2>
          {(positions ?? []).length === 0 ? <p style={{ color: T.muted, fontSize: 13 }}>No open crypto paper positions.</p> : (
            <div style={{ overflowX: "auto" }}><table style={{ minWidth: 590, width: "100%", borderCollapse: "collapse", fontSize: 12 }}><thead><tr style={{ color: T.muted, textAlign: "left" }}>{["Symbol","Entry","Mark","Stop","Target","Unrealized"].map(h => <th key={h} style={{ padding: "0 8px 8px 0", fontWeight: 600 }}>{h}</th>)}</tr></thead><tbody>{positions.map((p: any) => {
              const entry = Number(p.entry_price); const mark = Number(p.current_price); const returnPct = entry > 0 ? ((mark - entry) / entry) * 100 : 0;
              return <tr key={p.symbol} style={{ borderTop: `1px solid ${T.border}` }}><td style={{ padding: "10px 8px 10px 0", color: T.text, fontWeight: 700 }}>{p.symbol}</td><td>{usd(entry)}</td><td>{usd(mark)}</td><td>{p.stop_loss == null ? "—" : usd(p.stop_loss)}</td><td>{p.price_target == null ? "—" : usd(p.price_target)}</td><td style={{ color: returnPct >= 0 ? T.green : T.red }}>{pct(returnPct)}</td></tr>;
            })}</tbody></table></div>
          )}
        </div>
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18 }}>
          <h2 style={{ margin: "0 0 12px", color: T.text, fontSize: 15 }}>Broker universe and native research</h2>
          {(members ?? []).length === 0 ? <p style={{ color: T.muted, fontSize: 13 }}>Awaiting the first broker-universe collection.</p> : (members ?? []).map((member: any) => {
            const symbol = member.symbol;
            const shadow = latestShadowBySymbol.get(symbol);
            const score = shadow?.geometry?.score;
            const evidence = shadow?.geometry?.evidence;
            const detail = member.admitted
              ? `Eligible research observation · ${member.history_days} daily bars · spread ${pct(member.spread_pct)}`
              : member.refusal_reason ?? "Not eligible";
            return <div key={symbol} style={{ padding: "10px 0", borderTop: `1px solid ${T.border}`, display: "grid", gridTemplateColumns: "90px 1fr auto", gap: 8, alignItems: "center" }}><strong>{symbol}</strong><span style={{ fontSize: 12, color: T.textSub }}>{detail}{evidence?.sessionDate ? ` · session ${evidence.sessionDate}` : ""}</span><span style={{ color: member.admitted && score?.ok ? T.green : T.amber, fontWeight: 700 }}>{member.admitted && score?.ok ? Number(score.score).toFixed(1) : member.admitted ? "Eligible" : "Refused"}</span></div>;
          })}
          <p style={{ margin: "12px 0 0", color: T.muted, fontSize: 11, lineHeight: 1.45 }}>Daily research is recorded independently of equities. Eligible means valid for measurement only—not paper or live trading. Deferred pairs stay visible with the exact reason.</p>
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 16 }}>
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18 }}>
          <h2 style={{ margin: "0 0 12px", color: T.text, fontSize: 15 }}>Geometry shadows</h2>
          {(shadows ?? []).length === 0 ? <p style={{ color: T.muted, fontSize: 13, lineHeight: 1.5 }}>No native geometry shadows yet. The next collector will record refusal reasons as carefully as eligible setups; no result will be silently treated as a trade.</p> : shadows.map((shadow: any) => <div key={`${shadow.symbol}-${shadow.observed_at}`} style={{ borderTop: `1px solid ${T.border}`, padding: "10px 0", display: "flex", justifyContent: "space-between", gap: 12 }}><div><strong>{shadow.symbol}</strong><div style={{ color: T.muted, fontSize: 11, marginTop: 3 }}>{shadow.strategy_version} · {dateTime(shadow.observed_at)}</div></div><div style={{ color: shadow.decision === "eligible" ? T.green : T.amber, fontSize: 12, textAlign: "right" }}>{shadow.decision}{shadow.refusal_reason ? `: ${shadow.refusal_reason}` : ""}</div></div>)}
        </div>
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18 }}>
          <h2 style={{ margin: "0 0 12px", color: T.text, fontSize: 15 }}>Crypto strategy genome</h2>
          {(strategies ?? []).length === 0 ? <p style={{ color: T.muted, fontSize: 13, lineHeight: 1.5 }}>No crypto genome has been promoted. This is correct: the platform must first collect shadow outcomes under a separate crypto strategy namespace.</p> : strategies.map((strategy: any) => <div key={strategy.version} style={{ borderTop: `1px solid ${T.border}`, padding: "10px 0", display: "flex", justifyContent: "space-between", gap: 12 }}><div><strong>{strategy.version}</strong><div style={{ color: T.muted, fontSize: 11, marginTop: 3 }}>{dateTime(strategy.created_at)}</div></div><span style={{ color: strategy.is_champion ? T.green : T.textSub, fontSize: 12 }}>{strategy.state}{strategy.is_champion ? " · champion" : ""}</span></div>)}
          <p style={{ margin: "12px 0 0", color: T.muted, fontSize: 11, lineHeight: 1.45 }}>No leverage, martingale, averaging down, or automatic live promotion is permitted by this genome.</p>
        </div>
      </section>
    </main>
  </div>;
}
