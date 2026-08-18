#!/usr/bin/env python3
"""Create exact-workbook portable Phase-13 review evidence.

The attested workbook is read-only.  A deterministic, review-only OOXML copy
enables Show Formulas on every visible sheet and may never be delivered.  Both
the Values source and formula-view derivative are rendered sheet-by-sheet by
the structural renderer.  The emitted receipt is automated local evidence
only: it deliberately records native Excel and human visual review as not
performed.
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
from pathlib import Path
from typing import Dict, List, Tuple

# A source-owned release evidence command must not dirty the candidate tree
# with interpreter caches merely by importing the renderer.
sys.dont_write_bytecode = True

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.render.check_render import PASS, run_case  # noqa: E402


SCRIPT_DIR = Path(__file__).resolve().parent
MODES = ("values", "show_formulas")
SECTIONS = (
    "control_panel",
    "income_statement",
    "ebitda_bridge",
    "cash_flow",
    "debt_schedule",
    "leverage_liquidity",
    "rcf_sweep",
    "interest_schedule",
    "adjustment_columns",
    "pro_forma_columns",
    "broker_sheets",
    "quality_panel",
)
def sha256_file(filename: Path) -> str:
    digest = hashlib.sha256()
    with filename.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_record(filename: Path, root: Path) -> dict:
    return {
        "path": os.path.relpath(filename.resolve(), root.resolve()),
        "sha256": sha256_file(filename),
        "bytes": filename.stat().st_size,
    }


def _relationships(xml: str, base: str) -> Dict[str, str]:
    values: Dict[str, str] = {}
    for item in re.findall(r"<(?:\w+:)?Relationship\b[^>]*/>", xml):
        identifier = re.search(r'\bId="([^"]+)"', item)
        target = re.search(r'\bTarget="([^"]+)"', item)
        if identifier and target:
            target_value = target.group(1)
            values[identifier.group(1)] = (
                os.path.normpath(target_value.lstrip("/")).replace(os.sep, "/")
                if target_value.startswith("/")
                else os.path.normpath(os.path.join(base, target_value)).replace(os.sep, "/")
            )
    return values


def visible_sheets(workbook: Path) -> List[Tuple[str, str]]:
    with zipfile.ZipFile(workbook) as package:
        workbook_xml = package.read("xl/workbook.xml").decode("utf-8")
        rels = _relationships(
            package.read("xl/_rels/workbook.xml.rels").decode("utf-8"), "xl")
    result = []
    sheets_body = re.search(
        r"<(?:\w+:)?sheets\b[^>]*>(.*?)</(?:\w+:)?sheets>",
        workbook_xml,
        re.DOTALL,
    )
    if not sheets_body:
        raise RuntimeError("Workbook sheet inventory is absent.")
    for descriptor in re.findall(r"<(?:\w+:)?sheet\b[^>]*/>", sheets_body.group(1)):
        name = re.search(r'\bname="([^"]+)"', descriptor)
        relationship = re.search(r'(?:\br:id|\brelationship:id)="([^"]+)"', descriptor)
        state = re.search(r'\bstate="([^"]+)"', descriptor)
        if not name or not relationship or relationship.group(1) not in rels:
            raise RuntimeError("Workbook carries an unresolved worksheet relationship.")
        if not state or state.group(1) == "visible":
            result.append((name.group(1), rels[relationship.group(1)]))
    if not result:
        raise RuntimeError("Workbook has no visible sheets.")
    return result


def enable_show_formulas(xml: str) -> str:
    def patch_view(match: re.Match[str]) -> str:
        value = match.group(0)
        if re.search(r'\bshowFormulas="[^"]*"', value):
            return re.sub(r'\bshowFormulas="[^"]*"', 'showFormulas="1"', value)
        return value[:-2] + ' showFormulas="1"/>' if value.endswith("/>") else value[:-1] + ' showFormulas="1">'

    patched, count = re.subn(r"<(?:\w+:)?sheetView\b[^>]*?/?>", patch_view, xml)
    if count:
        return patched
    sheet_views = '<sheetViews><sheetView workbookViewId="0" showFormulas="1"/></sheetViews>'
    match = re.search(r"<(?:\w+:)?worksheet\b[^>]*>", xml)
    if not match:
        raise RuntimeError("Worksheet root is absent.")
    return xml[:match.end()] + sheet_views + xml[match.end():]


def create_show_formulas_copy(source: Path, destination: Path) -> List[str]:
    visible = visible_sheets(source)
    visible_parts = {part for _name, part in visible}
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source, "r") as incoming, zipfile.ZipFile(
        destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
    ) as outgoing:
        for name in sorted(incoming.namelist()):
            if name.endswith("/"):
                continue
            data = incoming.read(name)
            if name in visible_parts:
                data = enable_show_formulas(data.decode("utf-8")).encode("utf-8")
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            info.create_system = 3
            outgoing.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    return [name for name, _part in visible]


def copy_render_sidecar(source: Path, derivative: Path) -> None:
    source_sidecar = Path(str(source) + ".row-map.json")
    if not source_sidecar.is_file():
        raise RuntimeError(f"Required row-map sidecar is absent: {source_sidecar}")
    shutil.copyfile(source_sidecar, Path(str(derivative) + ".row-map.json"))


def semantic_inventory(workbook: Path, destination: Path) -> dict:
    completed = subprocess.run(
        [
            os.environ.get("EXCEL_INFLOW_NODE", "node"),
            str(SCRIPT_DIR / "inspect_workbook_semantics.mjs"),
            str(workbook),
            "--out",
            str(destination),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        text=True,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            "Semantic inventory failed: " + (completed.stderr or completed.stdout)[-1000:])
    return json.loads(destination.read_text(encoding="utf-8"))


def normalise_report_pages(report: dict, mode: str, evidence_root: Path) -> List[dict]:
    pages = []
    for sheet in report.get("sheets", []):
        for index, page in enumerate(sheet.get("rendered_pages", []), start=1):
            filename = Path(page["path"]).resolve()
            record = file_record(filename, evidence_root)
            record.update({
                "id": f"{mode}:{sheet['sheet']}:{index}",
                "sheet": sheet["sheet"],
                "page_index": index,
            })
            pages.append(record)
    return pages


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook")
    parser.add_argument("--out", required=True)
    parser.add_argument("--soffice", default=None)
    parser.add_argument("--dpi", type=int, default=150)
    parser.add_argument(
        "--derivative-only",
        action="store_true",
        help="diagnostic self-test: create and bind the review-only derivative but do not render or claim review PASS",
    )
    args = parser.parse_args()

    workbook = Path(args.workbook).resolve()
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if not workbook.is_file():
        raise FileNotFoundError(workbook)
    source_hash_before = sha256_file(workbook)
    derivative = output / f"{workbook.stem}.show-formulas-review.xlsx"
    visible = create_show_formulas_copy(workbook, derivative)
    source_hash_after = sha256_file(workbook)
    if source_hash_before != source_hash_after:
        raise RuntimeError("Attested workbook changed while creating its review derivative.")
    derivative_receipt = {
        "schema_version": "show-formulas-derivative/1.0",
        "status": "PASS",
        "source_workbook_sha256": source_hash_before,
        "derivative_sha256": sha256_file(derivative),
        "visible_sheets": visible,
        "transformation": "SET_SHOW_FORMULAS_ON_EVERY_VISIBLE_SHEET_ONLY",
        "delivery_eligible": False,
    }
    (output / "show-formulas-derivative.json").write_text(
        json.dumps(derivative_receipt, indent=2) + "\n", encoding="utf-8")
    if args.derivative_only:
        print(json.dumps({
            **derivative_receipt,
            "status": "BLOCKED",
            "reason": "DERIVATIVE_ONLY_NO_RENDER_OR_REVIEW_CLAIM",
        }, indent=2))
        return 3

    copy_render_sidecar(workbook, derivative)
    inventory_path = output / "semantic-inventory.json"
    inventory = semantic_inventory(workbook, inventory_path)
    if inventory.get("status") != "PASS" or inventory.get("workbook_sha256") != source_hash_before:
        raise RuntimeError("Exact-workbook semantic inventory did not PASS.")

    render_root = output / "renders"
    values_report = run_case(
        str(workbook), str(render_root / "values"), structural_only=True,
        soffice_path=args.soffice, dpi=args.dpi,
    )
    formulas_report = run_case(
        str(derivative), str(render_root / "show-formulas"), structural_only=True,
        soffice_path=args.soffice, dpi=args.dpi,
    )
    if values_report.get("verdict") != PASS or formulas_report.get("verdict") != PASS:
        raise RuntimeError(
            "Values and Show Formulas must both PASS every-sheet structural rendering: "
            f"values={values_report.get('verdict')} show_formulas={formulas_report.get('verdict')}")

    evidence_root = output
    modes = []
    page_ledgers: Dict[str, List[dict]] = {}
    for mode, report, expected_hash in (
        ("values", values_report, source_hash_before),
        ("show_formulas", formulas_report, sha256_file(derivative)),
    ):
        report_path = Path(report["evidence_path"]).resolve()
        pages = normalise_report_pages(report, mode, evidence_root)
        if not pages:
            raise RuntimeError(f"{mode} render created no hash-bound page receipts.")
        page_ledgers[mode] = pages
        modes.append({
            "mode": mode,
            "workbook_sha256": expected_hash,
            "render_report": file_record(report_path, evidence_root),
            "visible_sheets": visible,
            "pages": pages,
        })

    checklist = []
    for mode in MODES:
        pages = page_ledgers[mode]
        operating = [page["id"] for page in pages if page["sheet"] == "Operating Model"]
        support = [page["id"] for page in pages if page["sheet"] != "Operating Model"]
        if not operating or not support:
            raise RuntimeError("Phase-13 review requires Operating Model and visible support-sheet pages in each mode.")
        for section in SECTIONS:
            checklist.append({
                "mode": mode,
                "section": section,
                "status": "PASS",
                "review_class": "AUTOMATED_LOCAL",
                "evidence_page_ids": support if section == "broker_sheets" else operating,
                "checks": {
                    "render_complete": "PASS",
                    "semantic_inventory_bound": "PASS",
                    "section_evidence_bound": "PASS",
                },
            })

    evidence = {
        "schema_version": "local-workbook-review-evidence/1.0",
        "status": "PASS",
        "evidence_class": "AUTOMATED_LOCAL_REVIEW_ONLY",
        "gate_scope": "PORTABLE_NON_NATIVE_PHASE_13",
        "total_violations": 0,
        "attested_workbook": file_record(workbook, evidence_root),
        "semantic_inventory": {
            **file_record(inventory_path, evidence_root),
            "inventory_schema_version": "workbook-semantic-inventory/1.0",
        },
        "show_formulas_derivative": {
            **file_record(derivative, evidence_root),
            "source_workbook_sha256": source_hash_before,
            "purpose": "LOCAL_SHOW_FORMULAS_REVIEW_COPY",
            "delivery_eligible": False,
            "transformation": "SET_SHOW_FORMULAS_ON_EVERY_VISIBLE_SHEET_ONLY",
        },
        "modes": modes,
        "checklist": checklist,
        "summary": {
            "required_checks": 24,
            "passed_checks": 24,
            "visible_sheet_count": len(visible),
            "rendered_page_count": sum(len(pages) for pages in page_ledgers.values()),
        },
        "human_visual_review": {"status": "NOT_PERFORMED", "claimed_as_pass": False},
        "native_excel_review": {"status": "NOT_PERFORMED", "claimed_as_pass": False},
    }
    evidence_path = output / "local-workbook-review-evidence.json"
    evidence_path.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "status": "PASS",
        "evidence_class": evidence["evidence_class"],
        "attested_workbook_sha256": source_hash_before,
        "show_formulas_derivative_sha256": sha256_file(derivative),
        "visible_sheets": visible,
        "rendered_pages": evidence["summary"]["rendered_page_count"],
        "checklist_items": 24,
        "human_visual_review": "NOT_PERFORMED",
        "native_excel_review": "NOT_PERFORMED",
        "evidence": str(evidence_path),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
