# Feature: Daily Briefing

Status: v1 shipped (2026-07-04). v2 partially shipped; live holding-risk integration shipped 2026-07-21.

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
