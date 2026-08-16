#!/usr/bin/env python3
"""Finalize canonical Tier-1 demand metadata and refresh development identity.

This bootstrap is deleted before the product commit. It derives labels and
aliases from the shipped broker metric dictionary, verifies all nine core
metrics, and recompiles an internally consistent *development* package. It may
never write certification evidence or claim production readiness.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
EXTRACTOR = ROOT / "scripts" / "extract_broker_evidence.py"
CORE_IDS = (
    "revenue",
    "ebit",
    "adjusted_ebitda",
    "depreciation_and_amortisation",
    "effective_tax_rate",
    "capex",
    "change_in_working_capital",
    "dividends",
    "share_buybacks",
)
FALLBACK_LABELS = {
    "revenue": "Revenue",
    "ebit": "EBIT",
    "adjusted_ebitda": "Adjusted EBITDA",
    "depreciation_and_amortisation": "Depreciation and amortisation",
    "effective_tax_rate": "Effective tax rate",
    "capex": "Capital expenditure",
    "change_in_working_capital": "Change in working capital",
    "dividends": "Dividends",
    "share_buybacks": "Share buybacks",
}
FALLBACK_SECTIONS = {
    "revenue": "income_statement",
    "ebit": "income_statement",
    "adjusted_ebitda": "income_statement",
    "depreciation_and_amortisation": "income_statement",
    "effective_tax_rate": "income_statement",
    "capex": "cash_flow",
    "change_in_working_capital": "cash_flow",
    "dividends": "cash_flow",
    "share_buybacks": "cash_flow",
}
FALLBACK_DOMAINS = {
    **{metric: "operating" for metric in (
        "revenue", "ebit", "adjusted_ebitda", "depreciation_and_amortisation"
    )},
    "effective_tax_rate": "tax",
    **{metric: "cash_flow" for metric in (
        "capex", "change_in_working_capital", "dividends", "share_buybacks"
    )},
}


def dictionary_entries(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        candidate_id = value.get("metric_id") or value.get("id")
        if isinstance(candidate_id, str):
            yield value
        for child in value.values():
            yield from dictionary_entries(child)
    elif isinstance(value, list):
        for child in value:
            yield from dictionary_entries(child)


def metric_specs() -> dict[str, dict[str, Any]]:
    dictionary_path = ROOT / "assets" / "broker-metric-dictionary.json"
    dictionary = json.loads(dictionary_path.read_text("utf-8"))
    indexed: dict[str, dict[str, Any]] = {}
    for entry in dictionary_entries(dictionary):
        metric_id = str(entry.get("metric_id") or entry.get("id") or "")
        if metric_id in CORE_IDS and metric_id not in indexed:
            indexed[metric_id] = entry
    missing = sorted(set(CORE_IDS) - set(indexed))
    if missing:
        raise RuntimeError(
            "Broker metric dictionary is missing canonical Tier-1 IDs: "
            + ", ".join(missing)
        )
    output: dict[str, dict[str, Any]] = {}
    for metric_id in CORE_IDS:
        entry = indexed[metric_id]
        label = next(
            (
                str(entry.get(key)).strip()
                for key in ("display_label", "label", "name", "canonical_label")
                if isinstance(entry.get(key), str) and str(entry.get(key)).strip()
            ),
            FALLBACK_LABELS[metric_id],
        )
        aliases: list[str] = []
        for key in ("aliases", "synonyms", "labels", "search_terms"):
            value = entry.get(key)
            if isinstance(value, list):
                aliases.extend(str(item).strip() for item in value if str(item).strip())
        aliases.extend([label, metric_id.replace("_", " ")])
        if metric_id == "share_buybacks":
            aliases.extend(["Share repurchases", "Buybacks"])
        if metric_id == "depreciation_and_amortisation":
            aliases.extend(["D&A", "Depreciation & amortisation"])
        output[metric_id] = {
            "label": label,
            "aliases": sorted(set(aliases), key=str.casefold),
            "section": FALLBACK_SECTIONS[metric_id],
            "economic_domain": FALLBACK_DOMAINS[metric_id],
        }
    return output


def patch_extractor(specs: dict[str, dict[str, Any]]) -> None:
    source = EXTRACTOR.read_text("utf-8")
    start = source.find("_CORE_BROKER_DEMAND = (")
    end = source.find("\n\n\ndef _replace_demand_identity", start)
    if start < 0 or end < 0:
        raise RuntimeError("Existing core broker demand helper was not found.")
    block = (
        "_CORE_BROKER_DEMAND_IDS = (\n"
        + "".join(f'    "{metric_id}",\n' for metric_id in CORE_IDS)
        + ")\n\n"
        + "_CORE_BROKER_DEMAND_FALLBACK = "
        + json.dumps(specs, indent=2, sort_keys=True)
        + "\n"
    )
    source = source[:start] + block + source[end:]

    function_start = source.find("def ensure_core_broker_demand_contract(")
    function_end = source.find("\n\ndef main() -> int:", function_start)
    if function_start < 0 or function_end < 0:
        raise RuntimeError("Core demand closure function was not found.")
    function = r'''def _runtime_core_broker_demand_specs() -> dict[str, dict[str, Any]]:
    """Read canonical labels and aliases from the shipped metric dictionary."""
    dictionary_path = Path(__file__).resolve().parents[1] / "assets" / "broker-metric-dictionary.json"
    dictionary = json.loads(dictionary_path.read_text("utf-8"))
    indexed: dict[str, dict[str, Any]] = {}

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            metric_id = value.get("metric_id") or value.get("id")
            if isinstance(metric_id, str) and metric_id in _CORE_BROKER_DEMAND_IDS:
                indexed.setdefault(metric_id, value)
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(dictionary)
    missing = sorted(set(_CORE_BROKER_DEMAND_IDS) - set(indexed))
    if missing:
        raise ValueError(
            "Broker metric dictionary omits Tier-1 demand IDs: " + ", ".join(missing)
        )
    specs = json.loads(json.dumps(_CORE_BROKER_DEMAND_FALLBACK))
    for metric_id, entry in indexed.items():
        label = next(
            (
                str(entry.get(key)).strip()
                for key in ("display_label", "label", "name", "canonical_label")
                if isinstance(entry.get(key), str) and str(entry.get(key)).strip()
            ),
            specs[metric_id]["label"],
        )
        aliases: list[str] = []
        for key in ("aliases", "synonyms", "labels", "search_terms"):
            value = entry.get(key)
            if isinstance(value, list):
                aliases.extend(str(item).strip() for item in value if str(item).strip())
        aliases.extend(specs[metric_id]["aliases"])
        aliases.extend([label, metric_id.replace("_", " ")])
        specs[metric_id]["label"] = label
        specs[metric_id]["aliases"] = sorted(set(aliases), key=str.casefold)
    return specs


def ensure_core_broker_demand_contract(contract: dict[str, Any]) -> dict[str, Any]:
    """Close broker recovery over every canonical Tier-1 model concept.

    Filing face rows remain the source of issuer topology, but broker recovery
    must also request synthetic bridge and cash-flow driver concepts that the
    model consumes. Existing targets retain their original graph custody; only
    genuinely absent concepts are cloned into the same period/authority shape.
    """
    output = json.loads(json.dumps(contract))
    targets = list(output.get("targets") or [])
    existing = {
        str(target.get("metric_id") or target.get("concept_id") or "")
        for target in targets
    }
    prototype = next(
        (
            target for target in targets
            if str(target.get("metric_id") or target.get("concept_id")) == "revenue"
        ),
        targets[0] if targets else None,
    )
    if prototype is None:
        return output
    old_metric = str(
        prototype.get("metric_id") or prototype.get("concept_id") or "revenue"
    )
    old_label = str(
        prototype.get("label") or prototype.get("source_label") or "Revenue"
    )
    specs = _runtime_core_broker_demand_specs()
    for metric_id in _CORE_BROKER_DEMAND_IDS:
        if metric_id in existing:
            continue
        spec = specs[metric_id]
        label = spec["label"]
        target = _replace_demand_identity(
            prototype, old_metric, old_label, metric_id, label,
        )
        for key in ("metric_id", "concept_id", "semantic_role"):
            if key in target:
                target[key] = metric_id
        for key in ("label", "source_label"):
            if key in target:
                target[key] = label
        if "section" in target:
            target["section"] = spec["section"]
        if "statement_family" in target:
            target["statement_family"] = spec["section"]
        if "economic_domain" in target:
            target["economic_domain"] = spec["economic_domain"]
        if "definition_id" in target:
            target["definition_id"] = f"dict.{metric_id}"
        if "source_line_id" in target:
            target["source_line_id"] = f"synthetic-tier1.{metric_id}"
        if "definition_signature_sha256" in target:
            target["definition_signature_sha256"] = hashlib.sha256(
                f"tier1-demand:{metric_id}".encode("utf-8")
            ).hexdigest()
        if "aliases" in target:
            target["aliases"] = list(spec["aliases"])
        if "search_terms" in target:
            target["search_terms"] = list(spec["aliases"])
        targets.append(target)
        existing.add(metric_id)
    output["targets"] = targets
    if "contract_sha256" in output:
        body = {key: value for key, value in output.items() if key != "contract_sha256"}
        output["contract_sha256"] = hashlib.sha256(
            (json.dumps(body, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        ).hexdigest()
    return output
'''
    source = source[:function_start] + function + source[function_end:]
    EXTRACTOR.write_text(source, "utf-8")


def patch_test(specs: dict[str, dict[str, Any]]) -> None:
    target = ROOT / "scripts" / "run_broker_tier1_demand_tests.py"
    source = target.read_text("utf-8")
    required_block = re.compile(r"required = \{\n.*?\n\}", re.S)
    replacement = "required = {\n" + "".join(
        f'    "{metric_id}",\n' for metric_id in CORE_IDS
    ) + "}"
    source, count = required_block.subn(replacement, source, count=1)
    if count != 1:
        raise RuntimeError("Tier-1 required-set test block was not found.")
    additions = r'''
for metric_id in required:
    target = next(
        item for item in closed["targets"]
        if str(item.get("metric_id") or item.get("concept_id")) == metric_id
    )
    expected = broker._runtime_core_broker_demand_specs()[metric_id]
    if "section" in target:
        assert target["section"] == expected["section"], (metric_id, target)
    if "economic_domain" in target:
        assert target["economic_domain"] == expected["economic_domain"], (metric_id, target)

sample_text = " ".join(spec["label"] for spec in broker._runtime_core_broker_demand_specs().values())
selected = broker.demand_targets_for_surface(sample_text, [], closed, opaque_image=False)
selected_ids = {
    str(item.get("metric_id") or item.get("concept_id") or "")
    for item in selected
}
assert required <= selected_ids, sorted(required - selected_ids)
'''
    anchor = 'source = (HERE / "extract_broker_evidence.py").read_text("utf-8")\n'
    if additions.strip() not in source:
        if anchor not in source:
            raise RuntimeError("Tier-1 test insertion anchor was not found.")
        source = source.replace(anchor, additions + "\n" + anchor, 1)
    target.write_text(source, "utf-8")


def file_hashes(root: Path) -> dict[str, str]:
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in root.rglob("*")
        if path.is_file() and ".git" not in path.parts
    }


def discover_release_command() -> list[str]:
    candidates = [
        ["node", "scripts/compile_skill_release.mjs"],
        ["node", "scripts/compile_skill_release.mjs", "--mode", "development"],
        ["node", "scripts/compile_skill_release.mjs", "--package-mode", "development"],
        ["node", "scripts/compile_skill_release.mjs", "development"],
    ]
    with tempfile.TemporaryDirectory(prefix="excel-inflow-release-probe-") as temporary:
        base = Path(temporary)
        for index, command in enumerate(candidates):
            trial = base / str(index)
            shutil.copytree(
                ROOT,
                trial,
                ignore=shutil.ignore_patterns(".git", "audit", "__pycache__", "*.pyc"),
            )
            completed = subprocess.run(
                command,
                cwd=trial,
                text=True,
                capture_output=True,
                timeout=300,
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            )
            if completed.returncode != 0:
                continue
            try:
                manifest = json.loads((trial / "release-manifest.json").read_text("utf-8"))
            except Exception:
                continue
            certification = manifest.get("certification") or {}
            if (
                manifest.get("packageMode") == "development"
                and certification.get("currentClosureSha256")
                and certification.get("certifiedClosureSha256") is None
            ):
                return command
    raise RuntimeError("No supported development release compiler invocation succeeded.")


def verify_manifest_members(manifest: dict[str, Any]) -> dict[str, Any]:
    members = manifest.get("files") or manifest.get("closure", {}).get("files") or []
    checked = 0
    failures: list[str] = []
    for member in members:
        if not isinstance(member, dict) or not isinstance(member.get("path"), str):
            continue
        path = ROOT / member["path"]
        if not path.is_file():
            failures.append(f"missing:{member['path']}")
            continue
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        expected = member.get("sha256")
        if expected and actual != expected:
            failures.append(f"hash:{member['path']}")
        if member.get("bytes") is not None and path.stat().st_size != member["bytes"]:
            failures.append(f"bytes:{member['path']}")
        checked += 1
    if failures:
        raise RuntimeError("Release manifest member verification failed: " + ", ".join(failures))
    return {"verified_member_count": checked}


def refresh_development_release() -> None:
    command = discover_release_command()
    before = file_hashes(ROOT)
    completed = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=600,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    if completed.returncode != 0:
        raise RuntimeError(
            "Development release compiler failed:\n"
            + completed.stdout
            + "\n"
            + completed.stderr
        )
    manifest = json.loads((ROOT / "release-manifest.json").read_text("utf-8"))
    certification = manifest.get("certification") or {}
    if manifest.get("packageMode") != "development":
        raise RuntimeError("Repair branch package mode is not development.")
    if certification.get("certifiedClosureSha256") is not None:
        raise RuntimeError("Development refresh unexpectedly wrote a certified closure.")
    if certification.get("evidenceReceipt") is not None:
        raise RuntimeError("Development refresh unexpectedly wrote certification evidence.")
    if not certification.get("currentClosureSha256"):
        raise RuntimeError("Development refresh emitted no current closure digest.")
    verification = verify_manifest_members(manifest)
    after = file_hashes(ROOT)
    changed = sorted(
        path for path in set(before) | set(after) if before.get(path) != after.get(path)
    )
    allowed_prefixes = (
        "release-manifest.json",
        "assets/runtime-manifest.json",
        "assets/deployment-profile.json",
        "SKILL.md",
        "central-instructions.md",
        "references/runtime-core.md",
    )
    unexpected = [
        path for path in changed
        if path not in allowed_prefixes and not path.startswith("audit/")
    ]
    if unexpected:
        raise RuntimeError(
            "Development release compiler changed unexpected product files: "
            + ", ".join(unexpected)
        )
    audit = ROOT / "audit" / "reviewed-portable-gate"
    audit.mkdir(parents=True, exist_ok=True)
    (audit / "development-release-refresh.json").write_text(
        json.dumps(
            {
                "schema_version": "development-release-refresh/1.0",
                "status": "PASS",
                "command": command,
                "package_mode": manifest.get("packageMode"),
                "source_status": manifest.get("sourceStatus"),
                "skill_version": manifest.get("skillVersion"),
                "current_closure_sha256": certification.get("currentClosureSha256"),
                "certified_closure_sha256": certification.get("certifiedClosureSha256"),
                "evidence_receipt": certification.get("evidenceReceipt"),
                "changed_files": changed,
                **verification,
            },
            indent=2,
        )
        + "\n",
        "utf-8",
    )


def main() -> int:
    specs = metric_specs()
    patch_extractor(specs)
    patch_test(specs)
    refresh_development_release()
    print(
        json.dumps(
            {
                "status": "PASS",
                "core_metric_count": len(CORE_IDS),
                "package_mode": "development",
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
