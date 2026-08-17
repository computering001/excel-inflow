#!/usr/bin/env python3
from extract_filing_statements import infer_source_arithmetic_links

def row(identifier, label, values, level):
    return {"source_line_id": identifier, "raw_label": label, "values": values, "hierarchy_level": level, "is_subtotal": False}

def assert_family(label):
    rows = [
        row("is.product_sales", "Product Sales", [100, 120, 140], 1),
        row("is.alliance_revenue", "Alliance Revenue", [10, 12, 14], 1),
        row("is.parent", label, [110, 132, 154], 0),
    ]
    infer_source_arithmetic_links(rows)
    assert rows[0]["parent_source_line_id"] == "is.parent"
    assert rows[1]["parent_source_line_id"] == "is.parent"
    assert rows[2]["is_subtotal"] is True

assert_family("Product Revenue")
assert_family("Whatever the issuer calls this aggregate")
parent_first = [
    row("is.parent", "Operating family", [110, 132, 154], 0),
    row("is.a", "A", [100, 120, 140], 1), row("is.b", "B", [10, 12, 14], 1),
]
infer_source_arithmetic_links(parent_first)
assert all(item.get("parent_source_line_id") == "is.parent" for item in parent_first[1:])
mutated = [
    row("is.a", "A", [100, 120, 140], 1), row("is.b", "B", [10, 12, 14], 1),
    row("is.parent", "Aggregate", [111, 132, 154], 0),
]
infer_source_arithmetic_links(mutated)
assert not any(item.get("parent_source_line_id") for item in mutated)
neutral_separator = [
    row("cf.pbt", "Profit before taxation", [150, 150, 150], 1),
    row("cf.da", "Depreciation and amortisation", [50, 50, 50], 1),
    row("cf.neutral", "Net finance result", [0, 0, 0], 0),
    row("cf.addback", "Net finance costs add-back", [-5, -5, -5], 1),
    row("cf.wc", "Change in working capital", [0, 0, 0], 1),
    row("cf.cfo", "Cash generated from operations", [195, 195, 195], 0),
]
infer_source_arithmetic_links(neutral_separator)
assert neutral_separator[0]["parent_source_line_id"] == "cf.cfo"
assert neutral_separator[1]["parent_source_line_id"] == "cf.cfo"
assert neutral_separator[3]["parent_source_line_id"] == "cf.cfo"
assert neutral_separator[2].get("parent_source_line_id") is None
print('{"status":"PASS","checks":5}')
