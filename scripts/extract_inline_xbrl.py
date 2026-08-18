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
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

from lxml import etree

IX_NS = "http://www.xbrl.org/2013/inlineXBRL"
XBRLI_NS = "http://www.xbrl.org/2003/instance"

SCHEMA_VERSION = "inline-xbrl-facts/1.0"


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


def main() -> int:
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
