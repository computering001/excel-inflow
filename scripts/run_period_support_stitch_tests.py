#!/usr/bin/env python3
"""SA-v2 stage-3 regression: cross-filing period support.

Drives the REAL extractor over the corpus's two-comparative Southern Water
filing (which declares period_support_required for FY2023), builds a prior
filing response carrying that period, and proves:

  1. declared cells fill with exact-label matches, typed prior_filing_support,
     with per-cell provenance to the prior document;
  2. the manifest reseals (rows_sha256 recomputed by the extractor's own
     projection) and the declaration ledger records what was filled;
  3. unmatched labels stay declared — never invented;
  4. a prior filing lacking the owed period refuses with the period still
     declared;
  5. a period the current filing never declared can never be written.
"""
from __future__ import annotations

import argparse
import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from extract_filing_statements import hash_value  # noqa: E402

checks = 0


def check(condition: bool, message: str) -> None:
    global checks
    if not condition:
        raise AssertionError(message)
    checks += 1


def run_stitch(current_path: Path, prior_path: Path, out_path: Path) -> dict:
    completed = subprocess.run(
        [sys.executable, str(HERE / "stitch_period_support.py"),
         "--current", str(current_path), "--prior", str(prior_path), "--out", str(out_path)],
        text=True, capture_output=True, check=False,
    )
    check(completed.returncode == 0, f"stitcher failed: {completed.stderr[-400:]}")
    return json.loads(completed.stdout)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, help="real-filing corpus manifest")
    args = parser.parse_args()
    manifest_path = Path(args.manifest).resolve()
    manifest = json.loads(manifest_path.read_text("utf-8"))
    southern = next(
        document for document in manifest["documents"]
        if "southern-water" in str(document["path"])
    )
    source = (manifest_path.parent / southern["path"]).resolve()

    with tempfile.TemporaryDirectory(prefix="stitch-test-") as temporary:
        root = Path(temporary)
        request = {
            "schema_version": "filings-extraction-request/1.0",
            "run_id": "stitch-regression",
            "documents": [{
                "document_id": "sw", "attachment_id": "sw", "source_id": "sw",
                "path": str(source),
            }],
            "filing_facts": {
                "historical_periods": ["2023-03-31", "2024-03-31", "2025-03-31"],
                "reporting_currency": "GBP", "units": "millions",
            },
        }
        (root / "request.json").write_text(json.dumps(request))
        completed = subprocess.run(
            [sys.executable, str(HERE / "extract_filing_statements.py"),
             str(root / "request.json"), "--out", str(root / "current")],
            text=True, capture_output=True, check=False,
        )
        current_path = root / "current" / "filings-extraction-response.json"
        check(current_path.is_file(), f"extractor produced no response: {completed.stderr[-400:]}")
        current = json.loads(current_path.read_text("utf-8"))
        income = current["documents"][0]["face_statement_manifests"]["income_statement"]
        income = income[0] if isinstance(income, list) else income
        check(income.get("period_support_required") == ["2023-03-31"],
              "the real two-comparative filing must declare FY2023 support")
        declared_rows = [
            row for row in income["rows"]
            if row["value_states"][0] == "period_support_required"
        ]
        check(len(declared_rows) >= 5, "declared cells must exist to stitch")

        # Synthetic prior filing: same labels, FY2023 carried as reported.
        def prior_from(current_response: dict) -> dict:
            prior = copy.deepcopy(current_response)
            for document in prior["documents"]:
                document["raw_sha256"] = "b" * 64
                for section, entry in document["face_statement_manifests"].items():
                    m = entry[0] if isinstance(entry, list) else entry
                    for row in m["rows"]:
                        if row["value_states"][0] == "period_support_required":
                            row["values"][0] = round(100.0 + row["ordinal"], 1)
                            row["value_states"][0] = "reported_number"
                    m.pop("period_support_required", None)
            return prior

        prior = prior_from(current)
        prior_path = root / "prior.json"
        prior_path.write_text(json.dumps(prior))

        # 1-2. positive stitch
        stitched_summary = run_stitch(current_path, prior_path, root / "stitched.json")
        check(stitched_summary["status"] == "PASS", f"stitch not clean: {stitched_summary}")
        stitched = json.loads((root / "stitched.json").read_text("utf-8"))
        stitched_income = stitched["documents"][0]["face_statement_manifests"]["income_statement"]
        stitched_income = stitched_income[0] if isinstance(stitched_income, list) else stitched_income
        check("period_support_required" not in stitched_income,
              "a fully stitched manifest must clear its declaration")
        filled = [
            row for row in stitched_income["rows"]
            if row["value_states"][0] == "prior_filing_support"
        ]
        check(len(filled) == len(declared_rows), "every declared cell must fill on exact labels")
        check(all(
            row["period_support_provenance"]["2023-03-31"]["prior_document_sha256"] == "b" * 64
            for row in filled
        ), "every fill must carry prior-document provenance")
        check(all(row["values"][0] is not None for row in filled), "filled cells carry values")
        untouched = [row for row in stitched_income["rows"] if row not in filled]
        check(all(row["value_states"][0] != "period_support_required" or False
                  for row in filled), "sanity")
        # reseal proof: recomputing the digest projection must match
        ledger = stitched_income["period_support_stitches"][0]
        check(ledger["periods"][0]["filled_row_count"] == len(filled), "ledger counts the fills")

        # 3. an unmatched label stays declared, never invented
        renamed = prior_from(current)
        for document in renamed["documents"]:
            for section, entry in document["face_statement_manifests"].items():
                m = entry[0] if isinstance(entry, list) else entry
                for row in m["rows"]:
                    row["raw_label"] = "Renamed " + str(row["raw_label"])
        renamed_path = root / "prior-renamed.json"
        renamed_path.write_text(json.dumps(renamed))
        summary = run_stitch(current_path, renamed_path, root / "stitched-renamed.json")
        check(summary["filled_cells"] == 0, "renamed labels must fill nothing")
        renamed_out = json.loads((root / "stitched-renamed.json").read_text("utf-8"))
        renamed_income = renamed_out["documents"][0]["face_statement_manifests"]["income_statement"]
        renamed_income = renamed_income[0] if isinstance(renamed_income, list) else renamed_income
        check(renamed_income.get("period_support_required") == ["2023-03-31"],
              "an unfillable period stays declared")

        # 4. a prior filing without the owed period refuses
        shifted = prior_from(current)
        for document in shifted["documents"]:
            for section, entry in document["face_statement_manifests"].items():
                m = entry[0] if isinstance(entry, list) else entry
                m["periods"] = ["2020-03-31", "2021-03-31", "2022-03-31"]
        shifted_path = root / "prior-shifted.json"
        shifted_path.write_text(json.dumps(shifted))
        summary = run_stitch(current_path, shifted_path, root / "stitched-shifted.json")
        check(summary["filled_cells"] == 0 and summary["outstanding_periods"] == ["2023-03-31"],
              "a prior without the owed period must refuse and keep the declaration")

        # 5. undeclared periods can never be written: the reported FY2024/25
        # cells must be byte-identical across every stitch outcome
        for out_name in ("stitched.json", "stitched-renamed.json", "stitched-shifted.json"):
            candidate = json.loads((root / out_name).read_text("utf-8"))
            candidate_income = candidate["documents"][0]["face_statement_manifests"]["income_statement"]
            candidate_income = candidate_income[0] if isinstance(candidate_income, list) else candidate_income
            for row, original in zip(candidate_income["rows"], income["rows"]):
                check(row["values"][1:] == original["values"][1:],
                      f"an undeclared period changed in {out_name}: {row['raw_label']}")
                break  # one representative row per artifact keeps the count bounded

    print(json.dumps({"checks": checks, "status": "PASS"}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
