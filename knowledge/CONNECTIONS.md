# Live Connections & Account State

> Operational state — MCP connections, account numbers, auth status.
> Update this file when connections change.
> Last updated: 2026-06-27

---

## Robinhood MCP

**Status:** ✅ Connected + Authenticated  
**MCP endpoint:** `https://agent.robinhood.com/mcp/trading`  
**Tool namespace:** `mcp__e7f451df-9a3b-40ea-9548-4076b4aac063__*`  
**Connected via:** `claude mcp add robinhood-trading --transport http https://agent.robinhood.com/mcp/trading`

### Accounts

| Masked # | Full # | Type | Nickname | Agentic | Use |
|---|---|---|---|---|---|
| ••••2862 | 5QZ42862 | individual (margin) | — | ❌ | Primary — NEVER touch |
| ••••9200 | 116781169200 | joint_tenancy | — | ❌ | Joint — NEVER touch |
| ••••0481 | 181262410481 | individual (managed) | — | ❌ | Managed — NEVER touch |
| ••••8641 | 965848641 | individual (cash) | Trading | ❌ | Manual trading — NEVER touch |
| ••••9781 | 991989781 | individual (cash) | Autopilot | ❌ | NEVER touch |
| ••••0660 | 605420660 | individual (cash) | **Agentic** | ✅ | **ONLY account agents may use** |

**Agent account number for all tool calls:** `605420660`

### Available Robinhood Tools (confirmed working)
```
get_accounts          — list all accounts
get_portfolio         — buying power, market value (requires account_number)
get_equity_positions  — open positions (requires account_number)
get_equity_quotes     — real-time quotes
get_equity_orders     — order history
get_equity_historicals — price history
get_equity_fundamentals — fundamentals (P/E, market cap, etc.)
get_earnings_calendar — upcoming earnings dates
get_earnings_results  — past earnings beats/misses
place_equity_order    — place trade (USE WITH CAUTION)
review_equity_order   — preview before placing
get_watchlists        — Robinhood watchlists
get_indexes           — index quotes (SPY, QQQ, etc.)
get_index_quotes      — index real-time data
search                — search for tickers
get_portfolio         — portfolio breakdown
get_realized_pnl      — realized P&L history
create_scan / run_scan — stock screener
```

---

## Other MCP Connections

| MCP | Status | Purpose |
|---|---|---|
| Puppeteer (sequential-browser-scraping) | ✅ Connected | Web scraping for ResearchAgent |
| Supabase (bd2a476b) | Available | DB management |
| Slack (5c713a9d) | ⚠️ Auth needed | Notifications |
| GitHub (github) | ⚠️ Auth needed | — |

---

## Supabase Project

Applied migrations: `001_initial_schema.sql`  
Pending migrations: `002_agent_tables.sql` (not yet created — see PRD.md Section 4.3 for SQL)

---

## Key Facts for Any New Agent Session

1. Robinhood is authenticated and working right now
2. Only use account `605420660` for any trade operations
3. Before placing any order, call `review_equity_order` first
4. `strategy_config.trading_enabled` must be `true` before TraderAgent acts
5. All trades go to `trade_log` table in Supabase
