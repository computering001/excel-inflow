#!/usr/bin/env python3
"""Provider-neutral broker table engine seam tests."""

from __future__ import annotations

import copy
import json

from broker_table_engine import normalize, probe


capabilities = probe()
assert capabilities["status"] == "PASS"
assert capabilities["providers"]["rogo_vision"]["available"] is True
assert capabilities["optional_provider_absence_is_blocking"] is False

source = {
    "schema_version": "broker-table-engine-result/1.0",
    "provider": "rogo_vision", "document_id": "doc", "surface_id": "doc.p4",
    "image_sha256": "a" * 64, "execution_fingerprint": "read-one",
    "tables": [{"title": "Forecasts", "units": "USDm", "bbox": [1, 2, 3, 4], "rows": [["Metric", "2027E"], ["Revenue", "100"]]}],
    "footnotes": [],
}
normalized = normalize(source, pass_index=1)
assert normalized["schema_version"] == "broker-vision-result/1.1"
assert normalized["surface_disposition"] == "analytical_tables"
assert normalized["tables"][0]["rows"][1][1] == "100"

for provider in ("surya_layout", "docling"):
    variant = copy.deepcopy(source)
    variant["provider"] = provider
    variant["execution_fingerprint"] = provider + "-run"
    assert normalize(variant, pass_index=2)["method"] == "ocr_geometry"

bad = copy.deepcopy(source)
bad["invented_model_value"] = 999
try:
    normalize(bad, pass_index=1)
except ValueError as error:
    assert "undeclared" in str(error)
else:
    raise AssertionError("undeclared provider output was accepted")

print(json.dumps({"status": "PASS", "positive_checks": 7, "mutations_caught": 1}, sort_keys=True))
