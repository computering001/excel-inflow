#!/usr/bin/env python3
"""Keep case-dependent tests in the case-owning portable cohort."""
from __future__ import annotations

from pathlib import Path

path = Path(__file__).resolve().with_name("run_repair_stage2_gate.py")
text = path.read_text("utf-8")
for entry in [
    '    ("node", "scripts/run_statement_classifier_tests.mjs"),\n',
]:
    text = text.replace(entry, "")
path.write_text(text, "utf-8")
print({"status": "PASS", "gate": str(path.name)})
