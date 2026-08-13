"use client";

import React, { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useMarket } from "@/lib/market-context";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, ReferenceLine,
} from "recharts";

// ── Palette ──────────────────────────────────────────────────────────────────

const T = {
  bg: "#0D0F1A", card: "#12141F", border: "#1E2030",
  text: "#E2E8F0", muted: "#64748B", accent: "#6366F1",
  green: "#22C55E", red: "#EF4444", yellow: "#EAB308",
};

const LINE_COLORS = [
  "#6366F1","#22C55E","#EAB308","#EF4444","#3B82F6",
  "#A855F7","#F97316","#06B6D4","#EC4899","#84CC16",
];

// ── Chart grouping: same-scale indicators share one panel ─────────────────────

const CHART_GROUPS = [
  {
    id: "scores", label: "Scores (0–100)",
    keys: ["analyst_score","fundamental_score","technical_score","sentiment_score","macro_score","insider_score"],
    pct: false, yDomain: [0, 100] as [number,number],
  },
  {
    id: "price",  label: "Price",
    keys: ["price"],
    pct: false,
  },
  {
    id: "pct",    label: "Margins & Yields (%)",
    keys: ["ReturnOnEquityTTM","GrossMarginTTM","FCFYield","QuarterlyRevenueGrowthYOY","ProfitMargin"],
    pct: true,
  },
  {
    id: "ratio",  label: "Valuation Ratios",
    keys: ["PERatio","PEGRatio","DebtToEquity"],
    pct: false,
  },
  {
    id: "eps",    label: "EPS",
    keys: ["EPS"],
    pct: false,
  },
];

// ── Indicator defs ────────────────────────────────────────────────────────────

const INDICATOR_DEFS = [
  { key: "analyst_score",     label: "Analyst Score",  group: "scores" },
  { key: "fundamental_score", label: "F-Score",        group: "scores" },
  { key: "technical_score",   label: "T-Score",        group: "scores" },
  { key: "sentiment_score",   label: "S-Score",        group: "scores" },
  { key: "macro_score",       label: "M-Score",        group: "scores" },
  { key: "insider_score",     label: "I-Score",        group: "scores" },
  { key: "price",             label: "Price",          group: "price"  },
  { key: "PERatio",           label: "P/E",            group: "ratio"  },
  { key: "PEGRatio",          label: "PEG",            group: "ratio"  },
  { key: "ReturnOnEquityTTM", label: "ROE",            group: "pct", pct: true },
  { key: "GrossMarginTTM",    label: "Gross Margin",   group: "pct", pct: true },
  { key: "FCFYield",          label: "FCF Yield",      group: "pct", pct: true },
  { key: "DebtToEquity",      label: "D/E",            group: "ratio"  },
  { key: "QuarterlyRevenueGrowthYOY", label: "Rev Growth", group: "pct", pct: true },
  { key: "ProfitMargin",      label: "Profit Margin",  group: "pct", pct: true },
  { key: "EPS",               label: "EPS",            group: "eps"    },
];
const IND_BY_KEY = Object.fromEntries(INDICATOR_DEFS.map(d => [d.key, d]));

// ── Table column defs ─────────────────────────────────────────────────────────

interface ColDef {
  key: string; label: string; csvLabel?: string; width: number;
  pct?: boolean; score?: boolean; tooltip: string; defaultHidden?: boolean;
  // "breakdown" means: value is in the immutable per-run domain breakdown.
  // "breakdown_source" names which object
  breakdownSource?: "fundamental" | "technical" | "sentiment" | "macro";
  breakdownField?: string;  // field name inside the breakdown object
  boolField?: boolean;      // render as ✓/✗
  formulaKey?: string;      // score column formula key — shows formula panel button
  derived?: boolean;        // computed from row data (not stored in any field)
}

// ── Score formulas — displayed in persistent panel ────────────────────────────

const SCORE_FORMULAS: Record<string, { title: string; text: string }> = {
  analyst_score: {
    title: "Analyst Score (composite)",
    text: `Weighted sum of available F + T + S + M + I scores using champion genome weights.
Weights are learned from closed-trade outcomes by LearnerAgent (weekly batch).
Default weights: F=0.30, T=0.25, S=0.20, M=0.15, I=0.10.
Unavailable or inapplicable dimensions are excluded and the remaining weights are renormalized.`,
  },
  fundamental_score: {
    title: "Fundamental Score (F-Score)",
    text: `Base: 50 pts

SCORING COMPONENTS (these move the score):
• P/E vs sector median — sector-relative:
   ratio < 0.7 → +18, < 1.0 → +8, < 1.4 → −3, < 2.0 → −12, ≥ 2.0 → −22
   (omitted entirely when the sector is unmapped or P/E is non-positive)
• Profit Margin:
   > 20% → +20, > 10% → +10, < 0% → −20
• ROE:
   > 20% → +15, > 10% → +8, < 0% → −10
• EPS (sign only):
   > 0 → +5, ≤ 0 → −10
• Revenue Growth YoY:
   > 20% → +15, > 10% → +8, < 0% → −10

MEASURE-ONLY (recorded as evidence, contribute ZERO points):
• FCF Yield
• Debt/Equity
• Gross Margin
• PEG Ratio
• 52-week-high proximity

  These were disabled by commit ba20f4ff ("restore score governance"). They are
  still collected and shown in the table, and they are still useful for judging a
  name by eye, but the F-score does not currently use them. Re-enabling any of
  them is a scoring change that needs its own validation.

Score clamped to [0, 100]. ETFs and symbols with no fundamentals return a
neutral 55 baseline with low confidence, not a computed score.`,
  },
  technical_score: {
    title: "Technical Score (T-Score)",
    text: `Base: 50 pts
ACTIVE: continuous RSI(14), price vs EMA20, price vs EMA50, 20-session trend, and direction-confirming volume.
BREAKDOWN VETO: a >=2.5 ATR down move, or a <=-7% drop on >=1.5x volume, caps the score at 20.
MEASURE-ONLY: EMA200, MACD, ADX, and relative strength vs SPY/NIFTY are recorded but contribute zero points until a market-local challenger passes replay and forward-shadow gates.
Score clamped to [0, 100].`,
  },
  sentiment_score: {
    title: "Sentiment Score (S-Score)",
    text: `US sources: StockTwits and GDELT, with Alpha Vantage news only when both free sources fail.
Social evidence is shrunk toward 50 with a 10-message neutral prior; news uses a 5-item prior. When both exist the blend is 40% social and 60% news.
No resolved evidence means unavailable and the dimension is excluded. India news remains shadow-only, so India sentiment is inapplicable to the active score.`,
  },
  macro_score: {
    title: "Macro Score (M-Score)",
    text: `US only: score = 100 - danger_score from the newest valid weekly MacroSentinel verdict.
A verdict is usable only when it is known, no more than 10 days old, and backed by at least 3 real US macro indicators.
India FII/DII and event evidence is advisory/shadow-only. India macro is inapplicable to the active score and its weight is renormalized away.`,
  },
  insider_score: {
    title: "Insider Score (I-Score)",
    text: `US equities only: open-market purchases and sales over 90 days. Requires at least 3 qualifying transactions. Awards, exercises, gifts and tax withholding are excluded.
ETFs, India symbols, ADRs and unresolved feeds are inapplicable or unavailable and their weight is renormalized away.`,
  },
};

