"use client";
import { useEffect, useState } from "react";
import {
  ResponsiveContainer, LineChart as LC, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, Cell,
} from "recharts";
import AlphaScorecard from "@/components/dashboard/AlphaScorecard";
import AlphaDiagnosticLab from "@/components/dashboard/AlphaDiagnosticLab";

// Build 3 — Performance-truth section. Fetches /api/agents/performance/metrics
// (owner-gated) and renders risk-adjusted truth: Sharpe/Sortino/max-DD,
// expectancy/profit-factor, gross-vs-net (cost drag), calibration curve, alpha
// vs benchmark. Every estimator carries an `insufficient` flag from the pure lib
// — small samples render "n too small" instead of a fake number. Tainted trades
// are COUNTED here (opposite of the learner filter): the book still moved, so the
// P&L view must not hide them — the count is surfaced so the reader judges the mix.

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24",
};

interface Metric { value: number | null; n: number; insufficient: boolean }
interface CalibBin { bucket: number; predicted: number; realized: number; n: number }
interface MarketMetrics {
  closedTrades: number;
  taintedTrades: number;
  navPoints: number;
  sharpe: Metric;
  sortino: Metric;
  maxDrawdown: Metric;
  expectancyPct: Metric;
  winRate: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  profitFactor: Metric;
  cost: { netReturnPct: Metric; costPct: Metric; grossReturnPct: Metric };
  slip: { realized: Metric; modeledPct: number };
  calibration: { bins: CalibBin[]; n: number; insufficient: boolean };
  alphaPct: number | null;
  benchmarkReturnPct: number | null;
}
type ApiResp = { ok: boolean; markets: Record<string, MarketMetrics>; error?: string };

interface Mandate { id: string; name: string; market: string; horizon: string; benchmark_symbol: string }
interface EvalRow {
  id: string; mandate_id: string; market: string; evaluated_at: string;
  n_trades_total: number; n_trades_evaluable: number; tainted_count: number;
  book_sharpe: number | null; book_max_drawdown: number | null; book_win_rate: number | null;
  book_alpha_pct: number | null; health_label: string; health_reason: string | null;
  promotion_eligible: boolean;
}

function fmt(m: Metric, opts: { pct?: boolean; dp?: number } = {}): string {
  if (m.insufficient || m.value === null) return "—";
  const dp = opts.dp ?? 2;
  const v = m.value.toFixed(dp);
  return opts.pct ? `${v}%` : v;
}

function CustomTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "8px 12px", fontSize: "12px" }}>
      <div style={{ color: T.muted, marginBottom: "4px" }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ color: p.color }}>{p.name}: {typeof p.value === "number" ? p.value.toFixed(2) : p.value}</div>
      ))}
    </div>
  );
}

// One metric tile. `good` colors the value green/red when a direction is meaningful.
function MetricTile({ label, value, sub, tone, n, insufficient }: {
  label: string; value: string; sub?: string; tone?: "good" | "bad" | "neutral";
  n?: number; insufficient?: boolean;
}) {
  const color = insufficient ? T.muted : tone === "good" ? T.green : tone === "bad" ? T.red : T.text;
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "14px 16px", minWidth: 0 }}>
      <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
      <div style={{ fontSize: "20px", fontWeight: 700, color, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontSize: "11px", color: T.muted, marginTop: "3px" }}>
        {insufficient ? `n=${n ?? 0} · too small` : (sub ?? (n != null ? `n=${n}` : ""))}
      </div>
    </div>
  );
}

const HEALTH_COLORS: Record<string, string> = {
  insufficient_sample:        "#6B7280",
  negative_or_zero_edge:      "#F87171",
  promising_but_unvalidated:  "#FBBF24",
  validation_required:        "#34D399",
};

