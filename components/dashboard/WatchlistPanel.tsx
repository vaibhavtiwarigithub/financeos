"use client";
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useMarket } from "@/lib/market-context";

const T = {
  card: "#1A1D27", border: "#252836", text: "#ECEDEF", textSub: "#9B9EA8",
  muted: "#6B7280", dim: "#13151C", accent: "#6366F1", accentBg: "#1E1F3A",
  green: "#34D399", red: "#F87171", amber: "#FBBF24", blue: "#60A5FA",
  purple: "#A78BFA", surface: "#0F1117",
};

const SOURCE_META: Record<string, { label: string; color: string; bg: string }> = {
  llm_theme:          { label: "AI Scout",    color: T.purple, bg: "#A78BFA18" },
  manual:             { label: "Manual",      color: T.muted,  bg: "#6B728018" },
  tradingview_import: { label: "TradingView", color: T.blue,   bg: "#60A5FA18" },
  robinhood_sync:     { label: "Robinhood",   color: T.green,  bg: "#34D39918" },
  robinhood_holding:  { label: "Holdings",    color: T.green,  bg: "#34D39918" },
  robinhood:          { label: "Robinhood",   color: T.green,  bg: "#34D39918" },
  holdings:           { label: "Holdings",    color: T.green,  bg: "#34D39918" },
  briefing:           { label: "Briefing",    color: T.amber,  bg: "#FBBF2418" },
};

// Always-visible one-line "why added" derived from source + optional reason clause.
function whyAdded(item: { source: string; theme?: string; reason?: string; auto_added?: boolean }): string {
  let base: string;
  if (item.source === "llm_theme" || item.auto_added) {
    base = item.theme ? `AI Scout · ${item.theme}` : "AI Scout";
  } else if (item.source === "briefing") {
    base = "From a briefing mention";
  } else if (item.source === "tradingview_import") {
    base = "Imported from TradingView";
  } else if (item.source === "robinhood" || item.source === "robinhood_sync" || item.source === "holdings") {
    base = "From your Robinhood account";
  } else {
    base = "Manually added";
  }
  if (item.reason) {
    const clause = item.reason.split(/[.;\n]/)[0].trim();
    if (clause) base = `${base} — ${clause}`;
  }
  return base;
}

type WatchlistItem = {
  id: string;
  symbol: string;
  source: string;
  theme?: string;
  reason?: string;
  notes?: string;
  company_name?: string;
  auto_added: boolean;
  expires_at?: string;
  created_at: string;
  research_enabled: boolean;
  alert_on_signal: boolean;
  alert_on_earnings: boolean;
};

type Quote = { price: number; changePct: number };

function Toggle({
  on, label, onChange,
}: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onChange(!on); }}
      title={label}
      style={{
        display: "flex", alignItems: "center", gap: "3px",
        background: on ? `${T.accent}22` : T.surface,
        border: `1px solid ${on ? T.accent + "55" : T.border}`,
        borderRadius: "4px", padding: "2px 6px", cursor: "pointer",
        fontSize: "9px", fontWeight: 700, color: on ? T.accent : T.muted,
        letterSpacing: "0.05em",
      }}
    >
      <span style={{ fontSize: "7px" }}>{on ? "●" : "○"}</span>
      {label}
    </button>
  );
}

function parseCsvSymbols(text: string): string[] {
  return text
    .split(/[\n,\r]+/)
    .map(s => s.trim())
    .map(s => s.includes(":") ? s.split(":")[1] : s)  // strip exchange prefix e.g. NASDAQ:CRNT
    .map(s => s.replace(/[^A-Z0-9.]/gi, "").toUpperCase())
    .filter(s => s.length >= 1 && s.length <= 5)
    .filter((s, i, arr) => arr.indexOf(s) === i); // dedupe
}

