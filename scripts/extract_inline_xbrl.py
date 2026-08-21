#!/usr/bin/env python3
"""Inline XBRL structured-fact extraction — the filings lane's primary source.

SEC (and ESEF) filings embed machine-readable facts inside the HTML via
Inline XBRL: every tagged number carries its concept, context (entity +
period), unit, scale, sign and decimals. Structured data OWNS concepts,
periods, units and restatement basis; the rendered document owns labels and
visible order. This module reads the structured half: it parses one Inline
XBRL HTML document with lxml and emits a deterministic fact table.

Output: {schema_version, source_sha256, fact_count, contexts, units, facts[]}
with each fact {concept, context_ref, unit_ref, value, decimals, scale, sign,
period {instant | start/end}}. Facts are sorted canonically so the artifact
bytes are stable for hash binding.

Reconcile mode (--reconcile): reconciles the structured facts of every
inline-XBRL filing in an extraction request against the visible face-statement
rows of the hash-bound extraction response. A face row is classified to a
statement-semantic-taxonomy role from its own printed label; a fact may
evidence that row only through the declared concept->role crosswalk. Each
reconciled row period records the XBRL concept, context_ref, unit_ref and
decimals in its provenance; a material disagreement between a structured fact
and the printed row value is a typed finding (fail-closed); rows and filings
without XBRL coverage are recorded as unreconciled with a typed reason, never
silently skipped. The reconciler validates and records — it never repairs the
response.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

from lxml import etree

IX_NS = "http://www.xbrl.org/2013/inlineXBRL"
XBRLI_NS = "http://www.xbrl.org/2003/instance"

SCHEMA_VERSION = "inline-xbrl-facts/1.0"
RECONCILIATION_SCHEMA_VERSION = "xbrl-reconciliation/1.0"
CROSSWALK_SCHEMA_VERSION = "xbrl-concept-role-crosswalk/1.0"
INLINE_XBRL_MARKERS = (b"ix:nonfraction", b"xbrl.org/2013/inlinexbrl")
UNIT_SCALE_FACTORS = {
    "units": 1.0,
    "thousands": 1e3,
    "millions": 1e6,
    "billions": 1e9,
}
SECTIONS = ("income_statement", "cash_flow")
MISMATCH_FINDING_CODE = "XBRL_FACT_FACE_ROW_MISMATCH"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def text_of(node) -> str:
    return "".join(node.itertext()).strip()


def iter_tag(root, *names):
    """Iterate elements whose tag matches any prefixed/localname variant.

    lxml's HTML parser flattens namespaces to literal lowercase prefixed tag
    strings ("ix:nonfraction"); the XML parser keeps Clark notation. Accept
    both so real SEC documents parse regardless of well-formedness.
    """
    wanted = set()
    for name in names:
        wanted.add(name.lower())
    for node in root.iter():
        tag = node.tag
        if not isinstance(tag, str):
            continue
        local = tag.rsplit("}", 1)[-1].lower()
        if local in wanted or tag.lower() in wanted:
            yield node


def parse_contexts(root) -> dict[str, dict]:
    contexts: dict[str, dict] = {}
    for context in iter_tag(root, "context", "xbrli:context"):
        context_id = context.get("id")
        if not context_id:
            continue
        record: dict = {"dimensions": {}}
        for node in iter_tag(context, "instant", "xbrli:instant"):
            record["instant"] = (node.text or "").strip()
        for node in iter_tag(context, "startdate", "xbrli:startdate"):
            record["start"] = (node.text or "").strip()
        for node in iter_tag(context, "enddate", "xbrli:enddate"):
            record["end"] = (node.text or "").strip()
        for member in context.iter():
            tag = member.tag if isinstance(member.tag, str) else ""
            local = tag.rsplit("}", 1)[-1].lower()
            if local in {"explicitmember", "xbrldi:explicitmember"} or tag.lower().endswith("explicitmember"):
                dimension = member.get("dimension") or ""
                record["dimensions"][dimension] = (member.text or "").strip()
        contexts[context_id] = record
    return contexts


def parse_units(root) -> dict[str, str]:
    units: dict[str, str] = {}
    for unit in iter_tag(root, "unit", "xbrli:unit"):
        unit_id = unit.get("id")
        if not unit_id:
            continue
        measures = [
            (measure.text or "").strip()
            for measure in iter_tag(unit, "measure", "xbrli:measure")
        ]
        units[unit_id] = "/".join(measures) if measures else ""
    return units


def numeric_value(raw: str, node) -> float | None:
    cleaned = raw.replace(",", "").replace(" ", "").strip()
    if cleaned in {"", "-", "—"}:
        return 0.0
    try:
        value = float(cleaned)
    except ValueError:
        return None
    scale = node.get("scale") or node.get("Scale")
    if scale:
        value *= 10 ** int(scale)
    if node.get("sign") == "-":
        value = -value
    return value


def extract_facts(source: Path) -> dict:
    parser = etree.HTMLParser(huge_tree=True)
    tree = etree.parse(str(source), parser)
    root = tree.getroot()
    contexts = parse_contexts(root)
    units = parse_units(root)
    facts = []
    for node in iter_tag(root, "nonfraction", "ix:nonfraction"):
        concept = node.get("name") or ""
        context_ref = node.get("contextRef") or node.get("contextref") or ""
        raw = text_of(node)
        value = numeric_value(raw, node)
        if value is None or not concept:
            continue
        context = contexts.get(context_ref, {})
        facts.append({
            "concept": concept,
            "context_ref": context_ref,
            "unit_ref": node.get("unitRef") or node.get("unitref") or "",
            "value": value,
            "decimals": node.get("decimals"),
            "scale": node.get("scale"),
            "sign": node.get("sign"),
            "period": {
                key: context[key]
                for key in ("instant", "start", "end")
                if key in context
            },
            "dimensions": context.get("dimensions", {}),
        })
    facts.sort(key=lambda fact: (
        fact["concept"], fact["context_ref"], json.dumps(fact["period"], sort_keys=True), fact["value"],
    ))
    return {
        "schema_version": SCHEMA_VERSION,
        "source_sha256": sha256_file(source),
        "fact_count": len(facts),
        "context_count": len(contexts),
        "unit_count": len(units),
        "units": units,
        "facts": facts,
    }


def normalized_label(label: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(label or "").lower()).strip()


def is_inline_xbrl_bytes(raw: bytes) -> bool:
    lowered = raw.lower()
    return any(marker in lowered for marker in INLINE_XBRL_MARKERS)


def load_role_classifier(taxonomy: dict) -> dict[str, dict[str, str | None]]:
    """Per-section map of normalized printed alias -> taxonomy role id.

    The semantic-role vocabulary is the taxonomy's own — aliases are matched
    exactly after normalization, never fuzzily. An alias declared for two
    roles within the same section is ambiguous and classifies to nothing.
    """
    by_section: dict[str, dict[str, str | None]] = {section: {} for section in SECTIONS}
    for role in taxonomy.get("roles", []):
        for section in role.get("sections", []):
            if section not in by_section:
                continue
            table = by_section[section]
            for alias in role.get("aliases", []):
                key = normalized_label(alias)
                if not key:
                    continue
                if key in table and table[key] != role["id"]:
                    table[key] = None  # ambiguous within the section: refuse
                else:
                    table.setdefault(key, role["id"])
    return by_section


def load_crosswalk_index(crosswalk: dict) -> dict[str, list[dict]]:
    """role id -> [{concept, period_basis}] from the declared crosswalk."""
    if crosswalk.get("schema_version") != CROSSWALK_SCHEMA_VERSION:
        raise ValueError(
            f"crosswalk schema_version must be {CROSSWALK_SCHEMA_VERSION!r}, "
            f"got {crosswalk.get('schema_version')!r}"
        )
    index: dict[str, list[dict]] = {}
    seen_concepts: set[str] = set()
    for entry in crosswalk.get("concepts", []):
        concept = entry["concept"]
        if concept in seen_concepts:
            raise ValueError(f"crosswalk declares concept {concept!r} twice")
        seen_concepts.add(concept)
        basis = entry.get("period_basis")
        if basis not in ("duration", "instant"):
            raise ValueError(f"crosswalk concept {concept!r} has untyped period_basis {basis!r}")
        for role in entry["roles"]:
            index.setdefault(role, []).append({"concept": concept, "period_basis": basis})
    return index


def unit_currency(measure: str) -> str | None:
    """ISO currency of a pure single-measure unit; None for ratios/shares."""
    if not measure or "/" in measure:
        return None
    code = measure.rsplit(":", 1)[-1].strip().upper()
    return code if re.fullmatch(r"[A-Z]{3}", code) else None


def fact_matches_period(fact: dict, basis: str, period_date: str) -> bool:
    period = fact.get("period") or {}
    if basis == "instant":
        return period.get("instant") == period_date
    return period.get("end") == period_date and "instant" not in period


def fact_rounding_tolerance(decimals: str | None) -> float:
    if decimals in (None, "", "INF"):
        return 0.0
    try:
        return 0.5 * (10.0 ** (-int(decimals)))
    except ValueError:
        return 0.0


def provenance_of(fact: dict) -> dict:
    return {
        "concept": fact["concept"],
        "context_ref": fact["context_ref"],
        "unit_ref": fact["unit_ref"],
        "decimals": fact["decimals"],
        "xbrl_value": fact["value"],
    }


def reconcile_row(
    row: dict,
    section: str,
    manifest_units: str | None,
    manifest_currency: str | None,
    periods: list[str],
    role_tables: dict[str, dict[str, str | None]],
    crosswalk_index: dict[str, list[dict]],
    facts: list[dict],
    unit_measures: dict[str, str],
) -> dict:
    record: dict = {
        "source_line_id": row.get("source_line_id"),
        "raw_label": row.get("raw_label"),
        "material": row.get("material") is True,
        "semantic_role": None,
        "status": "unreconciled",
        "periods": [],
    }
    role = role_tables.get(section, {}).get(normalized_label(row.get("raw_label", "")))
    if role is None:
        record["reason"] = "row_label_not_classified"
        return record
    record["semantic_role"] = role
    candidates_spec = crosswalk_index.get(role)
    if not candidates_spec:
        record["reason"] = "concept_not_in_crosswalk"
        return record
    factor = UNIT_SCALE_FACTORS.get(str(manifest_units or ""))
    if factor is None:
        record["reason"] = "declared_units_not_scalable"
        return record

    value_states = row.get("value_states")
    precisions = row.get("value_precisions")
    reconciled_any = False
    mismatch_any = False
    for index, period_date in enumerate(periods):
        printed = (row.get("values") or [None] * len(periods))[index]
        state = value_states[index] if isinstance(value_states, list) and index < len(value_states) else None
        entry: dict = {"period": period_date}
        if printed is None or (state is not None and state not in ("reported_number", "reported_zero")):
            entry["status"] = "not_reported"
            entry["reason"] = "row_value_not_reported"
            record["periods"].append(entry)
            continue
        expected_raw = float(printed) * factor
        precision = precisions[index] if isinstance(precisions, list) and index < len(precisions) else None
        printed_tolerance = 0.5 * (10.0 ** (-int(precision))) * factor if isinstance(precision, int) else 0.5 * factor

        in_period: list[dict] = []
        dimension_qualified_only = False
        wrong_currency_only = False
        for spec in candidates_spec:
            for fact in facts:
                if fact["concept"] != spec["concept"]:
                    continue
                if not fact_matches_period(fact, spec["period_basis"], period_date):
                    continue
                if fact.get("dimensions"):
                    dimension_qualified_only = True
                    continue
                currency = unit_currency(unit_measures.get(fact["unit_ref"], ""))
                if manifest_currency and currency and currency != manifest_currency:
                    wrong_currency_only = True
                    continue
                if currency is None:
                    continue  # per-share/ratio units never evidence a money row
                in_period.append(fact)
        if not in_period:
            entry["status"] = "unreconciled"
            entry["reason"] = (
                "fact_dimension_qualified_only" if dimension_qualified_only
                else "fact_unit_currency_mismatch" if wrong_currency_only
                else "no_matching_fact_for_period"
            )
            record["periods"].append(entry)
            continue

        best = None
        for fact in in_period:
            tolerance = printed_tolerance + fact_rounding_tolerance(fact["decimals"])
            direct = abs(fact["value"] - expected_raw)
            inverted = abs(fact["value"] + expected_raw)
            for alignment, error in (("direct", direct), ("inverted", inverted)):
                if alignment == "inverted" and expected_raw == 0.0:
                    continue
                if best is None or error < best["error"]:
                    best = {"fact": fact, "alignment": alignment, "error": error, "tolerance": tolerance}
        assert best is not None
        entry.update(provenance_of(best["fact"]))
        entry["printed_value"] = printed
        entry["expected_raw_value"] = expected_raw
        entry["tolerance"] = best["tolerance"]
        entry["sign_alignment"] = best["alignment"]
        if best["error"] <= best["tolerance"]:
            entry["status"] = "reconciled"
            reconciled_any = True
        else:
            entry["status"] = "material_mismatch" if record["material"] else "value_mismatch"
            mismatch_any = True
        record["periods"].append(entry)

    if mismatch_any:
        record["status"] = "material_mismatch" if record["material"] else "value_mismatch"
    elif reconciled_any:
        record["status"] = "reconciled"
    else:
        record["status"] = "unreconciled"
        record["reason"] = next(
            (period["reason"] for period in record["periods"] if period.get("reason") and period["reason"] != "row_value_not_reported"),
            "row_value_not_reported",
        )
    return record


def reconcile(args: argparse.Namespace) -> int:
    request_path = Path(args.request).resolve()
    request = json.loads(request_path.read_text("utf-8"))
    response = json.loads(Path(args.response).read_text("utf-8"))
    crosswalk_path = Path(args.crosswalk).resolve()
    crosswalk = json.loads(crosswalk_path.read_text("utf-8"))
    taxonomy = json.loads(Path(args.taxonomy).read_text("utf-8"))
    role_tables = load_role_classifier(taxonomy)
    crosswalk_index = load_crosswalk_index(crosswalk)
    request_documents = {
        document["document_id"]: document for document in request.get("documents", [])
    }
    filing_facts = response.get("filing_facts") or {}
    default_units = filing_facts.get("units")
    default_currency = filing_facts.get("reporting_currency")

    documents: list[dict] = []
    findings: list[dict] = []
    summary = {
        "inline_xbrl_document_count": 0,
        "reconciled_row_count": 0,
        "material_mismatch_row_count": 0,
        "informational_mismatch_row_count": 0,
        "unreconciled_row_count": 0,
        "fact_count_total": 0,
    }
    for document in response.get("documents", []):
        document_id = document.get("document_id")
        manifests = document.get("face_statement_manifests") or {}
        row_count = sum(
            len(manifest.get("rows") or [])
            for section in SECTIONS
            for manifest in (manifests.get(section) or [])
        )
        declaration = request_documents.get(document_id)
        record: dict = {"document_id": document_id, "row_count": row_count}
        if declaration is None:
            record["inline_xbrl"] = False
            record["reason"] = "request_document_missing"
            summary["unreconciled_row_count"] += row_count
            documents.append(record)
            continue
        source = (request_path.parent / str(declaration.get("path") or "")).resolve()
        try:
            raw = source.read_bytes()
        except OSError:
            record["inline_xbrl"] = False
            record["reason"] = "raw_filing_unreadable"
            summary["unreconciled_row_count"] += row_count
            documents.append(record)
            continue
        if not is_inline_xbrl_bytes(raw):
            record["inline_xbrl"] = False
            record["reason"] = "document_not_inline_xbrl"
            summary["unreconciled_row_count"] += row_count
            documents.append(record)
            continue

        fact_table = extract_facts(source)
        record["inline_xbrl"] = True
        record["fact_count"] = fact_table["fact_count"]
        record["fact_source_sha256"] = fact_table["source_sha256"]
        summary["inline_xbrl_document_count"] += 1
        summary["fact_count_total"] += fact_table["fact_count"]
        sections: dict[str, list[dict]] = {}
        for section in SECTIONS:
            rows_out: list[dict] = []
            for manifest in manifests.get(section) or []:
                manifest_units = manifest.get("units") or default_units
                manifest_currency = manifest.get("reporting_currency") or default_currency
                periods = manifest.get("periods") or []
                for row in manifest.get("rows") or []:
                    row_record = reconcile_row(
                        row,
                        section,
                        manifest_units,
                        manifest_currency,
                        periods,
                        role_tables,
                        crosswalk_index,
                        fact_table["facts"],
                        fact_table["units"],
                    )
                    if row_record["status"] == "reconciled":
                        summary["reconciled_row_count"] += 1
                    elif row_record["status"] == "material_mismatch":
                        summary["material_mismatch_row_count"] += 1
                    elif row_record["status"] == "value_mismatch":
                        summary["informational_mismatch_row_count"] += 1
                    else:
                        summary["unreconciled_row_count"] += 1
                    for period in row_record["periods"]:
                        if period["status"] not in ("material_mismatch", "value_mismatch"):
                            continue
                        findings.append({
                            "code": MISMATCH_FINDING_CODE,
                            "severity": "material" if period["status"] == "material_mismatch" else "informational",
                            "document_id": document_id,
                            "statement": section,
                            "source_line_id": row_record["source_line_id"],
                            "raw_label": row_record["raw_label"],
                            "semantic_role": row_record["semantic_role"],
                            "period": period["period"],
                            "concept": period["concept"],
                            "context_ref": period["context_ref"],
                            "unit_ref": period["unit_ref"],
                            "decimals": period["decimals"],
                            "printed_value": period["printed_value"],
                            "expected_raw_value": period["expected_raw_value"],
                            "xbrl_value": period["xbrl_value"],
                            "tolerance": period["tolerance"],
                        })
                    rows_out.append(row_record)
            sections[section] = rows_out
        record["sections"] = sections
        documents.append(record)

    result = {
        "schema_version": RECONCILIATION_SCHEMA_VERSION,
        "run_id": response.get("run_id"),
        "crosswalk_sha256": sha256_file(crosswalk_path),
        "documents": documents,
        "findings": findings,
        "summary": summary,
        "status": "FAIL" if summary["material_mismatch_row_count"] > 0 else "PASS",
    }
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=1, sort_keys=True) + "\n", "utf-8")
    print(json.dumps({
        "status": result["status"],
        "inline_xbrl_document_count": summary["inline_xbrl_document_count"],
        "reconciled_row_count": summary["reconciled_row_count"],
        "material_mismatch_row_count": summary["material_mismatch_row_count"],
        "unreconciled_row_count": summary["unreconciled_row_count"],
        "out": str(out),
    }, sort_keys=True))
    return 0 if result["status"] == "PASS" else 3


def main() -> int:
    if "--reconcile" in sys.argv[1:]:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument("--reconcile", action="store_true", required=True)
        parser.add_argument("--request", required=True, help="filings extraction request JSON")
        parser.add_argument("--response", required=True, help="hash-bound filings extraction response JSON")
        parser.add_argument("--crosswalk", required=True, help="xbrl-concept-role-crosswalk-v1.json")
        parser.add_argument("--taxonomy", required=True, help="statement-semantic-taxonomy.v1.json")
        parser.add_argument("--out", required=True, help="reconciliation artifact output path")
        return reconcile(parser.parse_args())
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="Inline XBRL HTML filing")
    parser.add_argument("--out", required=True, help="Output fact-table JSON path")
    args = parser.parse_args()
    source = Path(args.source).resolve()
    result = extract_facts(source)
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=1, sort_keys=True) + "\n", "utf-8")
    print(json.dumps({
        "status": "PASS" if result["fact_count"] > 0 else "EMPTY",
        "fact_count": result["fact_count"],
        "context_count": result["context_count"],
        "out": str(out),
    }, sort_keys=True))
    return 0 if result["fact_count"] > 0 else 2


if __name__ == "__main__":
    sys.exit(main())
