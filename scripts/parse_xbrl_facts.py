#!/usr/bin/env python3
"""Extract the 15 core concept tags from a companyfacts JSON into a fact oracle.

Offline input: a data.sec.gov companyfacts payload (or any JSON with the same
shape: facts.<taxonomy>.<concept>.units.<unit> -> [ {end, val, fy, fp, form} ]).
Output: an oracle JSON keyed by period end-date:

    { "<period-end>": { "<Concept>": {"value": ..., "unit": "USD",
                                        "fy": 2023, "fp": "FY", "form": "10-K"} } }

When several filings report the same (period, concept) the LAST entry in the
companyfacts unit array wins — data.sec.gov appends in filing order, so the
most recently filed statement of that period stands.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

CORE_CONCEPTS: tuple[str, ...] = (
    "Revenues",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "CostOfGoodsAndServicesSold",
    "GrossProfit",
    "OperatingIncomeLoss",
    "NetIncomeLoss",
    "EarningsPerShareDiluted",
    "Assets",
    "Liabilities",
    "StockholdersEquity",
    "CashAndCashEquivalentsAtCarryingValue",
    "LongTermDebtNoncurrent",
    "NetCashProvidedByUsedInOperatingActivities",
    "DepreciationDepletionAndAmortization",
    "InterestExpense",
)

TAXONOMIES: tuple[str, ...] = ("us-gaap", "ifrs-full")


def extract_oracle(companyfacts: dict) -> tuple[dict, dict]:
    """Return (oracle, stats). Oracle is keyed by period end-date."""
    oracle: dict[str, dict[str, dict]] = {}
    concepts_found: list[str] = []
    facts = companyfacts.get("facts", {})
    for taxonomy in TAXONOMIES:
        branch = facts.get(taxonomy, {})
        for concept in CORE_CONCEPTS:
            concept_node = branch.get(concept)
            if not isinstance(concept_node, dict):
                continue
            concepts_found.append(f"{taxonomy}:{concept}")
            for unit_name, entries in sorted(concept_node.get("units", {}).items()):
                if not isinstance(entries, list):
                    continue
                for entry in entries:
                    period = entry.get("end")
                    if not period:
                        continue
                    oracle.setdefault(period, {})[concept] = {
                        "value": entry.get("val"),
                        "unit": unit_name,
                        "fy": entry.get("fy"),
                        "fp": entry.get("fp"),
                        "form": entry.get("form"),
                    }
    stats = {
        "entity": companyfacts.get("entityName"),
        "cik": companyfacts.get("cik"),
        "concepts_requested": len(CORE_CONCEPTS),
        "concepts_found": len(concepts_found),
        "concept_keys": concepts_found,
        "periods": len(oracle),
    }
    return oracle, stats


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("companyfacts", type=Path, help="path to a companyfacts JSON file")
    parser.add_argument("-o", "--out", type=Path, default=None, help="write oracle JSON here (default: stdout)")
    args = parser.parse_args()

    if not args.companyfacts.exists():
        print(f"typed refusal: input file not found: {args.companyfacts}", file=sys.stderr)
        return 1
    companyfacts = json.loads(args.companyfacts.read_text(encoding="utf-8"))
    if not isinstance(companyfacts.get("facts"), dict):
        print("typed refusal: input does not carry a 'facts' object (not companyfacts-shaped)", file=sys.stderr)
        return 1

    oracle, stats = extract_oracle(companyfacts)
    ordered = {period: oracle[period] for period in sorted(oracle)}
    payload = json.dumps(ordered, indent=2)
    if args.out is not None:
        args.out.write_text(payload + "\n", encoding="utf-8")
        print(f"oracle written: {args.out} ({stats['periods']} periods, "
              f"{stats['concepts_found']}/{stats['concepts_requested']} core concepts)")
    else:
        print(payload)
    print(json.dumps(stats), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
