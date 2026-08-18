#!/usr/bin/env python3
"""Inline XBRL structured-lane regression against REAL SEC filings.

The real-filing corpus's two HTML documents were terminally
BLOCKED_HTML_NATIVE_EXTRACTOR_UNSUPPORTED — the harness never attempted them.
This suite proves the structured lane's first brick on those exact bytes:
facts parse with concepts, contexts, periods, units, scale and sign; a known
three-year revenue history reads back exactly; and the emitted fact table is
byte-deterministic across runs.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def extract(source: Path, out: Path) -> dict:
    completed = subprocess.run(
        [sys.executable, str(HERE / "extract_inline_xbrl.py"), str(source), "--out", str(out)],
        text=True, capture_output=True, check=False,
    )
    check(completed.returncode == 0, f"extractor failed on {source.name}: {completed.stderr[-500:]}")
    return json.loads(out.read_text("utf-8"))


def undimensioned(facts, local_name):
    return [
        fact for fact in facts
        if fact["concept"].split(":")[-1] == local_name and not fact["dimensions"]
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, help="real-filing corpus manifest")
    args = parser.parse_args()
    manifest_path = Path(args.manifest).resolve()
    manifest = json.loads(manifest_path.read_text("utf-8"))
    html_documents = [
        document for document in manifest.get("documents", [])
        if str(document.get("path", "")).endswith((".htm", ".html"))
    ]
    check(len(html_documents) >= 2, "the corpus must supply at least two HTML filings")
    checks = 0
    with tempfile.TemporaryDirectory(prefix="inline-xbrl-") as temporary:
        root = Path(temporary)
        annual = None
        for index, document in enumerate(html_documents):
            source = (manifest_path.parent / document["path"]).resolve()
            check(source.is_file(), f"corpus source absent: {source}")
            first = extract(source, root / f"facts-{index}-a.json")
            check(first["fact_count"] > 100, f"{source.name}: suspiciously few facts ({first['fact_count']})")
            check(first["context_count"] > 10, f"{source.name}: contexts missing")
            check(first["source_sha256"] == sha256_file(source), f"{source.name}: source hash not bound")
            # Determinism: identical bytes on a second run.
            extract(source, root / f"facts-{index}-b.json")
            check(
                sha256_file(root / f"facts-{index}-a.json") == sha256_file(root / f"facts-{index}-b.json"),
                f"{source.name}: fact table is not byte-deterministic",
            )
            checks += 4
            if "10k" in source.name.lower() or "annual" in source.name.lower():
                annual = first
        check(annual is not None, "the corpus supplies no annual HTML filing")
        checks += 1
        # The known Apple FY2023-FY2025 consolidated revenue history must read
        # back exactly from structured facts — no ratio, label or layout logic.
        revenue = undimensioned(annual["facts"], "RevenueFromContractWithCustomerExcludingAssessedTax")
        by_period = {}
        for fact in revenue:
            period = fact["period"].get("end")
            if period:
                by_period.setdefault(period, set()).add(fact["value"])
        check(len(by_period) >= 3, "the annual filing must carry a three-year revenue history")
        for period, values in by_period.items():
            check(len(values) == 1, f"revenue facts disagree for {period}: {sorted(values)}")
        expected = {
            "2023-09-30": 383_285_000_000.0,
            "2024-09-28": 391_035_000_000.0,
            "2025-09-27": 416_161_000_000.0,
        }
        for period, value in expected.items():
            check(by_period.get(period) == {value},
                  f"revenue {period}: expected {value}, got {by_period.get(period)}")
        net_income = undimensioned(annual["facts"], "NetIncomeLoss")
        check(len(net_income) >= 3, "net income history missing")
        check(all(fact["unit_ref"] for fact in revenue), "revenue facts lack unit bindings")
        checks += 3 + len(by_period) + len(expected)
    print(json.dumps({"checks": checks, "status": "PASS"}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
