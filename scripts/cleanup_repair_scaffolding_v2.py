#!/usr/bin/env python3
"""Run base cleanup, then remove corrected one-off repair launchers."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
base = subprocess.run([sys.executable, str(HERE / "cleanup_repair_scaffolding.py")], check=False)
if base.returncode != 0:
    raise SystemExit(base.returncode)
extra = [
    "scripts/run_repair_stage1_stage_v4.py",
    "scripts/run_repair_stage1_stage_v5.py",
    "scripts/fix_stage1_policy_literals.py",
    "scripts/run_repair_stage2_stage_v3.py",
    "scripts/fix_stage2_contract_literals.py",
    "scripts/apply_excel_inflow_acquisition_repair_v2.py",
    "scripts/run_acquisition_repair_gate_v2.py",
    "scripts/cleanup_repair_scaffolding_v2.py",
    ".github/workflows/full-audit-repair-orchestrator-v2.yml",
]
removed=[]
for relative in extra:
    path=ROOT/relative
    if path.is_file() or path.is_symlink():
        path.unlink(); removed.append(relative)
print({"status":"PASS","removed":removed})
