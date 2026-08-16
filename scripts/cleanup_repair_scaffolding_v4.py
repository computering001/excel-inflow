#!/usr/bin/env python3
"""Final cleanup: retain only runtime, maintainable CI and read-only audit tools."""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
completed = subprocess.run(
    [sys.executable, str(HERE / "cleanup_repair_scaffolding_v3.py")],
    check=False,
)
if completed.returncode != 0:
    raise SystemExit(completed.returncode)

audit_tools = ROOT / "audit" / "tools"
audit_tools.mkdir(parents=True, exist_ok=True)
writer = ROOT / "scripts" / "write_source_identity_asset.py"
if writer.is_file():
    destination = audit_tools / writer.name
    if destination.exists():
        destination.unlink()
    shutil.move(str(writer), str(destination))

extra = [
    "scripts/cleanup_repair_scaffolding_v4.py",
    ".github/workflows/full-audit-repair-orchestrator-v4.yml",
]
removed = []
for relative in extra:
    target = ROOT / relative
    if target.is_file() or target.is_symlink():
        target.unlink()
        removed.append(relative)

print({
    "status": "PASS",
    "source_identity_writer": "audit/tools/write_source_identity_asset.py",
    "removed": removed,
})
