#!/usr/bin/env python3
"""Remove one-off repair scaffolding after the full portable gate passes."""
from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUDIT_TOOLS = ROOT / "audit" / "tools"
AUDIT_TOOLS.mkdir(parents=True, exist_ok=True)

move_to_audit = [
    "scripts/run_forensic_repository_audit.py",
    "scripts/run_deep_product_architecture_audit.py",
    "scripts/run_history_blame_audit.py",
    "scripts/run_acquisition_execution_map.py",
    "scripts/run_final_candidate_audit.py",
    "scripts/run_development_release_compile.py",
]
remove_files = [
    "scripts/apply_excel_inflow_repair_stage1.py",
    "scripts/fix_stage1_generated_sources.py",
    "scripts/run_repair_stage1_stage.py",
    "scripts/run_repair_stage1_gate.py",
    "scripts/apply_excel_inflow_repair_stage2.py",
    "scripts/fix_stage2_git_object_identity.py",
    "scripts/run_repair_stage2_gate.py",
    "scripts/apply_excel_inflow_acquisition_repair.py",
    "scripts/run_acquisition_repair_stage.py",
    "scripts/run_acquisition_repair_gate.py",
    "scripts/cleanup_repair_scaffolding.py",
    ".github/workflows/repair-workspace-export.yml",
    ".github/workflows/deep-forensic-audit.yml",
    ".github/workflows/deep-forensic-audit-v2.yml",
    ".github/workflows/history-blame-audit.yml",
    ".github/workflows/repair-stage1.yml",
    ".github/workflows/repair-stage1-auto.yml",
    ".github/workflows/repair-stage1-v2.yml",
    ".github/workflows/repair-stage2.yml",
    ".github/workflows/repair-stage2-v2.yml",
    ".github/workflows/acquisition-execution-map.yml",
    ".github/workflows/acquisition-repair.yml",
    ".github/workflows/frozen-baseline-audit.yml",
    ".github/workflows/full-audit-repair-orchestrator.yml",
]
trigger_globs = ["audit/trigger-*.txt"]
remove_generated = [
    "audit/generated/baseline-v2",
    "audit/generated/history-blame",
    "audit/generated/repair-stage1-failure",
    "audit/generated/repair-stage1-v2-failure",
    "audit/generated/repair-stage2-failure",
    "audit/generated/repair-stage2-v2-failure",
    "audit/generated/acquisition-repair-failure",
]

moved = []
removed = []
for relative in move_to_audit:
    source = ROOT / relative
    if not source.is_file():
        continue
    destination = AUDIT_TOOLS / source.name
    if destination.exists():
        destination.unlink()
    shutil.move(str(source), str(destination))
    moved.append((relative, destination.relative_to(ROOT).as_posix()))
for relative in remove_files:
    target = ROOT / relative
    if target.is_file() or target.is_symlink():
        target.unlink()
        removed.append(relative)
    elif target.is_dir():
        shutil.rmtree(target)
        removed.append(relative)
for pattern in trigger_globs:
    for target in ROOT.glob(pattern):
        if target.is_file():
            target.unlink()
            removed.append(target.relative_to(ROOT).as_posix())
for relative in remove_generated:
    target = ROOT / relative
    if target.is_dir():
        shutil.rmtree(target)
        removed.append(relative)

readme = ROOT / "audit" / "README.md"
readme.write_text(
    "# Excel Inflow audit and repair evidence\n\n"
    "`product-target-v1.json` is the frozen product target used by the audit.\n\n"
    "`generated/frozen-baseline/` records the exact untouched candidate audit.\n\n"
    "`generated/full-repair/` records the passing source, case, workbook and final-candidate evidence.\n\n"
    "`tools/` contains read-only audit and development-release utilities. They are not runtime entry points.\n",
    "utf-8",
)
print({"status": "PASS", "moved": moved, "removed": removed})
