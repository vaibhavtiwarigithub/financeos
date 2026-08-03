"""Lane B TEMPLATE — heavy/slow Python on GitHub Actions, results to Supabase REST.

This lane exists for work that cannot finish inside a serverless timeout:
backtests, ML fits, long universe rotations. It is NOT wired into any agent,
cron, score, gate or order path — it is a measurement job.

The "analysis" below is a deliberate placeholder: it fits an OLS trend on a
deterministic synthetic series so the plumbing (deps -> compute -> REST write)
is exercised end to end without touching real data. Replace `analyze()`.

Env (supplied by .github/workflows/lane-b-python.yml from repo secrets):
  SUPABASE_URL                 required to write
  SUPABASE_SERVICE_ROLE_KEY    required to write
  LANE_B_TABLE                 target table; UNSET => dry run (prints payload)
  LANE_B_RUN_KEY               idempotency key; defaults to the UTC date

Idempotency: the row is upserted on `run_key`, so a re-run of the same day
replaces its row instead of appending. The target table must have a unique
constraint on that column — pick the table deliberately before setting
LANE_B_TABLE, this script will not create one.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date

import numpy as np
import statsmodels.api as sm


def analyze() -> dict:
    """PLACEHOLDER. Deterministic OLS trend fit — replace with real work."""
    rng = np.random.default_rng(0)
    n = 500
    t = np.arange(n, dtype=float)
    y = 0.02 * t + rng.normal(scale=1.0, size=n)
    fit = sm.OLS(y, sm.add_constant(t)).fit()
    return {
        "n": n,
        "slope": float(fit.params[1]),
        "slope_se": float(fit.bse[1]),
        "t_stat": float(fit.tvalues[1]),
        "r_squared": float(fit.rsquared),
    }


def upsert(table: str, url: str, key: str, row: dict) -> None:
    req = urllib.request.Request(
        f"{url.rstrip('/')}/rest/v1/{table}?on_conflict=run_key",
        data=json.dumps([row]).encode(),
        method="POST",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        if resp.status >= 300:
            raise RuntimeError(f"supabase returned {resp.status}")


def main() -> int:
    row = {
        "run_key": os.environ.get("LANE_B_RUN_KEY") or date.today().isoformat(),
        "kind": "lane_b_placeholder",
        "result": analyze(),
    }

    table = os.environ.get("LANE_B_TABLE")
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not (table and url and key):
        # ponytail: dry run is the default so a template can never write junk
        # into a real table. Set LANE_B_TABLE once a target table exists.
        print("DRY RUN (LANE_B_TABLE / SUPABASE_URL / SERVICE_ROLE_KEY not all set)")
        print(json.dumps(row, indent=2))
        return 0

    try:
        upsert(table, url, key, row)
    except urllib.error.HTTPError as exc:
        print(f"supabase write failed: {exc.code} {exc.read().decode()[:500]}", file=sys.stderr)
        return 1
    print(f"wrote run_key={row['run_key']} to {table}")
    return 0


def _demo() -> None:
    out = analyze()
    assert out["n"] == 500
    assert abs(out["slope"] - 0.02) < 0.005, out["slope"]  # deterministic seed
    assert out["t_stat"] > 10 and 0 <= out["r_squared"] <= 1
    print(json.dumps(out, indent=2))
    print("self-check OK")


if __name__ == "__main__":
    if "--self-check" in sys.argv:
        _demo()
    else:
        sys.exit(main())
