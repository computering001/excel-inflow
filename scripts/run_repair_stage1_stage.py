#!/usr/bin/env python3
"""Apply and tighten Excel Inflow repair stage one."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
command = [sys.executable, str(HERE / "apply_excel_inflow_repair_stage1.py"), *sys.argv[1:]]
completed = subprocess.run(command, check=False)
if completed.returncode != 0:
    raise SystemExit(completed.returncode)
raise SystemExit(subprocess.run([sys.executable, str(HERE / "fix_stage1_generated_sources.py")], check=False).returncode)