export default function WatchlistPanel() {
  const router = useRouter();
  const { market } = useMarket();
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [newSymbol, setNewSymbol] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  // Ticker autocomplete state
  type SymbolResult = { symbol: string; name: string; exchange: string; locale: string };
  const [suggestions, setSuggestions] = useState<SymbolResult[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Filter + sort state
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [researchFilter, setResearchFilter] = useState(false);
  const [sortBy, setSortBy] = useState<"date" | "symbol" | "price">("date");

  // CSV import state
  const [showCsvModal, setShowCsvModal] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [csvParsed, setCsvParsed] = useState<string[]>([]);
  const [csvImporting, setCsvImporting] = useState(false);
  const [csvProgress, setCsvProgress] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/watchlist?market=${market}`);
      const d = await r.json();
      const list: WatchlistItem[] = d.items ?? [];
      setItems(list);
      // Fetch quotes for up to 15 symbols — hits price_cache, no AI
      const syms = list.slice(0, 20).map(i => i.symbol);
      if (syms.length > 0) {
        const r = await fetch(`/api/markets/quotes?symbols=${syms.join(",")}`);
        const d = await r.json();
        const q: Record<string, Quote> = {};
        for (const [sym, val] of Object.entries(d.quotes ?? {})) {
          const v = val as { price: number; changePct: number };
          if (v.price) q[sym] = { price: v.price, changePct: v.changePct ?? 0 };
        }
        setQuotes(q);
      }
    } catch {}
    setLoading(false);
  }, [market]);

  useEffect(() => { load(); }, [load]);

  // Debounced ticker autocomplete (250ms). Falls back to filtering existing
  // watchlist items client-side if the provider returns nothing/errors.
  useEffect(() => {
    const q = newSymbol.trim();
    if (q.length < 1) { setSuggestions([]); return; }
    const t = setTimeout(async () => {
      const clientFallback = (): SymbolResult[] =>
        items
          .filter(i =>
            i.symbol.toLowerCase().includes(q.toLowerCase()) ||
            i.company_name?.toLowerCase().includes(q.toLowerCase()))
          .slice(0, 8)
          .map(i => ({ symbol: i.symbol, name: i.company_name ?? "", exchange: "watchlist", locale: "us" }));
      try {
        const r = await fetch(`/api/symbols/search?q=${encodeURIComponent(q)}`);
        const d = await r.json();
        const results: SymbolResult[] = Array.isArray(d.results) ? d.results : [];
        setSuggestions(results.length > 0 ? results : clientFallback());
      } catch {
        setSuggestions(clientFallback());
      }
    }, 250);
    return () => clearTimeout(t);
  }, [newSymbol, items]);

  async function addSymbol(sym: string, source = "manual") {
    const clean = sym.trim().toUpperCase();
    if (!clean) return;
    setAdding(true);
    setAddError("");
    setSuggestions([]);
    setShowSuggestions(false);
    try {
      const r = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: clean, source, market }),
      });
      if (!r.ok) {
        // Surface the market-mismatch (or any) error instead of silently doing nothing.
        const d = await r.json().catch(() => ({}));
        setAddError(d.error ?? "Couldn't add that symbol.");
        setAdding(false);
        return;
      }
      setNewSymbol("");
    } catch {
      setAddError("Network error — couldn't add that symbol.");
      setAdding(false);
      return;
    }
    setAdding(false);
    load();
  }

  async function addManual() {
    await addSymbol(newSymbol, "manual");
  }

  async function removeItem(symbol: string) {
    setItems(i => i.filter(x => x.symbol !== symbol));
    await fetch(`/api/watchlist?symbol=${symbol}`, { method: "DELETE" }).catch(() => {});
  }

  async function importCsv() {
    if (csvParsed.length === 0 || csvImporting) return;
    setCsvImporting(true);
    setCsvProgress(0);
    for (let i = 0; i < csvParsed.length; i++) {
      const sym = csvParsed[i];
      await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: sym, source: "tradingview_import", market }),
      }).catch(() => {});
      setCsvProgress(i + 1);
    }
    setCsvImporting(false);
    setShowCsvModal(false);
    setCsvText("");
    setCsvParsed([]);
    load();
  }

  async function toggle(symbol: string, field: "research_enabled" | "alert_on_signal" | "alert_on_earnings", val: boolean) {
    setItems(prev => prev.map(i => i.symbol === symbol ? { ...i, [field]: val } : i));
    await fetch("/api/watchlist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, [field]: val }),
    }).catch(() => {});
  }

  // Filtered + sorted items
  const availableSources = [...new Set(items.map(i => i.source))];

  const filteredItems = (() => {
    let result = items.filter(item => {
      if (search && !item.symbol.toLowerCase().includes(search.toLowerCase()) &&
          !item.company_name?.toLowerCase().includes(search.toLowerCase())) return false;
      if (sourceFilter !== "all" && item.source !== sourceFilter) return false;
      if (researchFilter && !item.research_enabled) return false;
      return true;
    });

    if (sortBy === "symbol") {
      result = [...result].sort((a, b) => a.symbol.localeCompare(b.symbol));
    } else if (sortBy === "price") {
      result = [...result].sort((a, b) => {
        const aChg = quotes[a.symbol]?.changePct ?? -Infinity;
        const bChg = quotes[b.symbol]?.changePct ?? -Infinity;
        return bChg - aChg;
      });
    }
    // "date" keeps original API order
    return result;
  })();

  // Only group under an "AI SCOUT" theme header items that ACTUALLY came from AI Scout
  // (source === "llm_theme"). A manual item can carry a stale `theme` from a prior
  // AI-scout add; it must render as Manual, not under an AI SCOUT header.
  const themed = filteredItems.filter(i => i.theme && i.source === "llm_theme");
  const other = filteredItems.filter(i => !(i.theme && i.source === "llm_theme"));
  const themeGroups = new Map<string, WatchlistItem[]>();
  for (const item of themed) {
    const key = item.theme!;
    if (!themeGroups.has(key)) themeGroups.set(key, []);
    themeGroups.get(key)!.push(item);
  }

  function renderItem(item: WatchlistItem) {
    const q = quotes[item.symbol];
    const sm = SOURCE_META[item.source] ?? SOURCE_META.manual;
    const isExpanded = expanded === item.id;
    return (
      <div key={item.id} style={{ borderBottom: `1px solid ${T.border}22` }}>
        {/* Main row */}
        <div
          style={{ display: "flex", alignItems: "center", padding: "8px 12px", cursor: "pointer", gap: "8px" }}
          onClick={() => router.push(`/dashboard/symbol/${item.symbol}`)}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ fontSize: "13px", fontWeight: 700, color: T.text }}>{item.symbol}</span>
              <span style={{ fontSize: "9px", fontWeight: 700, color: sm.color, background: sm.bg, padding: "1px 5px", borderRadius: "3px" }}>
                {sm.label}
              </span>
              {!item.research_enabled && (
                <span style={{ fontSize: "9px", color: T.muted, background: "#1A1D27", padding: "1px 5px", borderRadius: "3px" }}>
                  no research
                </span>
              )}
            </div>
            {item.company_name && (
              <div style={{ fontSize: "10px", color: T.muted, marginTop: "1px", wordBreak: "break-word" }} title={item.company_name}>
                {item.company_name}
              </div>
            )}
            {/* Always-visible "why added" reason line */}
            <div style={{ fontSize: "9px", color: item.source === "llm_theme" ? T.purple : T.muted, marginTop: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.85 }}>
              {whyAdded(item)}
            </div>
          </div>

          {q ? (
            <div style={{ textAlign: "right", marginRight: "4px" }}>
              <div style={{ fontSize: "12px", fontWeight: 600, color: T.text }}>${q.price.toFixed(2)}</div>
              <div style={{ fontSize: "10px", color: q.changePct >= 0 ? T.green : T.red, fontWeight: 600 }}>
                {q.changePct >= 0 ? "+" : ""}{q.changePct.toFixed(2)}%
              </div>
            </div>
          ) : (
            <div style={{ width: "50px" }} />
          )}

          <button
            onClick={e => { e.stopPropagation(); setExpanded(isExpanded ? null : item.id); }}
            style={{ background: "none", border: "none", color: isExpanded ? T.accent : T.muted, cursor: "pointer", fontSize: "11px", padding: "0 2px" }}
            title="Settings"
          >⚙</button>
          <button
            onClick={e => { e.stopPropagation(); removeItem(item.symbol); }}
            style={{ background: "none", border: "none", color: T.muted, cursor: "pointer", fontSize: "14px", padding: "0 2px" }}
            title="Remove"
          >×</button>
        </div>

        {/* Expanded settings */}
        {isExpanded && (
          <div style={{ padding: "0 12px 10px 12px", background: T.surface, borderTop: `1px solid ${T.border}22` }}>
            <div style={{ fontSize: "10px", color: T.textSub, lineHeight: "1.6", marginTop: "6px", marginBottom: "8px" }}>
              {item.source === "llm_theme" || item.auto_added
                ? `AI Scout added via "${item.theme}" theme. `
                : item.source === "briefing"
                ? "Added from morning/evening briefing. "
                : "Manually added. "}
              {item.research_enabled
                ? "Included in daily agent research → gets signal score → PaperTrader can act if score ≥60."
                : "Research off — agent won't score this symbol."}
            </div>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
              <Toggle on={item.research_enabled} label="Research" onChange={v => toggle(item.symbol, "research_enabled", v)} />
              <Toggle on={item.alert_on_signal} label="Signal alert" onChange={v => toggle(item.symbol, "alert_on_signal", v)} />
              <Toggle on={item.alert_on_earnings} label="Earnings alert" onChange={v => toggle(item.symbol, "alert_on_earnings", v)} />
            </div>
            {item.reason && (
              <div style={{ marginTop: "8px", fontSize: "10px", color: T.muted, fontStyle: "italic" }}>
                Why: {item.reason}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", overflow: "hidden" }}>
      <div style={{ padding: "14px 16px 12px", borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <div>
            <div style={{ fontSize: "10px", fontWeight: 700, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
              Watchlist
            </div>
            <div style={{ fontSize: "11px", color: T.muted, marginTop: "2px" }}>
              {items.length} tracked · {items.filter(i => i.research_enabled).length} researched daily · tap ⚙ to configure each
            </div>
          </div>
        </div>

        {/* Callout: what adding means */}
        <div style={{ background: `${T.accent}10`, border: `1px solid ${T.accent}22`, borderRadius: "6px", padding: "8px 10px", marginBottom: "10px", fontSize: "10px", color: T.textSub, lineHeight: "1.6" }}>
          <span style={{ color: T.accent, fontWeight: 700 }}>Adding a symbol:</span>{" "}
          ResearchAgent scores it tomorrow 9 AM → signal appears in Intelligence → PaperTrader acts if score ≥60.
          AI Scout also auto-adds symbols from daily market themes (purple).
        </div>

        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <div style={{ flex: 1, position: "relative", minWidth: "160px" }}>
            <input
              value={newSymbol}
              onChange={e => { setNewSymbol(e.target.value.toUpperCase()); setShowSuggestions(true); if (addError) setAddError(""); }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              onKeyDown={e => e.key === "Enter" && addManual()}
              placeholder="Add ticker (e.g. NVDA)…"
              style={{
                width: "100%", boxSizing: "border-box", background: T.dim, border: `1px solid ${T.border}`,
                borderRadius: "6px", color: T.text, padding: "6px 10px", fontSize: "12px", outline: "none",
              }}
            />
            {showSuggestions && suggestions.length > 0 && (
              <div style={{
                position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 50,
                background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px",
                overflow: "hidden", boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
              }}>
                {suggestions.map(s => (
                  <div
                    key={`${s.symbol}-${s.exchange}`}
                    onMouseDown={e => { e.preventDefault(); addSymbol(s.symbol, "manual"); }}
                    style={{
                      display: "flex", alignItems: "center", gap: "8px", padding: "7px 10px",
                      cursor: "pointer", borderBottom: `1px solid ${T.border}22`,
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = T.surface)}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                  >
                    <span style={{ fontSize: "12px", fontWeight: 700, color: T.text, minWidth: "46px" }}>{s.symbol}</span>
                    <span style={{ fontSize: "11px", color: T.textSub, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.name || "—"}
                    </span>
                    {s.exchange && (
                      <span style={{ fontSize: "9px", fontWeight: 700, color: T.muted, background: T.surface, padding: "1px 5px", borderRadius: "3px", whiteSpace: "nowrap" }}>
                        {s.exchange}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={addManual}
            disabled={adding || !newSymbol}
            style={{
              background: T.accentBg, border: `1px solid ${T.accent}44`, color: T.accent,
              borderRadius: "6px", padding: "6px 14px", fontSize: "12px", cursor: "pointer",
              fontWeight: 600, opacity: adding || !newSymbol ? 0.5 : 1,
            }}
          >
            {adding ? "…" : "Add"}
          </button>
          <button
            onClick={() => { setShowCsvModal(true); setCsvText(""); setCsvParsed([]); }}
            title="Import TradingView CSV or symbol list"
            style={{
              background: T.dim, border: `1px solid ${T.border}`, color: T.muted,
              borderRadius: "6px", padding: "6px 10px", fontSize: "12px", cursor: "pointer",
              fontWeight: 600, whiteSpace: "nowrap",
            }}
          >
            📥 Import CSV
          </button>
        </div>

        {/* Add error (e.g. market mismatch) */}
        {addError && (
          <div style={{ marginTop: "8px", fontSize: "11px", color: T.red, background: `${T.red}12`, border: `1px solid ${T.red}33`, borderRadius: "6px", padding: "7px 10px", lineHeight: "1.5" }}>
            {addError}
          </div>
        )}

        {/* Multi-market note */}
        <div style={{ fontSize: "9px", color: T.muted, marginTop: "6px", lineHeight: "1.5" }}>
          US symbols fully supported. For India (NSE) names, add the <code>.NS</code> suffix — e.g. <code>RELIANCE.NS</code> — so it's tracked as India; a bare ticker is treated as US regardless of the market switch.
        </div>

        {/* Filter + search bar */}
        <div style={{ marginTop: "10px", display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search symbols…"
            style={{
              background: T.dim, border: `1px solid ${T.border}`, borderRadius: "6px",
              color: T.text, padding: "5px 10px", fontSize: "12px", outline: "none", width: "150px",
            }}
          />

          {/* All chip */}
          <button
            onClick={() => setSourceFilter("all")}
            style={{
              background: sourceFilter === "all" ? `${T.accent}22` : "transparent",
              border: `1px solid ${sourceFilter === "all" ? T.accent : T.border}`,
              color: sourceFilter === "all" ? T.accent : T.muted,
              borderRadius: "5px", padding: "3px 9px", fontSize: "10px", fontWeight: 700, cursor: "pointer",
            }}
          >All</button>

          {/* Per-source chips — only sources present in items */}
          {availableSources.map(src => {
            const meta = SOURCE_META[src] ?? SOURCE_META.manual;
            const active = sourceFilter === src;
            return (
              <button
                key={src}
                onClick={() => setSourceFilter(active ? "all" : src)}
                style={{
                  background: active ? `${meta.color}22` : "transparent",
                  border: `1px solid ${active ? meta.color + "88" : T.border}`,
                  color: active ? meta.color : T.muted,
                  borderRadius: "5px", padding: "3px 9px", fontSize: "10px", fontWeight: 700, cursor: "pointer",
                }}
              >{meta.label}</button>
            );
          })}

          {/* Research ON toggle chip */}
          <button
            onClick={() => setResearchFilter(r => !r)}
            style={{
              background: researchFilter ? `${T.green}18` : "transparent",
              border: `1px solid ${researchFilter ? T.green + "55" : T.border}`,
              color: researchFilter ? T.green : T.muted,
              borderRadius: "5px", padding: "3px 9px", fontSize: "10px", fontWeight: 700, cursor: "pointer",
            }}
          >Research ON</button>

          {/* Sort dropdown */}
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value as "date" | "symbol" | "price")}
            style={{
              background: T.dim, border: `1px solid ${T.border}`, borderRadius: "5px",
              color: T.muted, padding: "3px 8px", fontSize: "10px", cursor: "pointer", marginLeft: "auto",
            }}
          >
            <option value="date">Sort: Recent</option>
            <option value="symbol">Sort: A–Z</option>
            <option value="price">Sort: % Change</option>
          </select>
        </div>

        {/* Result count (only shown when a filter is active) */}
        {(search || sourceFilter !== "all" || researchFilter) && (
          <div style={{ fontSize: "11px", color: T.muted, marginTop: "6px" }}>
            {filteredItems.length} of {items.length} symbols
          </div>
        )}
      </div>

      {loading ? (
        <div style={{ color: T.muted, fontSize: "12px", textAlign: "center", padding: "24px" }}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ color: T.muted, fontSize: "12px", textAlign: "center", padding: "24px" }}>
          No symbols yet. Add one above or AI Scout will populate this daily.
        </div>
      ) : filteredItems.length === 0 ? (
        <div style={{ color: T.muted, fontSize: "12px", textAlign: "center", padding: "24px" }}>
          No symbols match the current filters.
        </div>
      ) : (
        <div>
          {[...themeGroups.entries()].map(([theme, stocks]) => (
            <div key={theme}>
              <div style={{ padding: "5px 12px", background: `${T.purple}10`, borderBottom: `1px solid ${T.border}22`, display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "9px", fontWeight: 700, color: T.purple, background: `${T.purple}22`, padding: "1px 6px", borderRadius: "3px" }}>AI SCOUT</span>
                <span style={{ fontSize: "11px", fontWeight: 600, color: T.text }}>{theme}</span>
                {stocks[0]?.expires_at && (
                  <span style={{ fontSize: "9px", color: T.muted, marginLeft: "auto" }}>
                    expires {new Date(stocks[0].expires_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </span>
                )}
              </div>
              {stocks.map(renderItem)}
            </div>
          ))}
          {other.length > 0 && (
            <div>
              {themed.length > 0 && (
                <div style={{ padding: "5px 12px", borderBottom: `1px solid ${T.border}22`, borderTop: `1px solid ${T.border}` }}>
                  <span style={{ fontSize: "9px", fontWeight: 700, color: T.muted }}>MANUALLY ADDED</span>
                </div>
              )}
              {other.map(renderItem)}
            </div>
          )}
        </div>
      )}

      {/* CSV Import Modal */}
      {showCsvModal && (
        <div
          onClick={e => { if (e.target === e.currentTarget && !csvImporting) { setShowCsvModal(false); setCsvText(""); setCsvParsed([]); } }}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div style={{
            background: T.card, border: `1px solid ${T.border}`, borderRadius: "14px",
            padding: "16px", width: "420px", maxWidth: "95vw", display: "flex", flexDirection: "column", gap: "14px",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: "14px", color: T.text }}>Import TradingView Watchlist</div>
                <div style={{ fontSize: "11px", color: T.muted, marginTop: "3px" }}>
                  Paste CSV export or one symbol per line. Exchange prefixes (NASDAQ:CRNT) are stripped automatically.
                </div>
              </div>
              {!csvImporting && (
                <button
                  onClick={() => { setShowCsvModal(false); setCsvText(""); setCsvParsed([]); }}
                  style={{ background: "none", border: "none", color: T.muted, cursor: "pointer", fontSize: "18px", padding: "0 0 0 8px", lineHeight: 1 }}
                >×</button>
              )}
            </div>

            <textarea
              value={csvText}
              onChange={e => { setCsvText(e.target.value); setCsvParsed(parseCsvSymbols(e.target.value)); }}
              placeholder={"NASDAQ:NVDA,NVIDIA Corp\nNYSE:AMD,Advanced Micro Devices\nCRNT\nAAPL"}
              rows={6}
              disabled={csvImporting}
              style={{
                background: T.dim, border: `1px solid ${T.border}`, borderRadius: "8px",
                color: T.text, padding: "10px 12px", fontSize: "12px", outline: "none",
                resize: "vertical", fontFamily: "monospace", opacity: csvImporting ? 0.5 : 1,
              }}
            />

            {/* Preview */}
            {csvParsed.length > 0 && (
              <div>
                <div style={{ fontSize: "11px", color: T.muted, marginBottom: "6px" }}>
                  {csvParsed.length} symbol{csvParsed.length !== 1 ? "s" : ""} parsed:
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
                  {csvParsed.map(sym => (
                    <span key={sym} style={{
                      fontSize: "11px", fontWeight: 700, color: T.blue, background: `${T.blue}18`,
                      border: `1px solid ${T.blue}33`, borderRadius: "4px", padding: "2px 7px",
                    }}>{sym}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Progress bar */}
            {csvImporting && (
              <div>
                <div style={{ fontSize: "11px", color: T.muted, marginBottom: "5px" }}>
                  Importing {csvParsed.length} symbols… {csvProgress}/{csvParsed.length} done
                </div>
                <div style={{ height: "4px", background: T.border, borderRadius: "2px" }}>
                  <div style={{
                    height: "4px", borderRadius: "2px", background: T.accent,
                    width: `${csvParsed.length > 0 ? (csvProgress / csvParsed.length) * 100 : 0}%`,
                    transition: "width 0.2s",
                  }} />
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              {!csvImporting && (
                <button
                  onClick={() => { setShowCsvModal(false); setCsvText(""); setCsvParsed([]); }}
                  style={{
                    background: "transparent", border: `1px solid ${T.border}`, color: T.muted,
                    borderRadius: "7px", padding: "8px 16px", fontSize: "12px", cursor: "pointer", fontWeight: 600,
                  }}
                >Cancel</button>
              )}
              <button
                onClick={importCsv}
                disabled={csvParsed.length === 0 || csvImporting}
                style={{
                  background: csvParsed.length === 0 || csvImporting ? T.border : T.accent,
                  border: "none", color: csvParsed.length === 0 || csvImporting ? T.muted : "#fff",
                  borderRadius: "7px", padding: "8px 20px", fontSize: "12px", cursor: csvParsed.length === 0 || csvImporting ? "not-allowed" : "pointer",
                  fontWeight: 600,
                }}
              >
                {csvImporting ? `Importing… ${csvProgress}/${csvParsed.length}` : `Import ${csvParsed.length > 0 ? csvParsed.length + " Symbols" : ""}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
