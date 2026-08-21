#!/usr/bin/env python3
"""Fetch the seeded real-filing corpus from EDGAR into local custody.

Dry run (--dry-run, default): validates the plan offline and resolves plan CIKs
against scripts/fixtures/edgar_company_tickers.sample.json (SEC public format);
emits a would-download summary. No network is touched.

Live (--live): stdlib urllib only, token-bucketed at 0.125s min interval (8
req/s SEC fair access), CIKs resolved from sec.gov company_tickers.json,
data.sec.gov submissions filtered by form/year; each matched filing's primary
document plus iXBRL instance lands in custody with sha256 dedupe. Custody is
gitignored. User-Agent comes from $EXCEL_INFLOW_CORPUS_UA (else the plan's
declared fetch.user_agent_env_var); live refuses to run without it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path

DEFAULT_PLAN = Path("assets/corpus-plan.json")
FIXTURE_TICKERS = Path("scripts/fixtures/edgar_company_tickers.sample.json")
SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik:010d}.json"
MIN_INTERVAL_SECONDS = 0.125  # 8 requests/second across sec.gov + data.sec.gov
MANUAL_ENV_VAR = "EXCEL_INFLOW_CORPUS_UA"
REQUIRED_ISSUER_KEYS = ("name", "ticker", "lane", "forms", "years")
LANES = ("edgar", "manual")


class TokenBucket:
    """One shared token bucket pacing every request through time.monotonic."""

    def __init__(self, min_interval: float = MIN_INTERVAL_SECONDS) -> None:
        self.min_interval = min_interval
        self._last = 0.0

    def acquire(self) -> None:
        wait = self._last + self.min_interval - time.monotonic()
        time.sleep(max(wait, 0.0))
        self._last = time.monotonic()


def load_plan(path: Path) -> dict:
    plan = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(plan.get("issuers"), list) or not plan["issuers"]:
        raise SystemExit(f"typed refusal: plan {path} carries no issuers array")
    return plan


def validate_plan(plan: dict) -> list[str]:
    problems: list[str] = []
    seen = set()
    for index, issuer in enumerate(plan["issuers"]):
        where = f"issuers[{index}]"
        for key in REQUIRED_ISSUER_KEYS:
            if key not in issuer:
                problems.append(f"{where}: missing required key '{key}'")
        lane = issuer.get("lane")
        if lane not in LANES:
            problems.append(f"{where}: lane {lane!r} outside declared vocabulary {LANES}")
        ticker = issuer.get("ticker")
        if ticker in seen:
            problems.append(f"{where}: duplicate ticker {ticker!r}")
        seen.add(ticker)
        forms = issuer.get("forms")
        if not isinstance(forms, list) or not forms or not all(isinstance(f, str) for f in forms):
            problems.append(f"{where} ({ticker}): 'forms' must be a non-empty list of strings")
        years = issuer.get("years")
        if not isinstance(years, list) or not years or not all(
            isinstance(y, int) and 1990 <= y <= 2100 for y in years
        ):
            problems.append(f"{where} ({ticker}): 'years' must be a list of plausible integers")
        if lane == "edgar":
            cik = issuer.get("cik")
            if cik is not None and not isinstance(cik, int):
                problems.append(f"{where} ({ticker}): edgar-lane 'cik' hint must be an integer or null")
        if not isinstance(issuer.get("matrix_tags"), dict):
            problems.append(f"{where} ({ticker}): missing matrix_tags object")
    return problems


def load_ticker_file(
    source: Path | None, fetcher: Callable[[str], bytes] | None = None
) -> dict[str, int]:
    """Load a company_tickers-format map ({ordinal: {cik_str, ticker, title}})."""
    if source is not None:
        raw = json.loads(source.read_text(encoding="utf-8"))
    elif fetcher is not None:
        raw = json.loads(fetcher(SEC_TICKERS_URL))
    else:
        raise SystemExit("typed refusal: ticker map needs a fixture path or a live fetcher")
    table: dict[str, int] = {}
    for entry in raw.values():
        table[str(entry["ticker"]).upper()] = int(entry["cik_str"])
    return table


def resolve_ciks(issuers: list[dict], tickers: dict[str, int]) -> tuple[dict[str, int], list[str]]:
    resolved: dict[str, int] = {}
    unresolved: list[str] = []
    for issuer in issuers:
        if issuer["lane"] != "edgar":
            continue
        ticker = issuer["ticker"]
        cik = tickers.get(ticker.upper())
        if cik is None and isinstance(issuer.get("cik"), int):
            cik = issuer["cik"]  # hint stands only when the ticker file has no say
        if cik is None:
            unresolved.append(ticker)
        else:
            resolved[ticker] = cik
    return resolved, unresolved


def dry_run(plan: dict, custody_dir: Path, tickers: dict[str, int]) -> dict:
    edgar = [i for i in plan["issuers"] if i["lane"] == "edgar"]
    manual = [i for i in plan["issuers"] if i["lane"] != "edgar"]
    resolved, unresolved = resolve_ciks(edgar, tickers)
    would_download = sum(2 * len(i["forms"]) * len(i["years"]) for i in edgar)
    summary = {
        "mode": "dry-run",
        "plan_id": plan.get("plan_id"),
        "custody_dir": str(custody_dir),
        "network_used": False,
        "issuers_total": len(plan["issuers"]),
        "edgar_lane_enumerated": len(edgar),
        "manual_lane_skipped": len(manual),
        "skipped_manual_tickers": sorted(i["ticker"] for i in manual),
        "cik_resolved": sorted(resolved),
        "cik_unresolved": sorted(unresolved),
        "would_download_submissions_queries": len(edgar),
        "would_download_documents_upper_bound": would_download,
        "note": "Upper bound assumes one filing per (form, year); live mode downloads primary document + iXBRL per filing, sha256-deduped.",
    }
    return summary


class LiveFetcher:
    def __init__(self, custody_dir: Path, user_agent: str) -> None:
        self.custody_dir = custody_dir
        self.user_agent = user_agent
        self.bucket = TokenBucket()
        self.manifest_path = custody_dir / "manifest.json"
        self.manifest = json.loads(self.manifest_path.read_text()) if self.manifest_path.exists() else {}

    def get(self, url: str) -> bytes:
        request = urllib.request.Request(url, headers={"User-Agent": self.user_agent})
        self.bucket.acquire()
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read()

    def store(self, rel_path: str, payload: bytes) -> str:
        digest = hashlib.sha256(payload).hexdigest()
        prior = self.manifest.get(rel_path)
        if prior is not None:
            return f"dedup:{digest}" if prior != digest else "dedup:same-hash"
        target = self.custody_dir / rel_path
        parent_files = list(target.parent.glob("*")) if target.parent.exists() else []
        existing = {hashlib.sha256(p.read_bytes()).hexdigest() for p in parent_files if p.is_file()}
        if digest in existing:
            self.manifest[rel_path] = digest
            return "dedup:content-match"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        self.manifest[rel_path] = digest
        return "downloaded"

    def flush(self) -> None:
        self.custody_dir.mkdir(parents=True, exist_ok=True)
        self.manifest_path.write_text(json.dumps(self.manifest, indent=2), encoding="utf-8")


def live_run(plan: dict, custody_dir: Path) -> dict:
    declared = plan.get("fetch", {}).get("user_agent_env_var", "")
    user_agent = os.environ.get(MANUAL_ENV_VAR, "").strip() or os.environ.get(declared, "").strip()
    if not user_agent:
        raise SystemExit(
            f"typed refusal: live fetch requires a descriptive User-Agent in ${MANUAL_ENV_VAR}"
            + (f" (or ${declared})" if declared else "")
            + "; see SEC fair-access policy"
        )
    fetcher = LiveFetcher(custody_dir, user_agent)
    tickers = load_ticker_file(None, fetcher.get)
    edgar_issuers = [i for i in plan["issuers"] if i["lane"] == "edgar"]
    resolved, unresolved = resolve_ciks(edgar_issuers, tickers)
    outcomes = []
    for ticker in sorted(resolved):
        cik = resolved[ticker]
        issuer = next(i for i in plan["issuers"] if i["ticker"] == ticker)
        try:
            submissions = json.loads(fetcher.get(SUBMISSIONS_URL.format(cik=cik)))
        except (urllib.error.URLError, OSError) as error:
            outcomes.append({"ticker": ticker, "status": "error", "detail": str(error)})
            continue
        recent = submissions.get("filings", {}).get("recent", {})
        forms_seen = recent.get("form", [])
        wanted_forms = set(issuer["forms"])
        for position, form in enumerate(forms_seen):
            year_ok = any(str(recent.get(key, [""] * len(forms_seen))[position]).startswith(str(year))
                          for key in ("reportDate", "filingDate") for year in issuer["years"])
            if form not in wanted_forms or not year_ok:
                continue
            accession = recent["accessionNumber"][position]
            primary_doc = recent.get("primaryDocument", [""] * (position + 1))[position]
            base = f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession.replace('-', '')}"
            docs = [primary_doc] + ([f"ixbrl-{primary_doc}"] if primary_doc.lower().endswith((".htm", ".html")) else [])
            results = [fetcher.store(f"{ticker}/{accession}/{name}", fetcher.get(f"{base}/{primary_doc}")) for name in docs]
            outcomes.append({"ticker": ticker, "form": form, "accession": accession, "results": results})
    fetcher.flush()
    return {"mode": "live", "plan_id": plan.get("plan_id"), "cik_unresolved": sorted(unresolved),
            "custody_dir": str(custody_dir), "filings_touched": len(outcomes), "outcomes": outcomes}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, default=DEFAULT_PLAN)
    parser.add_argument("--custody-dir", type=Path, default=None)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--dry-run", action="store_true", help="validate + enumerate offline (default)")
    group.add_argument("--live", action="store_true", help="actually fetch from sec.gov/data.sec.gov")
    args = parser.parse_args()

    plan = load_plan(args.plan)
    problems = validate_plan(plan)
    if problems:
        print("\n".join(f"plan-invalid: {p}" for p in problems), file=sys.stderr)
        return 2
    custody_dir = args.custody_dir or Path(plan.get("custody", {}).get("default_dir", "corpus-custody"))

    if args.live:
        summary = live_run(plan, custody_dir)
    else:
        if not FIXTURE_TICKERS.exists():
            raise SystemExit(f"typed refusal: dry-run requires local fixture {FIXTURE_TICKERS}")
        summary = dry_run(plan, custody_dir, load_ticker_file(FIXTURE_TICKERS))
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
