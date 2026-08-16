#!/usr/bin/env python3
"""Run the portable cohort with adaptive validator and registry interfaces."""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("portable_e2e_impl", HERE / "run_portable_end_to_end_cases.py")
module = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(module)


def adaptive_validation_commands(case_path: Path, workbook: Path, output: Path, python: str, timeout: int, env: dict[str, str]) -> list[dict[str, Any]]:
    output.mkdir(parents=True, exist_ok=True)
    definitions = [
        (
            module.ROOT / "scripts" / "verify" / "validate_dynamic_model.py",
            [
                [python, str(module.ROOT / "scripts" / "verify" / "validate_dynamic_model.py"), str(case_path), str(workbook), "--out", str(output / "dynamic-model.json")],
                [python, str(module.ROOT / "scripts" / "verify" / "validate_dynamic_model.py"), str(workbook), str(case_path), "--out", str(output / "dynamic-model.json")],
                [python, str(module.ROOT / "scripts" / "verify" / "validate_dynamic_model.py"), str(workbook), "--out", str(output / "dynamic-model.json")],
                [python, str(module.ROOT / "scripts" / "verify" / "validate_dynamic_model.py"), str(workbook)],
            ],
        ),
        (
            module.ROOT / "scripts" / "verify" / "finance_proof.py",
            [
                [python, str(module.ROOT / "scripts" / "verify" / "finance_proof.py"), str(case_path), str(workbook), "--out", str(output / "finance-proof.json")],
                [python, str(module.ROOT / "scripts" / "verify" / "finance_proof.py"), str(workbook), str(case_path), "--out", str(output / "finance-proof.json")],
            ],
        ),
        (
            module.ROOT / "scripts" / "verify" / "workbook_semantic_oracle.py",
            [
                [python, str(module.ROOT / "scripts" / "verify" / "workbook_semantic_oracle.py"), str(case_path), str(workbook), "--out", str(output / "semantic-oracle.json")],
                [python, str(module.ROOT / "scripts" / "verify" / "workbook_semantic_oracle.py"), str(workbook), str(case_path), "--out", str(output / "semantic-oracle.json")],
                [python, str(module.ROOT / "scripts" / "verify" / "workbook_semantic_oracle.py"), str(workbook), "--out", str(output / "semantic-oracle.json")],
            ],
        ),
        (
            module.ROOT / "scripts" / "validate_cache_parity.mjs",
            [
                [module.NODE, str(module.ROOT / "scripts" / "validate_cache_parity.mjs"), str(workbook), "--json", str(output / "cache-parity.json")],
            ],
        ),
    ]
    results = []
    for script, attempts in definitions:
        if not script.is_file():
            results.append({"script": str(script), "status": "MISSING", "attempts": []})
            continue
        attempted = []
        selected = None
        for command in attempts:
            result = module.run(command, timeout=timeout, env=env)
            attempted.append(result)
            if result["status"] == "PASS":
                selected = result
                break
        results.append({
            "script": str(script),
            "status": "PASS" if selected else "FAIL",
            "selected_command": selected.get("command") if selected else None,
            "attempts": attempted,
        })
    return results


def adaptive_fixed_point_manifest(cases: list[Path], output: Path) -> Path:
    source = (module.ROOT / "scripts" / "run_fixed_point_constitution_tests.mjs").read_text("utf-8")
    versions = re.findall(r'["\']([A-Za-z0-9_.-]*fixed[A-Za-z0-9_.-]*point[A-Za-z0-9_./-]*)["\']', source, re.I)
    schema_version = next((value for value in versions if "/" in value), "fixed-point-cases/1.0")
    entries = [
        {
            "id": path.stem,
            "case_id": path.stem,
            "path": str(path.resolve()),
            "case_path": str(path.resolve()),
            "model_case_path": str(path.resolve()),
        }
        for path in cases
    ]
    manifest = {
        "schema_version": schema_version,
        "cases": entries,
        "case_paths": [entry["path"] for entry in entries],
        "representative_cases": entries,
    }
    target = output / "fixed-point-cases.json"
    target.write_text(json.dumps(manifest, indent=2) + "\n", "utf-8")
    return target


def adaptive_portable_registry(output: Path, substitutions: dict[str, Path | str], timeout: int, env: dict[str, str]) -> dict[str, Any]:
    registry = json.loads((module.ROOT / "assets" / "development-test-registry.json").read_text("utf-8"))
    results = []
    for test in registry.get("tests", []):
        test_id = str(test.get("id") or "unknown")
        local = {**substitutions, "TEST_OUT": output / "registry" / test_id}
        requirements = test.get("requires") or []
        missing = [item for item in requirements if item not in local]
        if missing:
            classification = "EXTERNAL_RELEASE_CUSTODY" if all(item in module.EXTERNAL_RELEASE_REQUIREMENTS for item in missing) else "MISSING_PORTABLE_INPUT"
            results.append({"id": test_id, "phase": test.get("phase"), "status": classification, "missing": missing})
            continue
        script = module.ROOT / "scripts" / str(test.get("script") or "")
        if not script.is_file():
            results.append({"id": test_id, "phase": test.get("phase"), "status": "MISSING_SCRIPT", "missing": [str(script)]})
            continue
        arguments = []
        unresolved = []
        for item in test.get("arguments") or []:
            match = re.fullmatch(r"\$([A-Z_]+)", str(item))
            if match:
                if match.group(1) not in local:
                    unresolved.append(match.group(1))
                else:
                    arguments.append(str(local[match.group(1)]))
            else:
                arguments.append(str(item))
        if unresolved:
            classification = "EXTERNAL_RELEASE_CUSTODY" if all(item in module.EXTERNAL_RELEASE_REQUIREMENTS for item in unresolved) else "MISSING_PORTABLE_INPUT"
            results.append({"id": test_id, "phase": test.get("phase"), "status": classification, "missing": unresolved})
            continue
        Path(local["TEST_OUT"]).mkdir(parents=True, exist_ok=True)
        command = [sys.executable if test.get("runtime") == "python" else module.NODE, str(script), *arguments]
        result = module.run(command, timeout=timeout, env=env)
        results.append({"id": test_id, "phase": test.get("phase"), **result})
    counts: dict[str, int] = {}
    for item in results:
        counts[item["status"]] = counts.get(item["status"], 0) + 1
    unacceptable = [item for item in results if item["status"] in {"FAIL", "TIMEOUT", "ERROR", "MISSING_SCRIPT", "MISSING_PORTABLE_INPUT"}]
    report = {"status": "PASS" if not unacceptable else "FAIL", "counts": counts, "results": results}
    (output / "portable-registry.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")
    return report


module.validation_commands = adaptive_validation_commands
module.create_fixed_point_manifest = adaptive_fixed_point_manifest
module.run_portable_registry = adaptive_portable_registry
raise SystemExit(module.main())
