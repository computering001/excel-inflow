#!/usr/bin/env python3
"""Non-vacuity, route-forcing and drift tests for the B3/B4 rehearsal."""
from __future__ import annotations

import copy
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "scripts/run_filings_ladder_corpus_rehearsal.py"
SPEC = importlib.util.spec_from_file_location("filings_ladder_rehearsal", RUNNER)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load rehearsal writer")
lane = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(lane)

checks = 0
caught: list[str] = []


def check(condition: bool, message: str) -> None:
    global checks
    if not condition:
        raise AssertionError(message)
    checks += 1


def reseal(evidence: dict) -> dict:
    evidence.pop("record_sha256", None)
    evidence["record_sha256"] = lane.sha256_bytes(lane.canonical_bytes(evidence))
    return evidence


def expect_evidence_refusal(identifier: str, evidence: dict, manifest: dict, *, check_sources: bool = True) -> None:
    try:
        lane.validate_evidence(reseal(evidence), manifest, ROOT, check_sources=check_sources)
    except AssertionError:
        caught.append(identifier)
        return
    raise AssertionError(f"mutation survived: {identifier}")


def expect_manifest_refusal(identifier: str, manifest: dict) -> None:
    try:
        lane.validate_manifest(manifest, ROOT)
    except AssertionError:
        caught.append(identifier)
        return
    raise AssertionError(f"manifest mutation survived: {identifier}")


def main() -> int:
    manifest = lane.load_json(lane.DEFAULT_MANIFEST)
    committed = lane.load_json(lane.DEFAULT_EVIDENCE)
    lane.validate_evidence(committed, manifest, ROOT)
    lane.validate_documents(committed, ROOT)
    check(committed["status"] == "PASS", "committed evidence is not PASS")
    check(len(committed["documents"]) == 8, "committed evidence is not 8 documents")
    check(committed["summary"]["route_counts"] == {route: 2 for route in lane.ROUTE_ORDER}, "committed evidence does not force every route twice")

    with tempfile.TemporaryDirectory(prefix="filings-ladder-rehearsal-tests-") as temp_text:
        temp = Path(temp_text)
        transient_path = temp / "transient.json"
        completed = subprocess.run(
            [sys.executable, str(RUNNER), "--rehearse", "--out", str(transient_path)],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=300,
        )
        check(completed.returncode == 0, f"live eight-document rehearsal failed: {completed.stdout} {completed.stderr}")
        transient = lane.load_json(transient_path)
        lane.validate_evidence(transient, manifest, ROOT)
        check(transient["summary"]["route_obligations_satisfied"] == 8, "live rehearsal did not satisfy 8/8 route obligations")
        check(len({row["materialized_sha256"] for row in transient["documents"]}) == 8, "materialized corpus is duplicate/vacuous")
        check(all(row["duration_ms"] > 0 for row in transient["documents"]), "live rehearsal omitted measured timing")

        mutated = copy.deepcopy(committed)
        mutated["documents"][0]["duration_ms"] = 0
        expect_evidence_refusal("zero-duration", mutated, manifest)

        mutated = copy.deepcopy(committed)
        mutated["documents"].pop()
        expect_evidence_refusal("seven-of-eight", mutated, manifest)

        mutated = copy.deepcopy(committed)
        mutated["documents"][0]["observed_route"] = "pdf_geometry"
        expect_evidence_refusal("route-substitution", mutated, manifest)

        mutated = copy.deepcopy(committed)
        mutated["documents"][0]["route_result"] = "OCR_UNAVAILABLE_TYPED_REFUSAL"
        expect_evidence_refusal("typed-refusal-outside-ocr", mutated, manifest)

        mutated = copy.deepcopy(committed)
        mutated["documents"][6]["route_force_proof"]["pdf_classification"] = "text"
        expect_evidence_refusal("ocr-route-not-image-only", mutated, manifest)

        mutated = copy.deepcopy(committed)
        mutated["documents"][1]["materialized_sha256"] = mutated["documents"][0]["materialized_sha256"]
        expect_evidence_refusal("duplicate-materialized-document", mutated, manifest)

        mutated = copy.deepcopy(committed)
        mutated["summary"]["route_counts"]["inline_xbrl"] = 1
        expect_evidence_refusal("route-count-understatement", mutated, manifest)

        mutated = copy.deepcopy(committed)
        mutated["route_claims"]["production_ladder_phrase_permitted"] = True
        expect_evidence_refusal("premature-production-phrase-permission", mutated, manifest)

        mutated = copy.deepcopy(committed)
        mutated["route_claims"]["routes"][-1]["claim_status"] = "PACKAGED_ROUTE_PROVED"
        expect_evidence_refusal("unwired-ocr-package-claim", mutated, manifest)

        mutated = copy.deepcopy(committed)
        first_binding = next(iter(mutated["source_bindings"]))
        mutated["source_bindings"][first_binding] = "0" * 64
        expect_evidence_refusal("source-binding-drift", mutated, manifest)

        short_manifest = copy.deepcopy(manifest)
        short_manifest["documents"].pop()
        expect_manifest_refusal("manifest-seven-documents", short_manifest)

        skewed_manifest = copy.deepcopy(manifest)
        skewed_manifest["documents"][-1]["route_id"] = "inline_xbrl"
        expect_manifest_refusal("manifest-route-not-forced-twice", skewed_manifest)

        docs_root = temp / "docs"
        docs_root.mkdir()
        for name in ("README.md", "RELEASE_NOTES.md", "KNOWN_LIMITATIONS.md"):
            shutil.copyfile(ROOT / name, docs_root / name)
        (docs_root / "README.md").write_text((docs_root / "README.md").read_text("utf-8") + "\nproduction ladder\n", "utf-8")
        try:
            lane.validate_documents(committed, docs_root)
        except AssertionError:
            caught.append("forbidden-production-ladder-phrase")
        else:
            raise AssertionError("forbidden production-ladder phrase survived")

        docs_root_two = temp / "docs-two"
        docs_root_two.mkdir()
        for name in ("README.md", "RELEASE_NOTES.md", "KNOWN_LIMITATIONS.md"):
            shutil.copyfile(ROOT / name, docs_root_two / name)
        readme = docs_root_two / "README.md"
        readme.write_text(readme.read_text("utf-8").replace("route obligations satisfied", "route obligations asserted", 1), "utf-8")
        try:
            lane.validate_documents(committed, docs_root_two)
        except AssertionError:
            caught.append("generated-doc-hand-edit")
        else:
            raise AssertionError("generated document hand edit survived")

    expected = {
        "zero-duration",
        "seven-of-eight",
        "route-substitution",
        "typed-refusal-outside-ocr",
        "ocr-route-not-image-only",
        "duplicate-materialized-document",
        "route-count-understatement",
        "premature-production-phrase-permission",
        "unwired-ocr-package-claim",
        "source-binding-drift",
        "manifest-seven-documents",
        "manifest-route-not-forced-twice",
        "forbidden-production-ladder-phrase",
        "generated-doc-hand-edit",
    }
    check(set(caught) == expected, f"mutation coverage drifted: {caught}")
    print(json.dumps({
        "status": "PASS",
        "checks": checks,
        "documents_rehearsed": 8,
        "routes_forced": list(lane.ROUTE_ORDER),
        "mutations_caught": len(caught),
        "mutation_ids": sorted(caught),
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
