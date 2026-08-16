#!/usr/bin/env python3
"""Deep, read-only Excel Inflow product, architecture, test and code audit.

The audit is intentionally independent from the build's own receipts. It maps
repository behaviour against audit/product-target-v1.json, runs every
repository-owned gate that does not require external custody, inspects registry
interfaces, reconstructs policy ownership, and emits machine-readable findings.
It never changes source files, schemas, goldens, exception lists or expected
outputs.
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
from collections import Counter, defaultdict, deque
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
TARGET_PATH = ROOT / "audit" / "product-target-v1.json"
REGISTRY_PATH = ROOT / "assets" / "development-test-registry.json"
DEPLOYMENT_PATH = ROOT / "assets" / "deployment-profile.json"
RELEASE_PATH = ROOT / "release-manifest.json"
TEXT_SUFFIXES = {".py", ".mjs", ".js", ".cjs", ".json", ".md", ".yml", ".yaml", ".sh"}
SOURCE_SUFFIXES = {".py", ".mjs", ".js", ".cjs"}
ABSOLUTE_PATH_RE = re.compile(r"/(?:Users|home|Volumes|private/tmp|var/folders)/[^\s\"'`]+")
JS_IMPORT_RE = re.compile(r"(?:from\s+|import\s*\()?[\"'](?P<value>\.{1,2}/[^\"']+)[\"']")
TODO_RE = re.compile(r"\b(?:TODO|FIXME|HACK|XXX)\b", re.I)
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")


@dataclass
class Finding:
    finding_id: str
    severity: str
    category: str
    title: str
    target_path: str
    source_paths: list[str]
    evidence: str
    impact: str
    earliest_layer: str
    general_repair: str
    preserved_invariants: list[str]
    test_required: str
    status: str = "OPEN"


def canonical(value: Any) -> Any:
    if isinstance(value, list):
        return [canonical(item) for item in value]
    if isinstance(value, dict):
        return {key: canonical(value[key]) for key in sorted(value)}
    return value


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(canonical(value), separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def read_text(path: Path) -> str:
    return path.read_text("utf-8", errors="ignore")


def repository_files() -> list[Path]:
    return sorted(
        path for path in ROOT.rglob("*")
        if path.is_file()
        and ".git" not in path.parts
        and "node_modules" not in path.parts
        and "audit/generated" not in path.as_posix()
    )


def run(command: list[str], timeout: int, env: dict[str, str]) -> dict[str, Any]:
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
            "status": "PASS" if completed.returncode == 0 else "FAIL",
            "exit_code": completed.returncode,
            "duration_ms": round((time.monotonic() - started) * 1000, 3),
            "stdout": completed.stdout[-50000:],
            "stderr": completed.stderr[-50000:],
        }
    except subprocess.TimeoutExpired as error:
        return {
            "command": command,
            "status": "TIMEOUT",
            "exit_code": None,
            "duration_ms": round((time.monotonic() - started) * 1000, 3),
            "stdout": error.stdout[-50000:] if isinstance(error.stdout, str) else "",
            "stderr": error.stderr[-50000:] if isinstance(error.stderr, str) else "",
        }
    except Exception as error:
        return {
            "command": command,
            "status": "ERROR",
            "exit_code": None,
            "duration_ms": round((time.monotonic() - started) * 1000, 3),
            "stdout": "",
            "stderr": repr(error),
        }


def flatten_target(value: Any, prefix: str = "") -> dict[str, Any]:
    result: dict[str, Any] = {}
    if isinstance(value, dict):
        for key, entry in value.items():
            path = f"{prefix}.{key}" if prefix else key
            result.update(flatten_target(entry, path))
    else:
        result[prefix] = value
    return result


def source_inventory(paths: list[Path]) -> dict[str, Any]:
    by_suffix: Counter[str] = Counter()
    by_top_level: Counter[str] = Counter()
    total_lines = 0
    total_bytes = 0
    absolute_paths: list[dict[str, Any]] = []
    todo_markers: list[dict[str, Any]] = []
    broad_handlers: list[dict[str, Any]] = []
    unchecked_processes: list[dict[str, Any]] = []
    explicit_exits: list[dict[str, Any]] = []
    oversized_modules: list[dict[str, Any]] = []
    long_functions: list[dict[str, Any]] = []
    branchy_functions: list[dict[str, Any]] = []
    duplicate_hashes: defaultdict[str, list[str]] = defaultdict(list)

    for path in paths:
        relative = path.relative_to(ROOT).as_posix()
        suffix = path.suffix.lower() or "<none>"
        by_suffix[suffix] += 1
        by_top_level[path.relative_to(ROOT).parts[0]] += 1
        size = path.stat().st_size
        total_bytes += size
        duplicate_hashes[hashlib.sha256(path.read_bytes()).hexdigest()].append(relative)
        if suffix not in TEXT_SUFFIXES:
            continue
        text = read_text(path)
        lines = text.splitlines()
        total_lines += len(lines)
        if suffix in SOURCE_SUFFIXES and (len(lines) >= 800 or size >= 100_000):
            oversized_modules.append({"path": relative, "lines": len(lines), "bytes": size})
        for line_number, line in enumerate(lines, 1):
            for match in ABSOLUTE_PATH_RE.finditer(line):
                absolute_paths.append({"path": relative, "line": line_number, "value": match.group(0)[:1000]})
            if TODO_RE.search(line):
                todo_markers.append({"path": relative, "line": line_number, "text": line.strip()[:1000]})
            if suffix == ".py" and re.search(r"except\s+(?:Exception|BaseException)(?:\s+as\s+\w+)?\s*:", line):
                broad_handlers.append({"path": relative, "line": line_number, "kind": "python_broad_exception"})
            if suffix in {".mjs", ".js", ".cjs"} and re.search(r"catch\s*\([^)]*\)\s*\{", line):
                broad_handlers.append({"path": relative, "line": line_number, "kind": "javascript_catch"})
            if "check=False" in line or "check = False" in line:
                unchecked_processes.append({"path": relative, "line": line_number, "text": line.strip()[:1000]})
            if re.search(r"process\.exit(?:Code)?|sys\.exit\s*\(|raise\s+SystemExit", line):
                explicit_exits.append({"path": relative, "line": line_number, "text": line.strip()[:1000]})
        if suffix == ".py":
            try:
                tree = ast.parse(text)
            except SyntaxError:
                continue
            for node in ast.walk(tree):
                if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) or not hasattr(node, "end_lineno"):
                    continue
                length = int(node.end_lineno or node.lineno) - node.lineno + 1
                branches = sum(
                    isinstance(child, (ast.If, ast.For, ast.AsyncFor, ast.While, ast.Try, ast.Match, ast.BoolOp))
                    for child in ast.walk(node)
                )
                if length >= 160:
                    long_functions.append({"path": relative, "name": node.name, "line": node.lineno, "lines": length, "branches": branches})
                if branches >= 25:
                    branchy_functions.append({"path": relative, "name": node.name, "line": node.lineno, "lines": length, "branches": branches})
        elif suffix in {".mjs", ".js", ".cjs"}:
            # Conservative JavaScript function-span estimate using brace balance.
            for match in re.finditer(r"(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{", text):
                start = match.start()
                line_number = text.count("\n", 0, start) + 1
                depth = 0
                end = None
                in_string = None
                escaped = False
                for index in range(match.end() - 1, len(text)):
                    char = text[index]
                    if in_string:
                        if escaped:
                            escaped = False
                        elif char == "\\":
                            escaped = True
                        elif char == in_string:
                            in_string = None
                        continue
                    if char in {"'", '"', '`'}:
                        in_string = char
                    elif char == "{":
                        depth += 1
                    elif char == "}":
                        depth -= 1
                        if depth == 0:
                            end = index
                            break
                if end is None:
                    continue
                body = text[start:end + 1]
                length = body.count("\n") + 1
                branches = len(re.findall(r"\b(?:if|for|while|switch|catch)\b|&&|\|\|", body))
                if length >= 160:
                    long_functions.append({"path": relative, "name": match.group(1), "line": line_number, "lines": length, "branches": branches})
                if branches >= 25:
                    branchy_functions.append({"path": relative, "name": match.group(1), "line": line_number, "lines": length, "branches": branches})

    exact_duplicates = [
        {"sha256": sha, "paths": members}
        for sha, members in duplicate_hashes.items()
        if len(members) > 1
    ]
    return {
        "file_count": len(paths),
        "byte_count": total_bytes,
        "text_line_count": total_lines,
        "by_suffix": dict(by_suffix.most_common()),
        "by_top_level": dict(by_top_level.most_common()),
        "absolute_paths": absolute_paths,
        "todo_markers": todo_markers,
        "broad_handlers": broad_handlers,
        "unchecked_processes": unchecked_processes,
        "explicit_exits": explicit_exits,
        "oversized_modules": sorted(oversized_modules, key=lambda item: (-item["bytes"], item["path"])),
        "long_functions": sorted(long_functions, key=lambda item: (-item["lines"], item["path"], item["line"])),
        "branchy_functions": sorted(branchy_functions, key=lambda item: (-item["branches"], item["path"], item["line"])),
        "exact_duplicate_files": exact_duplicates,
    }


def resolve_js_import(source: Path, value: str) -> Path | None:
    candidate = (source.parent / value).resolve()
    choices = [candidate]
    if candidate.suffix == "":
        choices += [candidate.with_suffix(suffix) for suffix in [".mjs", ".js", ".cjs", ".json"]]
        choices += [candidate / f"index{suffix}" for suffix in [".mjs", ".js", ".cjs"]]
    for choice in choices:
        if choice.is_file() and ROOT in choice.parents:
            return choice
    return None


def module_graph(paths: list[Path]) -> dict[str, Any]:
    source_paths = [path for path in paths if path.suffix.lower() in SOURCE_SUFFIXES]
    edges: defaultdict[str, set[str]] = defaultdict(set)
    reverse: defaultdict[str, set[str]] = defaultdict(set)
    syntax_failures = []
    for path in source_paths:
        relative = path.relative_to(ROOT).as_posix()
        text = read_text(path)
        if path.suffix.lower() == ".py":
            try:
                tree = ast.parse(text)
            except SyntaxError as error:
                syntax_failures.append({"path": relative, "error": str(error)})
                continue
            for node in ast.walk(tree):
                module = None
                if isinstance(node, ast.ImportFrom):
                    module = node.module
                if not module or node.level == 0:
                    continue
                base = path.parent
                for _ in range(max(0, node.level - 1)):
                    base = base.parent
                target = base / (module.replace(".", "/") + ".py")
                if target.is_file() and ROOT in target.resolve().parents:
                    target_relative = target.relative_to(ROOT).as_posix()
                    edges[relative].add(target_relative)
                    reverse[target_relative].add(relative)
        else:
            for match in JS_IMPORT_RE.finditer(text):
                target = resolve_js_import(path, match.group("value"))
                if target:
                    target_relative = target.relative_to(ROOT).as_posix()
                    edges[relative].add(target_relative)
                    reverse[target_relative].add(relative)
    deployment = json.loads(DEPLOYMENT_PATH.read_text("utf-8")) if DEPLOYMENT_PATH.is_file() else {}
    declared_entries = set()
    for key in ["entryPoints", "entry_points", "scripts"]:
        value = deployment.get(key)
        if isinstance(value, list):
            declared_entries.update(item for item in value if isinstance(item, str))
    release = json.loads(RELEASE_PATH.read_text("utf-8")) if RELEASE_PATH.is_file() else {}
    closure = release.get("closure") if isinstance(release, dict) else {}
    if isinstance(closure, dict):
        for key in ["entryPoints", "scripts"]:
            value = closure.get(key)
            if isinstance(value, list):
                declared_entries.update(item for item in value if isinstance(item, str))
    entry_candidates = {
        path.relative_to(ROOT).as_posix()
        for path in source_paths
        if path.name.startswith("run_") or path.name in {"build_dynamic_model.mjs", "compile_case.mjs", "orchestrate_release.mjs"}
    }
    roots = {item for item in declared_entries | entry_candidates if (ROOT / item).is_file()}
    reachable = set(roots)
    queue = deque(roots)
    while queue:
        current = queue.popleft()
        for target in edges.get(current, set()):
            if target not in reachable:
                reachable.add(target)
                queue.append(target)
    source_set = {path.relative_to(ROOT).as_posix() for path in source_paths}
    unreachable = sorted(source_set - reachable)
    orphan_runtime = sorted(
        path for path in unreachable
        if path.startswith("scripts/lib/") or path.startswith("scripts/") and "/verify/" not in path
    )
    missing_declared = sorted(item for item in declared_entries if not (ROOT / item).is_file())
    return {
        "source_module_count": len(source_set),
        "edge_count": sum(len(value) for value in edges.values()),
        "root_count": len(roots),
        "reachable_count": len(reachable),
        "unreachable_modules": unreachable,
        "orphan_runtime_candidates": orphan_runtime,
        "missing_declared_runtime_members": missing_declared,
        "syntax_failures": syntax_failures,
        "high_fan_in": sorted(
            ({"path": key, "importers": len(value)} for key, value in reverse.items()),
            key=lambda item: (-item["importers"], item["path"]),
        )[:40],
        "high_fan_out": sorted(
            ({"path": key, "imports": len(value)} for key, value in edges.items()),
            key=lambda item: (-item["imports"], item["path"]),
        )[:40],
    }


def schema_inventory(paths: list[Path]) -> dict[str, Any]:
    schemas = [path for path in paths if path.name.endswith(".schema.json")]
    schema_ids = defaultdict(list)
    const_versions = defaultdict(list)
    enums = defaultdict(list)
    invalid = []
    for path in schemas:
        relative = path.relative_to(ROOT).as_posix()
        try:
            value = json.loads(path.read_text("utf-8"))
        except Exception as error:
            invalid.append({"path": relative, "error": str(error)})
            continue
        if isinstance(value, dict) and value.get("$id"):
            schema_ids[str(value["$id"])].append(relative)
        stack = [("", value)]
        while stack:
            prefix, current = stack.pop()
            if isinstance(current, dict):
                if "const" in current and isinstance(current["const"], str) and "/" in current["const"]:
                    const_versions[current["const"]].append({"path": relative, "json_path": prefix})
                if "enum" in current and isinstance(current["enum"], list):
                    key = json.dumps(current["enum"], sort_keys=True)
                    enums[key].append({"path": relative, "json_path": prefix})
                for key, entry in current.items():
                    stack.append((f"{prefix}/{key}", entry))
            elif isinstance(current, list):
                for index, entry in enumerate(current):
                    stack.append((f"{prefix}/{index}", entry))
    return {
        "schema_count": len(schemas),
        "invalid_schemas": invalid,
        "duplicate_schema_ids": {key: value for key, value in schema_ids.items() if len(value) > 1},
        "schema_version_occurrences": dict(const_versions),
        "repeated_enums": [
            {"enum": json.loads(key), "occurrences": value}
            for key, value in enums.items()
            if len(value) >= 3 and len(json.loads(key)) >= 3
        ],
    }


def registry_audit(timeout: int, env: dict[str, str]) -> dict[str, Any]:
    registry = json.loads(REGISTRY_PATH.read_text("utf-8"))
    node = shutil.which("node") or "node"
    results = []
    interfaces = []
    duplicate_ids = [item for item, count in Counter(test.get("id") for test in registry.get("tests", [])).items() if count > 1]
    for test in registry.get("tests", []):
        script = ROOT / "scripts" / str(test.get("script") or "")
        text = read_text(script) if script.is_file() else ""
        usage = re.findall(r"Usage:\s*([^\n\"`]+)", text)
        node_positional = re.findall(r"const\s*\[([^\]]+)\]\s*=\s*process\.argv\.slice\(2\)", text)
        python_positional = re.findall(r"add_argument\(\s*[\"']([^\-][^\"']*)[\"']", text) if script.suffix == ".py" else []
        interface_findings = []
        declared_args = test.get("arguments") or []
        if node_positional:
            required_guess = len([item for item in node_positional[0].split(",") if item.strip()])
            if len(declared_args) < required_guess and not test.get("requires"):
                interface_findings.append(f"registry supplies {len(declared_args)} arguments but source destructures {required_guess}")
        interfaces.append({
            "id": test.get("id"),
            "phase": test.get("phase"),
            "script": test.get("script"),
            "script_exists": script.is_file(),
            "declared_arguments": declared_args,
            "declared_requires": test.get("requires") or [],
            "usage": usage[:10],
            "node_positional_destructures": node_positional[:10],
            "python_positional_arguments": python_positional[:20],
            "interface_findings": interface_findings,
        })
        if not script.is_file():
            results.append({"id": test.get("id"), "phase": test.get("phase"), "status": "MISSING_SCRIPT"})
            continue
        if test.get("requires"):
            results.append({
                "id": test.get("id"), "phase": test.get("phase"), "status": "EXTERNAL_CUSTODY",
                "requires": test.get("requires"), "arguments": declared_args,
            })
            continue
        command = [sys.executable if test.get("runtime") == "python" else node, str(script), *map(str, declared_args)]
        results.append({"id": test.get("id"), "phase": test.get("phase"), **run(command, timeout, env)})
    counts = Counter(result["status"] for result in results)
    return {
        "test_count": len(results),
        "counts": dict(counts),
        "duplicate_test_ids": duplicate_ids,
        "interfaces": interfaces,
        "results": results,
        "external_custody_fraction": round(counts["EXTERNAL_CUSTODY"] / max(1, len(results)), 4),
    }


def syntax_audit(paths: list[Path], env: dict[str, str]) -> dict[str, Any]:
    results = []
    results.append({"kind": "python_compileall", **run([sys.executable, "-m", "compileall", "-q", str(ROOT / "scripts")], 300, env)})
    node = shutil.which("node")
    node_failures = []
    checked = 0
    if node:
        for path in paths:
            if path.suffix.lower() not in {".mjs", ".js", ".cjs"}:
                continue
            checked += 1
            result = run([node, "--check", str(path)], 30, env)
            if result["status"] != "PASS":
                node_failures.append({"path": path.relative_to(ROOT).as_posix(), **result})
    results.append({"kind": "node_check", "status": "PASS" if node and not node_failures else "FAIL", "checked": checked, "failures": node_failures})
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
    results.append({"kind": "json_parse", "status": "PASS" if not json_failures else "FAIL", "checked": json_count, "failures": json_failures})
    return {"results": results}


def search_occurrences(paths: Iterable[Path], patterns: dict[str, re.Pattern[str]]) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {key: [] for key in patterns}
    for path in paths:
        if path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        relative = path.relative_to(ROOT).as_posix()
        for line_number, line in enumerate(read_text(path).splitlines(), 1):
            for key, pattern in patterns.items():
                if pattern.search(line):
                    result[key].append({"path": relative, "line": line_number, "text": line.strip()[:1200]})
    return result


def policy_ownership(paths: list[Path]) -> dict[str, Any]:
    terms = {
        "delivery_liveness": re.compile(r"broker.*(?:never|may not|cannot).*block|optional broker.*deliver", re.I),
        "broker_recovery_selection": re.compile(r"latest_supplied_house_then_zero_authority|vision_house_id|maximum_recovery_house_count", re.I),
        "broker_native_eligibility": re.compile(r"archive.only regardless|unselected_house|native.clean", re.I),
        "forecast_waterfall": re.compile(r"FORECAST_AUTHORITY_PRIORITY|authority_ladder|Forecast Waterfall", re.I),
        "lumpy_discretionary": re.compile(r"lumpy_discretionary_flow|three.year historical average used for a lumpy", re.I),
        "discrete_event": re.compile(r"NON_RECURRING_ROLES|STRUCTURAL_EVENT_ROLES|semantic_event_nonrecurrence", re.I),
        "acquisition_zero_cash": re.compile(r"zero direct transaction cash.flow effect|zero_direct_cash|acquisition.*cash.*zero", re.I),
        "acquisition_consideration": re.compile(r"consideration|financing proceeds", re.I),
        "release_pass": re.compile(r"PASS_PENDING_MANUAL|certifiedClosureSha256|packageMode", re.I),
        "runtime_trace": re.compile(r"user.submission|visible.response|duration_ms|telemetry|trace_id|span_id", re.I),
        "source_identity": re.compile(r"source_commit|source_tree|closure_sha256|installation_identity", re.I),
    }
    occurrences = search_occurrences(paths, terms)
    ownership = []
    for key, items in occurrences.items():
        code = [item for item in items if item["path"].endswith(tuple(SOURCE_SUFFIXES)) or item["path"].endswith(".json")]
        docs = [item for item in items if item["path"].endswith(".md")]
        ownership.append({"policy": key, "code_locations": code, "documentation_locations": docs, "total_locations": len(items)})
    return {"policies": ownership}


def semantic_registry_audit(paths: list[Path]) -> dict[str, Any]:
    taxonomy_path = ROOT / "assets" / "statement-semantic-taxonomy.v1.json"
    taxonomy_roles = set()
    if taxonomy_path.is_file():
        taxonomy = json.loads(taxonomy_path.read_text("utf-8"))
        taxonomy_roles = {str(item.get("id")) for item in taxonomy.get("roles", []) if item.get("id")}
    role_occurrences: defaultdict[str, set[str]] = defaultdict(set)
    set_blocks: list[dict[str, Any]] = []
    for path in paths:
        if path.suffix.lower() not in SOURCE_SUFFIXES:
            continue
        text = read_text(path)
        relative = path.relative_to(ROOT).as_posix()
        for match in re.finditer(r"[\"']([a-z][a-z0-9_]{2,})[\"']", text):
            value = match.group(1)
            if any(token in value for token in ["revenue", "ebit", "cash", "debt", "interest", "acquisition", "tax", "capex", "dividend", "lease", "liquidity", "working_capital"]):
                role_occurrences[value].add(relative)
        for match in re.finditer(r"(?:ROLES|ROLE|SEMANTIC)[A-Z0-9_]*\s*=\s*new\s+Set\(\[", text):
            start = match.start()
            end = text.find("]);", match.end())
            if end >= 0:
                block = text[start:end + 3]
                set_blocks.append({"path": relative, "line": text.count("\n", 0, start) + 1, "sha256": hashlib.sha256(block.encode()).hexdigest(), "preview": block[:1500]})
    emitted_not_centrally_registered = sorted(role for role in taxonomy_roles if len(role_occurrences.get(role, set())) == 0)
    multiply_owned = sorted(
        ({"role": role, "files": sorted(files)} for role, files in role_occurrences.items() if len(files) >= 5),
        key=lambda item: (-len(item["files"]), item["role"]),
    )
    return {
        "taxonomy_role_count": len(taxonomy_roles),
        "taxonomy_roles": sorted(taxonomy_roles),
        "taxonomy_roles_not_referenced_in_code": emitted_not_centrally_registered,
        "multiply_owned_role_literals": multiply_owned,
        "semantic_set_blocks": set_blocks,
    }


def test_quality_audit(paths: list[Path], registry: dict[str, Any]) -> dict[str, Any]:
    by_script = {item["script"]: item for item in registry["interfaces"]}
    rows = []
    for script_name, interface in by_script.items():
        path = ROOT / "scripts" / script_name
        if not path.is_file():
            continue
        text = read_text(path)
        lower = text.lower()
        raw_input = any(term in lower for term in ["%pdf", "raw pdf", "raw bytes", "source.write_bytes", "attachment"])
        workbook_output = any(term in lower for term in [".xlsx", "workbook", "build_dynamic_model"])
        mutation = any(term in lower for term in ["mutation", "corrupt", "hostile", "tamper", "assert.throws", "should fail", "incorrect"])
        preauthored = any(term in lower for term in ["simulate the installed model-host semantic response", "crosswalk =", "mappings =", "coverage_ledger ="])
        external = bool(interface.get("declared_requires"))
        output_inspection = any(term in lower for term in ["formula", "source provenance", "broker link", "selected value count", "inspect"])
        rows.append({
            "id": interface["id"],
            "script": script_name,
            "raw_input": raw_input,
            "workbook_output": workbook_output,
            "targeted_mutation": mutation,
            "preauthored_semantic_surface": preauthored,
            "external_custody": external,
            "workbook_consumption_inspected": output_inspection,
            "proof_classes": sorted([
                *(["liveness"] if any(term in lower for term in ["deliver", "pass_degraded", "user_blocking"]) else []),
                *(["integrity"] if any(term in lower for term in ["sha256", "hash", "schema", "receipt"]) else []),
                *(["economic_correctness"] if any(term in lower for term in ["economic", "leverage", "cash flow", "debt", "interest"]) else []),
                *(["usefulness"] if any(term in lower for term in ["usable", "selected broker", "model authority", "broker link"]) else []),
                *(["performance"] if any(term in lower for term in ["duration", "wall clock", "latency", "runtime"]) else []),
                *(["release_identity"] if any(term in lower for term in ["release", "closure", "installation"]) else []),
            ]),
        })
    return {"tests": rows}


def build_findings(
    target: dict[str, Any],
    inventory: dict[str, Any],
    modules: dict[str, Any],
    schemas: dict[str, Any],
    registry: dict[str, Any],
    policy: dict[str, Any],
    semantic: dict[str, Any],
    tests: dict[str, Any],
    paths: list[Path],
) -> tuple[list[Finding], list[dict[str, Any]]]:
    texts = {path.relative_to(ROOT).as_posix(): read_text(path) for path in paths if path.suffix.lower() in TEXT_SUFFIXES}
    combined = "\n".join(texts.values())
    findings: list[Finding] = []

    def add(**kwargs: Any) -> None:
        findings.append(Finding(**kwargs))

    def source_contains(path: str, needle: str) -> bool:
        return needle in texts.get(path, "")

    # Known economic and product seams.
    if source_contains("scripts/extract_broker_evidence.py", "archive-only regardless of whether its") or source_contains("scripts/extract_broker_evidence.py", "unselected_house = descriptor.get(\"house_id\") != vision_house_id"):
        add(
            finding_id="P1-BROKER-ELIGIBILITY-ORDER",
            severity="P1", category="broker", title="Non-selected houses are prohibited before native quality is assessed",
            target_path="evidence.broker.all_native_clean_houses_evaluated_before_recovery_selection",
            source_paths=["scripts/extract_broker_evidence.py", "references/broker-extraction.md"],
            evidence="The extractor sets all non-selected-house tables archive-only even when the native lane is complete, while the written contract says already-clean native cells remain eligible.",
            impact="A readable older house can be excluded solely because another report is newer, collapsing broker authority to zero and weakening forecast usefulness.",
            earliest_layer="evidence selection policy",
            general_repair="Separate all-house native eligibility from the one-house expensive recovery frontier; score coherent native coverage before choosing recovery.",
            preserved_invariants=["one coherent authority house", "one expensive recovery frontier", "exact selected-cell provenance", "broker failure never blocks delivery"],
            test_required="Newest report unreadable; older native-clean complete report remains eligible and is consumed by the workbook.",
        )
    if source_contains("scripts/extract_broker_evidence.py", "latest_supplied_house_then_zero_authority"):
        add(
            finding_id="P1-BROKER-DATE-FIRST",
            severity="P1", category="broker", title="Recovery selection treats publication date as evidence quality",
            target_path="evidence.broker.publication_date_is_late_tiebreak_only",
            source_paths=["scripts/extract_broker_evidence.py", "assets/broker-extraction-bundle.schema.json"],
            evidence="The selected recovery house is chosen by descending publication date before native coverage, confidence or demanded-concept completeness.",
            impact="The system may spend its only recovery frontier on the least useful report and suppress cleaner evidence.",
            earliest_layer="broker recovery policy",
            general_repair="Rank quality and material demanded coverage first; use publication date only after equal evidence quality.",
            preserved_invariants=["bounded optional work", "one recovery frontier", "one coherent house"],
            test_required="Two equal-quality houses use date tie-break; unequal-quality houses always choose quality.",
        )
    filing_text = texts.get("scripts/extract_filing_statements.py", "")
    if "is_subtotal_label" in filing_text and "infer_parent_links" in filing_text and "arithmetic" not in filing_text[filing_text.find("def infer_parent_links"):filing_text.find("def extract_statement")]:
        add(
            finding_id="P1-SOURCE-ARITHMETIC-OWNERSHIP",
            severity="P1", category="filings", title="Face-statement parent ownership depends on subtotal captions",
            target_path="evidence.filings.source_visible_arithmetic_precedes_taxonomy",
            source_paths=["scripts/extract_filing_statements.py", "scripts/lib/statement_topology.mjs"],
            evidence="Only rows recognised by is_subtotal_label may own geometrically indented children; source arithmetic equality across historical periods is not an independent ownership signal.",
            impact="Issuer-specific aggregates such as Product Revenue lose component ownership and are legitimately trended as independent forecast rows downstream.",
            earliest_layer="raw filing topology",
            general_repair="Compile source arithmetic edges from period-by-period equality, adjacency and geometry before taxonomy; labels may support but never own the relation.",
            preserved_invariants=["original issuer labels", "source order", "company-specific statement depth", "one forecast writer"],
            test_required="Caption mutation preserves Product Sales + Alliance Revenue = Product Revenue; numeric mutation breaks the edge.",
        )
    forecast_behavior = texts.get("scripts/lib/forecast_behavior.mjs", "")
    forecast_candidate = texts.get("scripts/lib/forecast_candidate_compiler.mjs", "")
    if "lumpy_discretionary_flow" in forecast_candidate and "historical_average" in forecast_candidate:
        add(
            finding_id="P1-DISCRETE-EVENT-AVERAGE",
            severity="P1", category="forecast", title="Lumpy discretionary rows can recur by historical average without forward evidence",
            target_path="economic_engine.discrete_event_policy",
            source_paths=["scripts/lib/forecast_behavior.mjs", "scripts/lib/forecast_candidate_compiler.mjs", "assets/statement-semantic-taxonomy.v1.json"],
            evidence="The lumpy behavior explicitly emits a three-year historical-average candidate, while emitted acquisition role names are not fully closed over the structured non-recurring registry.",
            impact="Acquisition and other discrete outflows can repeat mechanically in every forecast year despite the rationale admitting no stable trend.",
            earliest_layer="semantic role and behavior policy",
            general_repair="Make recurrence and variability independent; only recurring-lumpy rows may use history. Structured discrete events require commitment, guidance, broker or user evidence, otherwise supported zero/not separately forecast.",
            preserved_invariants=["forecast waterfall", "visible formulas", "material unresolved nodes remain strict"],
            test_required="Three non-zero acquisition history years with no forward evidence never generate average, trend or carry-forward candidates.",
        )
    if "acquisitions_net_of_cash" in combined and "acquisitions_net_of_cash" not in forecast_behavior:
        add(
            finding_id="P1-SEMANTIC-ROLE-CLOSURE",
            severity="P1", category="forecast", title="Taxonomy emits a role not owned by the non-recurring behavior registry",
            target_path="flexibility.semantic_roles_have_one_canonical_registry",
            source_paths=["assets/statement-semantic-taxonomy.v1.json", "scripts/lib/forecast_behavior.mjs", "scripts/lib/forecast_authority.mjs"],
            evidence="The filing taxonomy emits acquisitions_net_of_cash, but separate role sets use acquisition, acquisition_cost and business_combination names.",
            impact="A semantically known acquisition row can fall into a weaker generic caption-driven behavior path.",
            earliest_layer="semantic registry",
            general_repair="Generate all behavior and authority role sets from one canonical registry with CI closure checks for every emitted role.",
            preserved_invariants=["issuer labels unchanged", "no issuer branches", "one writer per node"],
            test_required="Every taxonomy role has an explicit recurrence, variability and producer policy; unknown roles fail closed.",
        )
    acquisition_doc = texts.get("references/acquisition.md", "")
    validation_doc = texts.get("references/validation.md", "")
    if "zero direct transaction cash-flow effect" in acquisition_doc and "consideration" in validation_doc and "financing proceeds" in validation_doc:
        add(
            finding_id="P1-ACQUISITION-CONSTITUTION",
            severity="P1", category="acquisition", title="Acquisition policy and validation require incompatible economics",
            target_path="acquisition.mode",
            source_paths=["references/acquisition.md", "references/validation.md", "scripts/lib/acquisition_policy.mjs", "scripts/lib/solver.mjs", "scripts/build_dynamic_model.mjs"],
            evidence="The acquisition reference forbids direct transaction cash flows, while validation requires consideration and acquisition debt financing proceeds once.",
            impact="The workbook can show a cash-generative acquisition entering leverage almost for free, while validators cannot establish one coherent product contract.",
            earliest_layer="product specification",
            general_repair="Adopt one lightweight funded-transaction contract: consideration out once, debt proceeds in once, residual through existing cash/RCF; no equity plug or full M&A model.",
            preserved_invariants=["lightweight overlay", "existing debt/RCF fixed point", "close-month timing", "no acquisition instrument-register expansion"],
            test_required="Acquisition On/Off, material EV/debt, insufficient cash and RCF shortfall cases prove visible P&L, investing, financing, debt, interest and leverage.",
        )
    raw_canary = texts.get("scripts/run_raw_input_black_box_canary.mjs", "")
    if "Simulate the installed model-host semantic response" in raw_canary or "zeroCrosswalk.coverage_ledger" in raw_canary:
        add(
            finding_id="P1-CANARY-SIMULATED-HOST",
            severity="P1", category="testing", title="Raw-input canary simulates the model-host semantic seam it claims to exercise",
            target_path="validation.raw_pdf_installed_host_canary_must_not_preauthor_semantics",
            source_paths=["scripts/run_raw_input_black_box_canary.mjs", "scripts/run_universal_broker_delivery_matrix.mjs"],
            evidence="After raw PDF discovery, the test itself authors active metrics, coverage ledger entries and mappings rather than consuming an actual installed-host response.",
            impact="A green canary can coexist with live host failure and zero broker authority.",
            earliest_layer="test harness",
            general_repair="Reclassify the deterministic downstream canary honestly and add an external-custody installed-host test that binds raw attachment, real host responses, selected-cell provenance and workbook links.",
            preserved_invariants=["deterministic local coverage", "raw attachment hashing", "no unverified broker values"],
            test_required="Raw usable broker PDF produces actual host artifacts and delivered workbook broker links without authored crosswalk in the test script.",
        )
    universal = next((item for item in registry["interfaces"] if item["id"] == "universal-broker-delivery-matrix"), None)
    if universal and universal["interface_findings"]:
        add(
            finding_id="P1-REGISTRY-INTERFACE-DRIFT",
            severity="P1", category="testing", title="Development registry and executable test interface have drifted",
            target_path="engineering_quality.no_stale_registry_interfaces",
            source_paths=["assets/development-test-registry.json", "scripts/run_universal_broker_delivery_matrix.mjs", "scripts/run_development_gate.mjs"],
            evidence="; ".join(universal["interface_findings"]),
            impact="A named universal matrix may be blocked or invoke the wrong inputs while release reporting implies coverage.",
            earliest_layer="test registry",
            general_repair="Use typed test run specifications and an interface probe that validates every registry entry before running the gate.",
            preserved_invariants=["missing custody remains BLOCKED", "no weakened tests"],
            test_required="Mutating any registered argument count or option name fails the registry interface gate.",
        )
    carrier = texts.get("scripts/lib/run_carrier.mjs", "")
    required_identity = ["source_commit", "source_tree", "package_mode", "certified_closure"]
    missing_identity = [field for field in required_identity if field not in carrier]
    if missing_identity:
        add(
            finding_id="P1-CARRIER-SOURCE-IDENTITY",
            severity="P1", category="release", title="Run carrier cannot identify the exact source and certification state",
            target_path="runtime_and_release.source_repository_commit_tree_and_closure_persisted_in_carrier",
            source_paths=["scripts/lib/run_carrier.mjs", "release-manifest.json", "assets/runtime-manifest.json"],
            evidence=f"Carrier source omits: {', '.join(missing_identity)}.",
            impact="A live diagnostic can prove artifact hashes yet cannot attribute behavior to a repository commit/tree or distinguish development from certified installation.",
            earliest_layer="run identity contract",
            general_repair="Introduce source and installation identity objects bound into the carrier hash and every nested trace/receipt.",
            preserved_invariants=["content-addressed resume", "workspace isolation", "issuer identity binding"],
            test_required="Commit/tree/package/certification mutation invalidates carrier verification and stale resume.",
        )
    release = json.loads(RELEASE_PATH.read_text("utf-8")) if RELEASE_PATH.is_file() else {}
    certification = release.get("certification") if isinstance(release, dict) else {}
    if release.get("packageMode") == "development" or not (certification or {}).get("certifiedClosureSha256"):
        add(
            finding_id="P0-UNCERTIFIED-LIVE-CANDIDATE",
            severity="P0", category="release", title="Current candidate is development-mode and uncertified",
            target_path="runtime_and_release.certified_immutable_closure_required_for_promotion",
            source_paths=["release-manifest.json", "assets/runtime-manifest.json", "references/development-and-release-loop.md"],
            evidence="release-manifest.json declares packageMode=development and no certified closure/evidence receipt.",
            impact="Byte identity and delivery do not establish release readiness or installed-host behavioral certification.",
            earliest_layer="release governance",
            general_repair="Keep development routes explicit; compile a new immutable certified closure only after economic, native Excel, visual, installed-host and performance evidence passes.",
            preserved_invariants=["closure hashing", "manual native Excel distinction", "development testing allowed"],
            test_required="Production alias refuses development or uncertified package; certified release binds exact evidence hashes.",
        )
    if inventory["absolute_paths"]:
        add(
            finding_id="P1-NONPORTABLE-PATHS",
            severity="P1", category="portability", title="Repository contains hidden machine-specific paths",
            target_path="engineering_quality.no_hidden_absolute_paths",
            source_paths=sorted({item["path"] for item in inventory["absolute_paths"]}),
            evidence=f"Found {len(inventory['absolute_paths'])} absolute Mac/Linux path literals.",
            impact="Repository-owned tests and release tools may only work on the original developer machine, turning missing fixtures into invisible coverage gaps.",
            earliest_layer="test and release configuration",
            general_repair="Replace local paths with repository-relative fixtures or explicit external-custody inputs; add a portability gate that rejects forbidden roots.",
            preserved_invariants=["external custody remains hash-bound", "missing inputs block rather than skip"],
            test_required="Clean checkout on Linux and macOS resolves every repository-owned fixture without /Users or /Volumes paths.",
        )
    if registry["counts"].get("EXTERNAL_CUSTODY", 0) > 0:
        add(
            finding_id="P2-EXTERNAL-CUSTODY-SURFACE",
            severity="P2", category="testing", title="Material portions of the test programme require undeclared external custody",
            target_path="flexibility.portable_repository_owned_test_fixtures_required",
            source_paths=["assets/development-test-registry.json", "scripts/run_development_gate.mjs"],
            evidence=f"{registry['counts'].get('EXTERNAL_CUSTODY', 0)} of {registry['test_count']} registered tests require supplied external paths.",
            impact="A developer cannot reproduce the full claimed gate from a clean checkout, and release claims can silently depend on unavailable private state.",
            earliest_layer="test custody architecture",
            general_repair="Separate portable repository-owned correctness fixtures from explicitly external release evidence; publish fixture manifests and provenance.",
            preserved_invariants=["real corpus remains external where licensing requires", "missing custody is BLOCKED"],
            test_required="Clean checkout runs the full development correctness gate; only clearly named release-certification tests remain external.",
        )
    failing = [item for item in registry["results"] if item["status"] in {"FAIL", "TIMEOUT", "ERROR", "MISSING_SCRIPT"}]
    if failing:
        add(
            finding_id="P1-REPOSITORY-OWNED-GATE-FAILURES",
            severity="P1", category="testing", title="Untouched repository-owned gates do not all pass",
            target_path="validation.positive_tests_have_targeted_mutations",
            source_paths=sorted({f"scripts/{next((i['script'] for i in registry['interfaces'] if i['id'] == item['id']), '')}" for item in failing}),
            evidence="; ".join(f"{item['id']}={item['status']}" for item in failing[:20]),
            impact="The candidate cannot be treated as a stable repair base; ordinary user and compiler paths may already be broken independently of AstraZeneca.",
            earliest_layer="repository baseline",
            general_repair="Fix earliest source owners; do not weaken assertions or update expected outputs. Require a clean baseline before certification.",
            preserved_invariants=["existing strict gates", "no expected-output regeneration"],
            test_required="All repository-owned gates pass in a clean Linux checkout with exact inputs recorded.",
        )
    if inventory["oversized_modules"]:
        largest = inventory["oversized_modules"][:8]
        add(
            finding_id="P2-OVERSIZED-MODULES",
            severity="P2", category="code_quality", title="Core modules concentrate unrelated responsibilities",
            target_path="engineering_quality.oversized_modules_require_named_decomposition_plan",
            source_paths=[item["path"] for item in largest],
            evidence="; ".join(f"{item['path']}={item['lines']} lines" for item in largest),
            impact="Economic ownership, rendering, policy and orchestration become hard to isolate; regression surface grows and shared-authority bugs are easier to hide.",
            earliest_layer="module architecture",
            general_repair="Decompose only along stable ownership boundaries: source topology, authority, solver, workbook IR, rendering and proof. Avoid adding wrapper layers.",
            preserved_invariants=["economic equation graph", "deterministic workbook output", "public APIs"],
            test_required="Module extraction is byte/economic-equivalent across frozen cases and removes duplicate policy logic.",
        )
    if modules["orphan_runtime_candidates"]:
        add(
            finding_id="P2-UNREACHABLE-RUNTIME-CODE",
            severity="P2", category="code_quality", title="Runtime-like modules are not reachable from declared entry points",
            target_path="engineering_quality.unused_or_unreachable_runtime_members_removed",
            source_paths=modules["orphan_runtime_candidates"][:30],
            evidence=f"Static import graph found {len(modules['orphan_runtime_candidates'])} runtime-like orphan candidates.",
            impact="Dead or parallel implementations can remain in release closure, confuse ownership and inflate audit surface.",
            earliest_layer="release/module registry",
            general_repair="Classify each candidate as dynamic entry, test-only or dead; declare dynamic edges explicitly and delete superseded code.",
            preserved_invariants=["installed runtime closure", "rollback assets where explicitly named"],
            test_required="Every shipped runtime member has a declared entry/reachability witness; deletion mutation is detected.",
        )
    if inventory["broad_handlers"] or inventory["unchecked_processes"]:
        add(
            finding_id="P2-ERROR-OWNERSHIP",
            severity="P2", category="code_quality", title="Broad exception and unchecked subprocess patterns obscure failure ownership",
            target_path="engineering_quality.no_broad_exception_swallowing_at_economic_boundaries",
            source_paths=sorted({item["path"] for item in inventory["broad_handlers"] + inventory["unchecked_processes"]})[:40],
            evidence=f"{len(inventory['broad_handlers'])} broad catch sites; {len(inventory['unchecked_processes'])} check=False subprocess sites.",
            impact="Optional broker failures may be contained appropriately, but mandatory source, compiler or workbook failures can be misclassified, retried or reported late.",
            earliest_layer="runtime error handling",
            general_repair="Give each boundary typed errors and explicit exit-code ownership; retain broad containment only at top-level optional adapters with preserved causes.",
            preserved_invariants=["broker circuit breaker", "mandatory failures remain blocking", "diagnostic receipts"],
            test_required="Fault injection proves every throw/exit/timeout maps to the correct blocker owner and preserves the original cause.",
        )
    if len([item for item in policy["policies"] if item["total_locations"] >= 8]) >= 3:
        add(
            finding_id="P2-DUPLICATE-POLICY-OWNERS",
            severity="P2", category="architecture", title="Policy is authored across many code, schema and documentation surfaces",
            target_path="engineering_quality.single_authority_per_policy_question",
            source_paths=sorted({loc["path"] for item in policy["policies"] for loc in item["code_locations"]})[:50],
            evidence="Multiple critical policies have eight or more independent literal locations.",
            impact="A change can update one constitution while leaving executable code, schemas, tests and release reporting contradictory.",
            earliest_layer="control-plane architecture",
            general_repair="Retain one executable product constitution and one semantic registry; generate schema enums, docs summaries and test fixtures from them where practical.",
            preserved_invariants=["hash-bound contracts", "human-readable docs", "independent validators"],
            test_required="Mutating the canonical owner changes generated views; editing a generated view directly fails CI.",
        )
    if semantic["multiply_owned_role_literals"]:
        add(
            finding_id="P2-SEMANTIC-VOCABULARY-DUPLICATION",
            severity="P2", category="flexibility", title="Economic roles are repeated in many independent source sets",
            target_path="flexibility.semantic_roles_have_one_canonical_registry",
            source_paths=sorted({file for item in semantic["multiply_owned_role_literals"][:20] for file in item["files"]}),
            evidence=f"{len(semantic['multiply_owned_role_literals'])} economic role literals appear in five or more modules.",
            impact="New issuer rows can be classified in one layer but omitted from behavior, authority, producer, validation or workbook projection.",
            earliest_layer="semantic vocabulary architecture",
            general_repair="Canonicalize role metadata: section, recurrence, variability, schedule owner, broker eligibility and output reachability; import generated sets.",
            preserved_invariants=["run-scoped broker concepts", "issuer labels", "company-specific row flexibility"],
            test_required="Role closure test fails whenever an emitted role lacks behavior, producer and validation ownership.",
        )

    # Target crosswalk: objective status from evidence patterns and findings.
    finding_by_target = defaultdict(list)
    for finding in findings:
        finding_by_target[finding.target_path].append(finding.finding_id)
    target_rows = []
    flat = flatten_target(target)
    for path, expected in flat.items():
        blockers = []
        for target_prefix, ids in finding_by_target.items():
            if path == target_prefix or path.startswith(target_prefix + ".") or target_prefix.startswith(path + "."):
                blockers.extend(ids)
        status = "DIVERGED" if blockers else "UNPROVEN"
        evidence = []
        # Stable positive evidence probes.
        probes = {
            "user_journey.visible_sequence": ["assets/product-constitution-v1.json", "assets/workflow-state-contract-v1.json"],
            "evidence.broker.archive_every_supplied_report": ["scripts/archive_broker_pages.py", "scripts/extract_broker_evidence.py"],
            "economic_engine.cash_rcf_interest_fixed_point_strict": ["assets/equation-graph.v1.json", "scripts/lib/solver.mjs", "scripts/run_fixed_point_constitution_tests.mjs"],
            "economic_engine.one_writer_per_forecast_node": ["scripts/lib/forecast_producer_contract.mjs", "scripts/lib/forecast_candidate_compiler.mjs"],
            "workbook.external_links_on_delivery": ["scripts/verify/validate_dynamic_model.py", "scripts/verify/workbook_semantic_oracle.py"],
            "validation.missing_external_custody_is_blocked_not_green": ["scripts/run_development_gate.mjs"],
            "runtime_and_release.development_package_not_promotable": ["references/development-and-release-loop.md", "scripts/validate_release_certification.mjs"],
        }
        if path in probes and all((ROOT / item).is_file() for item in probes[path]):
            evidence = probes[path]
            if not blockers:
                status = "IMPLEMENTED_NOT_END_TO_END_PROVEN"
        target_rows.append({"target_path": path, "expected": expected, "status": status, "blocking_findings": sorted(set(blockers)), "evidence_paths": evidence})
    return findings, target_rows


def markdown(report: dict[str, Any]) -> str:
    findings = report["findings"]
    counts = Counter(item["severity"] for item in findings)
    registry_counts = report["test_registry"]["counts"]
    lines = [
        "# Excel Inflow deep product and architecture audit",
        "",
        "## Executive verdict",
        "",
        f"The untouched candidate is **not promotion-ready**. This audit found {len(findings)} open findings: "
        f"{counts['P0']} P0, {counts['P1']} P1, {counts['P2']} P2 and {counts['P3']} P3.",
        "",
        "The delivery-safety repair is a real gain, but the implementation does not yet prove the independent obligations of broker usefulness, source arithmetic fidelity, acquisition economics, portable execution, installed-host behavior or certified release identity. The optional-evidence control plane and release ceremony are materially larger than the economic acceptance surface, while key semantic ownership is duplicated across role sets and documents.",
        "",
        "## Frozen identity",
        "",
        f"- Source commit: `{report['source_identity']['commit']}`",
        f"- Source tree: `{report['source_identity']['tree']}`",
        f"- Audit target SHA-256: `{report['target_sha256']}`",
        f"- Audit report SHA-256: `{report['report_sha256']}`",
        "",
        "## Repository scale",
        "",
        f"- Files: {report['inventory']['file_count']:,}",
        f"- Bytes: {report['inventory']['byte_count']:,}",
        f"- Parsed text lines: {report['inventory']['text_line_count']:,}",
        f"- Source modules: {report['module_graph']['source_module_count']:,}",
        f"- JSON schemas: {report['schemas']['schema_count']:,}",
        f"- Oversized source modules: {len(report['inventory']['oversized_modules'])}",
        f"- Long functions: {len(report['inventory']['long_functions'])}",
        f"- Runtime-like orphan candidates: {len(report['module_graph']['orphan_runtime_candidates'])}",
        "",
        "## Untouched test baseline",
        "",
        "| Status | Count |",
        "|---|---:|",
    ]
    for key in ["PASS", "FAIL", "TIMEOUT", "ERROR", "MISSING_SCRIPT", "EXTERNAL_CUSTODY"]:
        lines.append(f"| {key} | {registry_counts.get(key, 0)} |")
    lines += ["", "## Root-cause register", ""]
    for item in sorted(findings, key=lambda row: ({"P0": 0, "P1": 1, "P2": 2, "P3": 3}.get(row["severity"], 9), row["finding_id"])):
        lines += [
            f"### {item['severity']} — {item['finding_id']}: {item['title']}",
            "",
            f"- **Target:** `{item['target_path']}`",
            f"- **Earliest responsible layer:** {item['earliest_layer']}",
            f"- **Sources:** {', '.join(f'`{path}`' for path in item['source_paths'])}",
            f"- **Evidence:** {item['evidence']}",
            f"- **User/product impact:** {item['impact']}",
            f"- **General repair:** {item['general_repair']}",
            f"- **Preserve:** {', '.join(item['preserved_invariants'])}",
            f"- **Non-vacuous test:** {item['test_required']}",
            "",
        ]
    lines += ["## Product-target crosswalk", "", "| Target | Status | Blocking findings |", "|---|---|---|"]
    for row in report["target_crosswalk"]:
        lines.append(f"| `{row['target_path']}` | {row['status']} | {', '.join(row['blocking_findings'])} |")
    lines += ["", "## Largest modules", ""]
    for item in report["inventory"]["oversized_modules"][:30]:
        lines.append(f"- `{item['path']}` — {item['lines']:,} lines / {item['bytes']:,} bytes")
    lines += ["", "## Long and branch-heavy functions", ""]
    for item in report["inventory"]["long_functions"][:40]:
        lines.append(f"- `{item['path']}:{item['line']}` `{item['name']}` — {item['lines']} lines / {item['branches']} branch points")
    lines += ["", "## Machine-specific paths", ""]
    for item in report["inventory"]["absolute_paths"][:100]:
        lines.append(f"- `{item['path']}:{item['line']}` — `{item['value']}`")
    lines += ["", "## Failing repository-owned gates", ""]
    for item in report["test_registry"]["results"]:
        if item["status"] not in {"FAIL", "TIMEOUT", "ERROR", "MISSING_SCRIPT"}:
            continue
        lines += [f"### `{item['id']}` — {item['status']}", "", "```text", (item.get("stderr") or item.get("stdout") or "")[-8000:], "```", ""]
    lines += [
        "## Audit conclusion",
        "",
        "The smallest defensible architecture retains the economic graph, fixed point, instrument-period debt state, source custody, selected-cell provenance and independent workbook proofs. It removes or generates duplicated policy surfaces, makes semantic-role metadata canonical, evaluates all native-clean broker evidence before opening one recovery frontier, restores source arithmetic ownership before taxonomy, gives discrete events a non-recurring policy, adopts one lightweight funded acquisition contract, makes tests portable, binds source/installation identity into the carrier and measures wall-clock time from user submission.",
        "",
        "**Promotion recommendation: DO NOT PROMOTE until every P0/P1 exit criterion is proven on frozen cases and an immutable certified release is compiled.**",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--source-tree", required=True)
    args = parser.parse_args()
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    target = json.loads(TARGET_PATH.read_text("utf-8"))
    paths = repository_files()
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "EXCEL_INFLOW_TEST_PYTHON": sys.executable}
    inventory = source_inventory(paths)
    modules = module_graph(paths)
    schemas = schema_inventory(paths)
    registry = registry_audit(args.timeout, env)
    syntax = syntax_audit(paths, env)
    policy = policy_ownership(paths)
    semantic = semantic_registry_audit(paths)
    test_quality = test_quality_audit(paths, registry)
    findings, target_rows = build_findings(target, inventory, modules, schemas, registry, policy, semantic, test_quality, paths)
    report = {
        "schema_version": "excel-inflow-deep-product-architecture-audit/1.0",
        "source_identity": {"commit": args.source_commit, "tree": args.source_tree},
        "target_path": TARGET_PATH.relative_to(ROOT).as_posix(),
        "target_sha256": hashlib.sha256(TARGET_PATH.read_bytes()).hexdigest(),
        "toolchain": {"python": sys.version, "node": shutil.which("node"), "soffice": shutil.which("soffice") or shutil.which("libreoffice")},
        "inventory": inventory,
        "module_graph": modules,
        "schemas": schemas,
        "syntax": syntax,
        "test_registry": registry,
        "test_quality": test_quality,
        "policy_ownership": policy,
        "semantic_registry": semantic,
        "findings": [asdict(item) for item in findings],
        "target_crosswalk": target_rows,
    }
    report["report_sha256"] = digest(report)
    (output / "deep-product-architecture-audit.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")
    (output / "deep-product-architecture-audit.md").write_text(markdown(report), "utf-8")
    summary = {
        "status": "FINDINGS" if findings else "PASS",
        "finding_count": len(findings),
        "severity_counts": dict(Counter(item.severity for item in findings)),
        "test_counts": registry["counts"],
        "report_sha256": report["report_sha256"],
    }
    (output / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", "utf-8")
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
