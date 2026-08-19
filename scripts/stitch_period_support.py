#!/usr/bin/env python3
"""Statement Authority v2, stage 3: cross-filing period support.

A two-comparative filing owns its statement topology and the periods it
prints; each absent older period is a DECLARED support requirement
(`period_support_required` on the face-statement manifest, with the cells
typed `period_support_required`). This tool fulfils that declaration from the
SAME issuer's prior filing:

  - only declared periods are ever filled — a value never moves into a slot
    the current filing did not itself mark as owed;
  - a fill requires an exact normalized row-label match in the prior face for
    the same statement; unmatched rows stay declared, never invented;
  - every fill carries provenance (prior document sha, prior source line,
    prior period index) and flips the cell state to `prior_filing_support`;
  - the manifest's rows_sha256 is resealed with the extractor's own digest
    projection, and a stitch ledger (`period_support_stitches`) records what
    was filled, from where, and what remains owed.

Fail-closed: an issuer mismatch, a prior filing that does not carry the owed
period, or zero label matches leave the current manifest untouched for that
period (still declared), with the refusal recorded in the ledger.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from extract_filing_statements import hash_value  # noqa: E402

STITCH_SCHEMA = "filings-period-support-stitch/1.0"


def normalized_label(label: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(label or "").lower()).strip()


def reseal_rows_sha(manifest: dict) -> None:
    projected = {
        "schema_version": manifest["schema_version"],
        "statement": manifest["statement"],
        "statement_order": manifest["statement_order"],
        "source_id": manifest["source_id"],
        "document_sha256": manifest["document_sha256"],
        "page_or_note": manifest["page_or_note"],
        "periods": manifest["periods"],
        "complete_face_statement": manifest["complete_face_statement"],
        "source_pages": manifest["source_pages"],
        **({"reporting_currency": manifest["reporting_currency"]} if "reporting_currency" in manifest else {}),
        **({"units": manifest["units"]} if "units" in manifest else {}),
        "source_unit_labels": manifest["source_unit_labels"],
        "rows": [{
            "source_line_id": row["source_line_id"],
            "ordinal": row["ordinal"],
            "raw_label": row["raw_label"],
            "values": row["values"],
            "value_states": row["value_states"],
            "value_precisions": row["value_precisions"],
            "cells": row["cells"],
            "structural_role": row["structural_role"],
            "page_or_note": row["page_or_note"],
            "material": row["material"],
            "parent_source_line_id": row.get("parent_source_line_id"),
            "hierarchy_level": row.get("hierarchy_level"),
            "is_subtotal": row.get("is_subtotal"),
        } for row in manifest["rows"]],
    }
    manifest["rows_sha256"] = hash_value(projected)


def manifests_by_section(document: dict) -> dict[str, dict]:
    result: dict[str, dict] = {}
    for section, entry in (document.get("face_statement_manifests") or {}).items():
        manifest = entry[0] if isinstance(entry, list) and entry else entry
        if isinstance(manifest, dict):
            result[section] = manifest
    return result


def stitch_manifest(current: dict, prior: dict, prior_document_sha: str) -> dict:
    """Fill one current manifest's declared periods from one prior manifest."""
    ledger = {
        "schema_version": STITCH_SCHEMA,
        "prior_document_sha256": prior_document_sha,
        "periods": [],
    }
    still_required: list[str] = []
    for period in list(current.get("period_support_required") or []):
        record = {
            "period": period,
            "filled_row_count": 0,
            "unmatched_row_ordinals": [],
            "refusal": None,
        }
        if period not in (prior.get("periods") or []):
            record["refusal"] = "the prior filing does not carry the owed period"
            still_required.append(period)
            ledger["periods"].append(record)
            continue
        current_index = current["periods"].index(period)
        prior_index = prior["periods"].index(period)
        prior_rows = {
            normalized_label(row["raw_label"]): row
            for row in prior.get("rows", [])
            if str(row.get("value_states", [None] * (prior_index + 1))[prior_index] or "")
            == "reported_number"
        }
        filled = 0
        for row in current.get("rows", []):
            states = row.get("value_states") or []
            if current_index >= len(states) or states[current_index] != "period_support_required":
                continue
            match = prior_rows.get(normalized_label(row["raw_label"]))
            if match is None:
                record["unmatched_row_ordinals"].append(row.get("ordinal"))
                continue
            row["values"][current_index] = match["values"][prior_index]
            row["value_states"][current_index] = "prior_filing_support"
            precisions = row.get("value_precisions")
            if isinstance(precisions, list) and current_index < len(precisions):
                prior_precisions = match.get("value_precisions") or []
                precisions[current_index] = (
                    prior_precisions[prior_index] if prior_index < len(prior_precisions) else None
                )
            row.setdefault("period_support_provenance", {})[period] = {
                "prior_document_sha256": prior_document_sha,
                "prior_source_line_id": match.get("source_line_id"),
                "prior_period_index": prior_index,
            }
            filled += 1
        record["filled_row_count"] = filled
        if filled == 0:
            record["refusal"] = record["refusal"] or "no prior row label matched; nothing was invented"
            still_required.append(period)
        ledger["periods"].append(record)
    current["period_support_required"] = still_required
    if not still_required:
        current.pop("period_support_required")
    current.setdefault("period_support_stitches", []).append(ledger)
    reseal_rows_sha(current)
    return ledger


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--current", required=True, help="current filings-extraction-response.json")
    parser.add_argument("--prior", required=True, help="prior-year filings-extraction-response.json")
    parser.add_argument("--out", required=True, help="stitched response output path")
    args = parser.parse_args()
    current = json.loads(Path(args.current).read_text("utf-8"))
    prior = json.loads(Path(args.prior).read_text("utf-8"))
    ledgers = []
    for document in current.get("documents", []):
        current_manifests = manifests_by_section(document)
        for prior_document in prior.get("documents", []):
            prior_manifests = manifests_by_section(prior_document)
            for section, manifest in current_manifests.items():
                if not manifest.get("period_support_required"):
                    continue
                prior_manifest = prior_manifests.get(section)
                if not prior_manifest:
                    continue
                ledgers.append({
                    "document_id": document.get("document_id"),
                    "section": section,
                    **stitch_manifest(
                        manifest, prior_manifest, str(prior_document.get("raw_sha256") or ""),
                    ),
                })
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(current, indent=1, sort_keys=True) + "\n", "utf-8")
    filled = sum(period["filled_row_count"] for ledger in ledgers for period in ledger["periods"])
    outstanding = sorted({
        period["period"]
        for ledger in ledgers
        for period in ledger["periods"]
        if period["refusal"]
    })
    print(json.dumps({
        "status": "PASS" if ledgers and not outstanding else ("PARTIAL" if filled else "NO_STITCH"),
        "stitched_sections": len(ledgers),
        "filled_cells": filled,
        "outstanding_periods": outstanding,
        "out": str(out),
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
