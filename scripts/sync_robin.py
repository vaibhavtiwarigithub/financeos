#!/usr/bin/env python3
"""
FinanceOS — Robinhood account snapshot sync
Writes positions + account data to live_account_snapshots in Supabase.
Runs via Windows Task Scheduler (hourly during market hours).

First run: python sync_robin.py --setup  (handles 2FA interactively, saves session)
Subsequent runs: python sync_robin.py    (uses saved session, no 2FA prompt)
"""

import os, sys, json, datetime, logging, argparse
from pathlib import Path

# ─── Load env vars from scripts/robin.env then .env.local ────────────────────

SCRIPT_DIR = Path(__file__).parent
ROOT_DIR   = SCRIPT_DIR.parent

for env_file in [SCRIPT_DIR / "robin.env", ROOT_DIR / ".env.local"]:
    if env_file.exists():
        with open(env_file) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip())

# ─── Config ───────────────────────────────────────────────────────────────────

SUPABASE_URL  = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")
SUPABASE_KEY  = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
ACCOUNT_ID    = os.environ.get("TRADING_ACCOUNT_NUMBER", "965848641")
ROBIN_USER    = os.environ.get("ROBIN_USERNAME", "")
ROBIN_PASS    = os.environ.get("ROBIN_PASSWORD", "")

# ─── Logging ──────────────────────────────────────────────────────────────────

log_dir = SCRIPT_DIR / "logs"
log_dir.mkdir(exist_ok=True)
log_file = log_dir / f"robin-sync-{datetime.date.today()}.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(log_file, encoding="utf-8"),
    ],
)
log = logging.getLogger("robin-sync")

# ─── Validation ───────────────────────────────────────────────────────────────

def check_deps():
    missing = []
    try:
        import robin_stocks  # noqa
    except ImportError:
        missing.append("robin_stocks")
    try:
        import requests  # noqa
    except ImportError:
        missing.append("requests")
    if missing:
        log.error(f"Missing packages: {', '.join(missing)}")
        log.error(f"Run: pip install {' '.join(missing)}")
        sys.exit(1)

def check_env():
    problems = []
    if not SUPABASE_URL: problems.append("NEXT_PUBLIC_SUPABASE_URL")
    if not SUPABASE_KEY: problems.append("SUPABASE_SERVICE_ROLE_KEY")
    if not ROBIN_USER:   problems.append("ROBIN_USERNAME")
    if not ROBIN_PASS:   problems.append("ROBIN_PASSWORD")
    if problems:
        log.error(f"Missing env vars: {', '.join(problems)}")
        log.error("Add them to scripts/robin.env")
        sys.exit(1)

# ─── Supabase insert ──────────────────────────────────────────────────────────

def insert_snapshot(data: dict):
    import requests as req
    # live_account_snapshots has a unique constraint on account_id (one row
    # per account) — a plain POST/insert crashed with a duplicate-key error
    # on every run after the first ever succeeded. Upsert via Prefer header.
    headers = {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates",
    }
    r = req.post(
        f"{SUPABASE_URL}/rest/v1/live_account_snapshots?on_conflict=account_id",
        headers=headers,
        json=data,
        timeout=15,
    )
    r.raise_for_status()
    return r.status_code

def delete_old_snapshots():
    """Keep last 48 snapshots per account — avoids table bloat."""
    import requests as req
    cutoff = (datetime.datetime.utcnow() - datetime.timedelta(days=3)).isoformat() + "Z"
    headers = {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/json",
    }
    req.delete(
        f"{SUPABASE_URL}/rest/v1/live_account_snapshots",
        headers=headers,
        params={"account_id": f"eq.{ACCOUNT_ID}", "captured_at": f"lt.{cutoff}"},
        timeout=10,
    )

# ─── Main ─────────────────────────────────────────────────────────────────────

def main(setup_mode=False):
    check_deps()
    check_env()

    import robin_stocks.robinhood as rh

    log.info("Logging into Robinhood...")
    login = rh.login(
        ROBIN_USER,
        ROBIN_PASS,
        store_session=True,
        expiresIn=86400 * 7,  # session valid 7 days
        by_sms=True,          # 2FA via SMS
    )
    if not login:
        log.error("Robinhood login failed — check credentials or 2FA")
        sys.exit(1)
    log.info("Login OK")

    # Account profile
    profile = rh.load_account_profile(info=None) or {}
    equity        = float(profile.get("equity", 0) or 0)
    buying_power  = float(profile.get("buying_power", 0) or 0)
    portfolio_val = float(profile.get("portfolio_value") or equity)

    # Positions via build_holdings (includes symbol + price + return data)
    holdings = rh.build_holdings() or {}
    positions_json = []
    for symbol, h in holdings.items():
        positions_json.append({
            "symbol":            symbol,
            "quantity":          h.get("quantity", "0"),
            "average_buy_price": h.get("average_buy_price", "0"),
            "current_price":     h.get("price", "0"),
            "equity":            h.get("equity", "0"),
            "percent_change":    h.get("percent_change", "0"),
            "name":              h.get("name", ""),
            "type":              h.get("type", "stock"),
        })

    log.info(f"Fetched {len(positions_json)} positions  |  equity=${equity:.2f}  |  buying_power=${buying_power:.2f}")

    # Insert snapshot
    row = {
        "account_id":     ACCOUNT_ID,
        "equity":         equity,
        "buying_power":   buying_power,
        "portfolio_value": portfolio_val,
        "position_count": len(positions_json),
        "positions_json": positions_json,
        "captured_at":    datetime.datetime.utcnow().isoformat() + "Z",
    }

    status = insert_snapshot(row)
    log.info(f"Supabase insert → HTTP {status}")

    # Prune rows older than 3 days
    try:
        delete_old_snapshots()
        log.info("Old snapshots pruned")
    except Exception as e:
        log.warning(f"Prune failed (non-fatal): {e}")

    rh.logout()
    log.info("Done.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--setup", action="store_true", help="Interactive first-run (handles 2FA)")
    args = parser.parse_args()
    main(setup_mode=args.setup)
