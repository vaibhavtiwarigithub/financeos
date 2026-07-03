const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", yellow: "#FBBF24",
};

const TODAY = "2026-06-29";

type Feature = { name: string; date: string };
type Category = { label: string; color: string; features: Feature[] };

const CATEGORIES: Category[] = [
  {
    label: "Core Platform",
    color: "#6366F1",
    features: [
      { name: "Dashboard shell with sidebar navigation", date: "2026-05-01" },
      { name: "Auth: single-user lock (vterminater@gmail.com only)", date: "2026-05-01" },
      { name: "Supabase backend + service client", date: "2026-05-01" },
      { name: "Pause Mode (kill switch for all AI activity)", date: "2026-06-15" },
    ],
  },
  {
    label: "Markets",
    color: "#34D399",
    features: [
      { name: "Symbol chart: EMA/SMA overlays + volume + recession bands", date: "2026-06-29" },
      { name: "Symbol detail page with candlestick chart", date: "2026-06-29" },
      { name: "Symbol navigation from Portfolio, Markets, Activity", date: "2026-06-29" },
      { name: "Sector line chart (multi-sector performance)", date: "2026-06-20" },
      { name: "Sector treemap + sector heatmap", date: "2026-05-20" },
      { name: "Markets overview page with live index quotes", date: "2026-05-15" },
    ],
  },
  {
    label: "Research Agent",
    color: "#F59E0B",
    features: [
      { name: "Agent Knowledge Doctrine v1", date: "2026-06-25" },
      { name: "ResearchAgent: dual-bucket screener (Momentum + Value)", date: "2026-06-01" },
      { name: "3-candidate/day limit, long-only for new positions", date: "2026-06-01" },
      { name: "SELL signal allowed for existing Robinhood holdings", date: "2026-06-01" },
      { name: "Research cron: daily automated runs", date: "2026-06-01" },
      { name: "Social sentiment: StockTwits + Alpha Vantage signals", date: "2026-06-29" },
    ],
  },
  {
    label: "Paper Trading",
    color: "#60A5FA",
    features: [
      { name: "Position cards with gauge dials + NAV sparkline", date: "2026-06-20" },
      { name: "Trade queue with approval flow", date: "2026-06-10" },
      { name: "Paper trading engine: auto-execute approved signals", date: "2026-06-05" },
      { name: "Paper portfolio NAV tracking + daily snapshots", date: "2026-06-05" },
    ],
  },
  {
    label: "Mentor & Learning",
    color: "#A78BFA",
    features: [
      { name: "Journal + trade evaluation", date: "2026-06-15" },
      { name: "Activity feed: unified event timeline", date: "2026-06-15" },
      { name: "AI call history page", date: "2026-06-15" },
      { name: "Token usage tracking", date: "2026-06-15" },
      { name: "Mentor page: thesis builder + AI evaluation", date: "2026-06-10" },
    ],
  },
  {
    label: "Data Infrastructure",
    color: "#F87171",
    features: [
      { name: "Massive API (Polygon.io) integration for price history", date: "2026-06-29" },
      { name: "price_cache table: on-demand candle caching", date: "2026-06-29" },
      { name: "Markets overview: direct Massive API (no LLM)", date: "2026-06-29" },
      { name: "Earnings calendar: Alpha Vantage/Massive API (no LLM)", date: "2026-06-29" },
    ],
  },
  {
    label: "Multi-LLM",
    color: "#34D399",
    features: [
      { name: "LLM Router: Claude + DeepSeek + Groq routing by task", date: "2026-06-29" },
      { name: "LLM call log: cost + token tracking per model", date: "2026-06-29" },
      { name: "DeepSeek R1 integration (cheaper chat/summarize)", date: "2026-06-29" },
      { name: "Groq Llama 3.3 70B free-tier integration", date: "2026-06-29" },
      { name: "DeepSeek research agent variant (parallel signal source)", date: "2026-06-29" },
      { name: "Agent labels: track which LLM produced each signal", date: "2026-06-29" },
      { name: "API key vault (PIN protected, encrypted storage)", date: "2026-06-29" },
    ],
  },
  {
    label: "Strategies",
    color: "#FBBF24",
    features: [
      { name: "Strategy templates: 7 strategies (Momentum, GARP, Value, etc.)", date: "2026-06-29" },
      { name: "Strategy classification engine", date: "2026-06-29" },
    ],
  },
];

