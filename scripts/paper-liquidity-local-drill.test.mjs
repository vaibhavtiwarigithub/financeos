// Opt-in, isolated PostgreSQL proof. Uses synthetic rows only, never production.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PROJECT, drill, rowDigest, datasetDigest } from './provider-cache-archive.mjs';

test('actual fill routine enforces reserve after pool lock and counts every held role', {
  skip: process.platform !== 'win32' || !process.env.KAIROS_PAPER_FILL_FIXTURE,
  timeout: 120000,
}, async () => {
  const dir = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA, 'Kairos/backups/provider-cache/liquidity-synthetic-'));
  const identity = execFileSync('whoami.exe', { encoding: 'utf8', windowsHide: true }).trim();
  execFileSync('icacls.exe', [dir, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`], { windowsHide: true, stdio: 'ignore' });
  const rows = [{ cache_key: 'TEST-NO-REAL-ASSET', cache_date: '2026-01-01', payload_text: '{"synthetic": true}', fetched_at: '2026-01-01T00:00:00Z' }];
  const compressed = gzipSync(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'cache.ndjson.gz'), compressed);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: 1, project: PROJECT, table: 'public.av_cache',
    syntheticOnly: true, cutoff: '2026-01-03', rowCount: 1,
    compressedSha256: createHash('sha256').update(compressed).digest('hex'), datasetSha256: datasetDigest(rows.map(rowDigest)) }));
  const routine = fs.readFileSync(process.env.KAIROS_PAPER_FILL_FIXTURE, 'utf8');
  const migration = fs.readFileSync(new URL('../supabase/migrations/20261026224500_paper_leveraged_liquidity_reserve.sql', import.meta.url), 'utf8');
  await drill(dir, async sql => {
    await sql(`create table paper_portfolio(id uuid default gen_random_uuid(), market text, cash_balance numeric,nav numeric);
      create table paper_positions(id uuid default gen_random_uuid(),market text,symbol text,position_role text,qty numeric,avg_cost numeric,current_price numeric,sector text);
      create table strategy_config(app_paused boolean,trading_enabled boolean);
      create table market_controls(market text,paused boolean,trading_enabled boolean);
      create table trading_mandates(market text,score_threshold numeric,max_open_positions integer);
      insert into strategy_config values(false,true);
      insert into market_controls values('us',false,true),('india',false,true);
      insert into trading_mandates values('us',60,8),('india',60,8);
      insert into paper_portfolio(market,cash_balance,nav) values('us',1000,10000),('india',1000,10000);
      insert into paper_positions(market,symbol,position_role,qty,avg_cost,current_price) values('us','TEST-CORE','alpha',90,100,100);
      ${routine};
      ${migration}
      ${migration}
      create function local_check(m text,c numeric,s numeric default 0) returns jsonb language sql as $$
        select public.execute_paper_fill(null,m,case when m='india' then 'INR' else 'USD' end,'TEST-CANDIDATE',c/100,100,c,'synthetic',now(),null,null,null,s,'synthetic',null,null,120,90,'synthetic');
      $$;`);
    const check = async (market, cost, score = 0) => JSON.parse((await sql(`select local_check('${market}',${cost},${score});`)).trim());
    assert.equal((await check('us',501)).error, 'leveraged_liquidity_reserved');
    assert.equal((await check('us',500)).error, 'below_mandate_threshold'); // reserve passed; no fill attempted
    assert.equal((await check('india',501)).error, 'below_mandate_threshold');
    await sql("update paper_positions set symbol='SOXL',qty=5 where market='us';");
    assert.equal((await check('us',1000)).error, 'below_mandate_threshold'); // invested sleeve is not reserved twice
    await sql("update paper_positions set symbol='TEST-CORE',qty=90,current_price='NaN' where market='us';");
    assert.equal((await check('us',100)).error, 'invalid_liquidity_position_mark');
    await sql("update paper_positions set current_price=100 where market='us';");
    // Two independent transactions, one actual routine + synthetic local debit
    // each: the second must see the post-lock cash/book, never the first snapshot.
    await sql(`create function local_spend() returns text language plpgsql as $$ declare r jsonb; begin
      r:=local_check('us',500);
      if r->>'error'='below_mandate_threshold' then
        perform pg_sleep(0.2);
        update paper_portfolio set cash_balance=cash_balance-500 where market='us';
        insert into paper_positions(market,symbol,position_role,qty,avg_cost,current_price) values('us','TEST-ADDED','alpha',5,100,100);
        return 'accepted_synthetic';
      end if;
      return r->>'error'; end $$;`);
    const concurrent = await Promise.all([sql('select local_spend();'), sql('select local_spend();')]);
    assert.deepEqual(concurrent.map(value => value.trim()).sort(), ['accepted_synthetic','leveraged_liquidity_reserved']);
    assert.equal((await sql("select cash_balance from paper_portfolio where market='us';")).trim(), '500');
    await sql(`delete from paper_positions;
      update paper_portfolio set cash_balance=10000;
      insert into paper_positions(market,symbol,position_role,qty,avg_cost,current_price)
        select 'us','TEST-'||i,case when i=8 then 'sqqq_paper' else 'alpha' end,1,1,1 from generate_series(1,8) i;`);
    assert.equal((await check('us',100,70)).error, 'max_open_names');
    await sql("update paper_positions set market='india';");
    assert.equal((await check('india',100,70)).error, 'max_open_names');
  });
  assert.equal(fs.existsSync(path.join(dir, 'restore-drill/postmaster.pid')), false);
  console.log(JSON.stringify({ syntheticLiquidityAndConcurrencyVerified: true, realFinancialWrites: 0 }));
});