const ALL_COLS: ColDef[] = [
  // ── Core identity ────────────────────────────────────────────────────────
  { key: "run_date",   label: "Date",      csvLabel: "Research Date",          width: 86,  tooltip: "Exact date and time this research run was executed" },
  { key: "symbol",     label: "Symbol",    csvLabel: "Ticker Symbol",          width: 90,  tooltip: "Ticker — click to open deep dive" },
  { key: "Name",       label: "Name",      csvLabel: "Company Name",           width: 160, defaultHidden: true, tooltip: "Company full name" },
  { key: "Sector",     label: "Sector",    csvLabel: "Sector",                 width: 110, defaultHidden: true, tooltip: "Sector from provider taxonomy" },
  { key: "Industry",   label: "Industry",  csvLabel: "Industry",               width: 150, defaultHidden: true,
    tooltip: "Industry within the sector (e.g. Oil & Gas Integrated vs Refining & Marketing vs E&P). Sourced from Yahoo assetProfile — Finnhub exposes no separate industry, so US rows only carry this after the provider fill." },
  { key: "market",     label: "Mkt",       csvLabel: "Market",                 width: 42,  tooltip: "Market: 🇺🇸 US (NYSE/Nasdaq) or 🇮🇳 India (NSE)" },
  { key: "direction",  label: "Dir",       csvLabel: "Signal Direction",       width: 58,  tooltip: "Signal direction: LONG / NEUTRAL / SHORT from this research run" },

  // ── Composite scores ─────────────────────────────────────────────────────
  { key: "analyst_score",     label: "Score", csvLabel: "Analyst Score (0-100)",     width: 54, score: true, formulaKey: "analyst_score",
    tooltip: "Composite analyst score (0–100). Click ⓘ for formula." },
  { key: "fundamental_score", label: "F",   csvLabel: "Fundamental Score (0-100)", width: 42, score: true, formulaKey: "fundamental_score",
    tooltip: "Fundamental score (0–100). Click ⓘ for full formula breakdown." },
  { key: "technical_score",   label: "T",   csvLabel: "Technical Score (0-100)",    width: 42, score: true, formulaKey: "technical_score",
    tooltip: "Technical score (0–100). Click ⓘ for formula." },
  { key: "sentiment_score",   label: "S",   csvLabel: "Sentiment Score (0-100)",    width: 42, score: true, formulaKey: "sentiment_score",
    tooltip: "Sentiment score (0–100). Click ⓘ for formula." },
  { key: "macro_score",       label: "M",   csvLabel: "Macro Score (0-100)",        width: 42, score: true, formulaKey: "macro_score",
    tooltip: "Macro score (0–100). Click ⓘ for formula." },
  { key: "insider_score",     label: "I",   csvLabel: "Insider Score (0-100)",      width: 42, score: true, formulaKey: "insider_score",
    tooltip: "Insider score (0-100). Click for formula and applicability rules." },

  // ── Trade column ─────────────────────────────────────────────────────────
  { key: "last_trade_side", label: "Trade", csvLabel: "Last Trade Side", width: 60,
    tooltip: "Last paper trade executed for this symbol: BUY (entry) or SELL (exit). Shows score at time of trade in parentheses." },

  // ── Screener bucket (derived) ─────────────────────────────────────────────
  { key: "bucket", label: "Style", csvLabel: "Screener Bucket", width: 72, derived: true,
    tooltip: "Screener bucket: Momentum (RSI>60 + uptrend + rev>10%), Value (cheap P/E + positive FCF), Both, or —. Derived at render time from breakdown data." },

  // ── Price at research ─────────────────────────────────────────────────────
  { key: "price_at_research", label: "Price@R", csvLabel: "Price at Research (close)",
    width: 66, defaultHidden: false,
    tooltip: "Closing price at the time this research run executed (from technical_breakdown.price). Available for runs after 2026-08-10.",
    breakdownSource: "technical", breakdownField: "price" },

  // ── Fundamental sub-indicators (inputs to F-Score) ────────────────────────
  { key: "fund_status", label: "Status", csvLabel: "Fundamental Evidence Status", width: 74, defaultHidden: true,
    tooltip: "Fundamental evidence state for this exact research run.", breakdownSource: "fundamental", breakdownField: "status" },
  { key: "PERatio",           label: "P/E",   csvLabel: "Price-to-Earnings TTM",           width: 56, tooltip: "Price-to-Earnings TTM. Scored sector-relative. Lower vs sector = better.", breakdownSource: "fundamental", breakdownField: "pe_ratio" },
  { key: "PEGRatio",          label: "PEG",   csvLabel: "PEG Ratio",                        width: 50, tooltip: "PEG is measure-only and contributes zero points.", breakdownSource: "fundamental", breakdownField: "peg_ratio" },
  { key: "ReturnOnEquityTTM", label: "ROE",   csvLabel: "Return on Equity TTM (%)",         width: 60, pct: true, tooltip: "Return on Equity TTM.", breakdownSource: "fundamental", breakdownField: "roe" },
  { key: "GrossMarginTTM",    label: "G.Mgn", csvLabel: "Gross Margin TTM (%)",             width: 64, pct: true, tooltip: "Gross margin is measure-only and contributes zero points.", breakdownSource: "fundamental", breakdownField: "gross_margin" },
  { key: "FCFYield",          label: "FCF%",  csvLabel: "Free Cash Flow Yield (%)",         width: 56, pct: true, tooltip: "FCF yield is measure-only and contributes zero points.", breakdownSource: "fundamental", breakdownField: "fcf_yield" },
  { key: "DebtToEquity",      label: "D/E",   csvLabel: "Debt-to-Equity",                   width: 50, tooltip: "Debt/equity is measure-only and contributes zero points.", breakdownSource: "fundamental", breakdownField: "debt_to_equity" },
  { key: "QuarterlyRevenueGrowthYOY", label: "Rev↑", csvLabel: "Revenue Growth YoY (%)", width: 56, pct: true, tooltip: "Quarterly Revenue Growth YoY.", breakdownSource: "fundamental", breakdownField: "revenue_growth_yoy" },
  { key: "ProfitMargin",      label: "N.Mgn", csvLabel: "Net Profit Margin (%)",            width: 60, pct: true, tooltip: "Net Profit Margin.", breakdownSource: "fundamental", breakdownField: "profit_margin" },
  { key: "EPS",               label: "EPS",   csvLabel: "Earnings Per Share TTM",           width: 58, tooltip: "Earnings Per Share TTM.", breakdownSource: "fundamental", breakdownField: "eps" },
  { key: "EpsGrowth3Y",       label: "EPS↑",  csvLabel: "EPS Growth (TTM YoY %)", width: 58, pct: true, defaultHidden: true,
    tooltip: "EPS growth rate YoY TTM; recorded evidence, not an active score input.", breakdownSource: "fundamental", breakdownField: "eps_growth_yoy" },
  { key: "52WeekHigh",        label: "52wH",  csvLabel: "52-Week High",           width: 62, defaultHidden: true,
    tooltip: "52-week high; recorded evidence, not an active score input.", breakdownSource: "fundamental", breakdownField: "high_52_week" },

  // ── Technical sub-indicators (inputs to T-Score) ──────────────────────────
  { key: "tech_status", label: "Status", csvLabel: "Technical Evidence Status", width: 74, defaultHidden: true, tooltip: "Technical evidence state for this exact run.", breakdownSource: "technical", breakdownField: "status" },
  { key: "price_vs_ema20", label: "Px/EMA20", csvLabel: "Price vs EMA20", width: 70, defaultHidden: true, tooltip: "Active technical input: price above/below EMA20.", breakdownSource: "technical", breakdownField: "price_vs_ema20" },
  { key: "price_vs_ema50", label: "Px/EMA50", csvLabel: "Price vs EMA50", width: 70, defaultHidden: true, tooltip: "Active technical input: price above/below EMA50.", breakdownSource: "technical", breakdownField: "price_vs_ema50" },
  { key: "trend_20d", label: "20d Trend", csvLabel: "20-session Trend", width: 68, defaultHidden: true, tooltip: "Active technical input: up, flat, or down over 20 sessions.", breakdownSource: "technical", breakdownField: "trend_20d" },
  { key: "volume_vs_avg20", label: "Vol x", csvLabel: "Volume vs 20-session Average", width: 58, defaultHidden: true, tooltip: "Active direction-confirming volume input.", breakdownSource: "technical", breakdownField: "volume_vs_avg20" },
  { key: "rsi14",           label: "RSI",     csvLabel: "RSI (14-day)",            width: 50, defaultHidden: true,
    tooltip: "RSI (14): momentum oscillator. 40–60 = neutral (+10), >70 = overbought (−5), <30 = oversold (−20).",
    breakdownSource: "technical", breakdownField: "rsi14" },
  { key: "ema20_x_ema50",   label: "EMA fast", csvLabel: "EMA20 > EMA50",          width: 68, defaultHidden: true, boolField: true,
    tooltip: "EMA20 above EMA50 = short-term bullish trend (+8). Below = −8.",
    breakdownSource: "technical", breakdownField: "ema20_above_ema50" },
  { key: "ema50_x_ema200",  label: "EMA slow", csvLabel: "EMA50 > EMA200",         width: 68, defaultHidden: true, boolField: true,
    tooltip: "EMA50 above EMA200 = long-term bullish trend (golden cross, +10). Below = death cross (−10).",
    breakdownSource: "technical", breakdownField: "ema50_above_ema200" },
  { key: "macd_hist",       label: "MACD",    csvLabel: "MACD Histogram",          width: 58, defaultHidden: true,
    tooltip: "MACD histogram. Measure-only: it does not affect the active technical score.",
    breakdownSource: "technical", breakdownField: "macd_histogram" },
  { key: "adx14",           label: "ADX",     csvLabel: "ADX (14-day)",            width: 50, defaultHidden: true,
    tooltip: "ADX (14) trend strength. Measure-only: it does not affect the active technical score.",
    breakdownSource: "technical", breakdownField: "adx14" },
  { key: "rs_vs_bench",     label: "RS",      csvLabel: "RS vs Benchmark (%)",     width: 58, defaultHidden: true, pct: true,
    tooltip: "Relative strength vs SPY (US) or NIFTY (India). Measure-only: it does not affect the active technical score.",
    breakdownSource: "technical", breakdownField: "rs_vs_benchmark" },
  { key: "breakdown_veto",  label: "Veto",    csvLabel: "Breakdown Veto",          width: 44, defaultHidden: true, boolField: true,
    tooltip: "Breakdown veto: ATR crash or extreme vol spike detected → score capped at 20.",
    breakdownSource: "technical", breakdownField: "breakdown_veto" },

  // ── Sentiment sub-indicators (inputs to S-Score) ──────────────────────────
  { key: "sent_status", label: "Status", csvLabel: "Sentiment Evidence Status", width: 74, defaultHidden: true, tooltip: "Sentiment evidence state for this exact run.", breakdownSource: "sentiment", breakdownField: "status" },
  { key: "bullish_pct",     label: "Bull%",  csvLabel: "Bullish % (StockTwits)",  width: 52, defaultHidden: true, pct: true,
    tooltip: "Bullish % from StockTwits (or similar). >65% = positive sentiment, <35% = negative.",
    breakdownSource: "sentiment", breakdownField: "bullish_pct" },
  { key: "bearish_pct",     label: "Bear%",  csvLabel: "Bearish % (StockTwits)",  width: 52, defaultHidden: true, pct: true,
    tooltip: "Bearish % from StockTwits. 100% − bullish − neutral.",
    breakdownSource: "sentiment", breakdownField: "bearish_pct" },
  { key: "sent_sample",     label: "#Posts", csvLabel: "Sentiment Sample Size",   width: 52, defaultHidden: true,
    tooltip: "Number of posts/messages sampled for sentiment. <10 = low confidence.",
    breakdownSource: "sentiment", breakdownField: "sample_size" },
  { key: "sent_source",     label: "S.Src",  csvLabel: "Sentiment Source",        width: 70, defaultHidden: true,
    tooltip: "Sentiment data source (stocktwits, gdelt, finnhub, etc.).",
    breakdownSource: "sentiment", breakdownField: "source" },

  // ── Macro sub-indicators (inputs to M-Score) ──────────────────────────────
  { key: "macro_status", label: "Status", csvLabel: "Macro Evidence Status", width: 74, defaultHidden: true, tooltip: "Macro evidence state for this exact run.", breakdownSource: "macro", breakdownField: "status" },
  { key: "macro_regime",    label: "Regime", csvLabel: "Macro Regime",            width: 64, defaultHidden: true,
    tooltip: "Macro regime at time of research: bull / bear / neutral. Bull → +20, Bear → −30.",
    breakdownSource: "macro", breakdownField: "regime" },
  { key: "macro_danger",    label: "Danger", csvLabel: "Macro Danger Score",      width: 56, defaultHidden: true,
    tooltip: "Macro danger score (0–100). ≥70 → −25, ≥40 → −10 applied to macro score.",
    breakdownSource: "macro", breakdownField: "danger_score" },
  { key: "macro_week_of",   label: "M.AsOf", csvLabel: "Macro Regime As-Of",      width: 84, defaultHidden: true,
    tooltip: "Week the macro regime snapshot was captured (evidence field `as_of`).",
    breakdownSource: "macro", breakdownField: "as_of" },
];

const COL_BY_KEY = Object.fromEntries(ALL_COLS.map(c => [c.key, c]));

// ── Types ─────────────────────────────────────────────────────────────────────

interface LastTrade { side: string; date: string; exit_at: string | null; analyst_score: number | null; venue?: "paper" | "live" }

