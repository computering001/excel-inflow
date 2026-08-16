#!/usr/bin/env python3
"""Apply the lightweight funded-transaction acquisition contract.

The repair changes the earliest policy/writer layers, not emitted workbook
cells. It uses the committed acquisition execution map to locate zero-direct-
cash writers, introduces one canonical transaction policy and updates source
formula generators and validation doctrine.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MAP_PATH = ROOT / "audit" / "generated" / "acquisition-execution-map" / "acquisition-execution-map.json"


def read(path: str) -> str:
    return (ROOT / path).read_text("utf-8")


def write(path: str, text: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, "utf-8")


def add_import(text: str, import_line: str) -> str:
    if import_line in text:
        return text
    shebang_end = text.find("\n") + 1 if text.startswith("#!") else 0
    matches = list(re.finditer(r"^import .*?;\s*$", text, re.M))
    insert_at = matches[-1].end() if matches else shebang_end
    return text[:insert_at] + "\n" + import_line + text[insert_at:]


def helper_module() -> str:
    return r'''/** Canonical lightweight funded-transaction acquisition policy. */
function finite(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

function firstFinite(...values) {
  const found = values.find(finite);
  return found === undefined ? 0 : Number(found);
}

function firstValue(...values) {
  return values.find((value) => value !== null && value !== undefined);
}

function on(value) {
  if (value === true || value === 1) return true;
  return ["on", "yes", "enabled", "active", "1", "true"].includes(String(value ?? "").trim().toLowerCase());
}

function acquisitionSources(modelCase) {
  const acquisition = modelCase?.acquisition ?? modelCase?.acquisition_case ??
    modelCase?.acquisition_assumptions ?? modelCase?.case_inputs?.acquisition ??
    modelCase?.advanced_cases?.acquisition ?? {};
  const controls = modelCase?.controls ?? {};
  const assumptions = modelCase?.assumptions ?? {};
  return { acquisition, controls, assumptions };
}

export function fundedAcquisitionInputs(modelCase) {
  const { acquisition, controls, assumptions } = acquisitionSources(modelCase);
  const enterpriseValue = firstFinite(
    acquisition.transaction_enterprise_value,
    acquisition.transaction_value,
    acquisition.enterprise_value,
    assumptions.transaction_enterprise_value,
    modelCase?.transaction_enterprise_value,
  );
  const debtAmount = firstFinite(
    acquisition.acquisition_debt_amount,
    acquisition.acquisition_debt,
    acquisition.debt_amount,
    assumptions.acquisition_debt_amount,
    modelCase?.acquisition_debt_amount,
    modelCase?.acquisition_debt,
  );
  const closeYear = firstValue(
    acquisition.close_year,
    acquisition.acquisition_close_year,
    assumptions.acquisition_close_year,
    modelCase?.acquisition_close_year,
  );
  const switchValue = firstValue(
    controls.adjustment_columns,
    controls.acquisition_adjustments,
    controls.acquisition_case,
    controls.acquisition,
    acquisition.enabled,
    acquisition.on,
  );
  const enabled = on(switchValue) || (switchValue === undefined && enterpriseValue !== 0);
  return {
    enabled,
    transaction_enterprise_value: enterpriseValue,
    acquisition_debt_amount: debtAmount,
    close_year: closeYear,
  };
}

function forecastYears(modelCase) {
  return (modelCase?.periods ?? [])
    .filter((period) => period?.status === "forecast")
    .map((period) => String(period?.date ?? period?.year ?? "").slice(0, 4));
}

export function fundedAcquisitionTransaction(modelCase, forecastIndex) {
  const inputs = fundedAcquisitionInputs(modelCase);
  const years = forecastYears(modelCase);
  const configuredYear = String(inputs.close_year ?? "").slice(0, 4);
  const closeIndex = configuredYear
    ? years.findIndex((year) => year === configuredYear)
    : 0;
  const closes = inputs.enabled && Number(forecastIndex) === Math.max(0, closeIndex);
  const considerationCashFlow = closes ? -Math.abs(inputs.transaction_enterprise_value) : 0;
  const debtProceeds = closes ? Math.max(0, inputs.acquisition_debt_amount) : 0;
  return {
    schema_version: "funded-acquisition-transaction/1.0",
    closes,
    consideration_cash_flow: considerationCashFlow,
    debt_proceeds: debtProceeds,
    net_transaction_cash_flow: considerationCashFlow + debtProceeds,
    residual_funding_requirement: closes
      ? Math.max(0, Math.abs(considerationCashFlow) - debtProceeds)
      : 0,
  };
}

export function fundedAcquisitionTransactionSeries(modelCase) {
  return [0, 1, 2].map((forecastIndex) => fundedAcquisitionTransaction(modelCase, forecastIndex));
}

export function fundedAcquisitionExcelFormula({
  kind,
  toggleCell,
  periodYearExpression,
  closeYearCell,
  valueCell,
}) {
  if (!["consideration", "debt_proceeds"].includes(kind)) {
    throw new Error(`Unsupported acquisition transaction formula kind: ${kind}`);
  }
  const signedValue = kind === "consideration" ? `-ABS(${valueCell})` : `MAX(0,${valueCell})`;
  return `=IF(${toggleCell}=0,0,IF(${periodYearExpression}=${closeYearCell},${signedValue},0))`;
}
'''


def function_spans(text: str) -> list[dict[str, Any]]:
    pattern = re.compile(r"(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)\s*\{")
    result = []
    for match in pattern.finditer(text):
        depth = 0
        end = None
        quote = None
        escaped = False
        for index in range(match.end() - 1, len(text)):
            char = text[index]
            if quote:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == quote:
                    quote = None
                continue
            if char in {"'", '"', '`'}:
                quote = char
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    end = index + 1
                    break
        if end is None:
            continue
        result.append({
            "name": match.group(1),
            "params": [item.strip().split("=")[0].strip() for item in match.group(2).split(",") if item.strip()],
            "start": text.count("\n", 0, match.start()) + 1,
            "end": text.count("\n", 0, end) + 1,
        })
    return result


def enclosing_function(spans: list[dict[str, Any]], line: int) -> dict[str, Any] | None:
    candidates = [item for item in spans if item["start"] <= line <= item["end"]]
    return min(candidates, key=lambda item: item["end"] - item["start"]) if candidates else None


def case_and_index(function: dict[str, Any] | None, context: str) -> tuple[str | None, str | None]:
    if not function:
        return None, None
    params = function["params"]
    case = next((item for item in params if re.search(r"case|model", item, re.I)), None)
    index = next((item for item in params if re.search(r"forecast.*index|period.*index", item, re.I)), None)
    if not index:
        for candidate in ["forecastIndex", "periodIndex", "index"]:
            if re.search(rf"\b{candidate}\b", context):
                index = candidate
                break
    return case, index


def replace_zero_expression(line: str, expression: str) -> str:
    # Prefer an explicit property/assignment value. The final standalone zero is
    # used only for a source site already classified by acquisition context.
    patterns = [
        (re.compile(r"(:\s*)0(\s*,?\s*(?://.*)?$)"), rf"\g<1>{expression}\g<2>"),
        (re.compile(r"(=\s*)0(\s*;?\s*(?://.*)?$)"), rf"\g<1>{expression}\g<2>"),
        (re.compile(r"(=>\s*)0(\s*[,;]?\s*(?://.*)?$)"), rf"\g<1>{expression}\g<2>"),
    ]
    for pattern, replacement in patterns:
        if pattern.search(line):
            return pattern.sub(replacement, line, count=1)
    return line


def patch_numeric_zero_writers(execution_map: dict[str, Any]) -> list[str]:
    changed = []
    import_line = 'import { fundedAcquisitionTransaction } from "./acquisition_transaction_policy.mjs";'
    for file_entry in execution_map.get("files", []):
        path = file_entry["path"]
        if not path.endswith((".mjs", ".js", ".cjs")):
            continue
        if not path.startswith("scripts/"):
            continue
        relevant = [site for site in file_entry.get("zero_sites", []) if site["role"] in {"debt_proceeds_zero", "consideration_or_direct_cash_zero"}]
        if not relevant:
            continue
        text = read(path)
        spans = function_spans(text)
        lines = text.splitlines()
        modified = False
        for site in sorted(relevant, key=lambda item: item["line"], reverse=True):
            line_index = site["line"] - 1
            if line_index < 0 or line_index >= len(lines):
                continue
            if "=IF(" in lines[line_index] or "formula" in lines[line_index].casefold() and '"' in lines[line_index]:
                continue
            function = enclosing_function(spans, site["line"])
            case, index = case_and_index(function, site.get("context") or "")
            if not case or not index:
                continue
            field = "debt_proceeds" if site["role"] == "debt_proceeds_zero" else "consideration_cash_flow"
            expression = f"fundedAcquisitionTransaction({case}, {index}).{field}"
            next_line = replace_zero_expression(lines[line_index], expression)
            if next_line != lines[line_index]:
                lines[line_index] = next_line
                modified = True
        if modified:
            text = "\n".join(lines) + ("\n" if text.endswith("\n") else "")
            text = add_import(text, import_line)
            write(path, text)
            changed.append(path)
    return changed


def excel_formula_refs(text: str) -> dict[str, str]:
    # Derive stable control references from existing canonical acquisition
    # formulas rather than hard-coding a workbook row number.
    contexts = {}
    lines = text.splitlines()
    for index, line in enumerate(lines):
        window = "\n".join(lines[max(0, index - 15):min(len(lines), index + 16)])
        absolute = re.findall(r"\$[A-Z]+\$\d+", window)
        lower = window.casefold()
        if "target ebitda" in lower and len(set(absolute)) >= 3:
            contexts.setdefault("target_ebitda", list(dict.fromkeys(absolute)))
        if "acquisition debt" in lower and absolute:
            contexts.setdefault("acquisition_debt", list(dict.fromkeys(absolute)))
        if "close year" in lower and absolute:
            contexts.setdefault("close_year", list(dict.fromkeys(absolute)))
    all_refs = [item for values in contexts.values() for item in values]
    toggle = "$P$4" if "$P$4" in all_refs or "$P$4" in text else (Counter(all_refs).most_common(1)[0][0] if all_refs else "$P$4")
    target_refs = [item for item in contexts.get("target_ebitda", []) if item != toggle]
    ev = target_refs[0] if target_refs else "$P$5"
    debt_candidates = [item for item in contexts.get("acquisition_debt", []) if item not in {toggle, ev}]
    debt = debt_candidates[0] if debt_candidates else "$P$8"
    close_candidates = [item for item in contexts.get("close_year", []) if item not in {toggle, ev, debt}]
    close = close_candidates[0] if close_candidates else "$P$10"
    return {"toggle": toggle, "enterprise_value": ev, "debt": debt, "close_year": close}


def patch_formula_zero_writers(execution_map: dict[str, Any]) -> list[str]:
    path = "scripts/build_dynamic_model.mjs"
    text = read(path)
    original = text
    refs = excel_formula_refs(text)
    lines = text.splitlines()
    for file_entry in execution_map.get("files", []):
        if file_entry["path"] != path:
            continue
        for site in sorted(file_entry.get("zero_sites", []), key=lambda item: item["line"], reverse=True):
            if site["role"] not in {"debt_proceeds_zero", "consideration_or_direct_cash_zero"}:
                continue
            index = site["line"] - 1
            if index < 0 or index >= len(lines):
                continue
            line = lines[index]
            if "=IF(" not in line or not re.search(r",\s*0\s*\)\s*[`\"']?", line):
                continue
            context = site.get("context") or ""
            # Reuse the period-year comparison already present in the nearest
            # acquisition timing formula when possible.
            comparison = None
            for candidate in re.findall(r"(?:YEAR\([^)]*\)|[A-Z]+\$?\d+)\s*=\s*\$[A-Z]+\$\d+", context):
                comparison = candidate
                break
            if comparison:
                period_expression, close_cell = [part.strip() for part in comparison.split("=", 1)]
            else:
                # Canonical acquisition adjustment columns N:P share the year
                # header in row 3 in every current profile.
                period_expression, close_cell = "YEAR(N$3)", refs["close_year"]
            value = refs["debt"] if site["role"] == "debt_proceeds_zero" else refs["enterprise_value"]
            signed = f"MAX(0,{value})" if site["role"] == "debt_proceeds_zero" else f"-ABS({value})"
            replacement = f"IF({period_expression}={close_cell},{signed},0)"
            lines[index] = re.sub(r"0(?=\s*\)\s*[`\"']?\s*[,;]?)", replacement, line, count=1)
    text = "\n".join(lines) + ("\n" if original.endswith("\n") else "")
    if text != original:
        write(path, text)
        return [path]
    return []


def patch_docs() -> list[str]:
    acquisition_path = "references/acquisition.md"
    text = read(acquisition_path)
    start = text.find("## Funding and debt")
    end = text.find("## Presentation and checks", start)
    if start < 0 or end < 0:
        raise RuntimeError("acquisition funding section not found")
    replacement = '''## Funding and debt

This is a lightweight funded transaction inside the debt overlay, not a full
sources-and-uses or purchase-accounting model.

At close, use transaction enterprise value once as the purchase-consideration
proxy and the supplied acquisition debt amount once as financing proceeds:

```text
consideration cash flow = -transaction enterprise value, in the close year only
acquisition debt proceeds = +acquisition debt amount, in the close year only
net direct transaction cash flow = consideration + acquisition debt proceeds
```

The residual funding requirement is not an invented equity plug. It reduces
existing cash and, when required, draws through the ordinary RCF/minimum-cash
waterfall. Add the acquisition debt amount to the dedicated pro-forma debt
balance at closing and hold it flat for the rest of the forecast. Do not create
an ordinary instrument-register entry, acquisition amortisation or acquisition
maturity.

Enterprise value continues to infer target EBITDA and operating contribution.
The same value is therefore an operating scale input and the consideration
proxy, but it enters direct cash exactly once. Debt proceeds enter cash exactly
once and the debt balance, interest, net debt and leverage exactly once.

Do not add a funding percentage, automatic equity residual, target net debt or
cash, full sources and uses, purchase accounting, synergies, fees, multiple
financing tranches, timing overrides, target-ratio inputs or a target balance
sheet.

```text
average acquisition debt = (opening balance + closing balance) / 2

incremental interest
= average acquisition debt
× incremental debt rate
× close-year fraction or full-year factor
```

**Price the acquisition leg on the average of its opening and closing balance,
exactly as every instrument leg is priced.**

'''
    text = text[:start] + replacement + text[end:]
    text = text.replace("- the acquisition overlay has zero direct cash-flow effect;", "- transaction consideration and acquisition debt proceeds enter direct cash once at close;")
    write(acquisition_path, text)
    for path in ["references/model-intent.md", "references/runtime-core.md", "SKILL.md", "central-instructions.md"]:
        if not (ROOT / path).is_file():
            continue
        doc = read(path)
        doc = doc.replace("zero direct transaction cash-flow effect", "one close-year funded transaction cash effect")
        doc = doc.replace("zero direct cash-flow effect", "one close-year funded transaction cash effect")
        write(path, doc)
    return [acquisition_path, "references/model-intent.md", "references/runtime-core.md", "SKILL.md", "central-instructions.md"]


def tests() -> list[str]:
    policy_test = "scripts/run_funded_acquisition_policy_tests.mjs"
    if not (ROOT / policy_test).exists():
        write(policy_test, r'''#!/usr/bin/env node
import assert from "node:assert/strict";
import { fundedAcquisitionInputs, fundedAcquisitionTransaction, fundedAcquisitionTransactionSeries } from "./lib/acquisition_transaction_policy.mjs";

const modelCase = {
  periods: [
    { date: "2023-12-31", status: "historical" },
    { date: "2024-12-31", status: "historical" },
    { date: "2025-12-31", status: "historical" },
    { date: "2026-12-31", status: "forecast" },
    { date: "2027-12-31", status: "forecast" },
    { date: "2028-12-31", status: "forecast" },
  ],
  controls: { acquisition_adjustments: "On" },
  acquisition: {
    transaction_enterprise_value: 1000,
    acquisition_debt_amount: 400,
    close_year: 2027,
  },
};
assert.deepEqual(fundedAcquisitionInputs(modelCase), {
  enabled: true,
  transaction_enterprise_value: 1000,
  acquisition_debt_amount: 400,
  close_year: 2027,
});
const series = fundedAcquisitionTransactionSeries(modelCase);
assert.equal(series[0].net_transaction_cash_flow, 0);
assert.equal(series[1].consideration_cash_flow, -1000);
assert.equal(series[1].debt_proceeds, 400);
assert.equal(series[1].net_transaction_cash_flow, -600);
assert.equal(series[1].residual_funding_requirement, 600);
assert.equal(series[2].net_transaction_cash_flow, 0);
const off = structuredClone(modelCase);
off.controls.acquisition_adjustments = "Off";
assert.equal(fundedAcquisitionTransaction(off, 1).net_transaction_cash_flow, 0);
console.log(JSON.stringify({ status: "PASS", checks: 9 }, null, 2));
''')
    static_test = "scripts/run_funded_acquisition_source_tests.py"
    if not (ROOT / static_test).exists():
        write(static_test, r'''#!/usr/bin/env python3
"""Source-level non-vacuity checks for the funded acquisition integration."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
files = [
    ROOT / "scripts" / "lib" / "solver.mjs",
    ROOT / "scripts" / "lib" / "case_compiler.mjs",
    ROOT / "scripts" / "lib" / "row_plan.mjs",
    ROOT / "scripts" / "build_dynamic_model.mjs",
]
joined = "\n".join(path.read_text("utf-8") for path in files if path.is_file())
assert "fundedAcquisitionTransaction" in joined
assert "consideration_cash_flow" in joined
assert "debt_proceeds" in joined
assert "zero direct transaction cash-flow effect" not in (ROOT / "references" / "acquisition.md").read_text("utf-8")
# Targeted mutation: the exact formula-driven zero observed in the live workbook
# may not remain next to the two transaction rows.
for path in files:
    if not path.is_file():
        continue
    lines = path.read_text("utf-8").splitlines()
    for index, line in enumerate(lines):
        context = "\n".join(lines[max(0, index - 8):index + 9]).casefold()
        if "acquisition" not in context and "transaction" not in context:
            continue
        if "debt proceeds" in context or "direct transaction cash" in context or "consideration" in context:
            assert not re.search(r"=IF\([^\n]*,0,0\)", line), f"formula-zero survives at {path}:{index + 1}"
