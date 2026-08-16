#!/usr/bin/env python3
"""Correct Git-object versus SHA-256 identity validation after stage-two generation."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
carrier_path = ROOT / "scripts" / "lib" / "run_carrier.mjs"
text = carrier_path.read_text("utf-8")
if "const GIT_OBJECT" not in text:
    text = text.replace(
        "const SHA256 = /^[a-f0-9]{64}$/;",
        "const SHA256 = /^[a-f0-9]{64}$/;\nconst GIT_OBJECT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;",
        1,
    )
text = text.replace(
    'if (!SHA256.test(String(identity.source_commit ?? ""))) throw new Error("Non-development carrier source commit is absent or invalid.");',
    'if (!GIT_OBJECT.test(String(identity.source_commit ?? ""))) throw new Error("Non-development carrier source commit is absent or invalid.");',
)
text = text.replace(
    'if (!SHA256.test(String(identity.source_tree ?? ""))) throw new Error("Non-development carrier source tree is absent or invalid.");',
    'if (!GIT_OBJECT.test(String(identity.source_tree ?? ""))) throw new Error("Non-development carrier source tree is absent or invalid.");',
)
text = text.replace(
    'if (identity.source_commit !== null && !SHA256.test(String(identity.source_commit))) throw new Error("Carrier source commit is invalid.");',
    'if (identity.source_commit !== null && !GIT_OBJECT.test(String(identity.source_commit))) throw new Error("Carrier source commit is invalid.");',
)
text = text.replace(
    'if (identity.source_tree !== null && !SHA256.test(String(identity.source_tree))) throw new Error("Carrier source tree is invalid.");',
    'if (identity.source_tree !== null && !GIT_OBJECT.test(String(identity.source_tree))) throw new Error("Carrier source tree is invalid.");',
)
carrier_path.write_text(text, "utf-8")

test_path = ROOT / "scripts" / "run_run_carrier_source_identity_tests.mjs"
if test_path.is_file():
    test = test_path.read_text("utf-8")
    test = test.replace('"a".repeat(40) + "a".repeat(24)', '"a".repeat(40)')
    test = test.replace('"b".repeat(64)', '"b".repeat(40)')
    test = test.replace('"c".repeat(64)', '"c".repeat(40)')
    test_path.write_text(test, "utf-8")
print({"status": "PASS", "carrier": str(carrier_path.relative_to(ROOT))})
