-- Learning priors: human-written market principles as Bayesian starting context
create table if not exists learning_priors (
  id          bigserial primary key,
  category    text not null,            -- "fundamental" | "technical" | "macro" | "insider" | "general"
  principle   text not null,            -- the rule itself
  confidence  float not null default 0.6, -- prior confidence 0-1 (human-set)
  source      text default 'human',     -- "human" | "academic" | "backtested"
  enabled     boolean not null default true,
  notes       text,
  created_at  timestamptz default now()
);

alter table learning_priors disable row level security;

-- Seed: well-known market principles as priors
insert into learning_priors (category, principle, confidence, source, notes) values
  ('insider',     'Net insider buying >$500K in 90 days is a reliable long signal — insiders know their company best', 0.75, 'academic', 'Seyhun 1986, Lakonishok & Lee 2001'),
  ('insider',     'Insider selling is often noise (diversification, taxes) — only meaningful if >3 insiders sell simultaneously', 0.65, 'academic', 'Selling is less predictive than buying'),
  ('technical',   'RSI > 70 in a downtrending market signals distribution, not momentum continuation', 0.70, 'academic', 'RSI overbought in bear = exit, not entry'),
  ('technical',   'Price crossing above 50-day EMA after a sustained downtrend is a reliable long signal', 0.68, 'academic', 'Classic mean-reversion recovery pattern'),
  ('fundamental', 'Revenue acceleration (growth rate increasing QoQ) is more predictive than absolute growth level', 0.72, 'academic', 'O''Shaughnessy What Works on Wall Street'),
  ('fundamental', 'Free cash flow yield > 5% with positive revenue growth = strong value signal', 0.70, 'academic', 'Buffett / Graham value principle'),
  ('fundamental', 'P/E alone is a weak signal — P/E vs sector median is stronger (relative value matters)', 0.68, 'human', 'Absolute PE misleads across sectors'),
  ('macro',       'Rising Fed funds rate environment reduces valuation multiples for high-PE growth stocks', 0.80, 'academic', 'Duration risk: long-duration assets devalue in rising rates'),
  ('macro',       'Dollar strengthening (DXY up) headwind for US multinationals and emerging market exposure', 0.72, 'human', 'Currency translation risk'),
  ('macro',       'Geopolitical conflict (war, sanctions) causes energy/defense sector outperformance and tech underperformance', 0.65, 'human', 'Historical: Russia-Ukraine 2022, Gulf War 1990'),
  ('macro',       'Yield curve inversion (2Y > 10Y) precedes recessions by 6-18 months — reduce equity risk', 0.70, 'academic', 'Empirically validated since 1970s'),
  ('general',     'Momentum works better in bull markets; value works better in bear markets / recoveries', 0.72, 'academic', 'Fama-French momentum factor'),
  ('general',     'Earnings surprise (beat vs estimate) in the first week drives 3-5% avg move — strong short-term catalyst', 0.75, 'academic', 'Earnings drift studies'),
  ('general',     'Small-cap stocks underperform in rising rate / liquidity crunch environments', 0.68, 'human', 'Size premium disappears in tight credit conditions'),
  ('general',     'Averaging down on a falling stock is dangerous without fundamental catalyst — cut losers fast', 0.75, 'human', 'Kahneman loss aversion trap')
on conflict do nothing;

-- Learner config: per-dimension input/mutation controls
create table if not exists learner_config (
  dimension          text primary key,  -- "fundamental_score" | "technical_score" | etc
  learn_from         boolean not null default true,   -- include in correlation analysis
  allow_mutation     boolean not null default true,   -- allow weight mutation for this dim
  min_confidence     float not null default 0.70,     -- minimum confidence to mutate
  notes              text,
  updated_at         timestamptz default now()
);

alter table learner_config disable row level security;

insert into learner_config (dimension, learn_from, allow_mutation, min_confidence, notes) values
  ('fundamental_score', true, true, 0.70, 'Core valuation signal'),
  ('technical_score',   true, true, 0.70, 'RSI + EMA momentum'),
  ('sentiment_score',   true, true, 0.75, 'Higher gate — sentiment is noisy'),
  ('macro_score',       true, true, 0.70, 'Sector/rate environment'),
  ('insider_score',     true, true, 0.65, 'Lower gate — insider data is sparse but reliable')
on conflict (dimension) do nothing;

-- Signal weights history: snapshot before every mutation for rollback
create table if not exists signal_weights_history (
  id                 bigserial primary key,
  snapshot_at        timestamptz default now(),
  run_date           date,
  trigger            text default 'learner_mutation', -- "learner_mutation" | "manual_reset" | "auto_guard"
  fundamental_weight float,
  technical_weight   float,
  sentiment_weight   float,
  macro_weight       float,
  insider_weight     float,
  win_rate_at_time   float,
  notes              text
);

alter table signal_weights_history disable row level security;
create index if not exists swh_snapshot_idx on signal_weights_history(snapshot_at desc);

-- Auto-guard tracking: consecutive below-threshold win rate runs
alter table learner_runs add column if not exists mutations_paused boolean default false;
alter table learner_runs add column if not exists pause_reason text;
