#!/usr/bin/env python3
"""Deep, read-only repository audit used by the Excel Inflow repair branch.

This script deliberately separates repository-owned tests from external-custody
release evidence. It never edits sources, expected outputs, schemas or goldens.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "assets" / "development-test-registry.json"
TEXT_SUFFIXES = {".py", ".mjs", ".js", ".cjs", ".json", ".md", ".yml", ".yaml", ".sh"}
SOURCE_SUFFIXES = {".py", ".mjs", ".js", ".cjs"}
ABSOLUTE_PATH = re.compile(r"/(?:Users|home|Volumes|private/tmp|var/folders)/[^\s\"']+")
TODO = re.compile(r"\b(?:TODO|FIXME|HACK|XXX)\b", re.I)


def canonical(value: Any) -> Any:
    if isinstance(value, list):
        return [canonical(item) for item in value]
    if isinstance(value, dict):
        return {key: canonical(value[key]) for key in sorted(value)}
    return value


def digest(value: Any) -> str:
    payload = json.dumps(canonical(value), separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(payload).hexdigest()


def run(command: list[str], *, timeout: int, env: dict[str, str]) -> dict[str, Any]:
    started = time.monotonic()
    try:
        completed = subprocess.run(
            command,
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout,
            env=env,
        )
        return {
            "command": command,
            "exit_code": completed.returncode,
            "duration_ms": round((time.monotonic() - started) * 1000, 3),
            "stdout": completed.stdout[-30000:],
            "stderr": completed.stderr[-30000:],
            "status": "PASS" if completed.returncode == 0 else "FAIL",
        }
    except subprocess.TimeoutExpired as error:
        return {
            "command": command,
            "exit_code": None,
            "duration_ms": round((time.monotonic() - started) * 1000, 3),
            "stdout": error.stdout[-30000:] if isinstance(error.stdout, str) else "",
            "stderr": error.stderr[-30000:] if isinstance(error.stderr, str) else "",
            "status": "TIMEOUT",
        }
    except Exception as error:
        return {
            "command": command,
            "exit_code": None,
            "duration_ms": round((time.monotonic() - started) * 1000, 3),
            "stdout": "",
            "stderr": repr(error),
            "status": "ERROR",
        }


def files() -> list[Path]:
    return sorted(
        path for path in ROOT.rglob("*")
        if path.is_file() and ".git" not in path.parts and "node_modules" not in path.parts
    )


def static_inventory(paths: list[Path]) -> dict[str, Any]:
    by_suffix: Counter[str] = Counter()
    lines = 0
    absolute_paths: list[dict[str, Any]] = []
    todo_markers: list[dict[str, Any]] = []
    broad_handlers: list[dict[str, Any]] = []
    unchecked_processes: list[dict[str, Any]] = []
    explicit_exits: list[dict[str, Any]] = []
    oversized: list[dict[str, Any]] = []
    imports: defaultdict[str, set[str]] = defaultdict(set)

    for path in paths:
        suffix = path.suffix.lower() or "<none>"
        by_suffix[suffix] += 1
        if suffix not in TEXT_SUFFIXES:
            continue
        relative = path.relative_to(ROOT).as_posix()
        text = path.read_text("utf-8", errors="ignore")
        source_lines = text.splitlines()
        lines += len(source_lines)
        if len(source_lines) >= 800 or path.stat().st_size >= 100_000:
            oversized.append({"path": relative, "lines": len(source_lines), "bytes": path.stat().st_size})
        for number, line in enumerate(source_lines, 1):
            for match in ABSOLUTE_PATH.finditer(line):
                absolute_paths.append({"path": relative, "line": number, "value": match.group(0)[:500]})
            if TODO.search(line):
                todo_markers.append({"path": relative, "line": number, "text": line.strip()[:500]})
            if suffix == ".py" and re.search(r"except\s+(?:Exception|BaseException)(?:\s+as\s+\w+)?\s*:", line):
                broad_handlers.append({"path": relative, "line": number, "kind": "python_broad_exception"})
            if suffix in {".mjs", ".js", ".cjs"} and re.search(r"catch\s*\([^)]*\)\s*\{", line):
                broad_handlers.append({"path": relative, "line": number, "kind": "javascript_catch"})
            if "check=False" in line or "check = False" in line:
                unchecked_processes.append({"path": relative, "line": number, "text": line.strip()[:500]})
            if re.search(r"process\.exit(?:Code)?|sys\.exit\s*\(|raise\s+SystemExit", line):
                explicit_exits.append({"path": relative, "line": number, "text": line.strip()[:500]})
        if suffix == ".py":
            try:
                tree = ast.parse(text)
                for node in ast.walk(tree):
                    if isinstance(node, ast.Import):
                        imports[relative].update(alias.name for alias in node.names)
                    elif isinstance(node, ast.ImportFrom) and node.module:
                        imports[relative].add(node.module)
            except SyntaxError:
                pass
        else:
            for match in re.finditer(r"(?:from\s+|import\s*\()?[\"'](\.{1,2}/[^\"']+)[\"']", text):
                imports[relative].add(match.group(1))

    return {
        "file_count": len(paths),
        "byte_count": sum(path.stat().st_size for path in paths),
        "text_line_count": lines,
        "by_suffix": dict(by_suffix.most_common()),
        "absolute_paths": absolute_paths,
        "todo_markers": todo_markers,
        "broad_handlers": broad_handlers,
        "unchecked_processes": unchecked_processes,
        "explicit_exits": explicit_exits,
        "oversized_modules": sorted(oversized, key=lambda item: (-item["bytes"], item["path"])),
        "import_edges": sum(len(value) for value in imports.values()),
    }


def syntax_checks(paths: list[Path], env: dict[str, str]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    results.append(run([sys.executable, "-m", "compileall", "-q", str(ROOT / "scripts")], timeout=300, env=env))
    node = shutil.which("node")
    node_failures = []
    checked = 0
    if node:
        for path in paths:
            if path.suffix.lower() not in {".mjs", ".js", ".cjs"}:
                continue
            checked += 1
            result = run([node, "--check", str(path)], timeout=30, env=env)
            if result["status"] != "PASS":
                node_failures.append({"path": path.relative_to(ROOT).as_posix(), **result})
    results.append({
        "kind": "node_syntax",
        "checked": checked,
        "failures": node_failures,
        "status": "PASS" if not node_failures and node else "FAIL",
    })
    json_failures = []
    json_count = 0
    for path in paths:
        if path.suffix.lower() != ".json":
            continue
        json_count += 1
        try:
            json.loads(path.read_text("utf-8"))
        except Exception as error:
            json_failures.append({"path": path.relative_to(ROOT).as_posix(), "error": str(error)})
    results.append({
        "kind": "json_parse",
        "checked": json_count,
        "failures": json_failures,
        "status": "PASS" if not json_failures else "FAIL",
    })
    return results


def script_interface(test: dict[str, Any]) -> dict[str, Any]:
    path = ROOT / "scripts" / test.get("script", "")
    if not path.is_file():
        return {"script_exists": False, "declared_arguments": test.get("arguments", []), "declared_requires": test.get("requires", [])}
    text = path.read_text("utf-8", errors="ignore")
    usage = re.findall(r"Usage:\s*([^\n\"`]+)", text)
    positional_destructures = re.findall(r"const\s*\[([^\]]+)\]\s*=\s*process\.argv\.slice\(2\)", text)
    argparse_positions = []
    if path.suffix == ".py":
        argparse_positions = [
            match.group(1)
            for match in re.finditer(r"add_argument\(\s*[\"']([^\-][^\"']*)[\"']", text)
        ]
    return {
        "script_exists": True,
        "declared_arguments": test.get("arguments", []),
        "declared_requires": test.get("requires", []),
        "usage": usage[:10],
        "node_positional_destructures": positional_destructures[:10],
        "python_positional_arguments": argparse_positions[:20],
    }


def run_registry(timeout: int, env: dict[str, str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    registry = json.loads(REGISTRY.read_text("utf-8"))
    interfaces = []
    results = []
    node = shutil.which("node") or "node"
    for test in registry.get("tests", []):
        interfaces.append({"id": test.get("id"), "phase": test.get("phase"), "script": test.get("script"), **script_interface(test)})
        if test.get("requires"):
            results.append({
                "id": test.get("id"),
                "phase": test.get("phase"),
                "status": "EXTERNAL_CUSTODY",
                "requires": test.get("requires"),
            })
            continue
        script = ROOT / "scripts" / test.get("script", "")
        if not script.is_file():
            results.append({"id": test.get("id"), "phase": test.get("phase"), "status": "MISSING_SCRIPT"})
            continue
        command = [sys.executable if test.get("runtime") == "python" else node, str(script), *test.get("arguments", [])]
        results.append({"id": test.get("id"), "phase": test.get("phase"), **run(command, timeout=timeout, env=env)})
    return interfaces, results


def duplicate_contract_scan(paths: list[Path]) -> list[dict[str, Any]]:
    by_key: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    needles = [
        "latest_supplied_house_then_zero_authority",
        "PASS_PENDING_MANUAL",
        "PASS_DEGRADED",
        "lumpy_discretionary_flow",
        "acquisitions_net_of_cash",
        "transaction enterprise value",
        "zero direct transaction cash-flow effect",
        "selected coherent broker house",
        "Forecast Waterfall",
    ]
    for path in paths:
        if path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        relative = path.relative_to(ROOT).as_posix()
        text = path.read_text("utf-8", errors="ignore")
        for needle in needles:
            count = text.lower().count(needle.lower())
            if count:
                by_key[needle].append({"path": relative, "count": count})
    return [{"term": key, "locations": value, "location_count": len(value)} for key, value in by_key.items()]


def write_markdown(report: dict[str, Any], target: Path) -> None:
    counts = Counter(item["status"] for item in report["tests"])
    lines = [
        "# Excel Inflow untouched forensic repository audit",
        "",
        f"- Source commit: `{report['source_identity']['commit']}`",
        f"- Source tree: `{report['source_identity']['tree']}`",
        f"- Files: {report['inventory']['file_count']:,}",
        f"- Parsed text lines: {report['inventory']['text_line_count']:,}",
        f"- Self-contained tests: {counts['PASS']} pass / {counts['FAIL']} fail / {counts['TIMEOUT']} timeout / {counts['ERROR']} error",
        f"- External-custody tests: {counts['EXTERNAL_CUSTODY']}",
        f"- Absolute-path findings: {len(report['inventory']['absolute_paths'])}",
        f"- Oversized modules: {len(report['inventory']['oversized_modules'])}",
        "",
        "## Failing repository-owned gates",
        "",
    ]
    for item in report["tests"]:
        if item["status"] not in {"FAIL", "TIMEOUT", "ERROR", "MISSING_SCRIPT"}:
            continue
        lines.extend([
            f"### `{item['id']}` — {item['status']}",
            "",
            "```text",
            (item.get("stderr") or item.get("stdout") or "")[-6000:],
            "```",
            "",
        ])
    lines.extend(["## Absolute-path and portability findings", ""])
    for finding in report["inventory"]["absolute_paths"]:
        lines.append(f"- `{finding['path']}:{finding['line']}` — `{finding['value']}`")
    lines.extend(["", "## Oversized modules", ""])
    for item in report["inventory"]["oversized_modules"]:
        lines.append(f"- `{item['path']}` — {item['lines']:,} lines / {item['bytes']:,} bytes")
    lines.extend(["", "## Registry interface inventory", ""])
    for item in report["interfaces"]:
        lines.append(
            f"- `{item['id']}` → `{item['script']}`; declared args `{item['declared_arguments']}`; "
            f"requires `{item['declared_requires']}`; usage `{item.get('usage', [])}`"
        )
    target.write_text("\n".join(lines) + "\n", "utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--source-commit", default=os.environ.get("EXCEL_INFLOW_SOURCE_COMMIT", "unknown"))
    parser.add_argument("--source-tree", default=os.environ.get("EXCEL_INFLOW_SOURCE_TREE", "unknown"))
    args = parser.parse_args()
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    env = {
        **os.environ,
        "PYTHONDONTWRITEBYTECODE": "1",
        "EXCEL_INFLOW_TEST_PYTHON": sys.executable,
    }
    source_files = files()
    inventory = static_inventory(source_files)
    interfaces, tests = run_registry(args.timeout, env)
    report = {
        "schema_version": "excel-inflow-forensic-repository-audit/1.0",
        "source_identity": {"commit": args.source_commit, "tree": args.source_tree},
        "toolchain": {
            "python": sys.version,
            "node": shutil.which("node"),
            "soffice": shutil.which("soffice") or shutil.which("libreoffice"),
        },
        "inventory": inventory,
        "syntax_checks": syntax_checks(source_files, env),
        "interfaces": interfaces,
        "tests": tests,
        "duplicate_policy_terms": duplicate_contract_scan(source_files),
    }
    report["report_sha256"] = digest(report)
    (output / "forensic-repository-audit.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")
    write_markdown(report, output / "forensic-repository-audit.md")
    failures = [item for item in tests if item["status"] in {"FAIL", "TIMEOUT", "ERROR", "MISSING_SCRIPT"}]
    print(json.dumps({
        "status": "PASS" if not failures else "FINDINGS",
        "repository_owned_failures": len(failures),
        "external_custody_tests": sum(item["status"] == "EXTERNAL_CUSTODY" for item in tests),
        "report_sha256": report["report_sha256"],
        "output": str(output),
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