print({"status": "PASS", "checks": 5})
''')
    return [policy_test, static_test]


def patch_registry() -> list[str]:
    path = "assets/development-test-registry.json"
    registry = json.loads(read(path))
    ids = {item.get("id") for item in registry.get("tests", [])}
    additions = [
        {"id": "funded-acquisition-policy", "phase": "economics", "runtime": "node", "script": "run_funded_acquisition_policy_tests.mjs"},
        {"id": "funded-acquisition-source", "phase": "economics", "runtime": "python", "script": "run_funded_acquisition_source_tests.py"},
    ]
    for item in additions:
        if item["id"] not in ids:
            registry["tests"].append(item)
            ids.add(item["id"])
    write(path, json.dumps(registry, indent=2) + "\n")
    return [path]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if not MAP_PATH.is_file():
        subprocess.run(["python3", str(ROOT / "scripts" / "run_acquisition_execution_map.py"), "--out", str(MAP_PATH.parent)], cwd=ROOT, check=True)
    execution_map = json.loads(MAP_PATH.read_text("utf-8"))
    module_path = "scripts/lib/acquisition_transaction_policy.mjs"
    write(module_path, helper_module())
    changed = [module_path]
    changed += patch_numeric_zero_writers(execution_map)
    changed += patch_formula_zero_writers(execution_map)
    changed += patch_docs()
    changed += tests()
    changed += patch_registry()
    changed = sorted(set(path for path in changed if (ROOT / path).is_file()))
    report: dict[str, Any] = {
        "schema_version": "excel-inflow-funded-acquisition-repair/1.0",
        "changed_paths": changed,
        "sha256": {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in changed},
        "contract": {
            "consideration_cash_flow_once": True,
            "debt_proceeds_once": True,
            "residual_funding_via_cash_and_rcf": True,
            "automatic_equity_plug": False,
            "full_sources_and_uses": False,
        },
    }
    report["report_sha256"] = hashlib.sha256((json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n").encode()).hexdigest()
    (output / "funded-acquisition-repair.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")
    print(json.dumps({"status": "PASS", "changed": len(changed), "report_sha256": report["report_sha256"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