interface SymbolRow {
  symbol: string; market: string; analyst_score: number | null;
  fundamental_score: number | null; technical_score: number | null;
  sentiment_score: number | null; macro_score: number | null; insider_score: number | null;
  direction: string; last_researched_at: string;
  fundamentals: Record<string, string> | null;
  last_trade: LastTrade | null;
  fundamental_breakdown: Record<string, unknown> | null;
  technical_breakdown: Record<string, unknown> | null;
  sentiment_breakdown: Record<string, unknown> | null;
  macro_breakdown: Record<string, unknown> | null;
}

interface TradeMarker { date: string; side: string; type: "entry" | "exit"; analyst_score: number | null }

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtVal(v: string | number | undefined | null, pct = false) {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(v as string);
  if (!isFinite(n)) return "—";
  if (pct) return `${(n * 100).toFixed(1)}%`;
  return n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 })
       : n >= 10 ? n.toFixed(1) : n.toFixed(2);
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toISOString().slice(0, 10);
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function scoreColor(v: number) { return v >= 70 ? T.green : v >= 50 ? T.yellow : T.red; }
function dirColor(d: string)   { return d === "long" ? T.green : d === "short" ? T.red : T.muted; }

// ── Sector-aware thresholds ───────────────────────────────────────────────────
const SECTOR_PROFILES: Record<string, {
  peGood: number; peOk: number; peWarn: number;
  gmGood: number; gmOk: number;
  deHighNormal: boolean; // high D/E is structural (financials, utilities, REITs)
  ctx: string;
}> = {
  "Technology":             { peGood:25, peOk:45, peWarn:70, gmGood:0.65, gmOk:0.45, deHighNormal:false, ctx:"High-growth — valuation premium normal if growth supports it" },
  "Information Technology": { peGood:22, peOk:38, peWarn:60, gmGood:0.50, gmOk:0.35, deHighNormal:false, ctx:"IT services — asset-light, high margins expected" },
  "Healthcare":             { peGood:20, peOk:35, peWarn:55, gmGood:0.55, gmOk:0.35, deHighNormal:false, ctx:"R&D-heavy — margin range wide depending on pharma vs devices vs services" },
  "Energy":                 { peGood:10, peOk:18, peWarn:30, gmGood:0.30, gmOk:0.15, deHighNormal:false, ctx:"Cyclical commodity — low P/E and margins are normal; watch FCF" },
  "Financial Services":     { peGood:12, peOk:20, peWarn:30, gmGood:0.50, gmOk:0.30, deHighNormal:true,  ctx:"Banking/NBFC — D/E is structural; focus on ROE and NIM instead" },
  "Consumer Cyclical":      { peGood:15, peOk:25, peWarn:40, gmGood:0.40, gmOk:0.25, deHighNormal:false, ctx:"Discretionary — margins compress in downturns; evaluate at mid-cycle" },
  "Consumer Defensive":     { peGood:18, peOk:26, peWarn:35, gmGood:0.38, gmOk:0.25, deHighNormal:false, ctx:"Stable demand — moderate margins, predictable cash flow" },
  "Industrials":            { peGood:15, peOk:22, peWarn:35, gmGood:0.30, gmOk:0.18, deHighNormal:false, ctx:"Capital-intensive — lower margins are structurally normal" },
  "Real Estate":            { peGood:20, peOk:38, peWarn:55, gmGood:0.45, gmOk:0.30, deHighNormal:true,  ctx:"REIT — high leverage and P/E structural; evaluate on FFO yield" },
  "Utilities":              { peGood:14, peOk:20, peWarn:28, gmGood:0.30, gmOk:0.18, deHighNormal:true,  ctx:"Regulated monopoly — high D/E and low growth are normal; dividend yield matters" },
  "Communication Services": { peGood:18, peOk:32, peWarn:50, gmGood:0.55, gmOk:0.35, deHighNormal:false, ctx:"Mixed: telcos (low margin) vs digital platforms (high margin)" },
  "Basic Materials":        { peGood:12, peOk:20, peWarn:30, gmGood:0.28, gmOk:0.16, deHighNormal:false, ctx:"Commodity-linked — margins highly cyclical" },
};
const GENERIC_SP = { peGood:15, peOk:25, peWarn:40, gmGood:0.40, gmOk:0.25, deHighNormal:false, ctx:"No sector profile — generic thresholds applied" };

type IndGrade = { color: string; tip: string };
const SCORING = "· Active scoring component";
const MEASURE = "· Measure-only (not scored currently)";

function indicatorGrade(key: string, raw: string | number | null | undefined, sector?: string | null): IndGrade {
  const g  = (color: string, tip: string): IndGrade => ({ color, tip });
  const gn = (tip: string) => g(T.text,  tip);
  const gg = (tip: string) => g(T.green, tip);
  const ga = (tip: string) => g("#f59e0b", tip);
  const gr = (tip: string) => g(T.red,   tip);
  const gm = (tip: string) => g(T.muted, tip);
  const toN = (v: string | number | null | undefined) => {
    if (v == null) return null;
    const n = typeof v === "number" ? v : parseFloat(String(v));
    return isFinite(n) ? n : null;
  };
  const n  = toN(raw);
  const sp = SECTOR_PROFILES[sector ?? ""] ?? null;

  switch (key) {
    // ── Fundamentals ─────────────────────────────────────────────────────────
    case "PERatio": {
      if (n == null) return gm("P/E: no data");
      const t = sp ?? GENERIC_SP;
      const sLine = sp ? `${sector}: good ≤${t.peGood}×, ok ≤${t.peOk}×, high ≤${t.peWarn}× · ${t.ctx}` : `Generic: good ≤${t.peGood}×, ok ≤${t.peOk}×`;
      const tip = `P/E: ${n.toFixed(1)}×\n${sLine}\n${SCORING}`;
      if (n <= 0)       return gr(`P/E: ${n.toFixed(1)} — negative earnings (loss-making)\n${sLine}\n${SCORING}`);
      if (n <= t.peGood) return gg(tip);
      if (n <= t.peOk)   return ga(tip);
      if (n <= t.peWarn) return gr(tip);
      return gr(`P/E: ${n.toFixed(1)}× — well above ${sector ?? "generic"} range (${t.ctx})\n${SCORING}`);
    }
    case "PEGRatio": {
      if (n == null) return gm("PEG: no data");
      const tip = `PEG: ${n.toFixed(2)}\nPEG ≤1 = growth at reasonable price, >2 = expensive growth, <0 = no earnings/growth\n${MEASURE}`;
      if (n <= 0) return gm(`PEG: ${n.toFixed(2)} — negative (no earnings or no growth)\n${MEASURE}`);
      if (n <= 1) return gg(tip); if (n <= 2) return ga(tip); return gr(tip);
    }
    case "ReturnOnEquityTTM": {
      if (n == null) return gm("ROE: no data");
      const pct = `${(n * 100).toFixed(1)}%`;
      const tip = `ROE: ${pct}\n>20% = strong capital efficiency, >10% = acceptable, <0% = destroying value\n${SCORING}`;
      if (n >= 0.20) return gg(tip); if (n >= 0.10) return ga(tip); if (n >= 0) return gn(tip); return gr(tip);
    }
    case "GrossMarginTTM": {
      if (n == null) return gm("Gross Margin: no data");
      const t = sp ?? GENERIC_SP;
      const tip = `Gross Margin: ${(n * 100).toFixed(1)}%\n${sp ? `${sector}: good ≥${(t.gmGood*100).toFixed(0)}%, ok ≥${(t.gmOk*100).toFixed(0)}% · ${t.ctx}` : "Generic thresholds"}\n${MEASURE}`;
      if (n >= t.gmGood) return gg(tip); if (n >= t.gmOk) return ga(tip); if (n >= 0) return gn(tip); return gr(tip);
    }
    case "FCFYield": {
      if (n == null) return gm("FCF Yield: no data");
      const tip = `FCF Yield: ${(n * 100).toFixed(1)}%\n>5% = strong cash generation, 2–5% = healthy, <0% = cash burn\n${MEASURE}`;
      if (n >= 0.05) return gg(tip); if (n >= 0.02) return ga(tip); if (n >= 0) return gn(tip); return gr(tip);
    }
    case "DebtToEquity": {
      if (n == null) return gm("D/E: no data");
      if (sp?.deHighNormal) return gn(`D/E: ${n.toFixed(2)}\nHigh D/E is structural for ${sector} — not a standalone risk signal\nFocus on ROE / NIM instead\n${MEASURE}`);
      const tip = `D/E: ${n.toFixed(2)}\n<0.5 = low leverage, 0.5–1.5 = moderate, 1.5–3 = elevated, >3 = high\n${MEASURE}`;
      if (n <= 0.5) return gg(tip); if (n <= 1.5) return ga(tip); if (n <= 3) return gr(tip); return gr(tip);
    }
    case "ProfitMargin": {
      if (n == null) return gm("Net Profit Margin: no data");
      const thin = ["Consumer Cyclical","Consumer Defensive","Industrials","Basic Materials","Energy"].includes(sector ?? "");
      const tip = `Net Profit Margin: ${(n * 100).toFixed(1)}%\n>20% = strong, >10% = healthy, <0% = loss-making${thin ? `\n${sector}: structurally thin-margin sector` : ""}\n${SCORING}`;
      if (n >= 0.20) return gg(tip); if (n >= 0.10) return ga(tip); if (n >= 0) return gn(tip); return gr(tip);
    }
    case "EPS": {
      if (n == null) return gm("EPS: no data");
      const tip = `EPS: $${n.toFixed(2)}\nPositive EPS → +5 pts; negative → −10 pts\n${SCORING}`;
      return n > 0 ? gg(tip) : gr(tip);
    }
    case "QuarterlyRevenueGrowthYOY": {
      if (n == null) return gm("Revenue Growth YoY: no data");
      const tip = `Revenue Growth YoY: ${(n * 100).toFixed(1)}%\n>20% = strong, >10% = healthy, <0% = contraction\n${SCORING}`;
      if (n >= 0.20) return gg(tip); if (n >= 0.10) return ga(tip); if (n >= 0) return gn(tip); return gr(tip);
    }
    case "EpsGrowth3Y": {
      if (n == null) return gm("EPS Growth: no data");
      const tip = `EPS Growth YoY: ${(n * 100).toFixed(1)}%\n>30% = strong, >10% = healthy, <0% = shrinking earnings\n${MEASURE}`;
      if (n >= 0.30) return gg(tip); if (n >= 0.10) return ga(tip); if (n >= 0) return gn(tip); return gr(tip);
    }
    case "52WeekHigh": {
      if (n == null) return gm("52W High: no data");
      return gn(`52-Week High: $${n.toLocaleString()}\nProximity used for breakout context\n${MEASURE}`);
    }
    // ── Technical ─────────────────────────────────────────────────────────────
    case "rsi14": {
      if (n == null) return gm("RSI(14): no data");
      // Score: 40–60 = neutral momentum (+10), >70 = overbought (−5), <30 = oversold (−20)
      const tip = `RSI(14): ${n.toFixed(1)}\n40–60 = momentum neutral (+10 pts), >70 = overbought (−5), <30 = oversold (−20)\n${SCORING}`;
      if (n >= 40 && n <= 60) return gg(tip);
      if (n > 60 && n <= 70)  return ga(tip);
      if (n > 70)             return ga(`RSI: ${n.toFixed(1)} — overbought territory (−5 pts)\n${SCORING}`);
      if (n >= 30)            return ga(tip);
      return gr(`RSI: ${n.toFixed(1)} — oversold (−20 pts)\n${SCORING}`);
    }
    case "volume_vs_avg20": {
      if (n == null) return gm("Volume vs avg: no data");
      const tip = `Volume: ${n.toFixed(2)}× 20-day avg\n>1.5× = elevated — conviction signal when aligned with trend\n${SCORING}`;
      return n >= 1.5 ? ga(tip) : gn(tip); // context-dependent, not inherently bullish
    }
    case "macd_hist": {
      if (n == null) return gm("MACD Hist: no data");
      const tip = `MACD histogram: ${n.toFixed(4)}\nPositive = bullish momentum, Negative = bearish momentum\n${MEASURE}`;
      return n > 0 ? ga(tip) : n < 0 ? gr(tip) : gn(tip);
    }
    case "adx14": {
      if (n == null) return gm("ADX(14): no data");
      const tip = `ADX(14): ${n.toFixed(1)}\n>25 = strong trend (directional score valid), <20 = weak/choppy\n${MEASURE}`;
      if (n >= 40) return gg(tip); if (n >= 25) return ga(tip); return gn(tip);
    }
    case "rs_vs_bench": {
      if (n == null) return gm("RS vs benchmark: no data");
      const tip = `RS vs SPY/NIFTY: ${(n * 100).toFixed(1)}%\nPositive = outperforming benchmark, Negative = underperforming\n${MEASURE}`;
      if (n >= 0.05) return gg(tip); if (n >= 0) return ga(tip); if (n >= -0.05) return gn(tip); return gr(tip);
    }
    // ── Sentiment ─────────────────────────────────────────────────────────────
    case "bullish_pct": {
      if (n == null) return gm("Bullish %: no data");
      const v = n > 1 ? n / 100 : n; // stored as fraction or percentage
      const tip = `Bullish: ${(v * 100).toFixed(1)}% of tagged messages\n>65% = positive signal (scores positively), <35% = bearish signal\n${SCORING}`;
      if (v >= 0.65) return gg(tip); if (v >= 0.45) return gn(tip); return gr(tip);
    }
    case "bearish_pct": {
      if (n == null) return gm("Bearish %: no data");
      const v = n > 1 ? n / 100 : n;
      const tip = `Bearish: ${(v * 100).toFixed(1)}% of tagged messages\nHigh bearish % → negative sentiment score\n${SCORING}`;
      if (v >= 0.50) return gr(tip); if (v >= 0.35) return ga(tip); return gg(tip);
    }
    case "sent_sample": {
      if (n == null) return gm("Sample size: no data");
      const tip = `Sentiment sample: ${n} tagged posts\n<5 = noise (shrunk to neutral), 5–50 = moderate confidence, >50 = high confidence`;
      if (n >= 50) return gg(tip); if (n >= 5) return ga(tip); return gr(tip);
    }
    // ── Macro ──────────────────────────────────────────────────────────────────
    case "macro_danger": {
      if (n == null) return gm("Macro danger: no data");
      const tip = `Macro danger: ${n.toFixed(0)}/100\n<40 = no penalty, ≥40 → −10 pts, ≥70 → −25 pts\n${SCORING}`;
      if (n < 30) return gg(tip); if (n < 50) return gn(tip); if (n < 70) return ga(tip); return gr(tip);
    }
    default:
      return gn("");
  }
}

