# Feature: Daily Briefing

Status: v1 shipped (2026-07-04). v2 requirements captured below (user-requested).

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
