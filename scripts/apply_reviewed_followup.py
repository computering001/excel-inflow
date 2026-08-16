#!/usr/bin/env python3
"""Apply compatibility-only follow-up after the reviewed product repairs."""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OLD_POLICY = "latest_supplied_house_then_zero_authority"
NEW_POLICY = "native_quality_ranked_one_house_then_zero_authority"

# Tests and generated examples must assert the new intended policy. Production
# source was already changed by the reviewed core repair; this is not an
# expected-output rewrite for economics.
for path in sorted((ROOT / "scripts").rglob("*")):
    if not path.is_file() or path.suffix not in {".py", ".mjs", ".js", ".json"}:
        continue
    value = path.read_text("utf-8")
    if OLD_POLICY in value:
        path.write_text(value.replace(OLD_POLICY, NEW_POLICY), "utf-8")

# All shipped JSON remains parseable after integration patchers update schemas.
for path in ROOT.rglob("*.json"):
    json.loads(path.read_text("utf-8"))

# The repair branch may not retain author-machine paths or bootstrap patchers.
violations = []
for path in sorted((ROOT / "scripts").rglob("*")):
    if path.is_file() and path.suffix in {".py", ".mjs", ".js", ".json"}:
        text = path.read_text("utf-8")
        if re.search(r"/Users/|[A-Za-z]:\\\\Users\\\\", text):
            violations.append(str(path.relative_to(ROOT)))
if violations:
    raise SystemExit("Non-portable executable paths remain: " + ", ".join(violations))

# Guard the exact regression that escaped the previous generated patch.
broker_source = (ROOT / "scripts" / "extract_broker_evidence.py").read_text("utf-8")
if "return select_recovery_house_id(" in broker_source:
    raise SystemExit("Recursive broker recovery selector detected.")
if "archive_only = not selected_targets or unselected_house\n" in broker_source:
    raise SystemExit("Blanket unselected-house suppression remains.")

print(json.dumps({"status": "PASS", "repair": "reviewed_followup"}))
