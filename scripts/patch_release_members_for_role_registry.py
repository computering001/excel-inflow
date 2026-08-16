#!/usr/bin/env python3
"""Bind the economic-role registry into existing runtime/release member lists."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
NEW_ASSET = "assets/economic-role-registry-v1.json"
NEW_MODULE = "scripts/lib/economic_role_registry.mjs"
ASSET_ANCHORS = {
    "assets/statement-semantic-taxonomy.v1.json",
    "statement-semantic-taxonomy.v1.json",
}
MODULE_ANCHORS = {
    "scripts/lib/forecast_behavior.mjs",
    "lib/forecast_behavior.mjs",
}
changed: list[str] = []


def patch(value: Any) -> bool:
    modified = False
    if isinstance(value, dict):
        for entry in value.values():
            modified = patch(entry) or modified
    elif isinstance(value, list):
        strings = {item for item in value if isinstance(item, str)}
        if strings & ASSET_ANCHORS:
            style = "assets/" if any(item.startswith("assets/") for item in strings) else ""
            candidate = NEW_ASSET if style else Path(NEW_ASSET).name
            if candidate not in value:
                value.append(candidate)
                modified = True
        if strings & MODULE_ANCHORS:
            style = "scripts/" if any(item.startswith("scripts/") for item in strings) else ""
            candidate = NEW_MODULE if style else "lib/economic_role_registry.mjs"
            if candidate not in value:
                value.append(candidate)
                modified = True
        for entry in value:
            modified = patch(entry) or modified
    return modified


for relative in [
    "assets/deployment-profile.json",
    "assets/attachment-evidence-runtime-members.json",
    "assets/runtime-manifest.json",
]:
    path = ROOT / relative
    if not path.is_file():
        continue
    try:
        value = json.loads(path.read_text("utf-8"))
    except json.JSONDecodeError:
        continue
    if patch(value):
        path.write_text(json.dumps(value, indent=2) + "\n", "utf-8")
        changed.append(relative)

print({"status": "PASS", "changed": changed})
