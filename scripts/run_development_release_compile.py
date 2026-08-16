#!/usr/bin/env python3
"""Compile a consistent development package without asserting certification."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node") or "node"


def run(command: list[str], timeout: int) -> dict[str, Any]:
    started = time.monotonic()
    completed = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=False, timeout=timeout, env={**os.environ, "EXCEL_INFLOW_RELEASE_MODE": "development"})
    return {
        "command": command,
        "status": "PASS" if completed.returncode == 0 else "FAIL",
        "exit_code": completed.returncode,
        "duration_ms": round((time.monotonic() - started) * 1000, 3),
        "stdout": completed.stdout[-100000:],
        "stderr": completed.stderr[-100000:],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    parser.add_argument("--timeout", type=int, default=1800)
    args = parser.parse_args()
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    compiler = ROOT / "scripts" / "compile_skill_release.mjs"
    attempts = []
    commands = [
        [NODE, str(compiler)],
        [NODE, str(compiler), "--mode", "development"],
        [NODE, str(compiler), "--development"],
    ]
    selected = None
    for command in commands:
        result = run(command, args.timeout)
        attempts.append(result)
        manifest_path = ROOT / "release-manifest.json"
        if result["status"] == "PASS" and manifest_path.is_file():
            manifest = json.loads(manifest_path.read_text("utf-8"))
            certification = manifest.get("certification") or {}
            if manifest.get("packageMode") == "development" and certification.get("certifiedClosureSha256") is None:
                selected = result
                break
    report = {
        "schema_version": "excel-inflow-development-release-compile/1.0",
        "status": "PASS" if selected else "FAIL",
        "selected_command": selected.get("command") if selected else None,
        "attempts": attempts,
        "manifest": json.loads((ROOT / "release-manifest.json").read_text("utf-8")) if (ROOT / "release-manifest.json").is_file() else None,
    }
    (output / "development-release-compile.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")
    print(json.dumps({"status": report["status"], "selected_command": report["selected_command"]}, sort_keys=True))
    return 0 if selected else 1


if __name__ == "__main__":
    raise SystemExit(main())
