#!/usr/bin/env python3
"""Apply acquisition repair v2 with AST-safe proof and idempotent formula edits."""
from __future__ import annotations

import ast
import importlib.util
import re
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SPEC = importlib.util.spec_from_file_location("acquisition_v2", HERE / "apply_excel_inflow_acquisition_repair_v2.py")
module = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(module)


def offset(lines: list[str], lineno: int, column: int) -> int:
    return sum(len(line) for line in lines[:lineno - 1]) + column


def ast_python_finance_proof() -> dict[str, Any]:
    path = "scripts/verify/finance_proof.py"
    text = module.read(path)
    if (
        "funded_acquisition_transaction" in text
        and "consideration_cash_flow" in text
        and "debt_proceeds" in text
    ):
        try:
            ast.parse(text)
            return {"path": path, "patched": True, "already": True}
        except SyntaxError:
            # Recover the pristine file from git if an earlier uncommitted
            # heuristic edit produced invalid Python.
            import subprocess
            restored = subprocess.run(
                ["git", "show", f"HEAD:{path}"], cwd=ROOT, text=True,
                capture_output=True, check=False,
            )
            if restored.returncode != 0:
                raise
            text = restored.stdout
    import_line = "from acquisition_transaction_policy import funded_acquisition_transaction"
    if import_line not in text:
        lines = text.splitlines(keepends=True)
        tree = ast.parse(text)
        last_import_line = 0
        for node in tree.body:
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                last_import_line = max(last_import_line, int(getattr(node, "end_lineno", node.lineno)))
            elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                continue
            else:
                break
        lines.insert(last_import_line, import_line + "\n")
        text = "".join(lines)
    tree = ast.parse(text)
    source_lines = text.splitlines(keepends=True)
    replacements: list[tuple[int, int, str, str, str]] = []
    for function in [node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]:
        assignments: dict[str, ast.AST] = {}
        for node in ast.walk(function):
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id in {"cash_from_investing", "cash_from_financing"}:
                        assignments[target.id] = node.value
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id in {"cash_from_investing", "cash_from_financing"}:
                assignments[node.target.id] = node.value
        if set(assignments) != {"cash_from_investing", "cash_from_financing"}:
            continue
        arg_names = [argument.arg for argument in function.args.args]
        case = next((name for name in arg_names if "case" in name or "model" in name), None)
        index_name = next((name for name in arg_names if "index" in name and ("forecast" in name or "period" in name)), None)
        names = {node.id for node in ast.walk(function) if isinstance(node, ast.Name)}
        if not case:
            case = next((name for name in ["model_case", "case_data", "case"] if name in names), None)
        if not index_name:
            index_name = next((name for name in ["forecast_index", "period_index", "index"] if name in names), None)
        if not case or not index_name:
            continue
        for variable, field in [
            ("cash_from_investing", "consideration_cash_flow"),
            ("cash_from_financing", "debt_proceeds"),
        ]:
            value = assignments[variable]
            original = ast.get_source_segment(text, value)
            if not original:
                raise RuntimeError(f"Cannot recover source expression for {variable}")
            start = offset(source_lines, value.lineno, value.col_offset)
            end = offset(source_lines, int(value.end_lineno), int(value.end_col_offset))
            replacement = f"({original}) + funded_acquisition_transaction({case}, {index_name})[{field!r}]"
            replacements.append((start, end, replacement, function.name, field))
        break
    if len(replacements) != 2:
        raise RuntimeError(f"Could not locate both independent finance-proof cash owners: {replacements}")
    for start, end, replacement, _function, _field in sorted(replacements, reverse=True):
        text = text[:start] + replacement + text[end:]
    ast.parse(text)
    module.write(path, text)
    return {
        "path": path,
        "patched": True,
        "modifications": [
            {"function": function, "field": field}
            for _start, _end, _replacement, function, field in replacements
        ],
    }


def idempotent_excel_formula_owners() -> dict[str, Any]:
    path = "scripts/build_dynamic_model.mjs"
    text = module.read(path)
    refs = module.excel_refs(text)
    lines = text.splitlines()
    modifications = []
    present: set[str] = set()
    for index, line in enumerate(lines):
        context = "\n".join(lines[max(0, index - 15):min(len(lines), index + 16)]).casefold()
        field = None
        if "acquisition debt proceeds" in context or "debt proceeds" in context and "acquisition" in context:
            field = "debt_proceeds"
        elif "direct transaction cash" in context or "purchase consideration" in context or "acquisition consideration" in context:
            field = "consideration"
        if not field:
            continue
        if field == "consideration" and "ABS(" in line.upper():
            present.add(field)
            continue
        if field == "debt_proceeds" and "MAX(0," in line.upper():
            present.add(field)
            continue
        if "=if(" not in line.casefold() or not re.search(r",\s*0\s*\)\s*[`\"']?", line):
            continue
        period_column = re.search(r"([A-Z]+)\$?\d+", line)
        column = period_column.group(1) if period_column else "N"
        period_expression = f"YEAR({column}$3)"
        signed = f"MAX(0,{refs['debt']})" if field == "debt_proceeds" else f"-ABS({refs['enterprise_value']})"
        nested = f"IF({period_expression}={refs['close_year']},{signed},0)"
        next_line = re.sub(r"0(?=\s*\)\s*[`\"']?\s*[,;]?)", nested, line, count=1)
        if next_line != line:
            lines[index] = next_line
            present.add(field)
            modifications.append({"line": index + 1, "field": field, "formula": next_line.strip()})
    if present != {"consideration", "debt_proceeds"}:
        raise RuntimeError(f"Could not close both acquisition formula owners; present={present}, modifications={modifications}")
    if modifications:
        module.write(path, "\n".join(lines) + ("\n" if text.endswith("\n") else ""))
    return {"path": path, "already": not modifications, "modifications": modifications}


module.patch_python_finance_proof = ast_python_finance_proof
module.patch_excel_formula_owners = idempotent_excel_formula_owners
raise SystemExit(module.main())
