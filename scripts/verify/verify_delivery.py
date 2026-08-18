#!/usr/bin/env python3
"""Re-prove a delivered workbook against its live-delivery attestation.

The trust chain for a delivered Excel Inflow workbook must not depend on the
conversation that produced it. A chat host can narrate a receipt; it cannot
narrate the SHA-256 of the bytes in front of you. This command takes exactly
the two artifacts every delivery ships — the workbook and its
live-delivery-attestation JSON — and re-derives the claims that matter from
the bytes themselves:

  1. the workbook's SHA-256 equals artifact_hashes.workbook;
  2. the workbook's own sheet inventory equals topology.sheet_names, in order
     (this is the check that exposes a stale same-named download or a swapped
     alternative-product file in one line, without opening Excel);
  3. the attestation itself reports status PASS with zero violations.

Anyone — the user, a fresh chat, a reviewer — can run it at any time:

    python3 scripts/verify/verify_delivery.py <workbook.xlsx> <attestation.json>

Exit code 0 with a final PASS line only when every check holds; exit code 1
with the first failing comparison printed verbatim otherwise. Standard
library only, deliberately: this tool must run anywhere the release runs.
"""

from __future__ import annotations

import hashlib
import json
import sys
import xml.etree.ElementTree as ET
import zipfile

MAIN_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def workbook_sheet_names(path: str) -> list[str]:
    with zipfile.ZipFile(path) as archive:
        root = ET.fromstring(archive.read("xl/workbook.xml"))
    names = []
    for sheets in root.iter(f"{MAIN_NS}sheets"):
        for sheet in sheets.iter(f"{MAIN_NS}sheet"):
            names.append(str(sheet.get("name")))
    return names


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(
            "Usage: verify_delivery.py <workbook.xlsx> <live-delivery-attestation.json>",
            file=sys.stderr,
        )
        return 2
    workbook_path, attestation_path = argv[1], argv[2]
    with open(attestation_path, "r", encoding="utf-8") as handle:
        attestation = json.load(handle)

    failures = []

    expected_hash = str(
        (attestation.get("artifact_hashes") or {}).get("workbook") or ""
    )
    actual_hash = sha256_file(workbook_path)
    print(f"workbook sha256 expected {expected_hash}")
    print(f"workbook sha256 actual   {actual_hash}")
    if actual_hash != expected_hash:
        failures.append(
            "WORKBOOK_HASH_MISMATCH: these are not the attested bytes - "
            "a stale, renamed or regenerated file is standing in for the delivery."
        )

    expected_sheets = list(
        (attestation.get("topology") or {}).get("sheet_names") or []
    )
    actual_sheets = workbook_sheet_names(workbook_path)
    print(f"sheets expected {expected_sheets}")
    print(f"sheets actual   {actual_sheets}")
    if actual_sheets != expected_sheets:
        failures.append(
            "SHEET_INVENTORY_MISMATCH: the file's own sheet list differs from "
            "the attested topology."
        )

    status = attestation.get("status")
    violations = attestation.get("violations") or []
    print(f"attestation status {status} violations {len(violations)}")
    if status != "PASS" or violations:
        failures.append(
            "ATTESTATION_NOT_PASS: the attestation itself does not certify this delivery."
        )

    if failures:
        for failure in failures:
            print(f"FAIL {failure}")
        return 1
    print(
        f"PASS delivered bytes match attestation {attestation.get('attestation_sha256')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
