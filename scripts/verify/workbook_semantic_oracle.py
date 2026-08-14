#!/usr/bin/env python3
"""Independent OOXML workbook-semantic acceptance oracle.

This module is intentionally standard-library only and imports no compiler,
renderer, row-map or semantic-manifest code.  It accepts a hand-authored proof
contract and reconstructs workbook facts directly from the XLSX package.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_NS = {"r": "http://schemas.openxmlformats.org/package/2006/relationships"}
RID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
CELL_RE = re.compile(r"^([A-Z]+)([0-9]+)$")
REF_RE = re.compile(
    r"(?:(?:'((?:[^']|'')+)'|([A-Za-z0-9_ .-]+))!)?"
    r"(\$?[A-Z]{1,3}\$?[0-9]+)(?::(\$?[A-Z]{1,3}\$?[0-9]+))?"
)


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def column_number(name: str) -> int:
    value = 0
    for char in name:
        value = value * 26 + ord(char) - 64
    return value


def column_name(number: int) -> str:
    result = ""
    while number:
        number, remainder = divmod(number - 1, 26)
        result = chr(65 + remainder) + result
    return result


def split_cell(address: str) -> tuple[str, int]:
    match = CELL_RE.match(address.replace("$", ""))
    if not match:
        raise ValueError(f"Invalid A1 reference {address}")
    return match.group(1), int(match.group(2))


def normalise_label(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def _canonical(value: object) -> object:
    if isinstance(value, list):
        return [_canonical(item) for item in value]
    if isinstance(value, dict):
        return {key: _canonical(value[key]) for key in sorted(value)}
    return value


def _canonical_sha256(value: object) -> str:
    payload = json.dumps(
        _canonical(value), separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _portable_sorted(values, key=lambda value: value):
    return sorted(values, key=lambda value: str(key(value)).encode("utf-8"))


def _formula_graph_from_model_ir(model_ir: dict) -> dict:
    """Independently re-project the sealed model IR into a physical contract."""

    planes = model_ir.get("planes") or {}
    statements = {
        node.get("display_id"): node for node in planes.get("statement") or []
    }
    presentation = {
        node.get("display_id"): node for node in planes.get("presentation") or []
    }
    graph_nodes = []
    for identifier, node in statements.items():
        physical_row = (presentation.get(identifier) or {}).get("physical_row")
        if not isinstance(physical_row, int):
            continue
        graph_nodes.append(
            {
                "display_id": identifier,
                "semantic_role": node.get("semantic_role"),
                "section": node.get("section"),
                "label": node.get("label"),
                "row": physical_row,
            }
        )
    graph_nodes = _portable_sorted(graph_nodes, key=lambda item: item["display_id"])
    graph_node_by_id = {item["display_id"]: item for item in graph_nodes}

    dependency_pairs = {}
    calculation = planes.get("calculation") or {}
    for edge in calculation.get("edges") or []:
        if edge.get("edge_type") == "depends_on":
            consumer_node_id = str(edge.get("from") or "")
            dependency_node_id = str(edge.get("to") or "")
        elif edge.get("edge_type") == "contributes_to":
            consumer_node_id = str(edge.get("to") or "")
            dependency_node_id = str(edge.get("from") or "")
        else:
            continue
        if not (
            consumer_node_id.startswith("statement.")
            and dependency_node_id.startswith("statement.")
        ):
            continue
        consumer = consumer_node_id[len("statement.") :]
        dependency = dependency_node_id[len("statement.") :]
        if consumer not in graph_node_by_id or dependency not in graph_node_by_id:
            continue
        dependency_pairs[(consumer, dependency)] = {
            "consumer_display_id": consumer,
            "dependency_display_id": dependency,
        }
    authorised_edges = _portable_sorted(
        dependency_pairs.values(),
        key=lambda item: "%s\x00%s"
        % (item["consumer_display_id"], item["dependency_display_id"]),
    )

    authority_by_period = {
        (item.get("display_id"), item.get("forecast_index")): item
        for item in planes.get("authority") or []
    }
    forecast_columns = ("J", "K", "L")
    prior_columns = ("I", "J", "K")
    required_paths = []
    for edge in authorised_edges:
        consumer_id = edge["consumer_display_id"]
        dependency_id = edge["dependency_display_id"]
        consumer = graph_node_by_id[consumer_id]
        dependency = graph_node_by_id[dependency_id]
        for forecast_index in range(3):
            authority = authority_by_period.get((consumer_id, forecast_index)) or {}
            if authority.get("producer_type") != "Derived":
                continue
            self_roll_forward = consumer_id == dependency_id
            required_paths.append(
                {
                    "consumer_display_id": consumer_id,
                    "dependency_display_id": dependency_id,
                    "consumer_cell": "%s%s"
                    % (forecast_columns[forecast_index], consumer["row"]),
                    "dependency_cell": "%s%s"
                    % (
                        (
                            prior_columns[forecast_index]
                            if self_roll_forward
                            else forecast_columns[forecast_index]
                        ),
                        dependency["row"],
                    ),
                    "period_relation": (
                        "prior_period" if self_roll_forward else "same_period"
                    ),
                }
            )
    return {
        "statement_sheet": "Operating Model",
        "model_ir_sha256": _canonical_sha256(model_ir),
        "graph_nodes": graph_nodes,
        "authorised_dependency_edges": authorised_edges,
        "required_formula_paths": required_paths,
    }


@dataclass(frozen=True)
class Cell:
    address: str
    value: object
    formula: str | None
    style_id: int
    data_type: str | None


@dataclass
class Sheet:
    name: str
    cells: dict[str, Cell]
    outline_levels: dict[int, int]

    def labels(self, column: str = "B") -> dict[str, list[int]]:
        result: dict[str, list[int]] = {}
        for address, cell in self.cells.items():
            cell_column, row = split_cell(address)
            if cell_column != column or not isinstance(cell.value, str):
                continue
            result.setdefault(normalise_label(cell.value), []).append(row)
        return result


@dataclass
class WorkbookFacts:
    sheets: dict[str, Sheet]
    styles: list[dict]
    defined_names: dict[str, str]
    media_sha256: list[str]


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    return ["".join(node.text or "" for node in item.iter() if local(node.tag) == "t") for item in root]


def _styles(archive: zipfile.ZipFile) -> list[dict]:
    if "xl/styles.xml" not in archive.namelist():
        return []
    root = ET.fromstring(archive.read("xl/styles.xml"))
    fills_node = root.find("m:fills", NS)
    fonts_node = root.find("m:fonts", NS)
    xfs_node = root.find("m:cellXfs", NS)
    borders_node = root.find("m:borders", NS)
    fills = []
    for fill in list(fills_node) if fills_node is not None else []:
        pattern = fill.find("m:patternFill", NS)
        foreground = pattern.find("m:fgColor", NS) if pattern is not None else None
        fills.append({
            "pattern": pattern.get("patternType") if pattern is not None else None,
            "fg": dict(foreground.attrib) if foreground is not None else {},
        })
    fonts = []
    for font in list(fonts_node) if fonts_node is not None else []:
        colour = font.find("m:color", NS)
        fonts.append({"color": dict(colour.attrib) if colour is not None else {}})
    borders = []
    for border in list(borders_node) if borders_node is not None else []:
        borders.append({
            side: (border.find(f"m:{side}", NS).get("style")
                   if border.find(f"m:{side}", NS) is not None else None)
            for side in ("left", "right", "top", "bottom")
        })
    styles = []
    for xf in list(xfs_node) if xfs_node is not None else []:
        alignment = xf.find("m:alignment", NS)
        alignment_attributes = alignment.attrib if alignment is not None else {}
        fill_id = int(xf.get("fillId", "0"))
        font_id = int(xf.get("fontId", "0"))
        border_id = int(xf.get("borderId", "0"))
        styles.append({
            "fill_id": fill_id,
            "font_id": font_id,
            "fill": fills[fill_id] if fill_id < len(fills) else {},
            "font": fonts[font_id] if font_id < len(fonts) else {},
            "border_id": border_id,
            "border": borders[border_id] if border_id < len(borders) else {},
            "indent": int(alignment_attributes.get("indent", "0")),
            "horizontal": alignment_attributes.get("horizontal"),
        })
    return styles


def read_workbook(path: Path) -> WorkbookFacts:
    with zipfile.ZipFile(path) as archive:
        shared = _shared_strings(archive)
        styles = _styles(archive)
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {node.get("Id"): node.get("Target") for node in relationships}
        sheets: dict[str, Sheet] = {}
        sheets_node = workbook.find("m:sheets", NS)
        for node in list(sheets_node) if sheets_node is not None else []:
            name = node.get("name")
            target = targets[node.get(RID)]
            if target.startswith("/"):
                target = target.lstrip("/")
            else:
                target = f"xl/{target}" if not target.startswith("xl/") else target
            target = target.replace("xl/../", "")
            root = ET.fromstring(archive.read(target))
            cells: dict[str, Cell] = {}
            outline: dict[int, int] = {}
            for row_node in root.findall(".//m:sheetData/m:row", NS):
                row_number = int(row_node.get("r"))
                outline[row_number] = int(row_node.get("outlineLevel", "0"))
                for cell_node in row_node.findall("m:c", NS):
                    address = cell_node.get("r")
                    data_type = cell_node.get("t")
                    style_id = int(cell_node.get("s", "0"))
                    formula_node = cell_node.find("m:f", NS)
                    value_node = cell_node.find("m:v", NS)
                    inline = cell_node.find("m:is", NS)
                    raw = value_node.text if value_node is not None else None
                    if data_type == "s" and raw is not None:
                        value: object = shared[int(raw)]
                    elif data_type == "inlineStr" and inline is not None:
                        value = "".join(
                            item.text or "" for item in inline.iter() if local(item.tag) == "t"
                        )
                    elif data_type == "str":
                        value = raw or ""
                    elif raw is None:
                        value = None
                    else:
                        try:
                            value = float(raw)
                        except ValueError:
                            value = raw
                    cells[address] = Cell(
                        address=address,
                        value=value,
                        formula=formula_node.text if formula_node is not None else None,
                        style_id=style_id,
                        data_type=data_type,
                    )
            sheets[name] = Sheet(name=name, cells=cells, outline_levels=outline)
        defined_names = {}
        names_node = workbook.find("m:definedNames", NS)
        for item in list(names_node or []):
            defined_names[item.get("name")] = item.text or ""
        media_sha256 = sorted(
            hashlib.sha256(archive.read(name)).hexdigest()
            for name in archive.namelist()
            if name.startswith("xl/media/") and not name.endswith("/")
        )
        return WorkbookFacts(
            sheets=sheets,
            styles=styles,
            defined_names=defined_names,
            media_sha256=media_sha256,
        )


def expand_formula_references(formula: str | None, current_sheet: str) -> set[tuple[str, str]]:
    if not formula:
        return set()
    references: set[tuple[str, str]] = set()
    for match in REF_RE.finditer(formula):
        quoted, plain, first, last = match.groups()
        sheet = (quoted or plain or current_sheet).replace("''", "'").strip()
        first_col, first_row = split_cell(first)
        last_col, last_row = split_cell(last or first)
        for column in range(column_number(first_col), column_number(last_col) + 1):
            for row in range(first_row, last_row + 1):
                references.add((sheet, f"{column_name(column)}{row}"))
    return references


def strongly_connected_components(adjacency: dict[str, set[str]]) -> list[list[str]]:
    """Deterministic Tarjan SCCs, excluding singleton non-self-cycles."""

    next_index = 0
    indices: dict[str, int] = {}
    low_links: dict[str, int] = {}
    stack: list[str] = []
    on_stack: set[str] = set()
    components: list[list[str]] = []

    def visit(node: str) -> None:
        nonlocal next_index
        indices[node] = next_index
        low_links[node] = next_index
        next_index += 1
        stack.append(node)
        on_stack.add(node)
        for target in _portable_sorted(adjacency.get(node, set())):
            if target not in indices:
                visit(target)
                low_links[node] = min(low_links[node], low_links[target])
            elif target in on_stack:
                low_links[node] = min(low_links[node], indices[target])
        if low_links[node] != indices[node]:
            return
        component = []
        while stack:
            candidate = stack.pop()
            on_stack.remove(candidate)
            component.append(candidate)
            if candidate == node:
                break
        if len(component) > 1 or node in adjacency.get(node, set()):
            components.append(_portable_sorted(component))

    for node in _portable_sorted(adjacency):
        if node not in indices:
            visit(node)
    return _portable_sorted(components, key=lambda item: "\x00".join(item))


def is_independent_writer(cell: Cell | None) -> bool:
    return cell is not None and cell.formula is None and cell.value not in (None, "")


def _find_rows(sheet: Sheet, labels: list[str], column: str) -> list[int]:
    index = sheet.labels(column)
    rows = []
    for label in labels:
        rows.extend(index.get(normalise_label(label), []))
    return sorted(set(rows))


def _cell(sheet: Sheet, column: str, row: int) -> Cell | None:
    return sheet.cells.get(f"{column}{row}")


def _rule_rows(sheet: Sheet, rule: dict, role: str, label_column: str) -> list[int]:
    explicit = rule.get(f"{role}_row")
    if isinstance(explicit, int) and explicit > 0:
        return [explicit]
    return _find_rows(sheet, [rule[f"{role}_label"]], label_column)


def verify(facts: WorkbookFacts, contract: dict, model_ir: dict | None = None) -> dict:
    findings = []

    def block(code: str, message: str, **detail) -> None:
        findings.append({"severity": "BLOCK", "code": code, "message": message, **detail})

    sheet_name = contract.get("statement_sheet", "Operating Model")
    label_column = contract.get("label_column", "B")
    forecast_columns = contract.get("forecast_columns", ["J", "K", "L"])
    sheet = facts.sheets.get(sheet_name)
    if sheet is None:
        block("ORACLE_SHEET_MISSING", f"Required sheet {sheet_name} is absent.")
        return {"status": "BLOCK", "findings": findings, "metrics": {"sheets": len(facts.sheets)}}

    for rule in contract.get("unique_answers", []):
        rows = _find_rows(sheet, rule["labels"], label_column)
        maximum = int(rule.get("max_visible", 1))
        if len(rows) > maximum:
            block(
                "OOXML_DUPLICATE_ANSWER_OWNER",
                f"{rule['concept_id']} appears on {len(rows)} visible rows; maximum is {maximum}.",
                rows=rows,
            )

    # The compiler declares the semantic conclusion in the sealed proof
    # contract; this verifier independently reads the workbook package and
    # proves that exactly that physical row, and no competing row in the same
    # statement block, wears the answer treatment.  Formula fan-out is
    # deliberately irrelevant: an attribution line or EBITDA appendix may be
    # consumed more often without becoming the statement conclusion.
    for rule in contract.get("section_conclusions", []):
        rows = _find_rows(sheet, [rule["label"]], label_column)
        expected_row = int(rule.get("row") or 0)
        if expected_row not in rows:
            block(
                "OOXML_SECTION_CONCLUSION_UNRESOLVED",
                f"{rule['section']} conclusion does not resolve to its sealed owner.",
                expected_row=expected_row,
                resolved_rows=rows,
            )
            continue
        fill_rgb = str(rule.get("answer_fill_rgb", "")).upper()
        bottom = rule.get("answer_bottom_border")
        body_columns = rule.get("body_columns", forecast_columns)

        def has_answer_treatment(row: int) -> bool:
            observed = []
            for column in body_columns:
                cell = _cell(sheet, column, row)
                if cell is None or cell.style_id >= len(facts.styles):
                    continue
                style = facts.styles[cell.style_id]
                fill = style.get("fill", {}).get("fg", {})
                rgb = str(fill.get("rgb", "")).upper()
                if len(rgb) == 8:
                    rgb = rgb[-6:]
                observed.append(
                    rgb == fill_rgb and style.get("border", {}).get("bottom") == bottom
                )
            return bool(observed) and all(observed)

        if not has_answer_treatment(expected_row):
            block(
                "OOXML_SECTION_CONCLUSION_STYLE_MISSING",
                f"{rule['section']} conclusion lacks the answer treatment.",
                row=expected_row,
            )
        first_row = int(rule.get("first_row") or expected_row)
        last_row = int(rule.get("last_row") or expected_row)
        competitors = [
            row for row in range(first_row, last_row + 1)
            if row != expected_row and has_answer_treatment(row)
        ]
        if competitors:
            block(
                "OOXML_SECTION_CONCLUSION_STYLE_DUPLICATED",
                f"{rule['section']} has competing answer treatments.",
                expected_row=expected_row,
                competing_rows=competitors,
            )

    for rule in contract.get("single_writer_groups", []):
        rows = [int(row) for row in rule.get("rows", []) if isinstance(row, int)]
        if not rows:
            rows = _find_rows(sheet, rule["labels"], label_column)
        for column in rule.get("columns", forecast_columns):
            writers = [row for row in rows if is_independent_writer(_cell(sheet, column, row))]
            maximum = int(rule.get("max_independent_writers", 1))
            if len(writers) > maximum:
                block(
                    "OOXML_MULTIPLE_INDEPENDENT_WRITERS",
                    f"{rule['concept_id']} has {len(writers)} independent writers in {column}.",
                    rows=writers,
                    column=column,
                )

    for rule in contract.get("capture_memberships", []):
        parents = _rule_rows(sheet, rule, "parent", label_column)
        children = _rule_rows(sheet, rule, "child", label_column)
        if len(parents) != 1 or len(children) != 1:
            block(
                "OOXML_CAPTURE_LABEL_UNRESOLVED",
                f"Capture labels do not resolve uniquely: {rule}.",
            )
            continue
        parent_row, child_row = parents[0], children[0]
        for column in rule.get("columns", forecast_columns):
            parent_cell = _cell(sheet, column, parent_row)
            expected = (sheet_name, f"{column}{child_row}")
            refs = expand_formula_references(parent_cell.formula if parent_cell else None, sheet_name)
            if expected not in refs:
                block(
                    "OOXML_CAPTURE_MEMBERSHIP_MISSING",
                    f"{rule['child_label']} is not a member of {rule['parent_label']} in {column}.",
                    parent_cell=f"{column}{parent_row}",
                    child_cell=f"{column}{child_row}",
                )

    # A semantic-scope capture is intentionally different from physical formula
    # membership.  The parent owns a direct forecast authority (for example a
    # broker-linked aggregate) and the disclosed children remain visible only
    # for history.  Prove the physical consequence: one live independent parent
    # writer and blank forecast children.  Requiring the parent's formula to
    # reference those blank children would turn a valid aggregate forecast into
    # zero and contradict the sealed authority graph.
    for rule in contract.get("semantic_scope_captures", []):
        parents = _rule_rows(sheet, rule, "parent", label_column)
        children = _rule_rows(sheet, rule, "child", label_column)
        if len(parents) != 1 or len(children) != 1:
            block(
                "OOXML_SCOPE_CAPTURE_LABEL_UNRESOLVED",
                f"Semantic-scope capture labels do not resolve uniquely: {rule}.",
            )
            continue
        parent_row, child_row = parents[0], children[0]
        for column in rule.get("columns", forecast_columns):
            parent_cell = _cell(sheet, column, parent_row)
            child_cell = _cell(sheet, column, child_row)
            parent_live = bool(
                parent_cell
                and (
                    parent_cell.formula
                    or parent_cell.value not in (None, "")
                )
            )
            parent_refs = expand_formula_references(
                parent_cell.formula if parent_cell else None,
                sheet_name,
            )
            child_ref = (sheet_name, f"{column}{child_row}")
            if not parent_live or child_ref in parent_refs:
                block(
                    "OOXML_SCOPE_CAPTURE_PARENT_NOT_AUTHORITATIVE",
                    f"{rule['parent_label']} does not own an independent semantic-scope forecast in {column}.",
                    parent_cell=f"{column}{parent_row}",
                )
            child_populated = bool(
                child_cell
                and (
                    child_cell.formula
                    or child_cell.value not in (None, "")
                )
            )
            if child_populated:
                block(
                    "OOXML_SCOPE_CAPTURE_CHILD_NOT_BLANK",
                    f"{rule['child_label']} competes with its semantic parent in {column}.",
                    child_cell=f"{column}{child_row}",
                )

    for rule in contract.get("hierarchies", []):
        parents = _rule_rows(sheet, rule, "parent", label_column)
        children = _rule_rows(sheet, rule, "child", label_column)
        if len(parents) != 1 or len(children) != 1:
            block("OOXML_HIERARCHY_LABEL_UNRESOLVED", f"Hierarchy labels do not resolve uniquely: {rule}.")
            continue
        parent_row, child_row = parents[0], children[0]
        if child_row <= parent_row:
            block(
                "OOXML_CHILD_BEFORE_PARENT",
                f"{rule['child_label']} is not displayed after {rule['parent_label']}.",
                parent_row=parent_row,
                child_row=child_row,
            )
        parent_cell = _cell(sheet, label_column, parent_row)
        child_cell = _cell(sheet, label_column, child_row)
        parent_indent = facts.styles[parent_cell.style_id]["indent"] if parent_cell and parent_cell.style_id < len(facts.styles) else 0
        child_indent = facts.styles[child_cell.style_id]["indent"] if child_cell and child_cell.style_id < len(facts.styles) else 0
        if child_indent <= parent_indent:
            block(
                "OOXML_HIERARCHY_INDENT_INVALID",
                f"{rule['child_label']} is not indented beneath {rule['parent_label']}.",
                parent_indent=parent_indent,
                child_indent=child_indent,
            )

    for rule in contract.get("schedule_links", []):
        statement_sheet = facts.sheets.get(rule.get("statement_sheet", sheet_name))
        schedule_sheet_name = rule.get("schedule_sheet", sheet_name)
        schedule_sheet = facts.sheets.get(schedule_sheet_name)
        if statement_sheet is None or schedule_sheet is None:
            block("OOXML_LINK_SHEET_MISSING", f"Schedule-link sheet is absent: {rule}.")
            continue
        statement_rows = _rule_rows(statement_sheet, rule, "statement", label_column)
        schedule_rows = _rule_rows(schedule_sheet, rule, "schedule", label_column)
        if len(statement_rows) != 1 or len(schedule_rows) != 1:
            block("OOXML_LINK_LABEL_UNRESOLVED", f"Schedule-link labels do not resolve uniquely: {rule}.")
            continue
        for column in rule.get("columns", forecast_columns):
            statement_cell = _cell(statement_sheet, column, statement_rows[0])
            schedule_cell = _cell(schedule_sheet, column, schedule_rows[0])
            expected = (schedule_sheet_name, f"{column}{schedule_rows[0]}")
            statement_refs = expand_formula_references(
                statement_cell.formula if statement_cell else None,
                statement_sheet.name,
            )
            reverse = (statement_sheet.name, f"{column}{statement_rows[0]}") in expand_formula_references(
                schedule_cell.formula if schedule_cell else None,
                schedule_sheet.name,
            )
            if expected not in statement_refs or reverse:
                block(
                    "OOXML_SCHEDULE_LINK_REVERSED",
                    f"{rule['statement_label']} does not consume {rule['schedule_label']} in {column}.",
                    column=column,
                )

    formula_cells = []
    for candidate_sheet in facts.sheets.values():
        for cell in candidate_sheet.cells.values():
            if cell.data_type == "e" or (isinstance(cell.value, str) and cell.value.startswith("#")):
                block("OOXML_EXCEL_ERROR", f"Excel error at {candidate_sheet.name}!{cell.address}.")
            if not cell.formula:
                continue
            refs = expand_formula_references(cell.formula, candidate_sheet.name)
            formula_cells.append((candidate_sheet.name, cell, refs))
            if len(cell.formula) > int(contract.get("max_formula_characters", 8192)):
                block("OOXML_FORMULA_TOO_LONG", f"Formula at {candidate_sheet.name}!{cell.address} exceeds the length budget.")

    physical_graph = contract.get("physical_formula_graph")
    graph_path_checks = 0
    graph_direct_edges = 0
    if not isinstance(physical_graph, dict):
        block(
            "OOXML_FORMULA_GRAPH_CONTRACT_MISSING",
            "The sealed proof contract contains no physical formula-graph closure.",
        )
    else:
        graph_core = {
            "statement_sheet": physical_graph.get("statement_sheet"),
            "model_ir_sha256": physical_graph.get("model_ir_sha256"),
            "graph_nodes": physical_graph.get("graph_nodes") or [],
            "authorised_dependency_edges": physical_graph.get("authorised_dependency_edges") or [],
            "required_formula_paths": physical_graph.get("required_formula_paths") or [],
        }
        calculated_graph_hash = _canonical_sha256(graph_core)
        if physical_graph.get("schema_version") != 1:
            block(
                "OOXML_FORMULA_GRAPH_SCHEMA_INVALID",
                "The physical formula-graph contract schema is absent or invalid.",
            )
        if physical_graph.get("closure_sha256") != calculated_graph_hash:
            block(
                "OOXML_FORMULA_GRAPH_CLOSURE_HASH_MISMATCH",
                "The physical formula-graph closure hash does not match its canonical content.",
                expected=calculated_graph_hash,
                actual=physical_graph.get("closure_sha256"),
            )
        if not isinstance(model_ir, dict):
            block(
                "OOXML_FORMULA_GRAPH_MODEL_IR_MISSING",
                "The physical formula graph cannot be bound because its sealed model IR is absent.",
            )
        else:
            expected_graph_core = _formula_graph_from_model_ir(model_ir)
            if graph_core != expected_graph_core:
                block(
                    "OOXML_FORMULA_GRAPH_MODEL_IR_MISMATCH",
                    "The physical formula-graph contract is not the exact independent projection of the sealed model IR.",
                )
        graph_sheet_name = physical_graph.get("statement_sheet", sheet_name)
        graph_sheet = facts.sheets.get(graph_sheet_name)
        if graph_sheet is None:
            block(
                "OOXML_FORMULA_GRAPH_SHEET_MISSING",
                f"Formula-graph sheet {graph_sheet_name} is absent.",
            )
        else:
            graph_nodes = physical_graph.get("graph_nodes") or []
            node_by_id = {
                item.get("display_id"): item
                for item in graph_nodes
                if isinstance(item, dict) and item.get("display_id")
            }
            row_to_node = {}
            for identifier, node in node_by_id.items():
                row = node.get("row")
                if not isinstance(row, int) or row <= 0 or row in row_to_node:
                    block(
                        "OOXML_FORMULA_GRAPH_PROJECTION_NOT_UNIQUE",
                        f"Formula-graph node {identifier} has no unique physical row.",
                        row=row,
                    )
                    continue
                row_to_node[row] = identifier
                label_cell = _cell(graph_sheet, label_column, row)
                if (
                    label_cell is None
                    or normalise_label(label_cell.value)
                    != normalise_label(node.get("label"))
                ):
                    block(
                        "OOXML_FORMULA_GRAPH_PROJECTION_MISMATCH",
                        f"Formula-graph node {identifier} does not resolve to its sealed physical row.",
                        row=row,
                        expected_label=node.get("label"),
                        actual_label=label_cell.value if label_cell else None,
                    )

            authorised = {
                (
                    edge.get("consumer_display_id"),
                    edge.get("dependency_display_id"),
                )
                for edge in physical_graph.get("authorised_dependency_edges") or []
            }
            adjacency = {identifier: set() for identifier in node_by_id}
            for consumer, dependency in authorised:
                if consumer not in adjacency or dependency not in adjacency:
                    block(
                        "OOXML_FORMULA_GRAPH_ORPHAN_SEMANTIC_EDGE",
                        "A formula-graph dependency has an unbound endpoint.",
                        consumer_display_id=consumer,
                        dependency_display_id=dependency,
                    )
                    continue
                adjacency[consumer].add(dependency)

            semantic_closure = {}
            for identifier in adjacency:
                reached = set()
                pending = list(adjacency[identifier])
                while pending:
                    candidate = pending.pop()
                    if candidate in reached:
                        continue
                    reached.add(candidate)
                    pending.extend(adjacency.get(candidate, ()))
                semantic_closure[identifier] = reached

            def formula_path_exists(
                start_sheet: str,
                start_cell: str,
                target_sheet: str,
                target_cell: str,
            ) -> bool:
                pending = [(start_sheet, start_cell)]
                visited = set()
                while pending:
                    current_sheet, current_cell = pending.pop()
                    key = (current_sheet, current_cell)
                    if key in visited:
                        continue
                    visited.add(key)
                    candidate_sheet = facts.sheets.get(current_sheet)
                    candidate_cell = (
                        candidate_sheet.cells.get(current_cell)
                        if candidate_sheet is not None
                        else None
                    )
                    references = expand_formula_references(
                        candidate_cell.formula if candidate_cell else None,
                        current_sheet,
                    )
                    if (target_sheet, target_cell) in references:
                        return True
                    pending.extend(references - visited)
                return False

            for requirement in physical_graph.get("required_formula_paths") or []:
                graph_path_checks += 1
                consumer_cell = str(requirement.get("consumer_cell") or "")
                dependency_cell = str(requirement.get("dependency_cell") or "")
                if not formula_path_exists(
                    graph_sheet_name,
                    consumer_cell,
                    graph_sheet_name,
                    dependency_cell,
                ):
                    block(
                        "OOXML_FORMULA_GRAPH_PATH_MISSING",
                        "A required semantic dependency is not reachable through the physical formula graph.",
                        consumer_display_id=requirement.get("consumer_display_id"),
                        dependency_display_id=requirement.get("dependency_display_id"),
                        consumer_cell=consumer_cell,
                        dependency_cell=dependency_cell,
                        period_relation=requirement.get("period_relation"),
                    )

            if graph_path_checks <= 0:
                block(
                    "OOXML_FORMULA_GRAPH_VACUOUS",
                    "The physical formula-graph contract contains no required path checks.",
                )

            # Closure in the opposite direction: a projected forecast formula
            # may consume another projected statement node only when the
            # semantic dependency graph authorises that node transitively.
            for column in forecast_columns:
                for row, owner_id in row_to_node.items():
                    owner_cell = _cell(graph_sheet, column, row)
                    if owner_cell is None or not owner_cell.formula:
                        continue
                    for reference_sheet, reference_cell in expand_formula_references(
                        owner_cell.formula, graph_sheet_name
                    ):
                        if reference_sheet != graph_sheet_name:
                            continue
                        _, reference_row = split_cell(reference_cell)
                        dependency_id = row_to_node.get(reference_row)
                        if dependency_id is None:
                            continue
                        graph_direct_edges += 1
                        if dependency_id == owner_id:
                            continue
                        if dependency_id not in semantic_closure.get(owner_id, set()):
                            block(
                                "OOXML_FORMULA_GRAPH_UNAUTHORISED_EDGE",
                                "A physical statement formula consumes a node outside its semantic dependency closure.",
                                owner_display_id=owner_id,
                                dependency_display_id=dependency_id,
                                owner_cell=owner_cell.address,
                                dependency_cell=reference_cell,
                            )
            if graph_direct_edges <= 0:
                block(
                    "OOXML_FORMULA_GRAPH_CLOSURE_VACUOUS",
                    "No physical statement-to-statement forecast edges were inspected.",
                )

    fixed_point_graph = contract.get("fixed_point_formula_graph")
    fixed_point_scc_checks = 0
    fixed_point_gate_checks = 0
    if not isinstance(fixed_point_graph, dict):
        block(
            "OOXML_FIXED_POINT_CONTRACT_MISSING",
            "The sealed proof contract contains no physical fixed-point projection.",
        )
    else:
        fixed_point_core = {
            key: fixed_point_graph.get(key)
            for key in (
                "schema_version",
                "statement_sheet",
                "forecast_columns",
                "circularity_control_cell",
                "equation_graph_sha256",
                "convergence_contract_sha256",
                "economic_solve_policy_sha256",
                "expected_active_scc_nodes",
                "node_bindings",
                "zero_when_off_bindings",
                "live_when_off_bindings",
            )
        }
        if fixed_point_graph.get("closure_sha256") != _canonical_sha256(
            fixed_point_core
        ):
            block(
                "OOXML_FIXED_POINT_CLOSURE_HASH_MISMATCH",
                "The physical fixed-point projection hash does not match its canonical content.",
            )

        assets = Path(__file__).resolve().parents[2] / "assets"
        try:
            equation_graph = json.loads(
                (assets / "equation-graph.v1.json").read_text(encoding="utf-8")
            )
            convergence_contract = json.loads(
                (assets / "convergence-contract.v1.json").read_text(
                    encoding="utf-8"
                )
            )
            solve_policy = json.loads(
                (assets / "economic-solve-policy.v1.json").read_text(
                    encoding="utf-8"
                )
            )
        except (OSError, json.JSONDecodeError) as error:
            block(
                "OOXML_FIXED_POINT_CANONICAL_ASSET_MISSING",
                f"Canonical fixed-point assets cannot be read: {error}.",
            )
            equation_graph = convergence_contract = solve_policy = None

        if equation_graph and convergence_contract and solve_policy:
            for key, value in (
                ("equation_graph_sha256", equation_graph),
                ("convergence_contract_sha256", convergence_contract),
            ):
                if fixed_point_graph.get(key) != _canonical_sha256(value):
                    block(
                        "OOXML_FIXED_POINT_CANONICAL_BINDING_MISMATCH",
                        f"The fixed-point projection does not bind the canonical {key}.",
                    )
            # The policy contains IEEE-754 values whose JSON rendering differs
            # between Python and JavaScript at 1e-6.  Bind it through the
            # canonical hash already sealed into the convergence contract,
            # then independently compare the workbook semantics below; never
            # claim a false cross-runtime byte hash from Python's float text.
            expected_policy_hash = (
                convergence_contract.get("policy_binding", {}).get(
                    "canonical_sha256"
                )
            )
            if (
                fixed_point_graph.get("economic_solve_policy_sha256")
                != expected_policy_hash
            ):
                block(
                    "OOXML_FIXED_POINT_CANONICAL_BINDING_MISMATCH",
                    "The fixed-point projection does not bind the policy hash sealed by the convergence contract.",
                )
            graph_adjacency = {
                str(node.get("id")): set()
                for node in equation_graph.get("nodes") or []
            }
            for edge in equation_graph.get("edges") or []:
                if edge.get("activation") not in ("always", "circularity_on"):
                    continue
                if edge.get("from") in graph_adjacency:
                    graph_adjacency[edge["from"]].add(str(edge.get("to")))
            derived_graph_sccs = strongly_connected_components(graph_adjacency)
            declared_graph_sccs = _portable_sorted(
                [
                    _portable_sorted(item.get("nodes") or [])
                    for item in (
                        convergence_contract.get("scc_contract", {})
                        .get("active_by_circularity", {})
                        .get("1", [])
                    )
                ],
                key=lambda item: "\x00".join(item),
            )
            if derived_graph_sccs != declared_graph_sccs:
                block(
                    "OOXML_FIXED_POINT_CANONICAL_SCC_MISMATCH",
                    "The canonical equation graph no longer derives its declared convergence SCC.",
                    derived=derived_graph_sccs,
                    declared=declared_graph_sccs,
                )
            canonical_nodes = _portable_sorted(
                [node for component in declared_graph_sccs for node in component]
            )
            if fixed_point_graph.get("expected_active_scc_nodes") != canonical_nodes:
                block(
                    "OOXML_FIXED_POINT_EXPECTATION_MISMATCH",
                    "The physical fixed-point projection does not name the canonical active SCC.",
                )
            zero_roles = _portable_sorted(
                solve_policy.get("circularity_roles", {}).get("zero_when_off", [])
            )
            live_roles = _portable_sorted(
                solve_policy.get("circularity_roles", {}).get("live_when_off", [])
            )
            if _portable_sorted(
                item.get("role")
                for item in fixed_point_graph.get("zero_when_off_bindings") or []
            ) != zero_roles:
                block(
                    "OOXML_FIXED_POINT_ZERO_ROLE_BINDING_MISMATCH",
                    "Physical zero-when-off bindings do not cover the canonical role registry exactly.",
                )
            if _portable_sorted(
                item.get("role")
                for item in fixed_point_graph.get("live_when_off_bindings") or []
            ) != live_roles:
                block(
                    "OOXML_FIXED_POINT_LIVE_ROLE_BINDING_MISMATCH",
                    "Physical live-when-off bindings do not cover the canonical role registry exactly.",
                )

        fixed_sheet_name = fixed_point_graph.get("statement_sheet", sheet_name)
        fixed_sheet = facts.sheets.get(fixed_sheet_name)
        if fixed_sheet is None:
            block(
                "OOXML_FIXED_POINT_SHEET_MISSING",
                f"Fixed-point sheet {fixed_sheet_name} is absent.",
            )
        else:
            formula_addresses = {
                address
                for address, cell in fixed_sheet.cells.items()
                if cell.formula
            }
            physical_adjacency = {address: set() for address in formula_addresses}
            for dependent in formula_addresses:
                cell = fixed_sheet.cells[dependent]
                for reference_sheet, precedent in expand_formula_references(
                    cell.formula, fixed_sheet_name
                ):
                    if (
                        reference_sheet == fixed_sheet_name
                        and precedent in physical_adjacency
                    ):
                        physical_adjacency[precedent].add(dependent)
            physical_sccs = strongly_connected_components(physical_adjacency)
            component_by_cell = {
                address: component
                for component in physical_sccs
                for address in component
            }
            bindings = fixed_point_graph.get("node_bindings") or []
            for column in fixed_point_graph.get("forecast_columns") or []:
                binding_cells = {
                    item.get("node_id"): f"{column}{item.get('row')}"
                    for item in bindings
                    if isinstance(item.get("row"), int)
                }
                missing_formulas = [
                    address
                    for address in binding_cells.values()
                    if address not in formula_addresses
                ]
                if missing_formulas:
                    block(
                        "OOXML_FIXED_POINT_BINDING_FORMULA_MISSING",
                        "A canonical fixed-point node has no emitted formula.",
                        column=column,
                        cells=missing_formulas,
                    )
                    continue
                components = {
                    tuple(component_by_cell.get(address, []))
                    for address in binding_cells.values()
                }
                if len(components) != 1 or not next(iter(components), ()):
                    block(
                        "OOXML_FIXED_POINT_SCC_SPLIT",
                        "Canonical fixed-point bindings do not occupy one physical formula SCC.",
                        column=column,
                    )
                    continue
                component = set(next(iter(components)))
                observed_nodes = _portable_sorted(
                    node_id
                    for node_id, address in binding_cells.items()
                    if address in component
                )
                expected_nodes = fixed_point_graph.get(
                    "expected_active_scc_nodes"
                ) or []
                fixed_point_scc_checks += 1
                if observed_nodes != expected_nodes:
                    block(
                        "OOXML_FIXED_POINT_SCC_NODE_MISMATCH",
                        "The emitted formula SCC does not bind exactly the canonical solver state vector.",
                        column=column,
                        observed=observed_nodes,
                        expected=expected_nodes,
                    )
                same_column_components = [
                    item
                    for item in physical_sccs
                    if any(split_cell(address)[0] == column for address in item)
                ]
                if len(same_column_components) != 1:
                    block(
                        "OOXML_FIXED_POINT_UNRELATED_CYCLE",
                        "The forecast column contains an undeclared formula cycle outside the canonical fixed point.",
                        column=column,
                        component_count=len(same_column_components),
                    )

            control_cell = str(
                fixed_point_graph.get("circularity_control_cell") or ""
            ).replace("$", "")

            def reaches_control(address: str) -> bool:
                pending = [address]
                visited = set()
                while pending:
                    current = pending.pop()
                    if current in visited:
                        continue
                    visited.add(current)
                    cell = fixed_sheet.cells.get(current)
                    for reference_sheet, reference in expand_formula_references(
                        cell.formula if cell else None, fixed_sheet_name
                    ):
                        if reference_sheet != fixed_sheet_name:
                            continue
                        if reference.replace("$", "") == control_cell:
                            return True
                        if reference in formula_addresses:
                            pending.append(reference)
                return False

            direct_zero_gate = re.compile(
                r"^=?IF\(\$?C\$?[0-9]+=0,0,", re.IGNORECASE
            )

            for binding in fixed_point_graph.get("zero_when_off_bindings") or []:
                for row in binding.get("rows") or []:
                    for column in fixed_point_graph.get("forecast_columns") or []:
                        address = f"{column}{row}"
                        cell = fixed_sheet.cells.get(address)
                        compact = re.sub(r"\s+", "", str(cell.formula or ""))
                        structural_zero = compact in ("0", "=0") or (
                            not cell.formula and cell.value in (0, 0.0)
                            if cell is not None
                            else False
                        )
                        fixed_point_gate_checks += 1
                        gate_present = (
                            bool(direct_zero_gate.search(compact))
                            if binding.get("gate_mode") == "direct"
                            else reaches_control(address)
                        )
                        if not structural_zero and not gate_present:
                            block(
                                "OOXML_FIXED_POINT_GATE_MISSING",
                                "A zero-when-off physical role does not reach the circularity control.",
                                role=binding.get("role"),
                                cell=address,
                            )

            direct_gate = re.compile(
                r"^=?IF\(\$?C\$?[0-9]+=0,0,", re.IGNORECASE
            )
            for binding in fixed_point_graph.get("live_when_off_bindings") or []:
                for row in binding.get("rows") or []:
                    for column in fixed_point_graph.get("forecast_columns") or []:
                        address = f"{column}{row}"
                        cell = fixed_sheet.cells.get(address)
                        compact = re.sub(r"\s+", "", str(cell.formula or ""))
                        fixed_point_gate_checks += 1
                        if direct_gate.search(compact):
                            block(
                                "OOXML_FIXED_POINT_LIVE_MECHANIC_GATED",
                                "A live-when-off mechanic is directly zeroed by the circularity control.",
                                role=binding.get("role"),
                                cell=address,
                            )

    broker_evidence = contract.get("broker_evidence")
    if broker_evidence:
        source_sheets = set(broker_evidence.get("source_sheets", []))
        broker_sheet_name = broker_evidence.get("broker_sheet", "Brokers")
        divider_sheet = broker_evidence.get("divider_sheet", "> Brokers")
        missing_sheets = sorted(
            name for name in [divider_sheet, broker_sheet_name, *source_sheets]
            if name
            if name not in facts.sheets
        )
        if missing_sheets:
            block(
                "OOXML_BROKER_EVIDENCE_SHEET_MISSING",
                f"Broker evidence sheets are absent: {missing_sheets}.",
            )
        for source_sheet_name in sorted(source_sheets):
            source_sheet = facts.sheets.get(source_sheet_name)
            if source_sheet is None:
                continue
            source_formulas = [
                cell.address for cell in source_sheet.cells.values() if cell.formula
            ]
            if source_formulas:
                block(
                    "OOXML_BROKER_EVIDENCE_NOT_VALUES_ONLY",
                    f"Broker source sheet {source_sheet_name} contains formulas.",
                    cells=source_formulas[:20],
                )
        if broker_evidence.get("mode") == "page_images":
            expected_media = sorted(
                item["sha256"] for item in broker_evidence.get("page_images", [])
            )
            if expected_media != facts.media_sha256:
                block(
                    "OOXML_BROKER_PAGE_IMAGE_MISMATCH",
                    "Embedded broker page-image bytes do not equal the sealed page-image inventory.",
                    expected=expected_media,
                    actual=facts.media_sha256,
                )
        expected = Counter(
            (item["sheet"], item["address"].replace("$", ""))
            for item in broker_evidence.get("expected_source_references", [])
        )
        observed = Counter()
        for owner_sheet, cell, refs in formula_cells:
            evidence_refs = Counter(
                (ref_sheet, ref_address.replace("$", ""))
                for ref_sheet, ref_address in refs
                if ref_sheet in source_sheets
            )
            if evidence_refs and owner_sheet != broker_sheet_name:
                block(
                    "OOXML_BROKER_EVIDENCE_AUTHORITY_BYPASS",
                    f"{owner_sheet}!{cell.address} references raw broker evidence without passing through Brokers.",
                )
            if owner_sheet == broker_sheet_name:
                observed.update(evidence_refs)
        if expected != observed:
            block(
                "OOXML_BROKER_EVIDENCE_CROSSWALK_MISMATCH",
                "Physical broker-source references do not equal the sealed cell crosswalk.",
                missing=[f"{sheet}!{address}" for (sheet, address), count in (expected - observed).items() for _ in range(count)][:30],
                unexpected=[f"{sheet}!{address}" for (sheet, address), count in (observed - expected).items() for _ in range(count)][:30],
            )
    else:
        unexpected = sorted(
            name for name in facts.sheets
            if name == "> Brokers" or re.fullmatch(r"B\d{2} .+", name)
        )
        if unexpected:
            block(
                "OOXML_UNDECLARED_BROKER_EVIDENCE_SHEET",
                f"Workbook contains undeclared broker evidence sheets: {unexpected}.",
            )

    return {
        "schema_version": 1,
        "kind": "independent_workbook_semantic_oracle",
        "status": "PASS" if not findings else "BLOCK",
        "findings": findings,
        "metrics": {
            "sheets": len(facts.sheets),
            "cells": sum(len(item.cells) for item in facts.sheets.values()),
            "formula_cells": len(formula_cells),
            "formula_graph_required_paths": graph_path_checks,
            "formula_graph_direct_edges": graph_direct_edges,
            "fixed_point_scc_checks": fixed_point_scc_checks,
            "fixed_point_gate_checks": fixed_point_gate_checks,
            "defined_names": len(facts.defined_names),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--xlsx", required=True, type=Path)
    parser.add_argument("--contract", required=True, type=Path)
    parser.add_argument("--model-ir", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    facts = read_workbook(args.xlsx)
    contract = json.loads(args.contract.read_text(encoding="utf-8"))
    model_ir_path = args.model_ir or Path(str(args.xlsx) + ".model-ir-v3.json")
    model_ir = (
        json.loads(model_ir_path.read_text(encoding="utf-8"))
        if model_ir_path.exists()
        else None
    )
    report = verify(facts, contract, model_ir)
    payload = json.dumps(report, indent=2) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(payload, encoding="utf-8")
    sys.stdout.write(json.dumps({"status": report["status"], **report["metrics"]}) + "\n")
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