type Bucket = "momentum" | "value" | "both";
function deriveBucket(row: SymbolRow): { bucket: Bucket; momPts: number; valPts: number; signals: string[] } {
  const tb = row.technical_breakdown as any;
  const f  = row.fundamentals;
  const sp = SECTOR_PROFILES[f?.Sector ?? ""] ?? GENERIC_SP;

  const rsi   = tb?.rsi14             != null ? Number(tb.rsi14)                           : null;
  const trend = tb?.trend_20d         as string | undefined;
  const ema20 = tb?.price_vs_ema20    as string | undefined;
  const ema50 = tb?.price_vs_ema50    as string | undefined;
  const revG  = f?.QuarterlyRevenueGrowthYOY != null ? parseFloat(f.QuarterlyRevenueGrowthYOY) : null;
  const epsG  = f?.EpsGrowth3Y        != null ? parseFloat(f.EpsGrowth3Y)                  : null;
  const pe    = f?.PERatio            != null ? parseFloat(f.PERatio)                      : null;
  const fcf   = f?.FCFYield           != null ? parseFloat(f.FCFYield)                     : null;
  const roe   = f?.ReturnOnEquityTTM  != null ? parseFloat(f.ReturnOnEquityTTM)            : null;
  const pm    = f?.ProfitMargin       != null ? parseFloat(f.ProfitMargin)                 : null;

  let mom = 0; let val = 0; const sigs: string[] = [];

  // ── Momentum signals ───────────────────────────────────────────────────────
  if (rsi != null) {
    if (rsi > 65)       { mom += 2; sigs.push(`RSI ${rsi.toFixed(0)} (strong)`); }
    else if (rsi > 55)  { mom += 1; sigs.push(`RSI ${rsi.toFixed(0)} (elevated)`); }
    else if (rsi < 40)  { val += 1; sigs.push(`RSI ${rsi.toFixed(0)} (depressed → value lean)`); }
  }
  if (trend === "up")           { mom += 2; sigs.push("uptrend"); }
  else if (trend === "down")    { val += 1; } // pullback can be value
  if (ema50 === "above")        { mom += 1; sigs.push("above 50-EMA"); }
  if (ema20 === "above")        { mom += 1; sigs.push("above 20-EMA"); }
  if (revG != null) {
    if (revG > 0.20)            { mom += 2; sigs.push(`rev↑${(revG*100).toFixed(0)}%`); }
    else if (revG > 0.05)       { mom += 1; sigs.push(`rev↑${(revG*100).toFixed(0)}%`); }
    else if (revG < 0)          { val += 1; } // contracting revenue → value lean
  }
  if (epsG != null && epsG > 0.15) { mom += 1; sigs.push(`EPS↑${(epsG*100).toFixed(0)}%`); }

  // ── Value signals ─────────────────────────────────────────────────────────
  if (pe != null && pe > 0) {
    if (pe <= sp.peGood)        { val += 2; sigs.push(`P/E ${pe.toFixed(1)} (cheap)`); }
    else if (pe <= sp.peOk)     { val += 1; sigs.push(`P/E ${pe.toFixed(1)} (ok)`); }
    else if (pe > sp.peWarn)    { mom += 1; } // expensive P/E = market pricing in growth
  }
  if (fcf != null) {
    if (fcf > 0.05)             { val += 2; sigs.push(`FCF ${(fcf*100).toFixed(1)}%`); }
    else if (fcf > 0.01)        { val += 1; sigs.push(`FCF ${(fcf*100).toFixed(1)}%`); }
  }
  if (roe != null && roe > 0.15)  { val += 1; sigs.push(`ROE ${(roe*100).toFixed(0)}%`); }
  if (pm  != null && pm  > 0.10)  { val += 1; sigs.push(`margin ${(pm*100).toFixed(0)}%`); }

  // ── Always resolve — whichever scored higher wins ─────────────────────────
  // Tie (including 0-0 = no data) → prefer momentum for growth sectors, value otherwise
  const growthSectors = ["Technology","Information Technology","Healthcare","Communication Services"];
  const tieBreak: Bucket = growthSectors.includes(f?.Sector ?? "") ? "momentum" : "value";

  const BOTH_THRESHOLD = 3; // need meaningful signal on BOTH sides to show "Both"
  const bucket: Bucket =
    mom >= BOTH_THRESHOLD && val >= BOTH_THRESHOLD ? "both"
    : mom > val  ? "momentum"
    : val > mom  ? "value"
    : tieBreak;

  return { bucket, momPts: mom, valPts: val, signals: sigs };
}

const BUCKET_META: Record<Bucket, { label: string; color: string }> = {
  momentum: { label: "🚀 Mom",  color: "#818cf8" },
  value:    { label: "💰 Val",  color: "#22c55e" },
  both:     { label: "⚡ Both", color: "#f59e0b" },
};

