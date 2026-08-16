#!/usr/bin/env python3
"""Make the economic-role registry the sole structured-event owner."""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def patch_set(path: str, set_name: str, replacement_name: str) -> None:
    target = ROOT / path
    text = target.read_text("utf-8")
    import_line = 'import { STRUCTURED_EVENT_ROLE_SET } from "./economic_role_registry.mjs";\n'
    if import_line not in text:
        matches = list(re.finditer(r"^import .*?;\s*$", text, re.M))
        if not matches:
            raise RuntimeError(f"No import block in {path}")
        at = matches[-1].end()
        text = text[:at] + "\n" + import_line + text[at:]
    pattern = re.compile(
        rf"const\s+{re.escape(set_name)}\s*=\s*new\s+Set\(\[.*?\]\);",
        re.S,
    )
    if pattern.search(text):
        text = pattern.sub(
            f"const {set_name} = STRUCTURED_EVENT_ROLE_SET;",
            text,
            count=1,
        )
    elif f"const {set_name} = STRUCTURED_EVENT_ROLE_SET;" not in text:
        raise RuntimeError(f"{set_name} source block absent from {path}")
    target.write_text(text, "utf-8")


patch_set(
    "scripts/lib/forecast_behavior.mjs",
    "NON_RECURRING_ROLES",
    "STRUCTURED_EVENT_ROLE_SET",
)
patch_set(
    "scripts/lib/forecast_authority.mjs",
    "STRUCTURAL_EVENT_ROLES",
    "STRUCTURED_EVENT_ROLE_SET",
)

runtime_members = ROOT / "assets" / "attachment-evidence-runtime-members.json"
if runtime_members.is_file():
    value = json.loads(runtime_members.read_text("utf-8"))
    members = value.setdefault("members", [])
    for member in [
        "assets/economic-role-registry-v1.json",
        "scripts/lib/economic_role_registry.mjs",
    ]:
        if member not in members:
            members.append(member)
    runtime_members.write_text(json.dumps(value, indent=2) + "\n", "utf-8")

registry = ROOT / "assets" / "development-test-registry.json"
value = json.loads(registry.read_text("utf-8"))
if not any(item.get("id") == "economic-role-registry" for item in value.get("tests", [])):
    value["tests"].append({
        "id": "economic-role-registry",
        "phase": "forecast",
        "runtime": "node",
        "script": "run_economic_role_registry_tests.mjs",
    })
registry.write_text(json.dumps(value, indent=2) + "\n", "utf-8")

print({
    "status": "PASS",
    "owners": [
        "assets/economic-role-registry-v1.json",
        "scripts/lib/economic_role_registry.mjs",
    ],
})
