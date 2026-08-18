"""Render-stage geometry checks (G1 node N14) for the excel-inflow skill.

This package converts an emitted workbook to PDF through LibreOffice with an
isolated user profile, then asserts things about the *rendered* result that are
structurally invisible to XML inspection:

  * text metrics  -- clipping and overlap
  * whether conditional formatting actually FIRES, and whether the fill it
    applies is distinguishable from the fill underneath it
  * whether font substitution actually occurred

Read `check_render.py` for the entry point.

FAIL-CLOSED CONTRACT
--------------------
A render stage that degrades to "warning" on a failed conversion is WORSE than
no render stage at all, because it converts a hard failure into a green tick.
Every failure mode in this package -- missing soffice, non-zero exit, timeout,
zero-byte PDF, missing PyMuPDF, an unlocatable cell, an unexpected font --
returns BLOCKED. There is deliberately no code path that turns any of those
into a warning.

HONEST LIMIT
------------
This proves LibreOffice rendering with Carlito. It is authoritative for visual
regression and for clipping. It is NOT authoritative for how the workbook looks
to an analyst in Microsoft Excel with Calibri; that remains the human Excel
certification gate (ARCHITECTURE §10).
"""

__all__ = [
    "xlsx_model",
    "rowmap",
    "soffice",
    "pdfdoc",
    "calibrate",
    "checks",
    "baseline",
    "evidence",
]