/** Resolve cell value: score fields → row top-level; breakdown fields → breakdown object; else fundamentals */
function getCell(row: SymbolRow, col: ColDef): string | number | boolean | null {
  if (col.score) return (row as any)[col.key] ?? null;
  // The Trade column is derived, not a row field, so it fell through to the
  // fundamentals lookup and every row compared as null — the column looked
  // unsortable. Sort on the same composite the cell displays: venue, then side,
  // then date, so BUYs group together and are newest-first within the group.
  if (col.key === "last_trade_side") {
    const lt = row.last_trade;
    return lt ? `${lt.venue ?? "paper"}.${lt.side}.${lt.date}` : null;
  }
  // Breakdown fields
  if (col.breakdownSource) {
    const src = col.breakdownSource === "fundamental" ? row.fundamental_breakdown
              : col.breakdownSource === "technical" ? row.technical_breakdown
              : col.breakdownSource === "sentiment" ? row.sentiment_breakdown
              : row.macro_breakdown;
    if (!src) return null;
    return (src as any)[col.breakdownField!] ?? null;
  }
  // Direct row field
  if (col.key in row) return (row as any)[col.key] as any;
  // Fundamentals
  return row.fundamentals?.[col.key] ?? null;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function FundamentalsPage() {
  const router = useRouter();
  // Global US/India switcher in the shell header. This page previously ignored it
  // entirely (the in-page toggle was removed without wiring the global one up),
  // so both markets were always shown regardless of the switcher position.
  const { market: activeMarket, indiaEnabled } = useMarket();

  const [rows, setRows]         = useState<SymbolRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [viewMode, setViewMode] = useState<"latest" | "all_runs">("latest");

  // Table controls
  const [query, setQuery]           = useState("");
  const [sortKey, setSortKey]       = useState("analyst_score");
  const [sortDir, setSortDir]       = useState<"asc" | "desc">("desc");

  // Column management
  const [colOrder,  setColOrder]  = useState<string[]>(ALL_COLS.map(c => c.key));
  const [hiddenSet, setHiddenSet] = useState<Set<string>>(
    new Set(ALL_COLS.filter(c => c.defaultHidden).map(c => c.key))
  );
  const [showColPicker, setShowColPicker] = useState(false);
  const dragFrom = useRef<number | null>(null);

  // Domain tab presets — auto-set visible columns per domain
  const [domainTab, setDomainTab] = useState<"all"|"fundamental"|"technical"|"sentiment"|"macro"|"scores">("all");

  const DOMAIN_PRESETS: Record<string, string[]> = {
    all:         ALL_COLS.filter(c => !c.defaultHidden).map(c => c.key),
    scores:      ["run_date","symbol","market","direction","analyst_score","fundamental_score","technical_score","sentiment_score","macro_score","insider_score"],
    fundamental: ["run_date","symbol","Sector","Industry","market","direction","fundamental_score","fund_status",
                  "PERatio","PEGRatio","ReturnOnEquityTTM","GrossMarginTTM","FCFYield",
                  "DebtToEquity","QuarterlyRevenueGrowthYOY","ProfitMargin","EPS","EpsGrowth3Y","52WeekHigh"],
    technical:   ["run_date","symbol","market","direction","technical_score","tech_status",
                  "price_at_research","rsi14","price_vs_ema20","price_vs_ema50","trend_20d","volume_vs_avg20","ema20_x_ema50","ema50_x_ema200","macd_hist","adx14","rs_vs_bench","breakdown_veto"],
    sentiment:   ["run_date","symbol","market","direction","sentiment_score","sent_status",
                  "bullish_pct","bearish_pct","sent_sample","sent_source"],
    macro:       ["run_date","symbol","market","direction","macro_score","macro_status",
                  "macro_regime","macro_danger","macro_week_of"],
  };

  function applyDomainTab(tab: typeof domainTab) {
    setDomainTab(tab);
    const show = new Set(DOMAIN_PRESETS[tab]);
    setHiddenSet(new Set(ALL_COLS.map(c => c.key).filter(k => !show.has(k))));
  }

  // Backfill
  const [backfilling, setBackfilling] = useState(false);
  const [backfillMsg, setBackfillMsg] = useState("");

  // Forced fundamentals refresh. Pages through batches itself — one request can't
  // cover every symbol because Finnhub pacing (2 calls/symbol at 60/min) would blow
  // past Vercel's 300s request cap.
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState("");

  async function runRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    const scope = indiaEnabled ? activeMarket : "all";
    let offset = 0, updated = 0, unchanged = 0, failed = 0, total: number | null = null;
    const newFieldTally: Record<string, number> = {};
    try {
      for (;;) {
        const res = await fetch(
          `/api/admin/refresh-fundamentals?market=${scope}&limit=40&offset=${offset}`,
          { method: "POST" },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        if (d.error) throw new Error(d.error);
        updated += d.updated ?? 0; unchanged += d.unchanged ?? 0; failed += d.failed ?? 0;
        total = d.total ?? total;
        for (const r of d.results ?? []) {
          for (const f of r.new_fields ?? []) newFieldTally[f] = (newFieldTally[f] ?? 0) + 1;
        }
        const seen = (d.offset ?? offset) + (d.processed ?? 0);
        setRefreshMsg(
          `Refreshing ${scope.toUpperCase()}… ${seen}${total ? "/" + total : ""} symbols · ` +
          `${updated} updated, ${unchanged} unchanged${failed ? `, ${failed} failed` : ""}`
        );
        if (d.done || d.next_offset == null) break;
        offset = d.next_offset;
      }
      const gained = Object.entries(newFieldTally)
        .sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([k, n]) => `${k} +${n}`).join(" · ");
      setRefreshMsg(
        `Refresh done: ${updated} updated, ${unchanged} unchanged${failed ? `, ${failed} failed` : ""}` +
        (gained ? ` — newly populated: ${gained}` : "")
      );
      const d2 = await (await fetch(`/api/research/universe?mode=${viewMode}`)).json();
      setRows(d2.symbols ?? []);
    } catch (e: any) {
      setRefreshMsg(`Refresh failed: ${e?.message ?? "unknown error"}`);
    } finally {
      setRefreshing(false);
    }
  }

  function runBackfill() {
    if (backfilling) return;
    setBackfilling(true);
    setBackfillMsg("Fetching names from Finnhub/Yahoo… (takes ~3 min for 184 symbols)");
    fetch("/api/admin/backfill-names", { method: "POST" })
      .then(r => r.json())
      .then(d => {
        setBackfillMsg(`Done: ${d.updated} updated, ${d.failed} failed out of ${d.total} symbols`);
        setBackfilling(false);
        fetch(`/api/research/universe?mode=${viewMode}`).then(r => r.json()).then(d2 => setRows(d2.symbols ?? []));
      })
      .catch(() => { setBackfillMsg("Backfill failed — check server logs"); setBackfilling(false); });
  }

  // Persistent formula panel
  const [formulaPanel, setFormulaPanel] = useState<string | null>(null); // key of open formula

  // Chart
  const [chartSymbols,     setChartSymbols]     = useState<string[]>([]);
  const [chartIndicators,  setChartIndicators]  = useState<string[]>(["analyst_score","fundamental_score","technical_score"]);
  const [chartDays,        setChartDays]        = useState(365);
  const [showTradeMarkers, setShowTradeMarkers] = useState(true);
  const [chartLoading,     setChartLoading]     = useState(false);
  const [rawSeries, setRawSeries]   = useState<Record<string, Record<string, { date: string; value: number }[]>>>({});
  const [tradeMarkers, setTradeMarkers] = useState<Record<string, TradeMarker[]>>({});

  // Load rows
  useEffect(() => {
    setLoading(true);
    fetch(`/api/research/universe?mode=${viewMode}`)
      .then(r => r.json())
      .then(d => { setRows(d.symbols ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [viewMode]);

  // Load chart data
  useEffect(() => {
    if (!chartSymbols.length || !chartIndicators.length) {
      setRawSeries({}); setTradeMarkers({}); return;
    }
    setChartLoading(true);
    const params = new URLSearchParams({
      symbols: chartSymbols.join(","),
      indicators: chartIndicators.join(","),
      days: String(chartDays),
      include_trades: String(showTradeMarkers),
    });
    fetch(`/api/research/chart-data?${params}`)
      .then(r => r.json())
      .then(d => {
        setRawSeries(d.series ?? {});
        setTradeMarkers(d.trade_markers ?? {});
        setChartLoading(false);
      })
      .catch(() => setChartLoading(false));
  }, [chartSymbols, chartIndicators, chartDays, showTradeMarkers]);

  // Visible + ordered cols
  const visibleCols = colOrder
    .filter(k => {
      if (hiddenSet.has(k)) return false;
      if (viewMode === "all_runs" && k === "last_trade_side") return false;
      return true;
    })
    .map(k => COL_BY_KEY[k]).filter(Boolean);

  // Sort
  function handleSort(key: string) {
    if (sortKey === key) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  // Drag-to-reorder columns
  function onDragStart(i: number) { dragFrom.current = i; }
  function onDragOver(e: React.DragEvent) { e.preventDefault(); }
  function onDrop(toIdx: number) {
    const from = dragFrom.current;
    if (from == null || from === toIdx) return;
    setColOrder(prev => {
      const vis = prev.filter(k => !hiddenSet.has(k));
      const fromKey = vis[from];
      vis.splice(from, 1); vis.splice(toIdx, 0, fromKey);
      return [...vis, ...prev.filter(k => hiddenSet.has(k))];
    });
    dragFrom.current = null;
  }

  function toggleCol(key: string) {
    setHiddenSet(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }

  function toggleChartSymbol(sym: string) {
    setChartSymbols(prev => prev.includes(sym) ? prev.filter(s => s !== sym) : [...prev, sym].slice(0, 10));
  }
  function toggleChartIndicator(ind: string) {
    setChartIndicators(prev => prev.includes(ind) ? prev.filter(s => s !== ind) : [...prev, ind].slice(0, 12));
  }

  // CSV export — ALL rows + ALL columns for the active market. Deliberately
  // ignores the text filter and the column picker (you always get the full
  // dataset), but does respect the global US/India switcher; the market is in
  // the filename so an exported file is never ambiguous about its scope.
  function downloadCSV() {
    const csvCols = ALL_COLS.filter(c => c.key !== "last_trade_side");
    const header = [...csvCols.map(c => c.csvLabel ?? c.label), "Trade Side", "Trade Date"].join(",");
    const csvRows = marketScoped.map(r => {
      const cells = csvCols.map(c => {
        let v: string;
        if (c.key === "run_date")          v = fmtDate(r.last_researched_at);
        else if (c.key === "symbol")       v = r.symbol;
        else if (c.key === "market")       v = r.market;
        else if (c.key === "direction")    v = r.direction ?? "";
        else if (c.score)                  v = String((r as any)[c.key] ?? "");
        else {
          const raw = getCell(r, c);
          v = raw == null ? "" : String(raw);
        }
        return `"${String(v).replace(/"/g,'""')}"`;
      });
      const lt = r.last_trade;
      cells.push(`"${lt ? lt.side.toUpperCase() : ""}"`, `"${lt ? fmtDate(lt.date) : ""}"`);
      return cells.join(",");
    });
    const blob = new Blob([header + "\n" + csvRows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url;
    a.download = `fundamentals-${indiaEnabled ? activeMarket + "-" : ""}${viewMode}-${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  // Filter + sort rows. Market scope comes from the global switcher; when India
  // isn't enabled for the account the switcher is hidden, so show everything
  // rather than silently filtering to an empty table.
  const marketScoped = indiaEnabled ? rows.filter(r => (r.market ?? "us") === activeMarket) : rows;

  const filtered = marketScoped.filter(r => {
    if (!query) return true;
    const q = query.toLowerCase();
    const f = r.fundamentals ?? {};
    const tb = r.technical_breakdown ?? {};
    const fb = r.fundamental_breakdown ?? {};
    const sb = r.sentiment_breakdown ?? {};
    const mb = r.macro_breakdown ?? {};
    const blob = [
      r.symbol, r.market, r.direction,
      fmtDate(r.last_researched_at),
      f.Name, f.Sector,
      String(r.analyst_score), String(r.fundamental_score), String(r.technical_score),
      String(r.sentiment_score), String(r.macro_score), String(r.insider_score),
      ...Object.values(f),
      ...Object.values(fb).map(String),
      ...Object.values(tb).map(String),
      ...Object.values(sb).map(String),
      ...Object.values(mb).map(String),
    ].join(" ").toLowerCase();
    return blob.includes(q);
  }).sort((a, b) => {
    if (sortKey === "last_researched_at" || sortKey === "run_date") {
      const at = new Date(a.last_researched_at).getTime();
      const bt = new Date(b.last_researched_at).getTime();
      return sortDir === "desc" ? bt - at : at - bt;
    }
    const colDef = COL_BY_KEY[sortKey];
    const av = colDef ? getCell(a, colDef) : null;
    const bv = colDef ? getCell(b, colDef) : null;

    // Empty always sinks, in BOTH directions. Previously "" sorted first when
    // ascending, so flipping a sparse column buried the populated rows.
    const aEmpty = av == null || av === "";
    const bEmpty = bv == null || bv === "";
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;

    const an = parseFloat(String(av)), bn = parseFloat(String(bv));
    if (!isNaN(an) && !isNaN(bn)) return sortDir === "desc" ? bn - an : an - bn;
    return sortDir === "desc"
      ? String(bv).localeCompare(String(av))
      : String(av).localeCompare(String(bv));
  });

  // Chart group rendering
  const activeGroups = CHART_GROUPS.map(g => ({
    ...g,
    activeKeys: g.keys.filter(k => chartIndicators.includes(k)),
  })).filter(g => g.activeKeys.length > 0);

  // Column pinning: the leading run of visible columns that are pin-eligible stays
  // frozen on the left while the table scrolls horizontally, so Date/Symbol never
  // scroll out of view on a wide table (or a phone). Only a LEADING run is pinned —
  // if you drag Symbol into the middle it simply stops being sticky, which avoids
  // pinned columns overlapping scrolled ones.
  const PINNABLE = new Set(["run_date", "symbol"]);
  const pinnedLefts = new Map<string, number>();
  {
    let offset = 0;
    for (const col of visibleCols) {
      if (!PINNABLE.has(col.key)) break;
      pinnedLefts.set(col.key, offset);
      offset += col.width;
    }
  }
  const lastPinnedKey = [...pinnedLefts.keys()].pop() ?? null;

  const SortArrow = ({ col }: { col: string }) => (
    <span style={{ fontSize: 8, marginLeft: 2, opacity: sortKey === col ? 1 : 0.25 }}>
      {sortKey === col && sortDir === "asc" ? "▲" : "▼"}
    </span>
  );

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text }} onClick={() => { setShowColPicker(false); }}>

      {/* ── Formula Panel ────────────────────────────────────────────────── */}
      {formulaPanel && SCORE_FORMULAS[formulaPanel] && (
        <div style={{
          position: "fixed", top: 60, right: 20, zIndex: 100, width: 380, maxHeight: "70vh",
          background: T.card, border: `1px solid ${T.accent}`,
          borderRadius: 10, boxShadow: "0 12px 40px #00000099",
          display: "flex", flexDirection: "column", overflow: "hidden",
        }}
          onClick={e => e.stopPropagation()}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "10px 14px", borderBottom: `1px solid ${T.border}`,
            background: `${T.accent}22`,
          }}>
            <span style={{ fontWeight: 700, fontSize: 13, color: T.accent }}>
              {SCORE_FORMULAS[formulaPanel].title}
            </span>
            <button onClick={() => setFormulaPanel(null)}
              style={{ background: "none", border: "none", color: T.muted, fontSize: 16, cursor: "pointer", lineHeight: 1 }}>
              ×
            </button>
          </div>
          <pre style={{
            padding: "12px 14px", fontSize: 11, color: T.text, lineHeight: 1.65,
            overflowY: "auto", margin: 0, fontFamily: "monospace",
            whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}>
            {SCORE_FORMULAS[formulaPanel].text}
          </pre>
          <div style={{ padding: "8px 14px", borderTop: `1px solid ${T.border}`, display: "flex", gap: 8 }}>
            <button
              onClick={() => navigator.clipboard.writeText(SCORE_FORMULAS[formulaPanel!].text)}
              style={{
                padding: "4px 10px", borderRadius: 5, fontSize: 11, cursor: "pointer",
                border: `1px solid ${T.border}`, background: T.bg, color: T.muted,
              }}>
              📋 Copy formula
            </button>
            <div style={{ display: "flex", gap: 4 }}>
              {Object.keys(SCORE_FORMULAS).map(k => (
                <button key={k} onClick={() => setFormulaPanel(k)}
                  style={{
                    padding: "3px 8px", borderRadius: 4, fontSize: 10, cursor: "pointer",
                    border: `1px solid ${formulaPanel === k ? T.accent : T.border}`,
                    background: formulaPanel === k ? `${T.accent}22` : T.bg,
                    color: formulaPanel === k ? T.accent : T.muted,
                  }}>
                  {k.replace("_score","").replace("analyst","total").toUpperCase().slice(0,3)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={{ padding: "18px 20px 0", display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Fundamentals</h1>
          <p style={{ color: T.muted, fontSize: 12, marginTop: 3 }}>
            Research audit log · score formulas · chart any indicator · trade markers
            <span style={{ marginLeft: 8, color: T.yellow }}>· Sort "Date" ↓ to see today&apos;s runs at top</span>
          </p>
          {backfillMsg && <p style={{ fontSize: 11, color: backfilling ? T.yellow : T.green, marginTop: 4 }}>{backfillMsg}</p>}
          {refreshMsg && <p style={{ fontSize: 11, color: refreshing ? T.yellow : T.green, marginTop: 4 }}>{refreshMsg}</p>}
        </div>
        <button onClick={e => { e.stopPropagation(); runRefresh(); }} disabled={refreshing}
          title="Force re-fetch of all fundamentals from Finnhub/Yahoo, bypassing the provider cache. Use after a provider mapping fix. Takes ~2s per US symbol (Finnhub rate limit)."
          style={{
            padding: "7px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: refreshing ? "default" : "pointer",
            border: `1px solid ${refreshing ? T.border : T.green}`, background: T.card,
            color: refreshing ? T.muted : T.green, opacity: refreshing ? 0.6 : 1,
          }}>
          {refreshing ? "⏳ Refreshing…" : "♻ Force Refresh Fundamentals"}
        </button>
        <button onClick={e => { e.stopPropagation(); runBackfill(); }} disabled={backfilling}
          title="Fetch company Name + Sector from Finnhub/Yahoo for all symbols missing it"
          style={{
            padding: "7px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: backfilling ? "default" : "pointer",
            border: `1px solid ${T.border}`, background: T.card, color: backfilling ? T.muted : T.accent,
            opacity: backfilling ? 0.6 : 1,
          }}>
          {backfilling ? "⏳ Backfilling…" : "🔄 Backfill Names"}
        </button>
      </div>

      {/* ══ CHART BUILDER ════════════════════════════════════════════════════ */}
      <div style={{ padding: "16px 20px 0" }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>
          Historical Chart Builder
          <span style={{ fontWeight: 400, fontSize: 11, color: T.muted, marginLeft: 8 }}>
            select symbols from table · pick indicators · same-scale indicators share one panel
          </span>
        </div>

        {/* Indicator pills */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 9, color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 5 }}>
            Indicators — S=Score · P=Price · %=Pct · R=Ratio
          </div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {INDICATOR_DEFS.map(ind => {
              const active = chartIndicators.includes(ind.key);
              const groupColor: Record<string, string> = {
                scores: T.accent, price: "#3B82F6", pct: T.green, ratio: T.yellow, eps: T.muted,
              };
              return (
                <button key={ind.key} onClick={() => toggleChartIndicator(ind.key)}
                  style={{
                    padding: "3px 9px", borderRadius: 10, fontSize: 11, cursor: "pointer",
                    fontWeight: active ? 700 : 400,
                    border: `1px solid ${active ? (groupColor[(ind as any).group] ?? T.border) : T.border}`,
                    background: active ? `${groupColor[(ind as any).group] ?? T.accent}22` : T.card,
                    color: active ? (groupColor[(ind as any).group] ?? T.text) : T.muted,
                  }}>
                  {ind.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Options row */}
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
          {([90, 180, 365, 730, 2000] as const).map(d => (
            <button key={d} onClick={() => setChartDays(d)}
              style={{
                padding: "3px 9px", borderRadius: 5, fontSize: 11, cursor: "pointer",
                border: `1px solid ${chartDays === d ? T.accent : T.border}`,
                background: chartDays === d ? `${T.accent}22` : T.card,
                color: chartDays === d ? T.accent : T.muted,
              }}>
              {d === 90 ? "3M" : d === 180 ? "6M" : d === 365 ? "1Y" : d === 730 ? "2Y" : "All"}
            </button>
          ))}
          <button onClick={() => setShowTradeMarkers(p => !p)}
            style={{
              padding: "3px 9px", borderRadius: 5, fontSize: 11, cursor: "pointer",
              border: `1px solid ${showTradeMarkers ? T.green : T.border}`,
              background: showTradeMarkers ? `${T.green}22` : T.card,
              color: showTradeMarkers ? T.green : T.muted,
            }}>
            📍 Trade markers {showTradeMarkers ? "on" : "off"}
          </button>
        </div>

        {/* Empty state */}
        {!chartSymbols.length && (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "20px", textAlign: "center", color: T.muted, fontSize: 12, marginBottom: 12 }}>
            Click &ldquo;+ Chart&rdquo; on any row in the table below.
          </div>
        )}

        {/* Symbol chips */}
        {chartSymbols.length > 0 && (
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
            {chartSymbols.map((sym, i) => (
              <span key={sym} onClick={() => toggleChartSymbol(sym)}
                style={{
                  background: `${LINE_COLORS[i % LINE_COLORS.length]}22`,
                  border: `1px solid ${LINE_COLORS[i % LINE_COLORS.length]}`,
                  borderRadius: 10, padding: "2px 9px", fontSize: 11, fontWeight: 700,
                  color: LINE_COLORS[i % LINE_COLORS.length], cursor: "pointer",
                }}>
                {sym} ×
              </span>
            ))}
          </div>
        )}

        {/* Charts: one panel per group */}
        {chartSymbols.length > 0 && activeGroups.map(group => {
          const dateMap = new Map<string, Record<string, number>>();
          for (const sym of chartSymbols) {
            for (const ind of group.activeKeys) {
              for (const { date, value } of rawSeries[sym]?.[ind] ?? []) {
                if (!dateMap.has(date)) dateMap.set(date, { date: date as any });
                dateMap.get(date)![`${sym}:${ind}`] = value;
              }
            }
          }
          const data = [...dateMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([,v]) => v);
          const allMarkers: (TradeMarker & { sym: string })[] = chartSymbols.flatMap(sym =>
            (tradeMarkers[sym] ?? []).map(m => ({ ...m, sym }))
          );
          if (!data.length && !chartLoading) return null;
          const lineKeys = chartSymbols.flatMap((sym, si) =>
            group.activeKeys.map((ind, ii) => ({
              key: `${sym}:${ind}`,
              label: group.activeKeys.length > 1 ? `${sym} ${IND_BY_KEY[ind]?.label ?? ind}` : sym,
              color: LINE_COLORS[(si * 3 + ii) % LINE_COLORS.length],
            }))
          );
          return (
            <div key={group.id} style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 5 }}>
                {group.label}
                <span style={{ fontSize: 9, marginLeft: 6, color: T.muted }}>
                  {group.activeKeys.map(k => IND_BY_KEY[k]?.label ?? k).join(" · ")}
                </span>
              </div>
              <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 4px 4px" }}>
                {chartLoading ? (
                  <div style={{ height: 180, display: "flex", alignItems: "center", justifyContent: "center", color: T.muted, fontSize: 11 }}>
                    Loading…
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={180}>
                    <LineChart data={data} margin={{ top: 4, right: 12, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
                      <XAxis dataKey="date" tick={{ fontSize: 9, fill: T.muted }}
                        tickFormatter={d => d.slice(5)} minTickGap={40} />
                      <YAxis tick={{ fontSize: 9, fill: T.muted }} width={36}
                        domain={group.yDomain}
                        tickFormatter={v => group.pct ? `${(v*100).toFixed(0)}%` : String(Number(v).toFixed(0))} />
                      <Tooltip
                        contentStyle={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, fontSize: 11 }}
                        formatter={(v: any, name: string) => {
                          const isPct = group.pct;
                          return [isPct ? `${(Number(v)*100).toFixed(1)}%` : Number(v).toFixed(2), name];
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: 10 }} />
                      {lineKeys.map(({ key, label, color }) => (
                        <Line key={key} dataKey={key} name={label} stroke={color}
                          dot={false} strokeWidth={1.5} connectNulls activeDot={{ r: 3 }} />
                      ))}
                      {showTradeMarkers && allMarkers.map((m, i) => (
                        <ReferenceLine key={i} x={m.date}
                          stroke={m.type === "entry" && m.side === "buy" ? T.green
                               : m.type === "exit" ? T.red : T.yellow}
                          strokeDasharray="4 2" strokeWidth={1.5}
                          label={{ value: m.side === "buy" ? "B" : "S", position: "top", fontSize: 8,
                            fill: m.side === "buy" ? T.green : T.red }}
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ══ TABLE ════════════════════════════════════════════════════════════ */}

      {/* Domain tabs */}
      <div style={{ padding: "12px 20px 0", display: "flex", gap: 4, flexWrap: "wrap" }}>
        {([
          { id: "all",         label: "All" },
          { id: "scores",      label: "📊 Scores" },
          { id: "fundamental", label: "📈 Fundamental" },
          { id: "technical",   label: "⚡ Technical" },
          { id: "sentiment",   label: "💬 Sentiment" },
          { id: "macro",       label: "🌐 Macro" },
        ] as const).map(tab => (
          <button key={tab.id} onClick={() => applyDomainTab(tab.id)}
            style={{
              padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer",
              border: `1px solid ${domainTab === tab.id ? T.accent : T.border}`,
              background: domainTab === tab.id ? `${T.accent}22` : T.card,
              color: domainTab === tab.id ? T.accent : T.muted,
            }}>
            {tab.label}
          </button>
        ))}
        {(domainTab === "technical" || domainTab === "sentiment" || domainTab === "macro") && (
          <span style={{ fontSize: 10, color: T.muted, alignSelf: "center", marginLeft: 4 }}>
            ℹ Sub-indicator columns populate for runs after 2026-08-10 (when we started storing breakdowns)
          </span>
        )}
      </div>

      {/* Table filter bar */}
      <div style={{ padding: "10px 20px 8px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Filter any column — symbol, sector, score, direction, regime…"
          style={{
            flex: "1 1 220px", minWidth: 160, background: T.card,
            border: `1px solid ${T.border}`, borderRadius: 6,
            padding: "6px 10px", color: T.text, fontSize: 13, outline: "none",
          }}
        />

        {/* View mode toggle */}
        <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", border: `1px solid ${T.border}` }}>
          {(["latest","all_runs"] as const).map(v => (
            <button key={v} onClick={() => setViewMode(v)}
              style={{
                padding: "5px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer", border: "none",
                background: viewMode === v ? T.accent : T.card,
                color: viewMode === v ? "#fff" : T.muted,
              }}>
              {v === "latest" ? "Latest" : "All Runs"}
            </button>
          ))}
        </div>

        {/* Column picker */}
        <div style={{ position: "relative" }}>
          <button onClick={e => { e.stopPropagation(); setShowColPicker(p => !p); }}
            style={{
              padding: "5px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer",
              border: `1px solid ${showColPicker ? T.accent : T.border}`,
              background: showColPicker ? `${T.accent}22` : T.card,
              color: showColPicker ? T.accent : T.muted,
            }}>
            ⚙ Columns
          </button>
          {showColPicker && (
            <div style={{
              position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 50,
              background: T.card, border: `1px solid ${T.border}`, borderRadius: 8,
              padding: "10px 12px", minWidth: 220, maxHeight: 400, overflowY: "auto",
              boxShadow: "0 8px 24px #00000066",
            }}
              onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 10, color: T.muted, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Show / hide · drag headers to reorder
              </div>
              {/* Group by domain */}
              {[
                { label: "Core", keys: ["run_date","symbol","Name","Sector","Industry","market","direction","last_trade_side","price_at_research"] },
                { label: "Scores", keys: ["analyst_score","fundamental_score","technical_score","sentiment_score","macro_score"] },
                { label: "Fundamental", keys: ["PERatio","PEGRatio","ReturnOnEquityTTM","GrossMarginTTM","FCFYield","DebtToEquity","QuarterlyRevenueGrowthYOY","ProfitMargin","EPS","EpsGrowth3Y","52WeekHigh"] },
                { label: "Technical", keys: ["rsi14","ema20_x_ema50","ema50_x_ema200","macd_hist","adx14","rs_vs_bench","breakdown_veto"] },
                { label: "Sentiment", keys: ["bullish_pct","bearish_pct","sent_sample","sent_source"] },
                { label: "Macro", keys: ["macro_regime","macro_danger","macro_week_of"] },
              ].map(g => (
                <div key={g.label}>
                  <div style={{ fontSize: 9, color: T.muted, marginTop: 8, marginBottom: 4, fontWeight: 700, textTransform: "uppercase" }}>{g.label}</div>
                  {g.keys.map(k => {
                    const col = COL_BY_KEY[k];
                    if (!col) return null;
                    return (
                      <label key={k} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", cursor: "pointer" }}>
                        <input type="checkbox" checked={!hiddenSet.has(k)} onChange={() => toggleCol(k)} />
                        <span style={{ fontSize: 12, color: T.text }}>{col.label}</span>
                        <span style={{ fontSize: 10, color: T.muted, marginLeft: "auto" }}>{col.csvLabel?.slice(0,25)}</span>
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        <button onClick={downloadCSV} disabled={loading || !filtered.length}
          title="Download full dataset as CSV (ignores current filter/column state)"
          style={{
            padding: "5px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer",
            border: `1px solid ${T.border}`, background: T.card, color: T.muted,
            opacity: (!filtered.length || loading) ? 0.4 : 1,
          }}>
          ⬇ CSV
        </button>

        <span style={{ fontSize: 11, color: T.muted }}>
          {loading ? "Loading…" : `${filtered.length} row${filtered.length !== 1 ? "s" : ""}`}
          {!loading && indiaEnabled && (
            <span style={{ color: T.accent }}>
              {" "}· {activeMarket === "india" ? "🇮🇳 India" : "🇺🇸 US"} only
              <span style={{ color: T.muted }}> ({rows.length - marketScoped.length} hidden by market switcher)</span>
            </span>
          )}
        </span>
        {chartSymbols.length > 0 && (
          <span style={{ fontSize: 11, color: T.accent }}>{chartSymbols.length} in chart ↑</span>
        )}
      </div>

      {/* Table — scrolls in both axes with always-visible scrollbars, sticky header
          row, and the leading Date/Symbol columns frozen to the left. */}
      <style>{`
        .fx-scroll { overflow: auto; max-height: 72vh; }
        /* Force scrollbars to stay visible instead of the OS overlay style that
           fades out (macOS/iOS) — otherwise there is no affordance that the table
           scrolls sideways at all. */
        .fx-scroll { scrollbar-width: thin; scrollbar-color: #3A3F55 #12141F; }
        .fx-scroll::-webkit-scrollbar { -webkit-appearance: none; width: 11px; height: 11px; }
        .fx-scroll::-webkit-scrollbar-track { background: #0F111B; }
        .fx-scroll::-webkit-scrollbar-thumb {
          background: #3A3F55; border-radius: 6px; border: 2px solid #0F111B;
        }
        .fx-scroll::-webkit-scrollbar-thumb:hover { background: #4C5270; }
        .fx-scroll::-webkit-scrollbar-corner { background: #0F111B; }
        .fx-scroll thead th { position: sticky; top: 0; z-index: 3; background: #0A0C16; }
        .fx-scroll th.fx-pin, .fx-scroll td.fx-pin { position: sticky; z-index: 2; }
        .fx-scroll thead th.fx-pin { z-index: 4; }
        .fx-scroll td.fx-pin { background: ${T.bg}; }
        .fx-scroll tr:hover td.fx-pin { background: #171A28; }
        /* Divider so pinned columns read as a frozen group, not overlapping text */
        .fx-scroll .fx-pin-last { box-shadow: inset -1px 0 0 ${T.border}, 1px 0 6px #00000055; }
      `}</style>
      <div className="fx-scroll" style={{ margin: "0 20px 32px", borderRadius: 8, border: `1px solid ${T.border}` }}>
        <table style={{ borderCollapse: "collapse", width: "max-content", minWidth: "100%", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "#0A0C16" }}>
              {visibleCols.map((col, i) => (
                <th key={col.key}
                  draggable onDragStart={() => onDragStart(i)} onDragOver={onDragOver} onDrop={() => onDrop(i)}
                  onClick={() => handleSort(col.key)}
                  title={col.tooltip}
                  className={[
                    pinnedLefts.has(col.key) ? "fx-pin" : "",
                    col.key === lastPinnedKey ? "fx-pin-last" : "",
                  ].filter(Boolean).join(" ")}
                  style={{
                    left: pinnedLefts.get(col.key),
                    padding: "8px 10px",
                    textAlign: (col.key === "symbol" || col.key === "Name" || col.key === "Sector" || col.key === "Industry" || col.key === "run_date") ? "left" : "right",
                    color: sortKey === col.key ? T.accent : T.muted,
                    fontWeight: 600, fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase",
                    cursor: "grab", whiteSpace: "nowrap",
                    borderBottom: `1px solid ${T.border}`, minWidth: col.width, userSelect: "none",
                  }}>
                  {col.label}
                  {col.formulaKey && (
                    <button
                      onClick={e => { e.stopPropagation(); setFormulaPanel(p => p === col.formulaKey ? null : col.formulaKey!); }}
                      title="Show formula (persistent, copyable)"
                      style={{
                        marginLeft: 4, padding: "1px 4px", borderRadius: 3, fontSize: 9,
                        border: `1px solid ${formulaPanel === col.formulaKey ? T.accent : T.border}`,
                        background: formulaPanel === col.formulaKey ? `${T.accent}22` : "transparent",
                        color: formulaPanel === col.formulaKey ? T.accent : T.muted,
                        cursor: "pointer",
                      }}>ⓘ</button>
                  )}
                  <SortArrow col={col.key} />
                </th>
              ))}
              <th style={{ padding: "8px 10px", color: T.muted, fontSize: 10, borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap" }}>
                CHART
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && Array.from({ length: 8 }).map((_, i) => (
              <tr key={i}>
                {visibleCols.map(c => (
                  <td key={c.key} style={{ padding: "8px 10px", borderBottom: `1px solid ${T.border}` }}>
                    <div style={{ height: 12, background: T.border, borderRadius: 3, opacity: 0.4 }} />
                  </td>
                ))}
                <td style={{ borderBottom: `1px solid ${T.border}` }} />
              </tr>
            ))}

            {!loading && filtered.map((row, ri) => {
              const inChart = chartSymbols.includes(row.symbol);
              const f = row.fundamentals ?? {};
              return (
                <tr key={ri}
                  style={{ borderBottom: `1px solid ${T.border}`, background: inChart ? `${T.accent}0D` : "transparent" }}
                  onMouseEnter={e => { if (!inChart) (e.currentTarget as HTMLElement).style.background = "#ffffff07"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = inChart ? `${T.accent}0D` : "transparent"; }}
                >
                  {visibleCols.map(col => {
                    const isLeft = ["symbol","Name","Sector","Industry","run_date","sent_source","macro_regime","macro_week_of"].includes(col.key);
                    let content: React.ReactNode;

                    if (col.key === "run_date") {
                      content = (
                        <span title={row.last_researched_at} style={{ color: T.muted, fontSize: 11, fontFamily: "monospace" }}>
                          {fmtDate(row.last_researched_at)}
                        </span>
                      );
                    } else if (col.key === "symbol") {
                      content = (
                        <span onClick={() => router.push(`/dashboard/research/${row.symbol}`)}
                          style={{ fontWeight: 700, cursor: "pointer", color: T.accent }}>
                          {row.symbol}
                        </span>
                      );
                    } else if (col.key === "Name" || col.key === "Sector" || col.key === "Industry") {
                      const v = f[col.key] ?? "—";
                      content = <span style={{ color: v === "—" ? T.muted : T.text }}>{v}</span>;
                    } else if (col.key === "market") {
                      content = <span>{row.market === "india" ? "🇮🇳" : "🇺🇸"}</span>;
                    } else if (col.key === "direction") {
                      content = (
                        <span style={{ color: dirColor(row.direction), fontWeight: 700, fontSize: 10 }}>
                          {row.direction?.toUpperCase() ?? "—"}
                        </span>
                      );
                    } else if (col.key === "last_trade_side") {
                      const lt = row.last_trade;
                      if (!lt) { content = <span style={{ color: T.muted }}>—</span>; }
                      else {
                        const isBuy = lt.side === "buy";
                        const venue = lt.venue ?? "paper";
                        content = (
                          <span title={`${venue} ${lt.side.toUpperCase()} on ${fmtDate(lt.date)}${lt.analyst_score != null ? ` · score ${lt.analyst_score}` : ""}${lt.exit_at ? ` · exited ${fmtDate(lt.exit_at)}` : " · still open"}`}
                            style={{ fontWeight: 700, fontSize: 10, color: isBuy ? T.green : T.red }}>
                            <span style={{ color: T.muted, fontWeight: 400 }}>{venue}.</span>
                            {lt.side.toUpperCase()} {fmtDate(lt.date).slice(5)}
                          </span>
                        );
                      }
                    } else if (col.derived && col.key === "bucket") {
                      const { bucket, momPts, valPts, signals } = deriveBucket(row);
                      const bm  = BUCKET_META[bucket];
                      const tip = `${bm.label.replace(/[🚀💰⚡]/u, "").trim()} · mom ${momPts} pts / val ${valPts} pts${signals.length ? `\nSignals: ${signals.join(", ")}` : ""}`;
                      content = <span title={tip} style={{ color: bm.color, fontSize: 10, fontWeight: 700 }}>{bm.label}</span>;
                    } else if (col.score) {
                      const rawScore = (row as any)[col.key];
                      const v = rawScore == null ? null : Number(rawScore);
                      content = <span style={{ fontWeight: 700, color: v == null || isNaN(v) ? T.muted : scoreColor(v) }}>{v == null || isNaN(v) ? "—" : v}</span>;
                    } else if (col.breakdownSource) {
                      // Breakdown cell
                      const raw = getCell(row, col);
                      if (raw == null) {
                        // A blank here has two very different meanings. India has no
                        // sentiment or macro evidence AT ALL (both are structurally
                        // excluded from the active scorer and score a flat neutral
                        // 50), whereas a US blank means the field genuinely did not
                        // resolve this run. Showing an identical "—" for both reads
                        // as a bug when it is a documented gap, so name it.
                        const src = col.breakdownSource;
                        const bd = src === "fundamental" ? row.fundamental_breakdown
                                 : src === "sentiment" ? row.sentiment_breakdown
                                 : src === "macro" ? row.macro_breakdown
                                 : row.technical_breakdown;
                        const note = (bd as any)?.note as string | undefined;
                        const structural = (bd as any)?.status === "inapplicable"
                          || (row.market === "india" && (src === "sentiment" || src === "macro"));
                        content = structural
                          ? <span title={note ?? `${src} evidence is not available for India — the dimension scores a neutral 50 and is excluded from the active scorer`}
                              style={{ color: T.muted, fontSize: 9, fontStyle: "italic" }}>n/a</span>
                          : <span title={note ?? "not resolved this run"} style={{ color: T.muted, fontSize: 10 }}>—</span>;
                      } else if (col.boolField) {
                        // Rows written before 2026-08-11 stored detectBreakdownVeto's
                        // whole { vetoed, reasons } object here. An object is always
                        // truthy, so reading it directly rendered "vetoed" for every
                        // symbol — unwrap it rather than trusting the raw value.
                        const bv = typeof raw === "object" && raw !== null
                          ? Boolean((raw as any).vetoed)
                          : Boolean(raw);
                        const isVeto = col.key === "breakdown_veto";
                        const good = isVeto ? !bv : bv;
                        const reasons = typeof raw === "object" && raw !== null ? (raw as any).reasons : null;
                        content = (
                          <span title={Array.isArray(reasons) && reasons.length ? reasons.join(" · ") : undefined}
                            style={{ color: good ? T.green : T.red, fontWeight: 700, fontSize: 11 }}>
                            {bv ? "✓" : "✗"}
                          </span>
                        );
                      } else if (col.pct) {
                        // sentiment pct fields stored as fractions (0.65 = 65%) or raw pct
                        const n = Number(raw);
                        const isProbFraction = n <= 1;
                        const ig = indicatorGrade(col.key, n, row.fundamentals?.Sector);
                        const disp = isProbFraction ? fmtVal(n, true) : `${n.toFixed(1)}%`;
                        content = <span title={ig.tip || undefined} style={{ color: ig.tip ? ig.color : T.text }}>{disp}</span>;
                      } else if (typeof raw === "string" && isNaN(parseFloat(raw))) {
                        // Text field (regime, source, week_of)
                        const colorMap: Record<string, string> = { bull: T.green, bear: T.red, neutral: T.muted };
                        const regimeTip: Record<string, string> = {
                          bull: `Macro regime: Bull · +20 pts to macro score · ${SCORING}`,
                          bear: `Macro regime: Bear · −30 pts to macro score · ${SCORING}`,
                          neutral: `Macro regime: Neutral · no regime adjustment · ${SCORING}`,
                        };
                        content = <span title={regimeTip[raw] ?? undefined} style={{ color: colorMap[raw] ?? T.text, fontSize: 11 }}>{raw}</span>;
                      } else {
                        const n = Number(raw);
                        const ig = indicatorGrade(col.key, isNaN(n) ? raw as string : n, row.fundamentals?.Sector);
                        content = <span title={ig.tip || undefined} style={{ color: ig.tip ? ig.color : T.text }}>{isNaN(n) ? String(raw) : fmtVal(n)}</span>;
                      }
                    } else {
                      const raw = getCell(row, col);
                      const sector = row.fundamentals?.Sector ?? null;
                      const ig = indicatorGrade(col.key, raw as string | number | null, sector);
                      const hasColor = ig.tip.length > 0;
                      content = <span title={ig.tip || undefined} style={{ color: hasColor ? ig.color : (raw != null && raw !== "" ? T.text : T.muted) }}>
                        {typeof raw === "boolean" ? String(raw) : fmtVal(raw, col.pct)}
                      </span>;
                    }

                    return (
                      <td key={col.key}
                        className={[
                          pinnedLefts.has(col.key) ? "fx-pin" : "",
                          col.key === lastPinnedKey ? "fx-pin-last" : "",
                        ].filter(Boolean).join(" ")}
                        style={{
                          left: pinnedLefts.get(col.key),
                          padding: "7px 10px",
                          textAlign: isLeft ? "left" : "right",
                          whiteSpace: "nowrap",
                        }}>
                        {content}
                      </td>
                    );
                  })}
                  <td style={{ padding: "7px 10px", textAlign: "center" }}>
                    <button onClick={() => toggleChartSymbol(row.symbol)}
                      style={{
                        background: inChart ? T.accent : T.card,
                        border: `1px solid ${inChart ? T.accent : T.border}`,
                        color: inChart ? "#fff" : T.muted,
                        borderRadius: 4, padding: "2px 7px", fontSize: 10,
                        fontWeight: 600, cursor: "pointer",
                      }}>
                      {inChart ? "✓" : "+"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
