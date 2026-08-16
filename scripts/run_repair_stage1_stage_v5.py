#!/usr/bin/env python3
"""Final corrected stage-one launcher with atomic roles and policy closure."""
from __future__ import annotations

import importlib.util
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("stage1_impl", HERE / "apply_excel_inflow_repair_stage1.py")
module = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(module)
original_discrete = module.patch_discrete_event_closure


def ensure_set_roles(path: Path, set_name: str, roles: list[str]) -> None:
    text = path.read_text("utf-8")
    pattern = re.compile(rf"(const\s+{re.escape(set_name)}\s*=\s*new\s+Set\(\[)(.*?)(\]\);)", re.S)
    match = pattern.search(text)
    if not match:
        raise RuntimeError(f"{set_name} block not found in {path}")
    body = match.group(2)
    missing = [role for role in roles if f'"{role}"' not in body and f"'{role}'" not in body]
    if not missing:
        return
    suffix = "" if body.endswith("\n") else "\n"
    insertion = "".join(f'  "{role}",\n' for role in missing)
    replacement = match.group(1) + body + suffix + insertion + match.group(3)
    path.write_text(text[:match.start()] + replacement + text[match.end():], "utf-8")


def corrected_discrete_event_closure() -> list[str]:
    roles = [
        "acquisitions_net_of_cash",
        "acquisition_of_subsidiaries_net_of_cash_acquired",
        "business_combinations_net_of_cash_acquired",
        "asset_disposal",
        "asset_sale",
    ]
    ensure_set_roles(HERE / "lib" / "forecast_behavior.mjs", "NON_RECURRING_ROLES", roles)
    ensure_set_roles(HERE / "lib" / "forecast_authority.mjs", "STRUCTURAL_EVENT_ROLES", roles)
    return original_discrete()


module.patch_discrete_event_closure = corrected_discrete_event_closure
status = module.main()
if status not in {None, 0}:
    raise SystemExit(status)
for helper in ["fix_stage1_generated_sources.py", "fix_stage1_policy_literals.py"]:
    completed = subprocess.run([sys.executable, str(HERE / helper)], check=False)
    if completed.returncode != 0:
        raise SystemExit(completed.returncode)
raise SystemExit(0)
