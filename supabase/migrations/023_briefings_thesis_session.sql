-- Extend briefings.session check to allow 'thesis' entries
alter table briefings drop constraint if exists briefings_session_check;
alter table briefings add constraint briefings_session_check
  check (session in ('morning', 'evening', 'thesis'));
