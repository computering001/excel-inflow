#!/usr/bin/env python3
"""Shared production-import independence scan for scripts/verify oracles.

An oracle is independent only if it cannot inherit a defect from the code
that PRODUCED the artifact it judges.  The classification rule for what
counts as a production import is therefore derived from what the production
side actually is:

  * the workbook emitter (``scripts/emit`` and
    ``emit_source_arithmetic_candidate_artifact``),
  * the case/forecast compilers, row planner and solver
    (``scripts/lib/case_compiler.mjs``, ``forecast_candidate_compiler.mjs``,
    ``row_plan.mjs``, ``solver.mjs`` — and any Python homonym of them),
  * the builder entrypoint (``build_dynamic_model``),
  * everything under ``scripts/lib`` (production JavaScript; a Python import
    shaped ``scripts.lib`` is equally forbidden — the bare token ``lib``
    is deliberately not used because it substring-matches stdlib names such
    as ``urllib``/``pathlib``),
  * generated production contracts (``scripts/generated``),
  * the render/synthesis pipeline (``scripts/render``).

Subprocess use follows the same rule but cannot be classified mechanically:
invoking production code to PRODUCE the artifact under test is lawful (for
example ``verify/run_deterministic_tests.py`` building its A/B workbooks
through ``build_dynamic_model.mjs``); invoking production code to COMPUTE
the expected answer is not.  That distinction is a review obligation on each
harness and is recorded here rather than pretended to be automated.

Matching is substring matching over the full dotted module name — never
weaker than the original single-file scan this helper was lifted from
(``run_emitted_candidate_independent_oracle_tests.py``).

Scope: this helper scans Python only.  The same-language ``.mjs`` checkers
in ``scripts/verify`` (``recalc_second_opinion.mjs`` and
``run_linked_debt_addback_proof_test.mjs``, which imports
``lib/row_plan.mjs``) share the production language and module graph and are
classified NOT_INDEPENDENT; scanning them as if they were independent would
launder that fact.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Iterable, Sequence

# Exact dotted-path components that are forbidden regardless of the caller's
# token list: substring matching cannot use the bare token ``lib`` (it would
# hit ``urllib``/``pathlib``), but ``from lib import row_plan`` and
# ``import lib.solver`` are production imports and must be caught.
_FORBIDDEN_EXACT_COMPONENTS = ("lib",)


def imported_modules(path: Path) -> list[str]:
    """All dotted module names imported by the Python file at ``path``."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            names.add(node.module or "")
        elif isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
    return sorted(names)


def production_imports(path: Path, forbidden: Sequence[str]) -> list[str]:
    """Imports of ``path`` whose dotted name contains a forbidden token.

    ``forbidden`` MUST be non-empty: an empty list would make every scan
    vacuously pass, which is exactly the decorative state this helper exists
    to eliminate.
    """
    if not forbidden:
        raise ValueError("FORBIDDEN_PRODUCTION_IMPORTS must be non-empty; an empty list is a vacuous scan")
    return [
        name for name in imported_modules(path)
        if any(token in name for token in forbidden)
        or any(component in _FORBIDDEN_EXACT_COMPONENTS for component in name.split("."))
    ]


def scan_directory(directory: Path, forbidden: Sequence[str]) -> dict[str, list[str]]:
    """Scan every ``*.py`` file directly inside ``directory``.

    Returns ``{file name: [forbidden imports]}`` for all files, so a caller
    can assert both full coverage and emptiness of every violation list.
    """
    files: Iterable[Path] = sorted(directory.glob("*.py"))
    results = {path.name: production_imports(path, forbidden) for path in files}
    if not results:
        raise ValueError(f"no Python files found under {directory}")
    return results
