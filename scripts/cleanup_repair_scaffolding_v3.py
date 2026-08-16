#!/usr/bin/env python3
"""Run v2 cleanup, then remove the final corrected repair scaffolding."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
completed = subprocess.run(
    [sys.executable, str(HERE / "cleanup_repair_scaffolding_v2.py")],
    check=False,
)
if completed.returncode != 0:
    raise SystemExit(completed.returncode)

extra = [
    "scripts/apply_excel_inflow_acquisition_repair_v3.py",
    "scripts/discover_portable_canary_fixture_v2.py",
    "scripts/cleanup_repair_scaffolding_v3.py",
    ".github/workflows/full-audit-repair-orchestrator-v3.yml",
]
removed = []
for relative in extra:
    target = ROOT / relative
    if target.is_file() or target.is_symlink():
        target.unlink()
        removed.append(relative)

print({"status": "PASS", "removed": removed})