function FeatureRow({ name, date }: Feature) {
  const isToday = date === TODAY;
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: "10px",
      padding: "9px 0",
      borderBottom: `1px solid ${T.border}44`,
    }}>
      <span style={{
        width: "7px",
        height: "7px",
        borderRadius: "50%",
        background: isToday ? T.green : T.accent,
        flexShrink: 0,
        boxShadow: isToday ? `0 0 6px ${T.green}88` : "none",
      }} />
      <span style={{ flex: 1, fontSize: "13px", color: T.text, fontWeight: 500 }}>{name}</span>
      <span style={{
        fontSize: "11px",
        color: isToday ? T.green : T.muted,
        fontFamily: "'JetBrains Mono', monospace",
        flexShrink: 0,
        fontWeight: isToday ? 600 : 400,
      }}>{date}</span>
    </div>
  );
}

export default function FeaturesPage() {
  const totalFeatures = CATEGORIES.reduce((s, c) => s + c.features.length, 0);
  const todayCount = CATEGORIES.reduce(
    (s, c) => s + c.features.filter(f => f.date === TODAY).length,
    0
  );

  return (
    <div style={{ padding: "28px", maxWidth: "900px" }}>
      {/* Header */}
      <div style={{ marginBottom: "28px" }}>
        <div style={{ fontSize: "22px", fontWeight: 700, marginBottom: "4px" }}>Kairos Features</div>
        <div style={{ fontSize: "13px", color: T.muted }}>Built features &amp; release timeline</div>
      </div>

      {/* Summary badges */}
      <div style={{ display: "flex", gap: "12px", marginBottom: "28px", flexWrap: "wrap" }}>
        {[
          { value: totalFeatures, label: "Total Features", color: T.accent },
          { value: todayCount,    label: "Shipped Today",  color: T.green },
          { value: CATEGORIES.length, label: "Categories", color: T.yellow },
        ].map(s => (
          <div key={s.label} style={{
            background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px",
            padding: "14px 20px", display: "flex", flexDirection: "column", gap: "2px",
          }}>
            <div style={{ fontSize: "26px", fontWeight: 700, color: s.color, fontFamily: "'JetBrains Mono', monospace" }}>{s.value}</div>
            <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.07em" }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Legend */}
      <div style={{ display: "flex", gap: "20px", marginBottom: "24px", fontSize: "12px", color: T.muted }}>
        <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: T.green, display: "inline-block", boxShadow: `0 0 6px ${T.green}88` }} />
          Shipped today
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: T.accent, display: "inline-block" }} />
          Previously released
        </span>
      </div>

      {/* Categories */}
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        {CATEGORIES.map(cat => (
          <div
            key={cat.label}
            style={{
              background: T.card,
              border: `1px solid ${T.border}`,
              borderRadius: "12px",
              overflow: "hidden",
              borderLeft: `3px solid ${cat.color}`,
            }}
          >
            {/* Category header */}
            <div style={{
              padding: "14px 20px",
              borderBottom: `1px solid ${T.border}`,
              display: "flex",
              alignItems: "center",
              gap: "10px",
            }}>
              <span style={{
                fontWeight: 700, fontSize: "13px", color: cat.color,
                textTransform: "uppercase", letterSpacing: "0.08em",
              }}>
                {cat.label}
              </span>
              <span style={{
                fontSize: "10px", padding: "2px 7px", borderRadius: "999px",
                background: cat.color + "22", color: cat.color, fontWeight: 600,
              }}>
                {cat.features.length}
              </span>
            </div>

            {/* Features */}
            <div style={{ padding: "4px 20px 8px" }}>
              {cat.features.map(f => (
                <FeatureRow key={f.name} name={f.name} date={f.date} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
