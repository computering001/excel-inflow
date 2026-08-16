#!/usr/bin/env python3
"""Register the canonical role-registry mutation test in the stage-one gate."""
from __future__ import annotations

from pathlib import Path

path = Path(__file__).resolve().with_name("run_repair_stage1_gate.py")
text = path.read_text("utf-8")
entry = '    ("node", "scripts/run_economic_role_registry_tests.mjs", []),\n'
if entry not in text:
    marker = '    ("node", "scripts/run_discrete_event_forecast_tests.mjs", []),\n'
    if marker not in text:
        raise RuntimeError("Stage-one gate insertion marker is absent")
    text = text.replace(marker, marker + entry, 1)
    path.write_text(text, "utf-8")
print({"status": "PASS", "registered": "economic-role-registry"})
