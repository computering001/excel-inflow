"""Row-identity resolution against the `.row-map.json` sidecar.

Geometry must be resolved by ROW IDENTITY, never by physical row number: rows
shift by design between cases and between builds, so a check keyed on "row 137"
silently starts asserting about a different thing.  Everything the render checks
need is addressed through :class:`RowMap`.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Tuple


@dataclass
class RowMap:
    path: str
    raw: dict

    # ---- identity -> physical row ----------------------------------------

    @property
    def rows_by_id(self) -> Dict[str, int]:
        return {str(k): int(v) for k, v in (self.raw.get("rows_by_id") or {}).items()}

    def row(self, row_id: str) -> int:
        rows = self.rows_by_id
        if row_id not in rows:
            raise KeyError("row identity %r not present in %s" % (row_id, self.path))
        return rows[row_id]

    def maybe_row(self, row_id: str) -> Optional[int]:
        return self.rows_by_id.get(row_id)

    def identity_of(self, physical_row: int) -> Optional[str]:
        for row_id, row in self.rows_by_id.items():
            if row == physical_row:
                return row_id
        return None

    # ---- named structural rows -------------------------------------------

    @property
    def section_header_rows(self) -> Dict[str, int]:
        return {str(k): int(v) for k, v in (self.raw.get("section_headers") or {}).items()}

    @property
    def control_rows(self) -> Dict[str, int]:
        return {str(k): int(v) for k, v in (self.raw.get("controls") or {}).items()}

    @property
    def period_group_row(self) -> Optional[int]:
        value = self.raw.get("period_group_row")
        return int(value) if value is not None else None

    @property
    def period_row(self) -> Optional[int]:
        value = self.raw.get("period_row")
        return int(value) if value is not None else None

    @property
    def visible_end_row(self) -> int:
        return int(self.raw.get("visible_end_row") or 0)

    @property
    def outline_rows(self) -> List[Tuple[int, int]]:
        return [(int(e["row"]), int(e.get("level", 0))) for e in (self.raw.get("outline_rows") or [])]

    @property
    def label_indents(self) -> Dict[int, int]:
        return {int(k): int(v) for k, v in (self.raw.get("label_indents") or {}).items()}

    # ---- columns ----------------------------------------------------------

    @property
    def columns(self) -> dict:
        return self.raw.get("columns") or {}

    def label_column(self) -> str:
        return str(self.columns.get("labels") or "B")

    def numeric_column_letters(self) -> List[str]:
        """Every column that carries right-aligned numbers, in sheet order."""
        out: List[str] = []
        for key in ("terms", "historical", "forecast", "adjustment", "pro_forma_reference", "pro_forma"):
            value = self.columns.get(key)
            if value is None:
                continue
            if isinstance(value, str):
                out.append(value)
            else:
                out.extend(str(v) for v in value)
        seen = set()
        ordered: List[str] = []
        for letters in out:
            if letters not in seen:
                seen.add(letters)
                ordered.append(letters)
        return ordered

    def gutter_column_letters(self, first: str = "A", last: Optional[str] = None) -> List[str]:
        """Columns in the print range that carry neither labels nor numbers.

        These are the deliberate white separators (A, F, M, Q in the CRH
        profile).  Derived, not hard-coded, so a layout change is visible as a
        changed gutter set rather than as a silently wrong assertion.
        """
        from . import xlsx_model as xm

        used = set(self.numeric_column_letters()) | {self.label_column()}
        first_index = xm.col_letters_to_index(first)
        last_index = xm.col_letters_to_index(last) if last else max(
            xm.col_letters_to_index(c) for c in used
        )
        return [
            xm.col_index_to_letters(i)
            for i in range(first_index, last_index + 1)
            if xm.col_index_to_letters(i) not in used
        ]

    # ---- answer / control rows -------------------------------------------

    def answer_rows(self) -> Dict[str, int]:
        """Control (answer) rows: the interactive inputs an analyst toggles."""
        return dict(self.control_rows)


def load_row_map(path: str) -> RowMap:
    with open(path, "r", encoding="utf-8") as handle:
        return RowMap(path=path, raw=json.load(handle))


def sidecar_for(workbook_path: str) -> str:
    return workbook_path + ".row-map.json"


def load_for_workbook(workbook_path: str) -> RowMap:
    path = sidecar_for(workbook_path)
    if not os.path.exists(path):
        raise FileNotFoundError(
            "row-map sidecar missing for %s -- geometry cannot be resolved by row "
            "identity, so the render stage is BLOCKED rather than degraded" % workbook_path
        )
    return load_row_map(path)
