"""Vercel Python Function — Spearman rank IC with a Newey-West HAC standard error.

MEASURE-ONLY. Pure function: JSON in, numbers out. No DB, no market data, no LLM.
Nothing here scores, sizes, gates, promotes or trades anything.

Why this exists: `lib/edges/ic.ts` hand-rolls Spearman + a Bartlett-kernel
Newey-West SE in TypeScript. This endpoint does the same maths with
scipy/statsmodels so the TS implementation can be cross-checked against a
reference library instead of against itself.

Route (Vercel): POST /api/py/ic
Auth: same contract as the TS crons — `x-cron-secret` must equal `CRON_SECRET`,
compared timing-safely, failing closed when CRON_SECRET is unset.

Request body:
  {
    "periods": [ {"x": [..], "y": [..]}, ... ],   # one cross-section per as-of date
    "lag": 4,                                      # optional, explicit Bartlett lag
    "horizon": 20, "step": 5                       # optional, lag = ceil(horizon/step)
  }

Response:
  {
    "n_periods", "ic_series", "mean_ic", "ic_std", "ic_ir",
    "nw_se", "t_stat", "nw_se_small_sample", "t_stat_small_sample",
    "lag", "skipped_periods", "method"
  }
"""

from __future__ import annotations

import hmac
import json
import math
import os
import warnings
from http.server import BaseHTTPRequestHandler

import numpy as np
import statsmodels.api as sm
from scipy.stats import spearmanr

# ponytail: caps exist so one request can't pin a serverless CPU for 10s.
MAX_PERIODS = 2000
MAX_OBS_PER_PERIOD = 5000
MAX_BODY_BYTES = 4 * 1024 * 1024
MIN_OBS_PER_PERIOD = 3  # spearman is undefined below this


class BadRequest(ValueError):
    pass


def newey_west_lag(horizon: float, step: float) -> int:
    """Mirror of `neweyWestLag` in lib/edges/evidence.ts."""
    if not math.isfinite(horizon) or horizon < 1:
        return 1
    if not math.isfinite(step) or step < 1:
        return max(1, math.ceil(horizon))
    return max(1, math.ceil(horizon / step))


def _finite_floats(values, label: str) -> np.ndarray:
    if not isinstance(values, list):
        raise BadRequest(f"{label} must be an array of numbers")
    if len(values) > MAX_OBS_PER_PERIOD:
        raise BadRequest(f"{label} exceeds {MAX_OBS_PER_PERIOD} observations")
    out = np.empty(len(values), dtype=float)
    for i, v in enumerate(values):
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise BadRequest(f"{label}[{i}] is not a number")
        if not math.isfinite(v):
            raise BadRequest(f"{label}[{i}] is not finite")
        out[i] = float(v)
    return out


def compute_ic(payload: dict) -> dict:
    periods = payload.get("periods")
    if not isinstance(periods, list) or not periods:
        raise BadRequest("periods must be a non-empty array")
    if len(periods) > MAX_PERIODS:
        raise BadRequest(f"periods exceeds {MAX_PERIODS}")

    if payload.get("lag") is not None:
        lag_raw = payload["lag"]
        if isinstance(lag_raw, bool) or not isinstance(lag_raw, int) or lag_raw < 1:
            raise BadRequest("lag must be a positive integer")
        lag = lag_raw
    else:
        lag = newey_west_lag(float(payload.get("horizon", 1) or 1),
                             float(payload.get("step", 1) or 1))

    ics: list[float] = []
    skipped = 0
    for idx, period in enumerate(periods):
        if not isinstance(period, dict):
            raise BadRequest(f"periods[{idx}] must be an object")
        x = _finite_floats(period.get("x"), f"periods[{idx}].x")
        y = _finite_floats(period.get("y"), f"periods[{idx}].y")
        if x.size != y.size:
            raise BadRequest(f"periods[{idx}] x/y length mismatch")
        if x.size < MIN_OBS_PER_PERIOD:
            skipped += 1
            continue
        with warnings.catch_warnings():
            # A constant cross-section is an expected input, not an anomaly:
            # spearmanr returns nan and we skip the period below.
            warnings.simplefilter("ignore")
            ic = spearmanr(x, y).statistic
        if not math.isfinite(ic):
            skipped += 1
            continue
        ics.append(float(ic))

    n = len(ics)
    result = {
        "n_periods": n,
        "ic_series": ics,
        "skipped_periods": skipped,
        "lag": lag,
        "method": "spearman + newey-west(bartlett) via scipy/statsmodels",
    }
    if n < 2:
        # Not enough periods for a time-series SE; return what is defined.
        result.update({
            "mean_ic": ics[0] if n else None,
            "ic_std": None, "ic_ir": None,
            "nw_se": None, "t_stat": None,
            "nw_se_small_sample": None, "t_stat_small_sample": None,
        })
        return result

    arr = np.asarray(ics, dtype=float)
    mean_ic = float(arr.mean())
    ic_std = float(arr.std(ddof=0))  # population std, matches lib/edges/ic.ts
    exog = np.ones((n, 1))
    # Regressing the IC series on a constant makes the OLS coefficient the mean
    # and its HAC standard error the Newey-West SE of that mean.
    # use_correction=False reproduces lib/edges/ic.ts exactly; the corrected
    # variant (statsmodels' default) is returned alongside for reference.
    def _hac(use_correction: bool) -> tuple[float, float]:
        fit = sm.OLS(arr, exog).fit(
            cov_type="HAC",
            cov_kwds={"maxlags": lag, "kernel": "bartlett", "use_correction": use_correction},
        )
        return float(fit.bse[0]), float(fit.tvalues[0])

    se, t = _hac(False)
    se_c, t_c = _hac(True)
    result.update({
        "mean_ic": mean_ic,
        "ic_std": ic_std,
        "ic_ir": (mean_ic / ic_std) if ic_std > 0 else None,
        "nw_se": se,
        "t_stat": t,
        "nw_se_small_sample": se_c,
        "t_stat_small_sample": t_c,
    })
    return result


