#!/usr/bin/env python3
"""Apply only deterministic repairs named by architecture-hygiene.json."""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "audit" / "generated" / "architecture-hygiene.json"
OLD_POLICY = "latest_supplied_house_then_zero_authority"
NEW_POLICY = "quality_ranked_native_then_one_recovery_frontier"
SAFE_CODES = {
    "TEMP-SCAFFOLD",
    "BROKER-OLD-POLICY",
    "ACQ-CONTRADICTION",
    "ACQ-TARGET-MISSING",
    "REGISTRY-CUSTODY",
    "REGISTRY-UNIVERSAL-MATRIX-CLI",
    "ROLE-ORPHAN-ACQUISITION",
    "JOURNEY-DRIFT",
}


def read_json(path: Path):
    return json.loads(path.read_text("utf-8"))


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", "utf-8")


def replace_text(path: Path, old: str, new: str) -> bool:
    text = path.read_text("utf-8")
    if old not in text:
        return False
    path.write_text(text.replace(old, new), "utf-8")
    return True


def ensure_role_in_set(path: Path, set_name: str, role: str) -> bool:
    text = path.read_text("utf-8")
    pattern = re.compile(
        rf"(const\s+{re.escape(set_name)}\s*=\s*new\s+Set\(\[)(.*?)(\]\);)",
        re.S,
    )
    match = pattern.search(text)
    if not match or f'"{role}"' in match.group(2):
        return False
    body = match.group(2)
    insertion = f'\n  "{role}",'
    updated = text[: match.start(2)] + insertion + body + text[match.end(2) :]
    path.write_text(updated, "utf-8")
    return True


def repair_acquisition_docs(path: Path) -> bool:
    text = path.read_text("utf-8")
    original = text
    text = re.sub(
        r"This is a debt overlay, not a sources-and-uses schedule\.\s*The overlay has zero\s+direct transaction cash-flow effect\.",
        "This is a lightweight funded-transaction debt overlay, not a full sources-and-uses or purchase-accounting model. The overlay records the transaction consideration once as investing cash flow and acquisition debt once as financing proceeds.",
        text,
        flags=re.I,
    )
    text = re.sub(
        r"Do not create an unmatched financing inflow, a purchase-consideration outflow, an equity residual, financing-proceeds row, acquisition amortisation or an acquisition maturity\.",
        "Do not invent an equity residual, acquisition amortisation, acquisition maturity, fees, synergies or a target balance sheet. Record the supplied acquisition debt as financing proceeds once, record transaction value as consideration once, and route the residual funding requirement through existing cash and the ordinary RCF waterfall.",
        text,
        flags=re.I,
    )
    text = text.replace("the acquisition overlay has zero direct cash-flow effect;", "transaction consideration and acquisition debt proceeds enter direct cash flow exactly once;")
    if "funded_transaction" not in text:
        text += (
            "\n\n## Canonical product mode\n\n"
            "The only enabled acquisition mode is `funded_transaction`. Transaction enterprise value is the consideration proxy and produces one investing outflow at close. The separately supplied acquisition debt amount produces one financing inflow at close, enters the persistent acquisition debt balance once, and is priced on average opening/closing balance. Any residual consideration is funded from existing cash and then the ordinary RCF waterfall. No automatic equity plug is permitted.\n"
        )
    if text != original:
        path.write_text(text, "utf-8")
        return True
    return False


def main() -> int:
    report = read_json(REPORT)
    findings = report.get("findings") or []
    codes = {item.get("code") for item in findings}
    unsafe = sorted(code for code in codes if code not in SAFE_CODES)
    if unsafe:
        blocker = ROOT / "audit" / "generated" / "architecture-auto-fix-blocked.txt"
        blocker.write_text("\n".join(unsafe) + "\n", "utf-8")
        print({"status": "BLOCKED", "unsafe_codes": unsafe, "blocker": str(blocker)})
        return 2

    changed: list[str] = []
    for finding in findings:
        code = finding.get("code")
        rel = finding.get("path")
        path = ROOT / str(rel) if rel else None
        if code == "TEMP-SCAFFOLD" and path and path.exists():
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
            changed.append(str(rel))
        elif code == "BROKER-OLD-POLICY" and path and path.is_file():
            if replace_text(path, OLD_POLICY, NEW_POLICY):
                changed.append(str(rel))
        elif code in {"ACQ-CONTRADICTION", "ACQ-TARGET-MISSING"}:
            for doc in (
                ROOT / "references" / "acquisition.md",
                ROOT / "references" / "model-intent.md",
                ROOT / "references" / "validation.md",
                ROOT / "SKILL.md",
                ROOT / "central-instructions.md",
                ROOT / "references" / "runtime-core.md",
            ):
                if doc.is_file() and repair_acquisition_docs(doc):
                    changed.append(doc.relative_to(ROOT).as_posix())
        elif code in {"REGISTRY-CUSTODY", "REGISTRY-UNIVERSAL-MATRIX-CLI"}:
            registry_path = ROOT / "assets" / "development-test-registry.json"
            registry = read_json(registry_path)
            modified = False
            for entry in registry.get("tests", []):
                if entry.get("script") == "run_universal_broker_delivery_matrix.mjs":
                    entry["arguments"] = ["$RAW_CANARY_EVIDENCE", "$PYTHON", "$SOFFICE"]
                    entry["requires"] = ["RAW_CANARY_EVIDENCE", "PYTHON", "SOFFICE"]
                    modified = True
                    continue
                arguments = entry.get("arguments") or []
                placeholders = []
                for argument in arguments:
                    match = re.fullmatch(r"\$([A-Z_]+)", str(argument))
                    if match and match.group(1) not in placeholders:
                        placeholders.append(match.group(1))
                if entry.get("requires") != placeholders:
                    entry["requires"] = placeholders
                    modified = True
            if modified:
                write_json(registry_path, registry)
                changed.append("assets/development-test-registry.json")
        elif code == "ROLE-ORPHAN-ACQUISITION":
            behavior = ROOT / "scripts" / "lib" / "forecast_behavior.mjs"
            authority = ROOT / "scripts" / "lib" / "forecast_authority.mjs"
            if ensure_role_in_set(behavior, "NON_RECURRING_ROLES", "acquisitions_net_of_cash"):
                changed.append("scripts/lib/forecast_behavior.mjs")
            if ensure_role_in_set(authority, "STRUCTURAL_EVENT_ROLES", "acquisitions_net_of_cash"):
                changed.append("scripts/lib/forecast_authority.mjs")
        elif code == "JOURNEY-DRIFT":
            product_path = ROOT / "assets" / "product-constitution-v1.json"
            product = read_json(product_path)
            product["visible_milestones"] = ["company", "filings", "brokers", "debt", "build", "deliver"]
            write_json(product_path, product)
            changed.append("assets/product-constitution-v1.json")

    changed = sorted(set(changed))
    marker = ROOT / "audit" / "generated" / "architecture-auto-fix.json"
    write_json(marker, {"status": "PASS", "finding_codes": sorted(codes), "changed": changed})
    print({"status": "PASS", "changed": changed, "marker": str(marker)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
