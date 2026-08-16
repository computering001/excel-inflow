#!/usr/bin/env python3
"""Close the broker recovery policy identifier across executable views."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OLD = "latest_supplied_house_then_zero_authority"
NEW = "quality_ranked_native_then_one_recovery_frontier"
SUFFIXES = {".py", ".mjs", ".js", ".cjs", ".json", ".md"}
changed = []
for path in ROOT.rglob("*"):
    if not path.is_file() or path.suffix.lower() not in SUFFIXES:
        continue
    relative = path.relative_to(ROOT).as_posix()
    if relative.startswith("audit/generated/") or ".git" in path.parts:
        continue
    text = path.read_text("utf-8", errors="ignore")
    if OLD not in text:
        continue
    path.write_text(text.replace(OLD, NEW), "utf-8")
    changed.append(relative)
print({"status": "PASS", "changed": changed})
