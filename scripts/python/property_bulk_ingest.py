"""Privacy-minimized Stage-1 property evidence ingestion.

Runs only in GitHub Actions or explicitly from a trusted operator shell. Large
official archives are streamed to temporary disk, filtered to owner-selected
scopes, and discarded. Owner names and mailing addresses are never parsed.

Required env:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  PROPERTY_DATA_ENCRYPTION_KEY  (same base64 master used by FinanceOS)

The master key is used only as a domain-separated HMAC key here. Raw parcel
identifiers and situs addresses are never written or logged.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import hmac
import io
import json
import os
import re
import tempfile
import urllib.parse
import urllib.error
import urllib.request
import uuid
import zipfile
from collections import Counter
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable

MARICOPA_ITEM = "f3484c72a938497286adc4e5de7e9963"
MARICOPA_URL = f"https://www.arcgis.com/sharing/rest/content/items/{MARICOPA_ITEM}/data"
MARICOPA_META = f"https://www.arcgis.com/sharing/rest/content/items/{MARICOPA_ITEM}?f=json"
TCAD_PAGE = "https://traviscad.org/publicinformation/"
MARICOPA_HEADER = [
    "PARCELNUMBER", "SALEDATE_MMYYYY", "SALEPRICE", "DEEDNUMBER", "DEEDDATE_MMDDYYYY", "DEEDSTATUS",
    "DEEDTYPE", "PROPERTYTYPECODE", "PROPERTYTYPEDESCRIPTION", "PROPERTYTYPEOTHERDESCRIPTION",
    "SITUSADDRESS", "SITUSSUITE", "SITUSCITY", "SITUSZIP", "GRANTOROWNERNAME",
    "GRANTORADDRESSLINE1", "GRANTORADDRESSLINE2", "GRANTORCITY", "GRANTORSTATE",
    "GRANTORZIP", "GRANTORCOUNTRY", "GRANTEEOWNERNAME", "GRANTEEADDRESSLINE1",
    "GRANTEEADDRESSLINE2", "GRANTEECITY", "GRANTEESTATE", "GRANTEEZIP",
    "GRANTEECOUNTRY", "FINANCETYPECODE", "FINANCETYPEOTHERDESCRIPTION", "DOWNPAYMENT",
    "PARTIALINTERESTINDICATOR", "PARTIALINTERESTPERCENT", "PARTIALINTERESTDESCRIPTION",
    "MULTIPARCELINDICATOR", "NUMBEROFPARCELS", "BUY_SELLRELATIONSHIPINDICATOR",
    "BUY_SELLRELATIONSHIP", "OWNEROCCUPANCYINDICATOR", "ASSESSORCODE",
    "ASSESSORCODEDESCRIPTION", "PERSONALPROPERTYINDICATOR", "PERSONALPROPERTYVALUE",
    "PERSONALPROPERTYDESCRIPTION",
]


def _master_key() -> bytes:
    raw = os.environ.get("PROPERTY_DATA_ENCRYPTION_KEY", "")
    try:
        decoded = base64.b64decode(raw, validate=True)
    except Exception as exc:
        raise RuntimeError("PROPERTY_DATA_ENCRYPTION_KEY is not valid base64") from exc
    if len(decoded) != 32:
        raise RuntimeError("PROPERTY_DATA_ENCRYPTION_KEY must decode to 32 bytes")
    return decoded


def lookup_key(domain: str, value: str, key: bytes) -> str:
    normalized = " ".join(value.strip().upper().split())
    if not normalized:
        raise ValueError("empty lookup value")
    return hmac.new(key, f"property:{domain}:v1\0{normalized}".encode(), hashlib.sha256).hexdigest()


def payload_hash(values: Iterable[object]) -> str:
    return hashlib.sha256(json.dumps(list(values), separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()


class SupabaseRest:
    def __init__(self) -> None:
        self.url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        self.key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        if not self.url or not self.key:
            raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")

    def request(self, method: str, path: str, body: object | None = None, prefer: str | None = None):
        headers = {"apikey": self.key, "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"}
        if prefer:
            headers["Prefer"] = prefer
        req = urllib.request.Request(f"{self.url}/rest/v1/{path}", data=None if body is None else json.dumps(body).encode(), method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=120) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            message = exc.read().decode(errors="replace")[:500]
            raise RuntimeError(f"Supabase {method} {path} failed ({exc.code}): {message}") from exc

    def scopes(self, source: str) -> list[dict]:
        query = urllib.parse.urlencode({"select": "market_slug,scope_kind,scope_value", "source_key": f"eq.{source}", "active": "eq.true"})
        return self.request("GET", f"property_valuation_scopes?{query}") or []

    def insert(self, table: str, rows: list[dict], *, ignore: bool = False) -> list[dict] | None:
        prefer = "return=representation"
        if ignore:
            prefer = "resolution=ignore-duplicates,return=representation"
        return self.request("POST", table, rows, prefer)


def download(url: str, target: Path) -> tuple[str, int]:
    digest = hashlib.sha256(); size = 0
    request = urllib.request.Request(url, headers={"User-Agent": "KairosProperty/1.0 owner-research"})
    with urllib.request.urlopen(request, timeout=120) as response, target.open("wb") as output:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk); output.write(chunk); size += len(chunk)
    return digest.hexdigest(), size


def parse_sale_month(raw: str) -> str | None:
    if not re.fullmatch(r"\d{6}", raw):
        return None
    month, year = int(raw[:2]), int(raw[2:])
    if not 1 <= month <= 12 or not 1900 <= year <= 2100:
        return None
    return f"{year:04d}-{month:02d}-01"


def parse_deed_date(raw: str) -> str | None:
    if not re.fullmatch(r"\d{8}", raw): return None
    month, day, year = int(raw[:2]), int(raw[2:4]), int(raw[4:])
    try: return datetime(year, month, day).date().isoformat()
    except ValueError: return None


def parse_maricopa_line(line: str, zips: set[str], key: bytes) -> tuple[dict | None, str | None]:
    fields = next(csv.reader([line], delimiter="|", quotechar='"'))
    if len(fields) != 44:
        return None, "malformed_row"
    code = fields[7].strip()
    if code not in {"B", "C"}:
        return None, "not_residential"
    for index, reason in ((31, "partial_interest"), (34, "multi_parcel"), (36, "related_party"), (41, "personal_property")):
        if fields[index].strip().upper() == "Y":
            return None, reason
    postal = fields[13].strip()[:5]
    if postal not in zips:
        return None, "outside_scope"
    month = parse_sale_month(fields[1].strip())
    if not month:
        return None, "bad_date"
    try:
        price = float(fields[2])
    except ValueError:
        return None, "no_price"
    if price <= 0:
        return None, "no_price"
    parcel = fields[0].strip()
    if not parcel:
        return None, "malformed_row"
    deed_number = fields[3].strip(); deed_date = parse_deed_date(fields[4].strip())
    if not deed_number or not deed_date:
        return None, "bad_deed_identity"
    parcel_key = lookup_key("parcel", parcel, key)
    row = {
        "source_key": "maricopa-sales", "market_slug": "phoenix",
        "parcel_key": parcel_key,
        "event_key": hmac.new(key, f"property:sale-event:v1\0{parcel_key}\0{deed_number}\0{deed_date}".encode(), hashlib.sha256).hexdigest(),
        "postal_code": postal, "sale_month": month, "deed_date": deed_date,
        "sale_price": price, "property_type": code,
        "deed_type": fields[6].strip() or None, "deed_status": fields[5].strip() or None,
        "assessor_code": fields[39].strip() or None,
        "assessor_code_description": fields[40].strip() or None,
    }
    row["source_payload_hash"] = payload_hash(row.values())
    return row, None


class TcadLinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(); self.links: list[tuple[str, str]] = []; self._href: str | None = None; self._text: list[str] = []
    def handle_starttag(self, tag, attrs):
        if tag == "a": self._href = dict(attrs).get("href"); self._text = []
    def handle_data(self, data):
        if self._href: self._text.append(data)
    def handle_endtag(self, tag):
        if tag == "a" and self._href:
            self.links.append((" ".join(self._text).strip(), urllib.parse.urljoin(TCAD_PAGE, self._href)))
            self._href = None; self._text = []


def current_tcad_export_url() -> str:
    with urllib.request.urlopen(urllib.request.Request(TCAD_PAGE, headers={"User-Agent": "KairosProperty/1.0"}), timeout=30) as response:
        html = response.read().decode(errors="replace")
    parser = TcadLinkParser(); parser.feed(html)
    for text, href in parser.links:
        if "Certified Appraisal Export" in text and href.lower().endswith(".zip"):
            return href
    raise RuntimeError("TCAD certified appraisal export link not found; source layout may have changed")


def _fixed(line: str, start: int, end: int) -> str:
    return line[start - 1:end].strip()


def _number(raw: str) -> float | None:
    try: return float(raw) if raw else None
    except ValueError: return None


def parse_tcad_archive(archive: Path, wanted: set[str], key: bytes) -> tuple[list[dict], Counter, int]:
    parcels: dict[str, dict] = {}; rejected: Counter = Counter(); seen = 0
    with zipfile.ZipFile(archive) as zf:
        names = zf.namelist()
        prop_name = next((n for n in names if n.upper().endswith(("APPRAISAL_INFO.TXT", "PROP.TXT"))), None)
        if not prop_name: raise RuntimeError("TCAD property file missing; source layout changed")
        with zf.open(prop_name) as raw, io.TextIOWrapper(raw, encoding="latin-1", errors="replace") as text:
            for line in text:
                seen += 1; prop_id = _fixed(line, 1, 12)
                if not prop_id or lookup_key("parcel", prop_id, key) not in wanted: continue
                parcel_key = lookup_key("parcel", prop_id, key)
                postal = _fixed(line, 1140, 1149)[:5]
                parcels[parcel_key] = {
                    "source_key": "tcad-appraisal", "market_slug": "austin", "parcel_key": parcel_key,
                    "postal_code": postal if re.fullmatch(r"\d{5}", postal) else None,
                    "property_type": _fixed(line, 13, 17) or None,
                    "valuation_year": int(_fixed(line, 18, 22) or 0) or None,
                    "county_appraised_value": _number(_fixed(line, 1916, 1930)),
                    "county_assessed_value": _number(_fixed(line, 1946, 1960)),
                    "livable_sqft": None, "land_sqft": None, "year_built": None,
                }
        detail_name = next((n for n in names if n.upper().endswith(("APPRAISAL_IMPROVEMENT_DETAIL.TXT", "IMP_DET.TXT"))), None)
        if detail_name:
            with zf.open(detail_name) as raw, io.TextIOWrapper(raw, encoding="latin-1", errors="replace") as text:
                for line in text:
                    p = lookup_key("parcel", _fixed(line, 1, 12), key)
                    if p not in parcels: continue
                    area = _number(_fixed(line, 94, 108)) or 0
                    parcels[p]["livable_sqft"] = (parcels[p]["livable_sqft"] or 0) + area
                    year = int(_number(_fixed(line, 86, 89)) or 0)
                    if year: parcels[p]["year_built"] = min(parcels[p]["year_built"] or year, year)
        land_name = next((n for n in names if n.upper().endswith(("APPRAISAL_LAND_DETAIL.TXT", "LAND_DET.TXT"))), None)
        if land_name:
            with zf.open(land_name) as raw, io.TextIOWrapper(raw, encoding="latin-1", errors="replace") as text:
                for line in text:
                    p = lookup_key("parcel", _fixed(line, 1, 12), key)
                    if p not in parcels: continue
                    area = _number(_fixed(line, 84, 97)) or 0
                    parcels[p]["land_sqft"] = (parcels[p]["land_sqft"] or 0) + area
    for parcel in parcels.values(): parcel["source_payload_hash"] = payload_hash(parcel.values())
    rejected["requested_not_found"] = len(wanted - set(parcels))
    return list(parcels.values()), rejected, seen


def batch(rows: list[dict], size: int = 500):
    for index in range(0, len(rows), size): yield rows[index:index + size]


def run(source: str) -> int:
    rest = SupabaseRest(); key = _master_key(); scopes = rest.scopes(source)
    if not scopes:
        print(f"NO_SCOPE source={source}; no download performed")
        return 0
    started = datetime.now(timezone.utc).isoformat(); counts: Counter = Counter()
    scope_values = {s["scope_value"] for s in scopes}
    scope_fingerprint = hashlib.sha256("\n".join(sorted(scope_values)).encode()).hexdigest()
    with tempfile.TemporaryDirectory(prefix="kairos-property-") as temp:
        target = Path(temp) / f"{source}.zip"
        if source == "maricopa-sales":
            with urllib.request.urlopen(MARICOPA_META, timeout=30) as response: metadata = json.load(response)
            release = str(metadata.get("modified") or "unknown")
            url = MARICOPA_URL
        else:
            url = current_tcad_export_url(); release = Path(urllib.parse.urlparse(url).path).name
        digest, _ = download(url, target)
        if source == "maricopa-sales":
            rows: list[dict] = []; seen = 0
            with zipfile.ZipFile(target) as zf:
                name = next((n for n in zf.namelist() if n.replace("\\", "/").endswith("Data/Sales_Affidavits.txt")), None)
                if not name: raise RuntimeError("Maricopa Sales_Affidavits.txt missing; source layout changed")
                with zf.open(name) as raw, io.TextIOWrapper(raw, encoding="latin-1", errors="replace") as text:
                    header = next(csv.reader([next(text, "")], delimiter="|", quotechar='"'), [])
                    normalized_header = [cell.strip().upper().replace(" ", "") for cell in header]
                    if normalized_header != MARICOPA_HEADER:
                        raise RuntimeError("Maricopa header does not match the audited 44-column R102 schema")
                    for line in text:
                        seen += 1; row, reason = parse_maricopa_line(line.rstrip("\r\n"), scope_values, key)
                        if row: rows.append(row)
                        elif reason: counts[reason] += 1
            market, table = "phoenix", "property_sales"
        else:
            rows, counts, seen = parse_tcad_archive(target, scope_values, key)
            market, table = "austin", "property_parcel_snapshots"
        snapshot_id = str(uuid.uuid4())
        snapshot = {"id": snapshot_id, "source_key": source, "market_slug": market, "source_release_id": release, "source_url": url, "source_sha256": digest, "scope_fingerprint": scope_fingerprint, "started_at": started, "completed_at": datetime.now(timezone.utc).isoformat(), "outcome": "partial", "rows_seen": seen, "rows_written": 0, "rejection_counts": {**dict(counts), "selected_rows": len(rows)}, "detail": "Normalized successfully; authoritative write outcome is recorded in the append-only event ledger"}
        rest.insert("property_bulk_snapshots", [snapshot])
        rest.insert("property_bulk_snapshot_events", [{"bulk_snapshot_id": snapshot_id, "event_type": "write_started", "rows_written": 0}])
        written = 0
        try:
            for part in batch(rows):
                foreign_key = "observed_snapshot_id" if table == "property_sales" else "bulk_snapshot_id"
                for row in part: row[foreign_key] = snapshot_id
                inserted = rest.insert(table, part, ignore=True) or []
                written += len(inserted)
            rest.insert("property_bulk_snapshot_events", [{"bulk_snapshot_id": snapshot_id, "event_type": "write_completed", "rows_written": written}])
        except Exception as exc:
            rest.insert("property_bulk_snapshot_events", [{"bulk_snapshot_id": snapshot_id, "event_type": "write_failed", "rows_written": written, "detail": type(exc).__name__}])
            raise
    print(json.dumps({"source": source, "snapshot": snapshot_id, "rows_seen": seen, "rows_selected": len(rows), "rows_written": written, "rejections": counts}, default=dict))
    return 0


def self_check() -> None:
    key = bytes(range(32))
    assert lookup_key("parcel", " 123 ", key) == lookup_key("parcel", "123", key)
    assert lookup_key("parcel", "123", key) != lookup_key("address", "123", key)
    assert parse_sale_month("022024") == "2024-02-01"
    assert parse_sale_month("132024") is None
    fields = [""] * 44
    fields[0] = "123"; fields[1] = "022024"; fields[2] = "500000"; fields[3] = "D-1"; fields[4] = "02152024"; fields[7] = "B"; fields[10] = "1 Main St"; fields[13] = "85001"
    parsed, reason = parse_maricopa_line("|".join(fields), {"85001"}, key)
    assert reason is None and parsed and parsed["sale_price"] == 500000
    assert "1 Main St" not in json.dumps(parsed) and "D-1" not in json.dumps(parsed)
    print("property bulk ingest self-check OK")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", choices=("maricopa-sales", "tcad-appraisal"))
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    if args.self_check: self_check()
    elif not args.source: parser.error("--source is required")
    else: raise SystemExit(run(args.source))
