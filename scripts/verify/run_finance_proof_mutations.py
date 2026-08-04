#!/usr/bin/env python3
"""Prove the independent finance oracle rejects targeted workbook corruption.

Usage:
    python3 scripts/verify/run_finance_proof_mutations.py \
        CASE.json WORKBOOK.xlsx --out FOLDER
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    __package__ = "verify"

from .xlsx import Workbook  # noqa: E402


def replace_cached_value(xml: str, address: str, delta: float) -> str:
    pattern = re.compile(
        r'(<(?:[A-Za-z_][\w.-]*:)?c\b(?=[^>]*\br="%s")[^>]*>[\s\S]*?'
        r'<(?:[A-Za-z_][\w.-]*:)?v\b[^>]*>)([^<]*)(</(?:[A-Za-z_][\w.-]*:)?v>)'
        % re.escape(address)
    )
    matches = list(pattern.finditer(xml))
    if len(matches) != 1:
        raise RuntimeError("expected one cached value at %s, found %d" % (address, len(matches)))

    def changed(match: re.Match) -> str:
        value = float(match.group(2) or 0.0)
        return "%s%s%s" % (match.group(1), value + delta, match.group(3))

    return pattern.sub(changed, xml, count=1)


def mutate_workbook(source: str, destination: str, sheet_part: str,
                    address: str, delta: float) -> None:
    with zipfile.ZipFile(source, "r") as incoming, zipfile.ZipFile(
        destination, "w", compression=zipfile.ZIP_DEFLATED
    ) as outgoing:
        for info in incoming.infolist():
            data = incoming.read(info.filename)
            if info.filename == sheet_part:
                text = data.decode("utf-8")
                data = replace_cached_value(text, address, delta).encode("utf-8")
            outgoing.writestr(info, data)


def run_proof(script: str, case_path: str, workbook_path: str, report_path: str):
    completed = subprocess.run(
        [sys.executable, script, case_path, workbook_path, "--out", report_path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    report = None
    if os.path.exists(report_path):
        with open(report_path, "r", encoding="utf-8") as handle:
            report = json.load(handle)
    return completed, report


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("case")
    parser.add_argument("workbook")
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)
    with open(args.workbook + ".row-map.json", "r", encoding="utf-8") as handle:
        rows = json.load(handle)
    with open(args.case, "r", encoding="utf-8") as handle:
        case = json.load(handle)
    workbook = Workbook.open(args.workbook)
    sheet_part = workbook.sheet("Operating Model").part
    finance_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "finance_proof.py")

    baseline_report = os.path.join(args.out, "baseline.json")
    baseline_run, baseline = run_proof(
        finance_script, args.case, args.workbook, baseline_report
    )
    if baseline_run.returncode != 0 or not baseline or baseline.get("status") != "PASS":
        raise RuntimeError("clean finance proof did not pass before mutation")

    first_instrument = next(
        item for item in rows["instruments"] if item.get("interest_row")
    )
    controls = rows["controls"]
    debt = rows["debt_summary_rows"]
    interest = rows["interest_summary_rows"]
    waterfall = rows["waterfall_rows"]
    close_index = 0
    acquisition = case.get("acquisition") or {}
    if int(float(acquisition.get("enabled", 0))) == 1:
        close_year = int(acquisition["close_year"])
        for index, period in enumerate(case["periods"][3:]):
            if int(period["date"][:4]) == close_year:
                close_index = index
                break
    pro_forma_close_column = ("S", "T", "U")[close_index]
    mutations = [
        ("control-circularity", "controls", "C%d" % controls["circularity"], 1.0),
        ("instrument-debt", "instrument-debt", "J%d" % first_instrument["debt_row"], 17.0),
        ("instrument-interest", "instrument-interest", "J%d" % first_instrument["interest_row"], 3.0),
        ("rcf-draw", "rcf-waterfall", "J%d" % waterfall["rcf_draw_waterfall"], 11.0),
        ("rcf-repayment", "rcf-waterfall", "J%d" % waterfall["rcf_repayment_waterfall"], 13.0),
        ("rcf-ending", "rcf-waterfall", "J%d" % waterfall["ending_rcf"], 19.0),
        ("rcf-interest", "interest", "J%d" % interest["rcf_interest"], 5.0),
        ("rcf-commitment-fee", "interest", "J%d" % interest["rcf_commitment_fee"], 7.0),
        ("rcf-undrawn", "liquidity", "J%d" % debt["undrawn_rcf"], 17.0),
        ("acquisition-debt", "acquisition", "%s%d" % (pro_forma_close_column, debt["acquisition_debt"]), 23.0),
        ("lease-liability", "lease", "J%d" % debt["lease_liability"], 29.0),
        ("gross-interest", "interest", "J%d" % interest["gross_interest_expense"], 31.0),
        ("total-liquidity", "liquidity", "J%d" % debt["total_liquidity"], 37.0),
        ("leverage", "leverage", "J%d" % debt["net_debt_to_adjusted_ebitda"], 0.5),
    ]
    if debt.get("debt_fx_translation") is not None:
        mutations.append(
            (
                "debt-fx-translation",
                "debt-fx",
                "J%d" % debt["debt_fx_translation"],
                23.0,
            )
        )
    pik_instrument = next(
        (item for item in rows["instruments"] if item.get("pik_row") and item.get("pik_interest_row")),
        None,
    )
    if pik_instrument:
        mutations.extend(
            [
                ("pik-principal", "instrument-debt", "J%d" % pik_instrument["pik_row"], 11.0),
                ("pik-interest", "instrument-interest", "J%d" % pik_instrument["pik_interest_row"], 7.0),
            ]
        )
    cash_buckets = rows.get("cash_buckets") or []
    if cash_buckets:
        first_bucket = cash_buckets[0]
        mutations.extend(
            [
                (
                    "cash-bucket-balance",
                    "cash-buckets",
                    "J%d" % first_bucket["balance_row"],
                    13.0,
                ),
                (
                    "cash-bucket-interest",
                    "cash-buckets",
                    "J%d" % first_bucket["interest_row"],
                    5.0,
                ),
                (
                    "reported-cash",
                    "cash-buckets",
                    "J%d" % debt["reported_cash"],
                    17.0,
                ),
                (
                    "liquidity-cash",
                    "cash-buckets",
                    "J%d" % debt["liquidity_cash"],
                    19.0,
                ),
                (
                    "cash-for-net-debt",
                    "cash-buckets",
                    "J%d" % debt["cash_for_net_debt"],
                    23.0,
                ),
            ]
        )

    results = []
    for mutation_id, expected_check, address, delta in mutations:
        mutated = os.path.join(args.out, "%s.xlsx" % mutation_id)
        report_path = os.path.join(args.out, "%s.json" % mutation_id)
        mutate_workbook(args.workbook, mutated, sheet_part, address, delta)
        shutil.copyfile(
            args.workbook + ".row-map.json",
            mutated + ".row-map.json",
        )
        completed, report = run_proof(
            finance_script, args.case, mutated, report_path
        )
        observed_checks = sorted(
            {item.get("check") for item in (report or {}).get("findings", [])}
        )
        rejected = (
            completed.returncode != 0
            and (report or {}).get("status") == "FAIL"
            and expected_check in observed_checks
        )
        results.append(
            {
                "id": mutation_id,
                "address": address,
                "delta": delta,
                "expected_check": expected_check,
                "observed_checks": observed_checks,
                "status": "PASS" if rejected else "FAIL",
                "proof_exit_code": completed.returncode,
            }
        )

    report = {
        "schema_version": 1,
        "kind": "independent_finance_proof_mutations",
        "status": "PASS" if all(item["status"] == "PASS" for item in results) else "FAIL",
        "case": os.path.abspath(args.case),
        "workbook": os.path.abspath(args.workbook),
        "case_sha256": hashlib.sha256(open(args.case, "rb").read()).hexdigest(),
        "workbook_sha256": hashlib.sha256(open(args.workbook, "rb").read()).hexdigest(),
        "row_map_sha256": hashlib.sha256(
            open(args.workbook + ".row-map.json", "rb").read()
        ).hexdigest(),
        "baseline_status": baseline.get("status"),
        "summary": {
            "passed": sum(item["status"] == "PASS" for item in results),
            "failed": sum(item["status"] == "FAIL" for item in results),
        },
        "mutations": results,
    }
    final_path = os.path.join(args.out, "finance-proof-mutations.json")
    with open(final_path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(
        "STATUS=%s mutations=%d/%d rejected\n%s"
        % (report["status"], report["summary"]["passed"], len(results), final_path)
    )
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
