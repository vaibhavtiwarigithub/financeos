-- Realign kairos-research-india from post-close (16:30 IST, 1hr after NSE's
-- 15:30 close) to shortly after NSE open (9:30 IST, 15min after the 9:15
-- open). Previously India's research (score off the latest daily candle) and
-- its internally-chained paper-trade fill (fetch a "live" quote) both fired
-- on the SAME day's closing print, back-to-back -- no realistic gap between
-- decision and fill. The US equivalent fires research pre-open (scores off
-- YESTERDAY's close) and its chained paper-trade fill therefore lands on a
-- genuinely live/intraday quote fetched around/after the open. India's chained
-- call needs a quote source with real intraday movement to mirror that, and
-- free Yahoo data for NSE doesn't reliably carry real pre-market movement the
-- way US extended-hours data does -- so instead of moving pre-open like US,
-- India moves to just AFTER the open, which still scores off yesterday's
-- finalized candle (today's isn't final until 15:30 IST) while giving the
-- chained fill a real live intraday price instead of yesterday's frozen close.
--
-- kairos-position-monitor-india (15:45 IST, 15min after NSE close) is
-- unchanged -- it already correctly mirrors the US pattern (exit checks use
-- the day's closing price, checked shortly after close).

select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'kairos-research-india'),
  schedule := '0 4 * * 1-5' -- 04:00 UTC = 09:30 IST (15min after NSE's 09:15 open)
);
