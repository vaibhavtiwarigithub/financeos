-- Extend briefings.session check to allow 'synthesis' entries
-- (used by /api/markets/synthesis to cache the daily regime synthesis JSON blob)
alter table briefings drop constraint if exists briefings_session_check;
alter table briefings add constraint briefings_session_check
  check (session in ('morning', 'evening', 'thesis', 'synthesis'));
