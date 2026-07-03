"use client";
import { useState, useEffect, useRef, useCallback, type ChangeEvent } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280", dim: "#1C1F26",
  accent: "#6366F1", accentBg: "#1E1F3A",
  green: "#34D399", greenBg: "#052E16",
  red: "#F87171", redBg: "#3B0000",
  amber: "#FBBF24", amberBg: "#2D1B00",
  blue: "#60A5FA", blueBg: "#0F1A2E",
  purple: "#A78BFA",
};

const TIMEFRAMES = ["1D", "1W", "1M", "3M", "YTD", "1Y", "All"] as const;
type TF = typeof TIMEFRAMES[number];

const HOLDING_COLORS = [
  "#6366F1", "#34D399", "#60A5FA", "#FBBF24", "#F87171",
  "#A78BFA", "#F59E0B", "#10B981", "#EC4899", "#14B8A6",
];

function fmt$(n: number) {
  const abs = Math.abs(n);
  const s = abs >= 1_000_000 ? "$" + (abs / 1_000_000).toFixed(2) + "M"
    : abs >= 1000 ? "$" + (abs / 1000).toFixed(1) + "k"
    : "$" + abs.toFixed(2);
  return n < 0 ? "-" + s : s;
}
function fmtPct(n: number, decimals = 2) {
  return (n >= 0 ? "+" : "") + n.toFixed(decimals) + "%";
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "16px 20px", flex: 1 }}>
      <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "6px" }}>{label}</div>
      <div style={{ fontSize: "22px", fontWeight: 700, color: color ?? T.text }}>{value}</div>
      {sub && <div style={{ fontSize: "11px", color: T.muted, marginTop: "3px" }}>{sub}</div>}
    </div>
  );
}

function PctBadge({ value }: { value: number | null }) {
  if (value === null) return <span style={{ color: T.muted, fontSize: "12px" }}>—</span>;
  const color = value >= 0 ? T.green : T.red;
  return <span style={{ color, fontSize: "12px", fontWeight: 600 }}>{fmtPct(value, 2)}</span>;
}

type HoldingRow = {
  symbol: string; name: string; qty: number; avgCost: number;
  currentPrice: number; currentValue: number;
  totalPnlDollar: number; totalPnlPct: number;
  dayChangePct: number | null; dayChangeDollar: number | null;
  priceSource: string;
};

type ChartPoint = { date: string; portfolio: number; [key: string]: any };

type FileRecord = {
  id: string; filename: string; trade_count: number; duplicate_count: number;
  date_range_start: string | null; date_range_end: string | null;
  broker: string; uploaded_at: string;
};

type Decision = {
  id: string; symbol: string; action: string; qty: number; exec_price: number;
  exec_date: string; outcome_score: number | null; enrichment_status: string;
  price_1m_after: number | null; llm_analysis: string | null;
  macro_event_tag: string | null; pattern_tags: string[];
};

