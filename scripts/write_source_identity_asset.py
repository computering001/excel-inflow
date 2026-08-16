#!/usr/bin/env python3
"""Write the immutable source identity that ships inside the compiled closure."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
GIT_OBJECT = re.compile(r"^[a-f0-9]{40}$")


def insert_members(value: Any) -> bool:
    changed = False
    if isinstance(value, dict):
        for entry in value.values():
            changed = insert_members(entry) or changed
    elif isinstance(value, list):
        strings = {entry for entry in value if isinstance(entry, str)}
        asset_anchors = {
            "assets/runtime-manifest.json",
            "runtime-manifest.json",
        }
        if strings & asset_anchors:
            style = "assets/" if any(entry.startswith("assets/") for entry in strings) else ""
            for candidate in [
                "assets/source-identity.json" if style else "source-identity.json",
                "assets/source-identity-v1.schema.json" if style else "source-identity-v1.schema.json",
            ]:
                if candidate not in value:
                    value.append(candidate)
                    changed = True
        for entry in value:
            changed = insert_members(entry) or changed
    return changed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--tree", required=True)
    parser.add_argument("--branch", default="agent/excel-inflow-end-to-end-repair")
    parser.add_argument("--mode", choices=["development", "certified"], default="development")
    parser.add_argument("--out", default="assets/source-identity.json")
    args = parser.parse_args()
    if not GIT_OBJECT.fullmatch(args.commit):
        raise SystemExit("Source commit must be a 40-character Git object id.")
    if not GIT_OBJECT.fullmatch(args.tree):
        raise SystemExit("Source tree must be a 40-character Git object id.")
    identity = {
        "schema_version": "excel-inflow-source-identity/1.0",
        "repository": "computering001/excel-inflow",
        "source_commit": args.commit,
        "source_tree": args.tree,
        "source_branch": args.branch,
        "package_mode": args.mode,
    }
    target = (ROOT / args.out).resolve()
    if ROOT not in target.parents:
        raise SystemExit("Source-identity output must remain inside the repository.")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(identity, indent=2) + "\n", "utf-8")

    changed_profiles = []
    for relative in [
        "assets/deployment-profile.json",
        "assets/attachment-evidence-runtime-members.json",
    ]:
        path = ROOT / relative
        if not path.is_file():
            continue
        value = json.loads(path.read_text("utf-8"))
        if insert_members(value):
            path.write_text(json.dumps(value, indent=2) + "\n", "utf-8")
            changed_profiles.append(relative)
    print({
        "status": "PASS",
        "source_commit": args.commit,
        "source_tree": args.tree,
        "output": str(target.relative_to(ROOT)),
        "changed_profiles": changed_profiles,
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