export default function PerformanceTruth() {
  const [data, setData] = useState<ApiResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [market, setMarket] = useState<"us" | "india">("us");
  const [mandates, setMandates] = useState<Mandate[]>([]);
  const [mandateId, setMandateId] = useState<string>("");
  const [evals, setEvals] = useState<EvalRow[]>([]);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/agents/performance/metrics", { cache: "no-store" })
      .then(r => r.json())
      .then((j: ApiResp) => { if (live) { if (j.ok) setData(j); else setErr(j.error ?? "metrics_failed"); } })
      .catch(e => { if (live) setErr(String(e?.message ?? e)); });
    return () => { live = false; };
  }, []);

  // Fetch mandates + evaluations when market changes
  useEffect(() => {
    let live = true;
    fetch(`/api/agents/evaluation/mandates?market=${market}`, { cache: "no-store" })
      .then(r => r.json())
      .then((j: { ok: boolean; mandates?: Mandate[] }) => {
        if (!live || !j.ok) return;
        setMandates(j.mandates ?? []);
        const def = (j.mandates ?? []).find(m => m.market === market) ?? j.mandates?.[0];
        if (def) setMandateId(def.id);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [market]);

  useEffect(() => {
    if (!mandateId) return;
    let live = true;
    fetch(`/api/agents/evaluation/results?mandateId=${mandateId}&market=${market}&limit=10`, { cache: "no-store" })
      .then(r => r.json())
      .then((j: { ok: boolean; evaluations?: EvalRow[] }) => {
        if (live && j.ok) setEvals(j.evaluations ?? []);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [mandateId, market]);

  async function handleRunEval() {
    if (!mandateId || running) return;
    setRunning(true);
    setRunMsg(null);
    try {
      const res = await fetch("/api/agents/evaluation/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mandateId, market }),
      });
      const j = await res.json();
      if (j.ok) {
        setRunMsg(`Done — ${j.health_label?.replace(/_/g, " ")} (${j.n_trades_evaluable ?? 0} evaluable trades)`);
        // Refresh evaluations
        const r2 = await fetch(`/api/agents/evaluation/results?mandateId=${mandateId}&market=${market}&limit=10`, { cache: "no-store" });
        const j2 = await r2.json();
        if (j2.ok) setEvals(j2.evaluations ?? []);
      } else {
        setRunMsg(`Error: ${j.error ?? "unknown"}`);
      }
    } catch (e: any) {
      setRunMsg(`Error: ${e?.message ?? String(e)}`);
    } finally {
      setRunning(false);
    }
  }

  const wrap = (children: React.ReactNode) => (
    <div style={{ marginTop: "24px", background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px", marginBottom: "16px" }}>
        <div>
          <div style={{ fontSize: "11px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em" }}>Performance Truth</div>
          <div style={{ fontSize: "12px", color: T.muted, marginTop: "4px" }}>Risk-adjusted, cost-net, calibrated — the metrics that survive scrutiny, not just win-rate.</div>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          {mandates.length > 0 && (
            <select
              value={mandateId}
              onChange={e => setMandateId(e.target.value)}
              style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", color: T.text, fontSize: "12px", padding: "5px 10px", cursor: "pointer" }}
            >
              {mandates.map(mn => <option key={mn.id} value={mn.id}>{mn.name}</option>)}
            </select>
          )}
          <button
            onClick={handleRunEval}
            disabled={running || !mandateId}
            style={{ padding: "6px 14px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, cursor: running || !mandateId ? "default" : "pointer", border: "none", background: T.accent, color: "#fff", opacity: running || !mandateId ? 0.5 : 1 }}
          >
            {running ? "Running…" : "Run Eval"}
          </button>
          <div style={{ display: "flex", gap: "4px" }}>
            {(["us", "india"] as const).map(mk => (
              <button key={mk} onClick={() => setMarket(mk)} style={{ padding: "6px 14px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "none", background: market === mk ? T.accent : T.surface, color: market === mk ? "#fff" : T.muted, textTransform: "uppercase" }}>
                {mk}
              </button>
            ))}
          </div>
        </div>
      </div>
      {runMsg && (
        <div style={{ fontSize: "12px", color: runMsg.startsWith("Error") ? T.red : T.green, background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "8px 12px", marginBottom: "12px" }}>
          {runMsg}
        </div>
      )}
      {children}
    </div>
  );

  if (err) return wrap(<div style={{ color: T.red, fontSize: "13px", padding: "20px 0" }}>Metrics unavailable: {err}</div>);
  if (!data) return wrap(<div style={{ color: T.muted, fontSize: "13px", padding: "20px 0", textAlign: "center" }}>Loading performance metrics…</div>);

  const m = data.markets[market];
  if (!m) return wrap(<div style={{ color: T.muted, fontSize: "13px", padding: "20px 0", textAlign: "center" }}>No data for {market.toUpperCase()}.</div>);

  const taintNote = m.taintedTrades > 0
    ? `${m.taintedTrades} of ${m.closedTrades} data-tainted (shown, excluded from learning)`
    : `${m.closedTrades} closed · 0 tainted`;

  // Gross-vs-net cost bars.
  const costBars = (!m.cost.grossReturnPct.insufficient && !m.cost.netReturnPct.insufficient) ? [
    { name: "Gross", value: +(m.cost.grossReturnPct.value ?? 0).toFixed(3) },
    { name: "Net", value: +(m.cost.netReturnPct.value ?? 0).toFixed(3) },
  ] : [];

  // Calibration: predicted vs realized per decile + a diagonal reference.
  const calib = m.calibration.bins.map(b => ({
    predicted: +(b.predicted * 100).toFixed(1),
    realized: +(b.realized * 100).toFixed(1),
    n: b.n,
  }));

  return wrap(
    <>
      <div style={{ fontSize: "11px", color: T.muted, marginBottom: "14px" }}>{taintNote} · {m.navPoints} NAV points</div>

      {/* Metric tiles */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "12px", marginBottom: "20px" }}>
        <MetricTile label="Sharpe (ann.)" value={fmt(m.sharpe)} n={m.sharpe.n} insufficient={m.sharpe.insufficient}
          tone={!m.sharpe.insufficient && (m.sharpe.value ?? 0) >= 1 ? "good" : "neutral"} sub="risk-adj return" />
        <MetricTile label="Sortino (ann.)" value={fmt(m.sortino)} n={m.sortino.n} insufficient={m.sortino.insufficient}
          tone={!m.sortino.insufficient && (m.sortino.value ?? 0) >= 1 ? "good" : "neutral"} sub="downside-adj" />
        <MetricTile label="Max Drawdown" value={m.maxDrawdown.insufficient ? "—" : `${((m.maxDrawdown.value ?? 0) * 100).toFixed(1)}%`}
          n={m.maxDrawdown.n} insufficient={m.maxDrawdown.insufficient} tone={m.maxDrawdown.insufficient ? "neutral" : "bad"} sub="peak-to-trough" />
        <MetricTile label="Expectancy" value={fmt(m.expectancyPct, { pct: true })} n={m.expectancyPct.n} insufficient={m.expectancyPct.insufficient}
          tone={!m.expectancyPct.insufficient && (m.expectancyPct.value ?? 0) > 0 ? "good" : "bad"} sub="avg % / trade" />
        <MetricTile label="Profit Factor" value={fmt(m.profitFactor)} n={m.profitFactor.n} insufficient={m.profitFactor.insufficient}
          tone={!m.profitFactor.insufficient && (m.profitFactor.value ?? 0) >= 1 ? "good" : "bad"} sub="gross win / loss" />
        <MetricTile label="Alpha vs Bench" value={m.alphaPct != null ? `${m.alphaPct.toFixed(2)}%` : "—"}
          tone={m.alphaPct != null ? (m.alphaPct >= 0 ? "good" : "bad") : "neutral"}
          sub={m.benchmarkReturnPct != null ? `bench ${m.benchmarkReturnPct.toFixed(2)}%` : "cumulative"} />
        <MetricTile label="Exec Slip (realized)" value={fmt(m.slip.realized, { pct: true, dp: 3 })}
          n={m.slip.realized.n} insufficient={m.slip.realized.insufficient} tone="neutral"
          sub={`vs modeled ${m.slip.modeledPct.toFixed(2)}%`} />
      </div>

      <AlphaScorecard market={market} />

      {/* Charts row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "16px" }}>
        {/* Gross vs Net */}
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px" }}>
          <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "12px" }}>Gross vs Net (cost drag)</div>
          {costBars.length === 0
            ? <div style={{ color: T.muted, fontSize: "12px", textAlign: "center", padding: "40px 0" }}>Needs {20} closed trades — n={m.cost.netReturnPct.n}</div>
            : (
              <>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={costBars} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={T.border} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11, fill: T.textSub }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} width={40} unit="%" />
                    <Tooltip content={<CustomTip />} />
                    <ReferenceLine y={0} stroke={T.muted} />
                    <Bar dataKey="value" name="Return" radius={[4, 4, 0, 0]}>
                      {costBars.map((_, i) => <Cell key={i} fill={i === 0 ? T.accent : T.green} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <div style={{ fontSize: "11px", color: T.muted, marginTop: "8px", textAlign: "center" }}>
                  Spread/slippage drag: {fmt(m.cost.costPct, { pct: true, dp: 3 })} per trade
                </div>
              </>
            )}
        </div>

        {/* Calibration */}
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px" }}>
          <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "12px" }}>Calibration (predicted vs realized)</div>
          {m.calibration.insufficient || calib.length === 0
            ? <div style={{ color: T.muted, fontSize: "12px", textAlign: "center", padding: "40px 0" }}>Needs {10} labeled predictions — n={m.calibration.n}</div>
            : (
              <>
                <ResponsiveContainer width="100%" height={180}>
                  <LC data={calib} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={T.border} strokeDasharray="3 3" />
                    <XAxis dataKey="predicted" tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} unit="%" type="number" domain={[0, 100]} />
                    <YAxis tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} width={34} unit="%" domain={[0, 100]} />
                    <Tooltip content={<CustomTip />} />
                    <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 100, y: 100 }]} stroke={T.muted} strokeDasharray="4 4" />
                    <Line type="monotone" dataKey="realized" name="Realized win %" stroke={T.amber} strokeWidth={2} dot={{ r: 3, fill: T.amber }} />
                  </LC>
                </ResponsiveContainer>
                <div style={{ fontSize: "11px", color: T.muted, marginTop: "8px", textAlign: "center" }}>
                  On the diagonal = well-calibrated. Above = under-confident, below = over-confident.
                </div>
              </>
            )}
        </div>
      </div>

      {/* Win/loss breakdown line */}
      <div style={{ marginTop: "16px", display: "flex", gap: "20px", flexWrap: "wrap", fontSize: "12px", color: T.textSub }}>
        <span>Win rate: <b style={{ color: T.text }}>{m.winRate != null ? `${(m.winRate * 100).toFixed(1)}%` : "—"}</b></span>
        <span>Avg win: <b style={{ color: T.green }}>{m.avgWinPct != null ? `+${m.avgWinPct.toFixed(2)}%` : "—"}</b></span>
        <span>Avg loss: <b style={{ color: T.red }}>{m.avgLossPct != null ? `${m.avgLossPct.toFixed(2)}%` : "—"}</b></span>
      </div>

      {/* Evaluation history */}
      {evals.length > 0 && (
        <div style={{ marginTop: "24px" }}>
          <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "10px" }}>Evaluation History</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", fontVariantNumeric: "tabular-nums" }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                  {["Date", "Trades eval/total", "Sharpe", "MaxDD", "Win Rate", "Alpha", "Health"].map(h => (
                    <th key={h} style={{ padding: "6px 10px", textAlign: "left", color: T.muted, fontWeight: 500, whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {evals.map(ev => (
                  <tr key={ev.id} style={{ borderBottom: `1px solid ${T.border}` }}>
                    <td style={{ padding: "7px 10px", color: T.textSub }}>{new Date(ev.evaluated_at).toLocaleDateString()}</td>
                    <td style={{ padding: "7px 10px", color: T.text }}>{ev.n_trades_evaluable}/{ev.n_trades_total}</td>
                    <td style={{ padding: "7px 10px", color: ev.book_sharpe != null ? (ev.book_sharpe >= 1 ? T.green : T.text) : T.muted }}>{ev.book_sharpe != null ? ev.book_sharpe.toFixed(2) : "—"}</td>
                    <td style={{ padding: "7px 10px", color: ev.book_max_drawdown != null ? T.red : T.muted }}>{ev.book_max_drawdown != null ? `${(ev.book_max_drawdown * 100).toFixed(1)}%` : "—"}</td>
                    <td style={{ padding: "7px 10px", color: T.text }}>{ev.book_win_rate != null ? `${(ev.book_win_rate * 100).toFixed(1)}%` : "—"}</td>
                    <td style={{ padding: "7px 10px", color: ev.book_alpha_pct != null ? (ev.book_alpha_pct >= 0 ? T.green : T.red) : T.muted }}>{ev.book_alpha_pct != null ? `${ev.book_alpha_pct.toFixed(2)}%` : "—"}</td>
                    <td style={{ padding: "7px 10px" }}>
                      <span style={{ background: HEALTH_COLORS[ev.health_label] ?? T.muted, color: "#fff", borderRadius: "4px", padding: "2px 7px", fontSize: "11px", whiteSpace: "nowrap" }}>
                        {ev.health_label.replace(/_/g, " ")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Alpha Diagnostic Lab. Shares this component's market toggle so the two
          surfaces can never disagree about which book is on screen. Read-only:
          mounting it cannot trigger a diagnostic run. */}
      <div style={{ marginTop: "18px" }}>
        <AlphaDiagnosticLab market={market} />
      </div>
    </>
  );
}
