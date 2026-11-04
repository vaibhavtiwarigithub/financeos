# Feature: Daily Briefing

Status: v1 shipped (2026-07-04). v2 partially shipped; live holding-risk integration shipped 2026-07-21.

## Owner-requested portfolio holdings ledger extension (2026-11-03) — approved 2026-11-04 (“fix it”); implementation in progress

### 1. User intention

Make the existing US and India morning and evening emails answer, from verified
records, exactly which symbols are held in each paper and live book, the quantity,
purchase/average cost, latest stored mark, and unrealized profit or loss.

### 2. Current architecture

- The existing four scheduled editions are US morning/evening and India
  morning/evening. They use `/api/briefing/generate`; this proposal adds no
  schedule and sends no additional email.
- The paper section reads `paper_positions` with a 10-row limit. It shows symbol,
  quantity, entry, stored current price, and unrealized percent, but not the full
  book, not dollar P/L/value, not recorded protective levels, and not mark time.
- The live summary in the header is US-only and bound to one account. The
  deterministic Holding Risk section shows actionable holdings plus only three
  ordinary holds per account, so it is deliberately not a complete holdings
  ledger.
- The latest complete immutable `holding_risk_snapshots` rows already contain
  every account's symbol, quantity, average cost, mark, market value, source
  capture timestamp, and market/account identity for US and India, including
  Kite. This is the approved owner account source. The earlier proposed Kite
  write to `user_account_snapshots` is dropped: that table is tenant-isolated
  for connected users and must not become a new owner-data path.

### 3. Proposed architecture

Extend the current briefing's deterministic HTML data blocks. Every edition
continues to be market-local and includes two separately labeled ledgers:

1. **Paper holdings**: every open `paper_positions` row for that market, with
   quantity, average entry price, stored mark, market value, unrealized P/L in
   currency and percent, stop, target, opened date, and the mark record's
   timestamp. This is explicitly the stored paper mark, not a new quote.
2. **Live holdings by account**: every row in the latest complete immutable
   Holding Risk snapshot for each account in the edition's market. Also inspect
   the latest run status per account so a newer failed/partial run is surfaced
   beside its last complete rows. Show
   broker/account nickname (mask account IDs to the last four), quantity,
   average buy price, snapshot price, market value, unrealized P/L, and the
   source snapshot's exact capture time. Do not combine accounts.

Tables are assembled from validated numeric fields and escaped symbol/account
labels; the LLM never writes or modifies table values. The route makes no quote,
broker, or other provider calls for the tables. It adds no tables, columns,
provider, schedule, account access, trade, or order behavior.

### 4. User journey / system flow

The existing scheduled morning/evening call selects US or India, reads that
market's complete paper positions and latest complete immutable live holding
risk snapshots, renders the two tables, then sends and records the same email
as today. It makes no broker or market-data calls and writes no holdings.

### 5. UI / API / data / interaction model

- Reuse the existing authenticated/cron-protected briefing route, Resend
  delivery, four cron jobs, `paper_positions`, `holding_risk_runs`, and
  `holding_risk_snapshots`.
- Add a pure server-side normalizer/formatter so DB values are validated and
  table rendering can be regression-tested without sending email.
- Every row still present in `paper_positions` for the requested market is a
  held lot; close removes it, while `exit_reason` can also store an armed exit
  state. Do not filter on `exit_reason`. Remove the arbitrary 10-row cap.
- Live rows are grouped under their source account and included only when the
  source market, account, and currency match the email's market. Do not infer a
  flat book from absent/stale snapshots. Exclude internal, simulation, demo,
  and paper broker snapshots from this section; use only the existing live
  broker sources.
- If average entry, mark, quantity, or value is missing, show `Unavailable` for
  that field and omit derived P/L; never substitute zero or infer a fill price.
- Mask account IDs except their last four characters. Keep currencies local to
  US/USD and India/INR.
- Preserve the existing Live Holdings Risk section as its attention-oriented
  summary; it is complementary to, and clearly distinct from, the full ledger.

### 6. States and edge cases

- Empty paper query: “No open paper positions recorded for this market.”
- Empty live snapshot set: “No verified live holdings snapshot available; this
  is not confirmation that the account is flat.”
- No complete live run for an account: show that exact unavailable state and
  the last-known complete capture time when available; do not infer a flat book.
- Invalid numeric fields remain visible as `Unavailable`; never drop the
  symbol row. A failed database read or incomplete paginated result prevents
  the email from being sent. A newer failed account run is shown beside the
  last complete snapshot, not treated as current.
- Old snapshot: label its exact captured-at time. Do not call it current and do
  not fetch a replacement during email generation.
- Duplicate symbols in different accounts remain separate rows.
- Missing stop/target in paper rows is displayed as unavailable; no levels are
  generated or changed.

### 7. Files that may be touched after approval

- `app/api/briefing/generate/route.ts`
- New pure helper and focused tests under `lib/briefing/`
- `features/briefing/FEATURE_ARCHITECTURE.md`
- `features/briefing/IMPLEMENTATION_RESULT.md`
- `docs/arch/03-agents.md` (briefing input/output contract)
- `WORK_LOG.md`

No migration, scheduler change, broker refresh, persistence, policy, or trading
code is in scope. Email generation reads only completed persisted snapshots.

### 8. Risks / decisions needed

- The existing live-account snapshots can be old; showing their capture time
  is mandatory, and the email must never imply a fresh broker read occurred.
