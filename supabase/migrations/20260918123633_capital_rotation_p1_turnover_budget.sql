-- Capital-rotation P1 evidence budget. This is an explicit owner-approved
-- monthly gross turnover ceiling for paper rotation only; it does not enable
-- rotation execution. A single 10% replacement consumes roughly 20% (sell +
-- buy), so this permits one fully-audited replacement per market-month while
-- the evidence program is still young.
--
-- The value is stored on the mandate rather than defaulted in code: a missing
-- budget must always fail closed.
update public.investment_mandates
set turnover_budget_monthly = 20
where active = true
  and market in ('us', 'india')
  and turnover_budget_monthly is null;

-- Containment is restated defensively. This migration never grants execution.
update public.rotation_config
set rotation_paper_execute_enabled = false,
    rotation_allow_score_only_paper = false
where book_type = 'paper';
