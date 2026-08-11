-- Capital rotation may keep measuring, but paper execution must remain off
-- until benchmark-alpha, friction, turnover, correlation and tax readiness are
-- enforced by the execution path. Live rotation was already disabled.
update public.rotation_config
set rotation_paper_execute_enabled = false,
    updated_at = now()
where book_type = 'paper'
  and rotation_paper_execute_enabled = true;