- India live buy prices may remain unavailable until the existing owner-authorized
  Kite Holding Risk run completes successfully. The email reports the last
  complete capture time or the failed/unavailable state truthfully; it never
  reads credentials or retries Kite.
- The mailing list, frequency, Resend settings, and account eligibility remain
  unchanged.

### 9. Acceptance criteria

1. All open paper positions appear for the correct market even when there are
   more than ten; closed or other-market positions never appear.
2. Every displayed paper row has deterministic quantity/entry/mark/value/P&L
   formatting, with missing values visibly unavailable and no fabricated zero.
3. Every persisted live broker account in the market is separately represented
   with masked account label and its capture timestamp; internal/paper accounts
   and positions from another market/account are never merged into it.
4. Missing live snapshots and missing Kite detail are explicitly labeled as
   unavailable, not flat. Failed/partial latest runs remain explicit, and any
   last complete rows are labeled as last-known rather than current.
5. Snapshot-only email data is used; no broker calls or holdings writes occur.
   No orders, schema changes, or new emails/schedules are introduced.
6. Focused tests cover full paper row count, market isolation, staged open exit
   rows, account separation, missing fields, failed/stale snapshots, escaping,
   and the explicit unavailable-not-flat states. Email send is not used as a test.

### 10. Approval record

Owner approved implementation on 2026-11-04 with “fix it”. The full live table
reuses the complete immutable Holding Risk snapshots rather than writing Kite
holdings into the per-user snapshot table; this preserves its tenant boundary
and needs no schema, provider, or persistence change.

## v1 (done)
Newsletter-grade email: structured HTML data blocks (accurate, code-built) +
short LLM editor's note. Sections: header → editor's note → portfolio health
score → market snapshot + regime → agent signals → positions → earnings →
learning/phase → footer deep-links. Subject formula with preheader substance.
Route: `app/api/briefing/generate/route.ts`.

## v2 — REQUIREMENTS (user, 2026-07-04) — NOT yet built
The guiding rule from the user: **"the more details and explanations, the more
I like it. Top bullets OK, but explanation and details are MANDATORY."**

1. **Lighter theme** — not an all-dark background. Mixed/light layout.
2. **Explain every metric** — the Portfolio Health score and each Market
   Snapshot number must carry a short "what this is + why it matters" line, not
   just the number. No unexplained figures.
3. **Outlook sections with confidence** — add:
   - **Market outlook** (today + forward) with a stated confidence level.
   - **Positions-I-hold outlook** — per holding, where it's headed and why + confidence.
   - **Future market & position outlook** — near-term expectation + confidence.
4. **Agent activity recap** — what the Research agent and Learner agent actually
   did (a) on the day of the newsletter and (b) over the past 7 days. Concrete:
   runs, signals, hypotheses, weight challengers, rescore flags.
5. **Mentor block** — what the Mentor agent has for the user to learn, based on
   current market + the user's behavior + how they're doing on the learning
   curve. (Depends on the Mentor AI agent — see features/mentor-agent.)
6. **Structure** — top bullets for scannability, THEN mandatory explanation/
   detail beneath each. Details are the point, not an afterthought.

Design note for v2: keep the accurate code-built data blocks, but pair each
with an LLM-written explanation/outlook (grounded, with confidence), and pull
the 7-day agent recap from agent_runs + learner_runs + rescore flags.

## Live Holdings Risk addition (approved and shipped 2026-07-21)

- Each US/India edition reads the latest `complete` `holding_risk_runs` row per
  live broker account for that market, then replays its immutable
  `holding_risk_snapshots` and `account_risk_snapshots` rows.
- The briefing never recomputes risk and never calls a broker or market-data
  provider for this section. The LLM receives the deterministic postures only as
  grounded advisory context and cannot alter them.
- Accounts, markets, and currencies remain separate. Every row must match the
  selected run's `run_id + market + currency + account_id`; mismatches are
  discarded instead of cross-summed or relabelled. The `internal` paper-book
  adapter is excluded from this explicitly live section, and account identifiers
  embedded in labels are masked to their last four characters.
- The email shows every non-`hold` posture plus the three highest-risk ordinary
  holds per account. It states how many lower-priority holds were omitted and
  links to the complete Risk Analytics page.
- Snapshot date, session age, formula version, confidence, missing inputs,
  current price, NAV weight, unrealized P&L, score, posture, and deterministic
  action reason are displayed. Missing values stay unavailable, never zero.
- Every displayed live holding also carries the latest canonical ResearchAgent
  annotation for the same `(symbol, market)`: score, direction, exact researched
  timestamp, market-session age/freshness, and `holding re-score` versus
  `candidate score`. Only `deterministic_v1 + session_validated=true` rows count;
  a failed read, abstention, stale result, and never-researched state remain
  distinct. This is display-only and never changes Holding Risk.
- The email explains that research conviction and portfolio risk answer different
  questions. Since `hr-v3`, concentration is `REVIEW`, not `TRIM`, for every
  account; a high research score never erases measured exposure, but a global
  trading reference is never treated as an account-specific sell mandate.
- Failed reads and missing complete runs are visible states. A stale or missing
  snapshot must never be described as safe/current.
- Legacy `hr-v1`/`hr-v2` stored trims are immutable evidence, not current advice.
  The shared history normalizer preserves `sourcePosture=trim` for audit and
  displays `REVIEW` in both newsletters and Risk Analytics.
