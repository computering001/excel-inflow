#!/usr/bin/env python3
"""Apply stage two, correct Git-object validation and close contract literals."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
commands = [
    [sys.executable, str(HERE / "apply_excel_inflow_repair_stage2.py"), *sys.argv[1:]],
    [sys.executable, str(HERE / "fix_stage2_git_object_identity.py")],
    [sys.executable, str(HERE / "fix_stage2_contract_literals.py")],
]
for command in commands:
    completed = subprocess.run(command, check=False)
    if completed.returncode != 0:
        raise SystemExit(completed.returncode)
raise SystemExit(0)