export default function LivePortfolioPage({
  liveSnaps, initialFiles, decisionStats,
}: {
  liveSnaps: any[];
  initialFiles: FileRecord[];
  decisionStats: { total: number; enriched: number; pending: number };
}) {
  const allAccountIds = liveSnaps.map(s => s.account_id);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>(allAccountIds);
  const [holdings, setHoldings] = useState<HoldingRow[]>([]);
  const [loadingHoldings, setLoadingHoldings] = useState(liveSnaps.length > 0);
  const [snaps, setSnaps] = useState<any[]>(liveSnaps);

  const [period, setPeriod] = useState<TF>("1M");
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [chartSymbols, setChartSymbols] = useState<string[]>([]);
  const [loadingChart, setLoadingChart] = useState(false);
  const [showHoldingLines, setShowHoldingLines] = useState(false);

  const [files, setFiles] = useState<FileRecord[]>(initialFiles);
  const [uploading, setUploading] = useState(false);
  const [uploadResults, setUploadResults] = useState<any[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importOpen, setImportOpen] = useState(false);

  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [decidionsPage, setDecisionsPage] = useState(0);
  const [decisionsTotal, setDecisionsTotal] = useState(decisionStats.total);
  const [loadingDecisions, setLoadingDecisions] = useState(false);
  const [statsLocal, setStatsLocal] = useState(decisionStats);
  const [enriching, setEnriching] = useState(false);
  const [enrichResult, setEnrichResult] = useState<any>(null);

  async function enrichNow() {
    setEnriching(true);
    setEnrichResult(null);
    try {
      const r = await fetch("/api/live-portfolio/enrich", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ limit: 200 }) });
      const d = await r.json();
      setEnrichResult(d);
      setStatsLocal(prev => ({ ...prev, enriched: prev.enriched + (d.enriched ?? 0), pending: Math.max(0, prev.pending - (d.enriched ?? 0) - (d.no_data ?? 0)) }));
      loadDecisions(0);
    } catch (e: any) {
      setEnrichResult({ error: e.message });
    } finally {
      setEnriching(false);
    }
  }

  // Load enriched holdings
  const loadHoldings = useCallback(async (accounts?: string[]) => {
    setLoadingHoldings(true);
    try {
      const accts = accounts ?? selectedAccounts;
      const params = accts.length > 0 ? `?accounts=${accts.join(",")}` : "";
      const r = await fetch(`/api/live-portfolio${params}`);
      const d = await r.json();
      if (d.snaps?.length) setSnaps(d.snaps);
      setHoldings(d.holdings ?? []);
    } catch {
      // non-fatal
    } finally {
      setLoadingHoldings(false);
    }
  }, [selectedAccounts]);

  useEffect(() => { loadHoldings(); }, [loadHoldings]);

  // Load chart data when period or accounts change
  const loadChart = useCallback(async (tf: TF) => {
    setLoadingChart(true);
    setChartData([]);
    try {
      const acctParam = selectedAccounts.length > 0 ? `&accounts=${selectedAccounts.join(",")}` : "";
      const r = await fetch(`/api/live-portfolio/performance?period=${tf}${acctParam}`);
      const d = await r.json();
      if (!d.dates || d.dates.length === 0) return;
      const points: ChartPoint[] = d.dates.map((date: string, i: number) => {
        const pt: ChartPoint = { date: fmtDate(date), portfolio: d.portfolio[i] };
        for (const h of (d.holdings ?? [])) {
          pt[h.symbol] = h.data[i];
        }
        return pt;
      });
      setChartData(points);
      setChartSymbols((d.holdings ?? []).map((h: any) => h.symbol));
    } catch {
      // non-fatal
    } finally {
      setLoadingChart(false);
    }
  }, [selectedAccounts]);

  useEffect(() => { loadChart(period); }, [period, loadChart]);

  // Load decisions
  const loadDecisions = useCallback(async (page = 0) => {
    setLoadingDecisions(true);
    try {
      const r = await fetch(`/api/live-portfolio/decisions?limit=50&offset=${page * 50}`);
      const d = await r.json();
      setDecisions(d.decisions ?? []);
      setDecisionsTotal(d.total ?? 0);
    } finally {
      setLoadingDecisions(false);
    }
  }, []);

  useEffect(() => {
    if (statsLocal.total > 0) loadDecisions(0);
  }, [statsLocal.total, loadDecisions]);

  // CSV upload
  async function handleFileUpload(e: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = e.target.files;
    if (!selectedFiles || selectedFiles.length === 0) return;
    setUploading(true);
    setUploadResults([]);
    const form = new FormData();
    for (const f of Array.from(selectedFiles)) form.append("files", f);
    try {
      const r = await fetch("/api/live-portfolio/import-csv", { method: "POST", body: form });
      const d = await r.json();
      setUploadResults(d.results ?? []);
      // Refresh files list
      const fr = await fetch("/api/live-portfolio/files");
      const fd = await fr.json();
      setFiles(fd.files ?? []);
      // Refresh decision stats
      const total = (fd.files ?? []).reduce((s: number, f: any) => s + (f.trade_count ?? 0), 0);
      setStatsLocal(prev => ({ ...prev, total, pending: total - prev.enriched }));
      if (total > 0) loadDecisions(0);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function deleteFile(id: string) {
    const file = files.find(f => f.id === id);
    if (!confirm(`Delete "${file?.filename}" and all its trade decisions?`)) return;
    await fetch(`/api/live-portfolio/files?id=${id}`, { method: "DELETE" });
    setFiles(prev => prev.filter(f => f.id !== id));
    loadDecisions(0);
  }

  // Aggregate stats from selected accounts
  const selectedSnaps = snaps.filter(s => selectedAccounts.includes(s.account_id));
  const totalEquity = selectedSnaps.reduce((s, a) => s + Number(a.equity ?? a.portfolio_value ?? 0), 0);
  const buyingPower = selectedSnaps.reduce((s, a) => s + Number(a.buying_power ?? 0), 0);
  const positionCount = holdings.length;
  const syncedAt = selectedSnaps[0]?.captured_at;
  const hasSnaps = snaps.length > 0;

  const totalPnl = holdings.reduce((s, h) => s + h.totalPnlDollar, 0);
  const dayPnl = holdings.reduce((s, h) => s + (h.dayChangeDollar ?? 0), 0);
  const totalInvested = holdings.reduce((s, h) => s + h.qty * h.avgCost, 0);
  const totalPnlPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

  const enrichedDecisions = decisions.filter(d => d.enrichment_status === "enriched");
  const avgOutcome = enrichedDecisions.length > 0
    ? enrichedDecisions.reduce((s, d) => s + (d.outcome_score ?? 0), 0) / enrichedDecisions.length
    : null;

  return (
    <div style={{ padding: "28px", color: T.text, fontFamily: "'Inter', sans-serif", maxWidth: "1400px" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "24px" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
            <h1 style={{ fontSize: "22px", fontWeight: 700, margin: 0 }}>Live Portfolio</h1>
            <span style={{ fontSize: "10px", fontWeight: 800, padding: "2px 8px", borderRadius: "4px", background: T.blueBg, color: T.blue, letterSpacing: "0.08em" }}>LIVE</span>
            <span style={{ fontSize: "10px", color: T.muted }}>••••8641 · READ-ONLY</span>
          </div>
          {syncedAt && (
            <div style={{ fontSize: "11px", color: T.muted }}>
              Last synced: {new Date(syncedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              {" · "}
              <span style={{ color: T.muted + "88" }}>auto-syncs 8:50 AM weekdays</span>
            </div>
          )}
          {!hasSnaps && <div style={{ fontSize: "11px", color: T.amber }}>Not yet synced — will sync automatically at 8:50 AM on the next weekday</div>}

          {/* Account selector chips */}
          {snaps.length > 1 && (
            <div style={{ display: "flex", gap: "6px", marginTop: "8px", flexWrap: "wrap" }}>
              <button
                onClick={() => {
                  const next = selectedAccounts.length === snaps.length ? [] : snaps.map(s => s.account_id);
                  setSelectedAccounts(next);
                  loadHoldings(next);
                }}
                style={{
                  padding: "3px 10px", borderRadius: "6px", fontSize: "10px", fontWeight: 700,
                  border: `1px solid ${T.border}`, cursor: "pointer",
                  background: selectedAccounts.length === snaps.length ? T.accent : "none",
                  color: selectedAccounts.length === snaps.length ? "#fff" : T.muted,
                }}
              >All</button>
              {snaps.map(s => {
                const active = selectedAccounts.includes(s.account_id);
                return (
                  <button
                    key={s.account_id}
                    onClick={() => {
                      const next = active
                        ? selectedAccounts.filter(id => id !== s.account_id)
                        : [...selectedAccounts, s.account_id];
                      setSelectedAccounts(next);
                      loadHoldings(next);
                    }}
                    style={{
                      padding: "3px 10px", borderRadius: "6px", fontSize: "10px", fontWeight: 600,
                      border: `1px solid ${active ? T.blue + "66" : T.border}`,
                      background: active ? T.blueBg : "none",
                      color: active ? T.blue : T.muted,
                      cursor: "pointer",
                    }}
                  >
                    {s.nickname ?? "••••" + s.account_id.slice(-4)}
                    {s.equity ? " · " + fmt$(Number(s.equity)) : ""}
                    {s.position_count > 0 ? ` · ${s.position_count}p` : " · no pos"}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <button
          onClick={loadHoldings}
          style={{ background: T.accentBg, border: `1px solid ${T.accent}44`, color: T.accent, borderRadius: "8px", padding: "8px 16px", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
        >
          ↻ Refresh
        </button>
      </div>

      {/* Stats row */}
      <div style={{ display: "flex", gap: "12px", marginBottom: "20px" }}>
        <StatCard label="Total Equity" value={fmt$(Number(totalEquity))} sub="Live Robinhood" />
        <StatCard label="Buying Power" value={fmt$(Number(buyingPower))} color={T.green} />
        <StatCard label="Positions" value={String(positionCount)} sub={holdings.length > 0 ? fmt$(totalInvested) + " invested" : undefined} />
        <StatCard
          label="Total P&L"
          value={fmt$(totalPnl)}
          sub={totalPnlPct !== 0 ? fmtPct(totalPnlPct) : undefined}
          color={totalPnl >= 0 ? T.green : T.red}
        />
        <StatCard
          label="Day P&L"
          value={dayPnl !== 0 ? fmt$(dayPnl) : "—"}
          color={dayPnl >= 0 ? T.green : T.red}
        />
      </div>

      {/* Performance chart */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "14px", padding: "20px", marginBottom: "20px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div style={{ fontSize: "11px", fontWeight: 700, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              Performance
            </div>
            {loadingChart && <span style={{ fontSize: "11px", color: T.muted }}>Loading…</span>}
          </div>
          <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
            {/* Timeframe buttons */}
            {TIMEFRAMES.map(tf => (
              <button
                key={tf}
                onClick={() => setPeriod(tf)}
                style={{
                  padding: "4px 10px", borderRadius: "6px", fontSize: "11px", fontWeight: 600,
                  background: period === tf ? T.accent : "none",
                  color: period === tf ? "#fff" : T.muted,
                  border: `1px solid ${period === tf ? T.accent : T.border}`,
                  cursor: "pointer",
                }}
              >{tf}</button>
            ))}
            <div style={{ width: "1px", height: "20px", background: T.border, margin: "0 4px" }} />
            <button
              onClick={() => setShowHoldingLines(s => !s)}
              style={{
                padding: "4px 10px", borderRadius: "6px", fontSize: "11px", fontWeight: 600,
                background: showHoldingLines ? T.accentBg : "none",
                color: showHoldingLines ? T.accent : T.muted,
                border: `1px solid ${showHoldingLines ? T.accent + "44" : T.border}`,
                cursor: "pointer",
              }}
            >Holdings</button>
          </div>
        </div>

        {chartData.length === 0 && !loadingChart ? (
          <div style={{ height: "200px", display: "flex", alignItems: "center", justifyContent: "center", color: T.muted, fontSize: "13px", flexDirection: "column", gap: "6px" }}>
            <div>No price data</div>
            <div style={{ fontSize: "11px" }}>Requires Alpha Vantage API key · <code style={{ background: T.dim, padding: "1px 4px", borderRadius: "3px" }}>ALPHA_VANTAGE_API_KEY</code></div>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData} margin={{ top: 4, right: 0, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="portfolioGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={T.accent} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={T.accent} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} />
              <YAxis
                tick={{ fontSize: 10, fill: T.muted }}
                tickLine={false}
                axisLine={false}
                tickFormatter={v => v + "%"}
              />
              <Tooltip
                contentStyle={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", fontSize: "12px" }}
                labelStyle={{ color: T.textSub }}
                formatter={(v: any) => [v?.toFixed(2) + "%", ""]}
              />
              {showHoldingLines && chartSymbols.map((sym, i) => (
                <Area
                  key={sym}
                  type="monotone"
                  dataKey={sym}
                  stroke={HOLDING_COLORS[i % HOLDING_COLORS.length]}
                  fill="none"
                  strokeWidth={1}
                  dot={false}
                  strokeDasharray="4 2"
                />
              ))}
              <Area
                type="monotone"
                dataKey="portfolio"
                stroke={T.accent}
                fill="url(#portfolioGrad)"
                strokeWidth={2}
                dot={false}
                name="Portfolio"
              />
              {showHoldingLines && <Legend wrapperStyle={{ fontSize: "10px", paddingTop: "8px" }} />}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Holdings table */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "14px", padding: "20px", marginBottom: "20px" }}>
        <div style={{ fontSize: "11px", fontWeight: 700, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "14px" }}>
          Holdings {holdings.length > 0 && <span style={{ color: T.textSub, fontWeight: 400 }}>({holdings.length})</span>}
        </div>

        {loadingHoldings ? (
          <div style={{ color: T.muted, fontSize: "13px", padding: "16px 0" }}>Loading holdings…</div>
        ) : holdings.length === 0 ? (
          <div style={{ color: T.muted, fontSize: "13px", padding: "16px 0", textAlign: "center" }}>
            {hasSnaps ? "No positions in selected accounts" : "Not yet synced — run financeos-account-sync task"}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                  {["Symbol", "Name", "Qty", "Avg Cost", "Current", "Day %", "Total %", "Value", "P&L $"].map(h => (
                    <th key={h} style={{ padding: "6px 10px", textAlign: h === "Symbol" ? "left" : "right", fontSize: "10px", color: T.muted, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {holdings.sort((a, b) => b.currentValue - a.currentValue).map((h, i) => (
                  <tr
                    key={h.symbol}
                    style={{ borderBottom: `1px solid ${T.border}33`, background: i % 2 === 0 ? "none" : T.dim + "44" }}
                  >
                    <td style={{ padding: "10px 10px", fontWeight: 700, color: T.accent }}>{h.symbol}</td>
                    <td style={{ padding: "10px 10px", color: T.textSub, fontSize: "12px", maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.name}</td>
                    <td style={{ padding: "10px 10px", textAlign: "right", color: T.text }}>{h.qty.toFixed(h.qty % 1 === 0 ? 0 : 4)}</td>
                    <td style={{ padding: "10px 10px", textAlign: "right", color: T.muted }}>
                      {h.avgCost > 0 ? "$" + h.avgCost.toFixed(2) : "—"}
                    </td>
                    <td style={{ padding: "10px 10px", textAlign: "right", fontWeight: 600 }}>
                      {h.currentPrice > 0 ? "$" + h.currentPrice.toFixed(2) : "—"}
                      {h.priceSource === "unavailable" && <span style={{ fontSize: "9px", color: T.amber, marginLeft: "4px" }}>⚠</span>}
                    </td>
                    <td style={{ padding: "10px 10px", textAlign: "right" }}><PctBadge value={h.dayChangePct} /></td>
                    <td style={{ padding: "10px 10px", textAlign: "right" }}><PctBadge value={h.totalPnlPct} /></td>
                    <td style={{ padding: "10px 10px", textAlign: "right", fontWeight: 600 }}>{fmt$(h.currentValue)}</td>
                    <td style={{ padding: "10px 10px", textAlign: "right", fontWeight: 600, color: h.totalPnlDollar >= 0 ? T.green : T.red }}>
                      {fmt$(h.totalPnlDollar)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: `1px solid ${T.border}` }}>
                  <td colSpan={7} style={{ padding: "10px 10px", fontSize: "11px", color: T.muted }}>Total</td>
                  <td style={{ padding: "10px 10px", textAlign: "right", fontWeight: 700 }}>
                    {fmt$(holdings.reduce((s, h) => s + h.currentValue, 0))}
                  </td>
                  <td style={{ padding: "10px 10px", textAlign: "right", fontWeight: 700, color: totalPnl >= 0 ? T.green : T.red }}>
                    {fmt$(totalPnl)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Import Transaction History */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "14px", marginBottom: "20px", overflow: "hidden" }}>
        <button
          onClick={() => setImportOpen(o => !o)}
          style={{
            width: "100%", background: "none", border: "none", cursor: "pointer", color: T.text,
            padding: "18px 20px", textAlign: "left", display: "flex", alignItems: "center", justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "11px", fontWeight: 700, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              Transaction History
            </span>
            {statsLocal.total > 0 && (
              <span style={{ fontSize: "10px", padding: "2px 7px", borderRadius: "4px", background: T.accentBg, color: T.accent, fontWeight: 600 }}>
                {statsLocal.total.toLocaleString()} trades
              </span>
            )}
          </div>
          <span style={{ color: T.muted, transform: importOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s", display: "inline-block" }}>▶</span>
        </button>

        {importOpen && (
          <div style={{ padding: "0 20px 20px", borderTop: `1px solid ${T.border}` }}>
            <div style={{ paddingTop: "16px" }}>
              {/* Instructions */}
              <div style={{ background: T.dim, borderRadius: "10px", padding: "12px 14px", marginBottom: "16px", fontSize: "12px", color: T.textSub, lineHeight: "1.7" }}>
                <div style={{ fontWeight: 600, color: T.text, marginBottom: "4px" }}>How to export from Robinhood:</div>
                <div>1. Open Robinhood app or website</div>
                <div>2. Account → Statements & History → Account History</div>
                <div>3. Download CSV (one per year, or full history)</div>
                <div>4. Upload all files below — duplicates auto-detected and skipped</div>
              </div>

              {/* Upload button */}
              <div style={{ display: "flex", gap: "12px", alignItems: "center", marginBottom: "16px" }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  multiple
                  onChange={handleFileUpload}
                  style={{ display: "none" }}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  style={{
                    background: uploading ? T.dim : T.accentBg, border: `1px solid ${T.accent}44`,
                    color: T.accent, borderRadius: "8px", padding: "9px 18px",
                    fontSize: "13px", fontWeight: 600, cursor: uploading ? "not-allowed" : "pointer",
                  }}
                >
                  {uploading ? "Processing…" : "+ Upload CSV Files"}
                </button>
                <span style={{ fontSize: "11px", color: T.muted }}>Accepts multiple files at once · Robinhood CSV format</span>
              </div>

              {/* Upload results */}
              {uploadResults.length > 0 && (
                <div style={{ marginBottom: "16px", display: "flex", flexDirection: "column", gap: "6px" }}>
                  {uploadResults.map((r, i) => (
                    <div key={i} style={{
                      padding: "8px 12px", borderRadius: "8px",
                      background: r.status === "ok" ? T.greenBg + "88" : r.status === "duplicate_file" ? T.amberBg : T.redBg + "88",
                      border: `1px solid ${r.status === "ok" ? T.green + "33" : r.status === "duplicate_file" ? T.amber + "33" : T.red + "33"}`,
                      fontSize: "12px",
                    }}>
                      <span style={{ fontWeight: 600 }}>{r.filename}</span>
                      {r.status === "ok" && (
                        <span style={{ color: T.green }}> — {r.imported} imported, {r.duplicates} duplicates · {r.date_range}</span>
                      )}
                      {r.status === "duplicate_file" && (
                        <span style={{ color: T.amber }}> — Already uploaded ({r.trade_count} trades)</span>
                      )}
                      {r.status === "parse_error" && (
                        <span style={{ color: T.red }}> — {r.message}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Uploaded files list */}
              {files.length > 0 ? (
                <div>
                  <div style={{ fontSize: "10px", color: T.muted, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "8px" }}>
                    Uploaded Files
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {files.map(f => (
                      <div key={f.id} style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        padding: "10px 12px", background: T.dim, borderRadius: "8px",
                      }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                          <span style={{ fontSize: "14px" }}>📄</span>
                          <div>
                            <div style={{ fontSize: "12px", fontWeight: 600, color: T.text }}>{f.filename}</div>
                            <div style={{ fontSize: "10px", color: T.muted, marginTop: "1px" }}>
                              {f.trade_count} trades
                              {f.duplicate_count > 0 && ` · ${f.duplicate_count} duplicates skipped`}
                              {f.date_range_start && ` · ${f.date_range_start?.slice(0, 7)} to ${f.date_range_end?.slice(0, 7)}`}
                              {" · "}
                              {f.broker}
                            </div>
                          </div>
                        </div>
                        <button
                          onClick={() => deleteFile(f.id)}
                          style={{ background: "none", border: "none", color: T.red, cursor: "pointer", fontSize: "12px", padding: "4px 8px", borderRadius: "5px" }}
                          title="Remove file and its trade decisions"
                        >
                          ✕ Remove
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: "12px", color: T.muted, textAlign: "center", padding: "16px 0" }}>
                  No files uploaded yet
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Trade Decision Analysis */}
      {statsLocal.total > 0 && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "14px", padding: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
            <div>
              <div style={{ fontSize: "11px", fontWeight: 700, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "4px" }}>
                Transaction Analysis
              </div>
              <div style={{ fontSize: "12px", color: T.textSub }}>
                {statsLocal.total.toLocaleString()} trades imported
                {statsLocal.pending > 0 && (
                  <span style={{ color: T.amber }}> · {statsLocal.pending} pending analysis</span>
                )}
                {statsLocal.enriched > 0 && (
                  <span style={{ color: T.green }}> · {statsLocal.enriched} enriched</span>
                )}
              </div>
            </div>
            {avgOutcome !== null && (
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: "10px", color: T.muted, marginBottom: "2px" }}>Avg Decision Score</div>
                <div style={{ fontSize: "20px", fontWeight: 700, color: avgOutcome >= 0 ? T.green : T.red }}>
                  {avgOutcome >= 0 ? "+" : ""}{(avgOutcome * 100).toFixed(1)}%
                </div>
              </div>
            )}
          </div>

          {statsLocal.pending > 0 && (
            <div style={{ background: T.amberBg, border: `1px solid ${T.amber}33`, borderRadius: "10px", padding: "12px 14px", marginBottom: "16px", fontSize: "12px", color: T.amber }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: "3px" }}>📊 {statsLocal.pending} trades awaiting analysis</div>
                  <div style={{ color: T.textSub }}>
                    Fetches historical prices per symbol, scores each decision, tags macro regime.
                    {enrichResult && !enrichResult.error && <span style={{ color: T.green }}> Last run: {enrichResult.enriched} enriched, {enrichResult.no_data} no data.</span>}
                    {enrichResult?.error && <span style={{ color: T.red }}> Error: {enrichResult.error}</span>}
                  </div>
                </div>
                <button onClick={enrichNow} disabled={enriching}
                  style={{ background: T.amber, color: "#000", border: "none", borderRadius: "7px", padding: "7px 14px", fontSize: "11px", fontWeight: 700, cursor: enriching ? "not-allowed" : "pointer", opacity: enriching ? 0.6 : 1, whiteSpace: "nowrap", flexShrink: 0 }}>
                  {enriching ? "Analyzing…" : "Analyze Now"}
                </button>
              </div>
            </div>
          )}

          {/* Decisions table */}
          {decisions.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                    {["Date", "Symbol", "Action", "Qty", "Price", "1M After", "Score", "Tag", "Status"].map(h => (
                      <th key={h} style={{ padding: "6px 10px", textAlign: h === "Date" || h === "Symbol" || h === "Action" || h === "Tag" || h === "Status" ? "left" : "right", fontSize: "10px", color: T.muted, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {decisions.map((d, i) => {
                    const score = d.outcome_score;
                    const scoreColor = score === null ? T.muted : score >= 0.05 ? T.green : score <= -0.05 ? T.red : T.amber;
                    const actionColor = d.action === "buy" ? T.green : T.red;
                    return (
                      <tr key={d.id} style={{ borderBottom: `1px solid ${T.border}22`, background: i % 2 === 0 ? "none" : T.dim + "33" }}>
                        <td style={{ padding: "8px 10px", color: T.muted, whiteSpace: "nowrap" }}>{d.exec_date}</td>
                        <td style={{ padding: "8px 10px", fontWeight: 700, color: T.accent }}>{d.symbol}</td>
                        <td style={{ padding: "8px 10px" }}>
                          <span style={{ fontSize: "10px", fontWeight: 700, padding: "2px 6px", borderRadius: "4px", background: d.action === "buy" ? T.greenBg : T.redBg, color: actionColor }}>
                            {d.action.toUpperCase()}
                          </span>
                        </td>
                        <td style={{ padding: "8px 10px", textAlign: "right" }}>{Number(d.qty).toFixed(d.qty % 1 === 0 ? 0 : 2)}</td>
                        <td style={{ padding: "8px 10px", textAlign: "right" }}>${Number(d.exec_price).toFixed(2)}</td>
                        <td style={{ padding: "8px 10px", textAlign: "right", color: T.textSub }}>
                          {d.price_1m_after ? "$" + Number(d.price_1m_after).toFixed(2) : "—"}
                        </td>
                        <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 600, color: scoreColor }}>
                          {score !== null ? (score >= 0 ? "+" : "") + (score * 100).toFixed(1) + "%" : "—"}
                        </td>
                        <td style={{ padding: "8px 10px" }}>
                          {d.macro_event_tag ? (
                            <span style={{ fontSize: "9px", padding: "2px 5px", borderRadius: "3px", background: T.amberBg, color: T.amber }}>{d.macro_event_tag}</span>
                          ) : d.pattern_tags?.[0] ? (
                            <span style={{ fontSize: "9px", padding: "2px 5px", borderRadius: "3px", background: T.accentBg, color: T.accent }}>{d.pattern_tags[0]}</span>
                          ) : <span style={{ color: T.muted }}>—</span>}
                        </td>
                        <td style={{ padding: "8px 10px" }}>
                          <span style={{ fontSize: "9px", padding: "2px 5px", borderRadius: "3px",
                            background: d.enrichment_status === "enriched" ? T.greenBg : d.enrichment_status === "no_data" ? T.redBg : T.dim,
                            color: d.enrichment_status === "enriched" ? T.green : d.enrichment_status === "no_data" ? T.red : T.muted,
                          }}>
                            {d.enrichment_status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* Pagination */}
              {decisionsTotal > 50 && (
                <div style={{ display: "flex", justifyContent: "center", gap: "8px", marginTop: "14px" }}>
                  <button
                    disabled={decidionsPage === 0}
                    onClick={() => { const p = decidionsPage - 1; setDecisionsPage(p); loadDecisions(p); }}
                    style={{ padding: "5px 12px", borderRadius: "6px", border: `1px solid ${T.border}`, background: "none", color: T.muted, cursor: "pointer", fontSize: "12px" }}
                  >← Prev</button>
                  <span style={{ fontSize: "12px", color: T.muted, padding: "5px 0" }}>
                    {decidionsPage * 50 + 1}–{Math.min((decidionsPage + 1) * 50, decisionsTotal)} of {decisionsTotal}
                  </span>
                  <button
                    disabled={(decidionsPage + 1) * 50 >= decisionsTotal}
                    onClick={() => { const p = decidionsPage + 1; setDecisionsPage(p); loadDecisions(p); }}
                    style={{ padding: "5px 12px", borderRadius: "6px", border: `1px solid ${T.border}`, background: "none", color: T.muted, cursor: "pointer", fontSize: "12px" }}
                  >Next →</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
