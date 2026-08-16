#!/usr/bin/env python3
"""Compatibility launcher for the acquisition repair search stage."""
from __future__ import annotations

import builtins
import runpy
from collections import Counter
from pathlib import Path

builtins.Counter = Counter
runpy.run_path(
    str(Path(__file__).resolve().with_name("apply_excel_inflow_acquisition_repair.py")),
    run_name="__main__",
)
