#!/usr/bin/env python3
"""Independent mutations for the emitted half of ownership Preflight C."""

from __future__ import annotations

import copy
import json
import tempfile
import zipfile
from pathlib import Path

from forecast_ownership_physical_oracle import canonical_sha256, verify


def write_json(target: Path, value: object) -> None:
    target.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", "utf-8")


def workbook(target: Path, cell_xml: str) -> None:
    parts = {
        "[Content_Types].xml": """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="xml" ContentType="application/xml"/>
 <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
 <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>""",
        "_rels/.rels": """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>""",
        "xl/workbook.xml": """<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
 <sheets><sheet name="Model" sheetId="1" r:id="rId1"/></sheets>
</workbook>""",
        "xl/_rels/workbook.xml.rels": """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>""",
        "xl/worksheets/sheet1.xml": f"""<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{cell_xml}</sheetData></worksheet>""",
    }
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, payload in parts.items():
            archive.writestr(name, payload)


def seal(body: dict) -> dict:
    return {**body, "receipt_sha256": canonical_sha256(body)}


def main() -> int:
    # Cross-language sentinel for the exact numeric bands that differ between
    # Python's json.dumps and ECMAScript JSON.stringify.  The expected digest
    # is minted by scripts/lib/run_store.mjs hashValue over this object.
    numeric_canonicalisation_fixture = {
        "small_fixed": 0.000028320312500440536,
        "small_exp": 1e-8,
        "integer_float": 1.0,
        "large_fixed": 1e20,
        "large_exp": 1e21,
        "negative_zero": -0.0,
    }
    assert canonical_sha256(numeric_canonicalisation_fixture) == (
        "74aad83b8362f82baaa0e518cbb257a60ecb73dfb65f805bb8e43375fa0e6a41"
    )
    with tempfile.TemporaryDirectory(prefix="ownership-c-physical-") as temporary:
        root = Path(temporary)
        model_case = {
            "forecast_ownership_preflights": {
                "selected": {"receipt_sha256": "a" * 64},
            },
            "ownership_census": {"census_sha256": "b" * 64},
        }
        standalone = {"forecast": [{"period": 1}, {"period": 2}, {"period": 3}], "equation_graph_evidence": {"sha256": "c" * 64}}
        pro_forma = {"forecast": [{"period": 1}, {"period": 2}, {"period": 3}], "equation_graph_evidence": {"sha256": "d" * 64}}
        destinations = [
            {
                "section": "cash_flow",
                "parent_row_id": "wc_parent",
                "parent_destination_row": 20,
                "forecast_index": index,
                "parent_owner_class": "direct",
                "selected_mode": "parent_owned",
                "child_destination_rows": [
                    {"row_id": "wc_child", "row": 21, "owner_class": "absent"},
                ],
            }
            for index in range(3)
        ]
        c_body = {
            "schema_version": "forecast-ownership-preflight/1.0",
            "checkpoint": "C_PHYSICAL",
            "case_id": "physical_mutation_fixture",
            "status": "PASS",
            "selected_receipt_sha256": "a" * 64,
            "census_sha256": "b" * 64,
            "solver_binding": {
                "standalone_forecast_periods": 3,
                "pro_forma_forecast_periods": 3,
                "standalone_solution_sha256": canonical_sha256(standalone),
                "pro_forma_solution_sha256": canonical_sha256(pro_forma),
            },
            "destinations": destinations,
            "ownership_writer_contract_sha256": canonical_sha256(destinations),
            "violations": [],
            "controller_signal": {"action": "continue", "reason": None, "resume_from": "physical_ownership"},
        }
        baseline_row_map = {"forecast_ownership_preflight": seal(c_body)}
        baseline_solution = {"standalone": standalone, "pro_forma": pro_forma}
        base_cells = "".join(
            f'<row r="{row}">{content}</row>'
            for row, content in [
                (20, '<c r="J20"><v>1</v></c><c r="K20"><v>2</v></c><c r="L20"><v>3</v></c>'),
                (21, '<c r="J21" s="1"/><c r="K21" s="1"/><c r="L21" s="1"/>'),
            ]
        )
        case_path = root / "case.json"
        write_json(case_path, model_case)

        def run_case(name: str, *, cells: str = base_cells, row_map: dict | None = None, solution: dict | None = None) -> dict:
            xlsx = root / f"{name}.xlsx"
            row_path = root / f"{name}.row-map.json"
            solution_path = root / f"{name}.solution.json"
            workbook(xlsx, cells)
            write_json(row_path, row_map if row_map is not None else baseline_row_map)
            write_json(solution_path, solution if solution is not None else baseline_solution)
            return verify(workbook=xlsx, row_map=row_path, solution=solution_path, model_case=case_path)

        clean = run_case("clean")
        assert clean["status"] == "PASS", clean

        wrong_solver = copy.deepcopy(baseline_solution)
        wrong_solver["standalone"]["equation_graph_evidence"]["sha256"] = "0" * 64
        wrong_solver_report = run_case("wrong-solver", solution=wrong_solver)
        assert "STANDALONE_SOLVER_BINDING_MISMATCH" in wrong_solver_report["violations"]

        duplicate_cells = base_cells.replace(
            '<c r="J20"><v>1</v></c>',
            '<c r="J20"><v>1</v></c><c r="J20"><v>99</v></c>',
        )
        duplicate_report = run_case("duplicate-writer", cells=duplicate_cells)
        assert "DUPLICATE_PHYSICAL_WRITER:J20" in duplicate_report["violations"]

        missing_cells = base_cells.replace('<c r="K20"><v>2</v></c>', "")
        missing_report = run_case("missing-writer", cells=missing_cells)
        assert "PHYSICAL_WRITER_MISSING:wc_parent:K20" in missing_report["violations"]

        stale_row_map = copy.deepcopy(baseline_row_map)
        stale_row_map["forecast_ownership_preflight"]["selected_receipt_sha256"] = "f" * 64
        stale_report = run_case("stale-receipt", row_map=stale_row_map)
        assert "C_RECEIPT_STALE" in stale_report["violations"]

        print(json.dumps({
            "status": "PASS",
            "ecmascript_numeric_canonicalisation_cases": 6,
            "clean_checked_writer_bindings": clean["checked_writer_bindings"],
            "mutations_rejected": 4,
            "mutations": [
                "wrong_solver_binding",
                "duplicate_physical_writer",
                "missing_physical_writer",
                "stale_c_receipt",
            ],
        }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
