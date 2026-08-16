#!/usr/bin/env python3
"""Close stage-two schema and state identifiers across executable views."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SUFFIXES = {".py", ".mjs", ".js", ".cjs", ".json", ".md"}
changed = []
for path in ROOT.rglob("*"):
    if not path.is_file() or path.suffix.lower() not in SUFFIXES:
        continue
    relative = path.relative_to(ROOT).as_posix()
    if relative.startswith("audit/generated/") or ".git" in path.parts:
        continue
    text = path.read_text("utf-8", errors="ignore")
    original = text
    text = text.replace("debt-model-run-carrier/2.0", "debt-model-run-carrier/3.0")
    # The invalid pairing is never a public user boundary. Keep the repair
    # deliberately local to object literals that name both fields.
    text = re.sub(
        r'(status\s*:\s*["\'])ACTION_REQUIRED(["\'](?:(?!\n\s*\}).){0,500}?blocker_class\s*:\s*["\']INTERNAL_WORK["\'])',
        r'\1NEEDS_INTERNAL_WORK\2',
        text,
        flags=re.S,
    )
    text = re.sub(
        r'(blocker_class\s*:\s*["\']INTERNAL_WORK["\'](?:(?!\n\s*\}).){0,500}?status\s*:\s*["\'])ACTION_REQUIRED(["\'])',
        r'\1NEEDS_INTERNAL_WORK\2',
        text,
        flags=re.S,
    )
    if text != original:
        path.write_text(text, "utf-8")
        changed.append(relative)
print({"status": "PASS", "changed": changed})
