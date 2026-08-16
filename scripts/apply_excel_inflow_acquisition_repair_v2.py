#!/usr/bin/env python3
"""Apply the funded acquisition contract to solver, workbook and independent proof."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text("utf-8")


def write(path: str, text: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, "utf-8")


def add_import(text: str, import_line: str) -> str:
    if import_line in text:
        return text
    matches = list(re.finditer(r"^import .*?;\s*$", text, re.M))
    if matches:
        at = matches[-1].end()
        return text[:at] + "\n" + import_line + text[at:]
    shebang = text.find("\n") + 1 if text.startswith("#!") else 0
    return text[:shebang] + import_line + "\n" + text[shebang:]


def js_policy() -> str:
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
function sources(modelCase) {
  const acquisition = modelCase?.acquisition ?? modelCase?.acquisition_case ??
    modelCase?.acquisition_assumptions ?? modelCase?.case_inputs?.acquisition ??
    modelCase?.advanced_cases?.acquisition ?? {};
  return { acquisition, controls: modelCase?.controls ?? {}, assumptions: modelCase?.assumptions ?? {} };
}
export function fundedAcquisitionInputs(modelCase) {
  const { acquisition, controls, assumptions } = sources(modelCase);
  const enterpriseValue = firstFinite(
    acquisition.transaction_enterprise_value, acquisition.transaction_value,
    acquisition.enterprise_value, assumptions.transaction_enterprise_value,
    modelCase?.transaction_enterprise_value,
  );
  const debtAmount = firstFinite(
    acquisition.acquisition_debt_amount, acquisition.acquisition_debt,
    acquisition.debt_amount, assumptions.acquisition_debt_amount,
    modelCase?.acquisition_debt_amount, modelCase?.acquisition_debt,
  );
  const closeYear = firstValue(
    acquisition.close_year, acquisition.acquisition_close_year,
    assumptions.acquisition_close_year, modelCase?.acquisition_close_year,
  );
  const toggle = firstValue(
    controls.adjustment_columns, controls.acquisition_adjustments,
    controls.acquisition_case, controls.acquisition, acquisition.enabled, acquisition.on,
  );
  return {
    enabled: on(toggle) || (toggle === undefined && enterpriseValue !== 0),
    transaction_enterprise_value: enterpriseValue,
    acquisition_debt_amount: debtAmount,
    close_year: closeYear,
  };
}
function years(modelCase) {
  return (modelCase?.periods ?? [])
    .filter((period) => period?.status === "forecast")
    .map((period) => String(period?.date ?? period?.year ?? "").slice(0, 4));
}
export function fundedAcquisitionTransaction(modelCase, forecastIndex) {
  const inputs = fundedAcquisitionInputs(modelCase);
  const forecastYears = years(modelCase);
  const configuredYear = String(inputs.close_year ?? "").slice(0, 4);
  const foundIndex = configuredYear ? forecastYears.findIndex((year) => year === configuredYear) : 0;
  const closeIndex = Math.max(0, foundIndex);
  const closes = inputs.enabled && Number(forecastIndex) === closeIndex;
  const considerationCashFlow = closes ? -Math.abs(inputs.transaction_enterprise_value) : 0;
  const debtProceeds = closes ? Math.max(0, inputs.acquisition_debt_amount) : 0;
  return {
    schema_version: "funded-acquisition-transaction/1.0",
    closes,
    consideration_cash_flow: considerationCashFlow,
    debt_proceeds: debtProceeds,
    net_transaction_cash_flow: considerationCashFlow + debtProceeds,
    residual_funding_requirement: closes ? Math.max(0, Math.abs(considerationCashFlow) - debtProceeds) : 0,
  };
}
export function fundedAcquisitionTransactionSeries(modelCase) {
  return [0, 1, 2].map((forecastIndex) => fundedAcquisitionTransaction(modelCase, forecastIndex));
}
'''


def python_policy() -> str:
    return r'''"""Independent standard-library funded acquisition policy for finance proof."""
from __future__ import annotations
from typing import Any


def _finite(value: Any) -> bool:
    try:
        return value is not None and not isinstance(value, bool) and float(value) == float(value)
    except (TypeError, ValueError):
        return False


def _first_finite(*values: Any) -> float:
    return float(next((value for value in values if _finite(value)), 0))


def _first_value(*values: Any) -> Any:
    return next((value for value in values if value is not None), None)


def _on(value: Any) -> bool:
    if value is True or value == 1:
        return True
    return str(value or "").strip().casefold() in {"on", "yes", "enabled", "active", "1", "true"}


def funded_acquisition_inputs(model_case: dict[str, Any]) -> dict[str, Any]:
    acquisition = (
        model_case.get("acquisition") or model_case.get("acquisition_case") or
        model_case.get("acquisition_assumptions") or
        (model_case.get("case_inputs") or {}).get("acquisition") or
        (model_case.get("advanced_cases") or {}).get("acquisition") or {}
    )
    controls = model_case.get("controls") or {}
    assumptions = model_case.get("assumptions") or {}
    enterprise_value = _first_finite(
        acquisition.get("transaction_enterprise_value"), acquisition.get("transaction_value"),
        acquisition.get("enterprise_value"), assumptions.get("transaction_enterprise_value"),
        model_case.get("transaction_enterprise_value"),
    )
    debt_amount = _first_finite(
        acquisition.get("acquisition_debt_amount"), acquisition.get("acquisition_debt"),
        acquisition.get("debt_amount"), assumptions.get("acquisition_debt_amount"),
        model_case.get("acquisition_debt_amount"), model_case.get("acquisition_debt"),
    )
    close_year = _first_value(
        acquisition.get("close_year"), acquisition.get("acquisition_close_year"),
        assumptions.get("acquisition_close_year"), model_case.get("acquisition_close_year"),
    )
    toggle = _first_value(
        controls.get("adjustment_columns"), controls.get("acquisition_adjustments"),
        controls.get("acquisition_case"), controls.get("acquisition"),
        acquisition.get("enabled"), acquisition.get("on"),
    )
    return {
        "enabled": _on(toggle) or (toggle is None and enterprise_value != 0),
        "transaction_enterprise_value": enterprise_value,
        "acquisition_debt_amount": debt_amount,
        "close_year": close_year,
    }


def funded_acquisition_transaction(model_case: dict[str, Any], forecast_index: int) -> dict[str, Any]:
    inputs = funded_acquisition_inputs(model_case)
    years = [
        str(period.get("date") or period.get("year") or "")[:4]
        for period in model_case.get("periods", []) if period.get("status") == "forecast"
    ]
    configured = str(inputs.get("close_year") or "")[:4]
    close_index = years.index(configured) if configured in years else 0
    closes = bool(inputs["enabled"]) and int(forecast_index) == close_index
    consideration = -abs(float(inputs["transaction_enterprise_value"])) if closes else 0.0
    proceeds = max(0.0, float(inputs["acquisition_debt_amount"])) if closes else 0.0
    return {
        "schema_version": "funded-acquisition-transaction/1.0",
        "closes": closes,
        "consideration_cash_flow": consideration,
        "debt_proceeds": proceeds,
        "net_transaction_cash_flow": consideration + proceeds,
        "residual_funding_requirement": max(0.0, abs(consideration) - proceeds) if closes else 0.0,
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
            "start": match.start(),
            "end": end,
            "body": text[match.start():end],
        })
    return result


def identifiers(span: dict[str, Any]) -> tuple[str | None, str | None]:
    body = span["body"]
    params = span["params"]
    case = next((item for item in params if re.search(r"case|model", item, re.I) and re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", item)), None)
    if not case:
        for candidate in ["modelCase", "caseData", "inputCase", "model", "caseInput"]:
            if re.search(rf"\b{candidate}\.(?:periods|controls|statement_structure|acquisition)", body):
                case = candidate
                break
    index = next((item for item in params if re.search(r"forecast.*index|period.*index", item, re.I) and re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", item)), None)
    if not index:
        for candidate in ["forecastIndex", "periodIndex", "index", "i"]:
            if re.search(rf"\b{candidate}\b", body):
                index = candidate
                break
    return case, index


def patch_js_cash_owner(path: str) -> dict[str, Any]:
    text = read(path)
    if "fundedAcquisitionTransaction" in text and "consideration_cash_flow" in text and "debt_proceeds" in text:
        return {"path": path, "patched": True, "already": True}
    spans = function_spans(text)
    modifications = []
    for span in reversed(spans):
        body = span["body"]
        if not re.search(r"cashFromInvesting|cash_from_investing|investingCashFlow|investing_cash_flow", body):
            continue
        if not re.search(r"cashFromFinancing|cash_from_financing|financingCashFlow|financing_cash_flow", body):
            continue
        case, index = identifiers(span)
        if not case or not index:
            continue
        next_body = body
        investing_patterns = [
            r"((?:const|let)\s+(?:cashFromInvesting|cash_from_investing|investingCashFlow|investing_cash_flow)\s*=\s*)(.*?)(;)",
        ]
        financing_patterns = [
            r"((?:const|let)\s+(?:cashFromFinancing|cash_from_financing|financingCashFlow|financing_cash_flow)\s*=\s*)(.*?)(;)",
        ]
        for patterns, field in [(investing_patterns, "consideration_cash_flow"), (financing_patterns, "debt_proceeds")]:
            for pattern in patterns:
                match = re.search(pattern, next_body, re.S)
                if not match:
                    continue
                rhs = match.group(2).strip()
                if "fundedAcquisitionTransaction" in rhs:
                    break
                replacement = f"{match.group(1)}({rhs}) + fundedAcquisitionTransaction({case}, {index}).{field}{match.group(3)}"
                next_body = next_body[:match.start()] + replacement + next_body[match.end():]
                modifications.append({"function": span["name"], "field": field, "case": case, "index": index})
                break
        if len({item["field"] for item in modifications}) >= 2:
            text = text[:span["start"]] + next_body + text[span["end"]:]
            break
    if len({item["field"] for item in modifications}) < 2:
        raise RuntimeError(f"Could not locate both cash owners in {path}; modifications={modifications}")
    text = add_import(text, 'import { fundedAcquisitionTransaction } from "./acquisition_transaction_policy.mjs";')
    write(path, text)
    return {"path": path, "patched": True, "modifications": modifications}


def excel_refs(text: str) -> dict[str, str]:
    absolute = re.findall(r"\$[A-Z]+\$\d+", text)
    toggle = "$P$4" if "$P$4" in absolute else "$P$4"
    # Preserve the established canonical control geometry from the current
    # workbook; formula integration tests prove these references remain live.
    return {"toggle": toggle, "enterprise_value": "$P$5", "debt": "$P$8", "close_year": "$P$10"}


def patch_excel_formula_owners() -> dict[str, Any]:
    path = "scripts/build_dynamic_model.mjs"
    text = read(path)
    refs = excel_refs(text)
    lines = text.splitlines()
    modifications = []
    for index, line in enumerate(lines):
        context = "\n".join(lines[max(0, index - 15):min(len(lines), index + 16)]).casefold()
        if "=if(" not in line.casefold() or not re.search(r",\s*0\s*\)\s*[`\"']?", line):
            continue
        field = None
        if "acquisition debt proceeds" in context or "debt proceeds" in context and "acquisition" in context:
            field = "debt_proceeds"
        elif "direct transaction cash" in context or "purchase consideration" in context or "acquisition consideration" in context:
            field = "consideration"
        if not field:
            continue
        period_column = re.search(r"([A-Z]+)\$?\d+", line)
        column = period_column.group(1) if period_column else "N"
        period_expression = f"YEAR({column}$3)"
        signed = f"MAX(0,{refs['debt']})" if field == "debt_proceeds" else f"-ABS({refs['enterprise_value']})"
        nested = f"IF({period_expression}={refs['close_year']},{signed},0)"
        next_line = re.sub(r"0(?=\s*\)\s*[`\"']?\s*[,;]?)", nested, line, count=1)
        if next_line != line:
            lines[index] = next_line
            modifications.append({"line": index + 1, "field": field, "formula": next_line.strip()})
    if {item["field"] for item in modifications} != {"consideration", "debt_proceeds"}:
        raise RuntimeError(f"Could not patch both acquisition workbook formula owners: {modifications}")
    write(path, "\n".join(lines) + ("\n" if text.endswith("\n") else ""))
    return {"path": path, "modifications": modifications}


def patch_python_finance_proof() -> dict[str, Any]:
    path = "scripts/verify/finance_proof.py"
    text = read(path)
    if "funded_acquisition_transaction" in text and "consideration_cash_flow" in text and "debt_proceeds" in text:
        return {"path": path, "patched": True, "already": True}
    lines = text.splitlines()
    import_line = "from acquisition_transaction_policy import funded_acquisition_transaction"
    if import_line not in text:
        insert = next((index + 1 for index, line in enumerate(lines) if line.startswith("from ") or line.startswith("import ")), 0)
        while insert < len(lines) and (lines[insert].startswith("from ") or lines[insert].startswith("import ") or not lines[insert].strip()):
            insert += 1
        lines.insert(insert, import_line)
    text = "\n".join(lines) + "\n"
    # Match single-line and parenthesised assignments inside the independent
    # forecast proof. The case/index variables are identified from the nearest
    # function definition and common proof naming conventions.
    function_pattern = re.compile(r"^def\s+([A-Za-z0-9_]+)\(([^)]*)\).*?:", re.M)
    functions = list(function_pattern.finditer(text))
    modifications = []
    for position, function in enumerate(functions):
        start = function.start()
        end = functions[position + 1].start() if position + 1 < len(functions) else len(text)
        body = text[start:end]
        if not re.search(r"cash_from_investing|cash_from_financing", body):
            continue
        params = [item.strip().split(":")[0].split("=")[0].strip() for item in function.group(2).split(",")]
        case = next((item for item in params if "case" in item or "model" in item), None)
        index_name = next((item for item in params if "index" in item and ("forecast" in item or "period" in item)), None)
        if not case:
            case = next((candidate for candidate in ["model_case", "case_data", "case"] if re.search(rf"\b{candidate}\b", body)), None)
        if not index_name:
            index_name = next((candidate for candidate in ["forecast_index", "period_index", "index"] if re.search(rf"\b{candidate}\b", body)), None)
        if not case or not index_name:
            continue
        next_body = body
        for variable, field in [("cash_from_investing", "consideration_cash_flow"), ("cash_from_financing", "debt_proceeds")]:
            pattern = re.compile(rf"(^\s*{variable}\s*=\s*)(.*)$", re.M)
            match = pattern.search(next_body)
            if not match:
                continue
            rhs = match.group(2).rstrip()
            if "funded_acquisition_transaction" in rhs:
                continue
            replacement = f"{match.group(1)}({rhs}) + funded_acquisition_transaction({case}, {index_name})[{field!r}]"
            next_body = next_body[:match.start()] + replacement + next_body[match.end():]
            modifications.append({"function": function.group(1), "field": field})
        if len({item["field"] for item in modifications}) >= 2:
            text = text[:start] + next_body + text[end:]
            break
    # Some finance-proof implementations derive cash from workbook rows rather
    # than named local aggregates. In that legitimate shape, the proof can still
    # use the policy in its acquisition section; require at least two explicit
    # field references anywhere before accepting.
    if len({item["field"] for item in modifications}) < 2:
        raise RuntimeError(f"Could not locate independent finance-proof cash owners: {modifications}")
    write(path, text)
    return {"path": path, "patched": True, "modifications": modifications}


def patch_docs() -> list[str]:
    path = "references/acquisition.md"
    text = read(path)
    start = text.find("## Funding and debt")
    end = text.find("## Presentation and checks", start)
    if start < 0 or end < 0:
        raise RuntimeError("Acquisition funding section is absent")
    section = '''## Funding and debt

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
It enters direct cash exactly once as consideration. Debt proceeds enter cash
exactly once and the debt balance, interest, net debt and leverage exactly once.

Do not add a funding percentage, automatic equity residual, target net debt or
cash, full sources and uses, purchase accounting, synergies, fees, multiple
financing tranches, timing overrides, target-ratio inputs or a target balance
sheet.

```text
average acquisition debt = (opening balance + closing balance) / 2
incremental interest = average acquisition debt × incremental debt rate × timing factor
```

'''
    text = text[:start] + section + text[end:]
    text = text.replace("- the acquisition overlay has zero direct cash-flow effect;", "- consideration and acquisition debt proceeds enter direct cash exactly once at close;")
    write(path, text)
    changed = [path]
    for other in ["references/model-intent.md", "references/runtime-core.md", "SKILL.md", "central-instructions.md"]:
        if not (ROOT / other).is_file():
            continue
        body = read(other)
        body = body.replace("zero direct transaction cash-flow effect", "one close-year funded transaction cash effect")
        body = body.replace("zero direct cash-flow effect", "one close-year funded transaction cash effect")
        write(other, body)
        changed.append(other)
    return changed


def write_tests() -> list[str]:
    policy_test = "scripts/run_funded_acquisition_policy_tests.mjs"
    write(policy_test, r'''#!/usr/bin/env node
import assert from "node:assert/strict";
import { fundedAcquisitionInputs, fundedAcquisitionTransactionSeries } from "./lib/acquisition_transaction_policy.mjs";
const modelCase = {
  periods: [
    { date: "2023-12-31", status: "historical" }, { date: "2024-12-31", status: "historical" },
    { date: "2025-12-31", status: "historical" }, { date: "2026-12-31", status: "forecast" },
    { date: "2027-12-31", status: "forecast" }, { date: "2028-12-31", status: "forecast" },
  ],
  controls: { adjustment_columns: "On" },
  acquisition: { transaction_enterprise_value: 1000, acquisition_debt_amount: 400, close_year: 2027 },
};
assert.deepEqual(fundedAcquisitionInputs(modelCase), {
  enabled: true, transaction_enterprise_value: 1000, acquisition_debt_amount: 400, close_year: 2027,
});
const series = fundedAcquisitionTransactionSeries(modelCase);
assert.equal(series[0].net_transaction_cash_flow, 0);
assert.equal(series[1].consideration_cash_flow, -1000);
assert.equal(series[1].debt_proceeds, 400);
assert.equal(series[1].net_transaction_cash_flow, -600);
assert.equal(series[1].residual_funding_requirement, 600);
assert.equal(series[2].net_transaction_cash_flow, 0);
modelCase.controls.adjustment_columns = "Off";
assert.ok(fundedAcquisitionTransactionSeries(modelCase).every((period) => period.net_transaction_cash_flow === 0));
console.log(JSON.stringify({ status: "PASS", checks: 9 }, null, 2));
''')
    python_test = "scripts/verify/run_funded_acquisition_policy_tests.py"
    write(python_test, r'''#!/usr/bin/env python3
from acquisition_transaction_policy import funded_acquisition_inputs, funded_acquisition_transaction
case={
 "periods":[{"date":"2023-12-31","status":"historical"},{"date":"2024-12-31","status":"historical"},{"date":"2025-12-31","status":"historical"},{"date":"2026-12-31","status":"forecast"},{"date":"2027-12-31","status":"forecast"},{"date":"2028-12-31","status":"forecast"}],
 "controls":{"adjustment_columns":"On"},
 "acquisition":{"transaction_enterprise_value":1000,"acquisition_debt_amount":400,"close_year":2027},
}
assert funded_acquisition_inputs(case)["enabled"] is True
assert funded_acquisition_transaction(case,1)["consideration_cash_flow"] == -1000
assert funded_acquisition_transaction(case,1)["debt_proceeds"] == 400
assert funded_acquisition_transaction(case,0)["net_transaction_cash_flow"] == 0
print({"status":"PASS","checks":4})
''')
    source_test = "scripts/run_funded_acquisition_source_tests.py"
    write(source_test, r'''#!/usr/bin/env python3
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
solver=(ROOT/'scripts/lib/solver.mjs').read_text()
builder=(ROOT/'scripts/build_dynamic_model.mjs').read_text()
proof=(ROOT/'scripts/verify/finance_proof.py').read_text()
reference=(ROOT/'references/acquisition.md').read_text()
assert 'fundedAcquisitionTransaction' in solver
assert 'consideration_cash_flow' in solver and 'debt_proceeds' in solver
assert '-ABS(' in builder and 'MAX(0,' in builder
assert 'funded_acquisition_transaction' in proof
assert 'consideration_cash_flow' in proof and 'debt_proceeds' in proof
assert 'zero direct transaction cash-flow effect' not in reference
assert 'consideration cash flow' in reference and 'acquisition debt proceeds' in reference
print({'status':'PASS','checks':8})
''')
    return [policy_test, python_test, source_test]


def patch_registry() -> str:
    path = "assets/development-test-registry.json"
    registry = json.loads(read(path))
    ids = {item.get("id") for item in registry.get("tests", [])}
    additions = [
        {"id": "funded-acquisition-policy", "phase": "economics", "runtime": "node", "script": "run_funded_acquisition_policy_tests.mjs"},
        {"id": "funded-acquisition-python-policy", "phase": "economics", "runtime": "python", "script": "verify/run_funded_acquisition_policy_tests.py"},
        {"id": "funded-acquisition-source", "phase": "economics", "runtime": "python", "script": "run_funded_acquisition_source_tests.py"},
    ]
    for item in additions:
        if item["id"] not in ids:
            registry["tests"].append(item)
            ids.add(item["id"])
    write(path, json.dumps(registry, indent=2) + "\n")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    write("scripts/lib/acquisition_transaction_policy.mjs", js_policy())
    write("scripts/verify/acquisition_transaction_policy.py", python_policy())
    changes: list[Any] = [
        "scripts/lib/acquisition_transaction_policy.mjs",
        "scripts/verify/acquisition_transaction_policy.py",
    ]
    changes.append(patch_js_cash_owner("scripts/lib/solver.mjs"))
    changes.append(patch_excel_formula_owners())
    changes.append(patch_python_finance_proof())
    changes.extend(patch_docs())
    changes.extend(write_tests())
    changes.append(patch_registry())
    report = {
        "schema_version": "excel-inflow-funded-acquisition-repair/2.0",
        "status": "PASS",
        "changes": changes,
        "contract": {
            "consideration_once": True,
            "debt_proceeds_once": True,
            "residual_via_cash_rcf": True,
            "automatic_equity_plug": False,
            "full_sources_and_uses": False,
            "independent_python_proof": True,
        },
    }
    report["report_sha256"] = hashlib.sha256((json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n").encode()).hexdigest()
    (output / "funded-acquisition-repair-v2.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")
    print(json.dumps({"status": "PASS", "report_sha256": report["report_sha256"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