def _authorized(headers) -> bool:
    """Same fail-closed contract as verifyCronSecret in lib/auth/cron.ts."""
    secret = os.environ.get("CRON_SECRET")
    if not secret:
        return False
    provided = headers.get("x-cron-secret")
    if not provided:
        return False
    return hmac.compare_digest(provided.encode(), secret.encode())


class handler(BaseHTTPRequestHandler):  # noqa: N801 — Vercel requires this name
    def _send(self, status: int, body: dict) -> None:
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self) -> None:  # noqa: N802
        if not _authorized(self.headers):
            self._send(401, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._send(400, {"error": "bad Content-Length"})
            return
        if length <= 0 or length > MAX_BODY_BYTES:
            self._send(400, {"error": "body missing or too large"})
            return
        try:
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise BadRequest("body must be a JSON object")
            self._send(200, compute_ic(payload))
        except BadRequest as exc:
            self._send(400, {"error": str(exc)})
        except json.JSONDecodeError:
            self._send(400, {"error": "invalid JSON"})

    def do_GET(self) -> None:  # noqa: N802
        self._send(405, {"error": "POST only"})

    def log_message(self, *args) -> None:  # keep function logs quiet
        pass


# ── self-check ────────────────────────────────────────────────────────────────
def _ts_reference(ics: list[float], lag: int) -> float:
    """Line-for-line port of neweyWestSEofMean in lib/edges/ic.ts."""
    n = len(ics)
    mean = sum(ics) / n
    d = [v - mean for v in ics]
    g0 = sum(v * v for v in d) / n
    total = g0
    for k in range(1, min(lag, n - 1) + 1):
        gk = sum(d[t] * d[t - k] for t in range(k, n)) / n
        total += 2 * (1 - k / (lag + 1)) * gk
    return math.sqrt(total / n)


def _demo() -> None:
    rng = np.random.default_rng(7)
    # 60 cross-sections of 40 names; y carries a real but noisy signal from x.
    periods = []
    for _ in range(60):
        x = rng.normal(size=40)
        y = 0.25 * x + rng.normal(size=40)
        periods.append({"x": x.tolist(), "y": y.tolist()})

    out = compute_ic({"periods": periods, "horizon": 20, "step": 5})
    assert out["lag"] == 4, out["lag"]
    assert out["n_periods"] == 60
    ref = _ts_reference(out["ic_series"], 4)
    assert abs(out["nw_se"] - ref) < 1e-12, (out["nw_se"], ref)
    assert out["mean_ic"] > 0 and out["t_stat"] > 2

    # Degenerate + rejection paths.
    assert compute_ic({"periods": [{"x": [1, 1, 1], "y": [1, 2, 3]}]})["skipped_periods"] == 1
    for bad in ({"periods": []}, {"periods": [{"x": [1, 2, 3], "y": [1, 2]}]},
                {"periods": [{"x": [1, 2, 3], "y": [1, 2, "a"]}]}, {"periods": [{"x": [1], "y": [1]}], "lag": 0}):
        try:
            compute_ic(bad)
        except BadRequest:
            continue
        raise AssertionError(f"expected BadRequest for {bad}")

    assert not _authorized({"x-cron-secret": "anything"}), "must fail closed without CRON_SECRET"

    print(json.dumps({k: v for k, v in out.items() if k != "ic_series"}, indent=2))
    print(f"ts_reference_nw_se = {ref!r}")
    print("self-check OK")


if __name__ == "__main__":
    _demo()
