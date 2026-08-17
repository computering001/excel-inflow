#!/usr/bin/env python3
"""Prove selected broker failures demote one house without inventing values."""

from __future__ import annotations

import copy
import hashlib
import json
import tempfile
from pathlib import Path

from broker_terminal_recovery import canonical_hash, degrade_finding_houses
from compile_broker_candidate_manifest import compile_manifest
from compile_broker_canonical_tables import canonicalise_bundle
import run_broker_pipeline as broker
from run_broker_degraded_close_tests import build_house, invoke, reference_only_crosswalk, write_json
from verify_broker_semantics import verify


with tempfile.TemporaryDirectory(prefix="broker-house-exclusion-") as temporary:
    root = Path(temporary)
    artifact_root = root / "artifacts"
    artifact_root.mkdir()
    documents = [
        build_house(
            document_id=identifier, house_id=identifier, house_name=name,
            artifact_root=artifact_root, vision_required=False,
            clean_rows=[
                ["Metric", "2027E", "2028E"],
                ["EBIT" if identifier == "kepler" else "Alpha series", str(100 + index), str(110 + index)],
            ],
        )
        for index, (identifier, name) in enumerate([
            ("kepler", "Kepler Cheuvreux"), ("jpm", "J.P. Morgan"), ("jefferies", "Jefferies")
        ])
    ]
    bundle = {
        "schema_version": "broker-extraction-bundle/1.0", "run_id": "house_exclusion",
        "documents": documents, "summary": {}, "gate_status": "PASS", "findings": [],
    }
    bundle, _findings = canonicalise_bundle(bundle)
    for document in bundle["documents"]:
        document["tables"] = copy.deepcopy(document["canonical_tables"])
    bundle["candidate_manifest"] = compile_manifest(bundle, source_bundle_sha256="a" * 64)
    crosswalk = reference_only_crosswalk(bundle)

    selected = next(
        candidate for candidate in bundle["candidate_manifest"]["candidates"]
        if candidate["house_id"] == "kepler" and candidate["numeric"]
        and candidate["period_basis"] == "annual_forecast"
    )
    selected_entry = next(
        entry for entry in crosswalk["coverage_ledger"]
        if entry["candidate_id"] == selected["candidate_id"]
    )
    selected_entry.update({
        "economic_domain": "operating", "definition_id": "dict.revenue",
        "concept_id": "revenue", "model_use": "active_input",
        "definition_fingerprint": copy.deepcopy(crosswalk["metrics"]["revenue"]["definition_fingerprint"]),
        "definition_evidence": "The rendered forecast table visibly labels the selected series and its units.",
        "disposition": "mapped_metric", "metric_id": "revenue",
        "mapping_ids": ["m.kepler.revenue.0"],
        "rationale": "Direct selected forecast cell used only to exercise the negative-consumption fallback.",
    })
    selected_entry["definition_fingerprint"]["period_basis"] = selected_entry["period_basis"]
    period_column = next(
        item["column"] for item in selected["period_indexes"]
        if item.get("period_kind") == "annual"
    )
    crosswalk["mappings"] = [{
        "mapping_id": "m.kepler.revenue.0", "house_id": "kepler",
        "metric_id": "revenue", "definition_id": "dict.revenue", "period_index": 0,
        "sources": [{
            "table_id": selected["table_id"], "row": selected["row"],
            "column": period_column, "coefficient": 1,
        }],
        "rationale": "Direct selected forecast cell for fallback testing.",
        "review_status": "reviewed",
    }]
    semantic = {
        "schema_version": "broker-semantic-verification-report/1.0",
        "status": "BLOCKED", "total_violation_count": 1,
        "candidate_manifest_sha256": canonical_hash(bundle["candidate_manifest"]),
        "crosswalk_sha256": canonical_hash(crosswalk),
        "candidate_count": len(bundle["candidate_manifest"]["candidates"]),
        "coverage_entry_count": len(crosswalk["coverage_ledger"]),
        "terminal_quarantined_candidate_count": 0,
        "unresolved_selected_candidate_count": 1,
        "findings": [{
            "code": "SEM-UNRESOLVED-PERIOD-AUTHORITY",
            "candidate_id": selected["candidate_id"],
            "message": "A selected rendered period cell remains unresolved.",
        }],
    }
    bundle_bytes = (json.dumps(bundle, sort_keys=True, separators=(",", ":")) + "\n").encode()
    bundle_sha = hashlib.sha256(bundle_bytes).hexdigest()
    recovered, receipt, _terminal_report = degrade_finding_houses(
        bundle=bundle, crosswalk=crosswalk, semantic_report=semantic,
        bundle_sha256=bundle_sha, source_crosswalk_sha256=canonical_hash(crosswalk),
    )
    assert receipt["status"] == "PASS"
    assert receipt["excluded_house_ids"] == ["kepler"]
    assert receipt["model_consumption_added"] == 0
    assert all(mapping["house_id"] != "kepler" for mapping in recovered["mappings"])
    assert all(entry["house_id"] != "kepler" for entry in recovered["coverage_ledger"])
    assert {
        entry["house_id"] for entry in recovered["terminal_recovery"]["quarantined_candidates"]
    } == {"kepler"}
    report = verify(bundle, recovered, bundle_sha256=bundle_sha)
    assert report["status"] == "PASS" and report["total_violation_count"] == 0, report["findings"][:3]

    global_finding = {**semantic, "findings": [{"code": "SEM-SOURCE-HASH", "message": "global"}]}
    try:
        degrade_finding_houses(
            bundle=bundle, crosswalk=crosswalk, semantic_report=global_finding,
            bundle_sha256=bundle_sha, source_crosswalk_sha256=canonical_hash(crosswalk),
        )
    except ValueError as error:
        assert "every semantic finding" in str(error)
    else:
        raise AssertionError("global source finding was incorrectly localised")

    survivor_before = {
        item["candidate_id"]: item for item in crosswalk["coverage_ledger"]
        if item["house_id"] != "kepler"
    }
    survivor_after = {item["candidate_id"]: item for item in recovered["coverage_ledger"]}
    assert survivor_after == survivor_before

    # Real controller transition: start from a sealed clean extraction, submit
    # a crosswalk whose selected Kepler mapping contradicts the immutable row
    # label, and prove the controller excludes Kepler, re-verifies, compiles a
    # zero-consumption pack and reaches a closed degraded status by itself.
    source_dir = root / "sources"
    source_dir.mkdir()
    request_documents = []
    for document in documents:
        source = source_dir / f"{document['document_id']}.pdf"
        source.write_bytes(b"%PDF-house-exclusion " + document["document_id"].encode())
        document["raw_sha256"] = broker.sha256_file(source)
        document["byte_length"] = source.stat().st_size
        request_documents.append({
            "document_id": document["document_id"], "house_id": document["house_id"],
            "house_name": document["house_name"], "source_id": document["source_id"],
            "path": str(source), "media_type": "application/pdf",
            "published_date": "2026-06-30", "expected_sha256": broker.sha256_file(source),
        })
    request = {
        "schema_version": "broker-extraction-request/1.0",
        "run_id": "house_exclusion_controller", "documents": request_documents,
    }
    request_path = root / "request.json"
    write_json(request_path, request)
    controller_root = root / "controller"
    controller_root.mkdir()
    request_digest = broker.sha256_file(request_path)
    runtime_digest, _ = broker.runtime_closure()
    sources = broker.source_hashes(request, request_path.parent)
    cache_key = broker.sha256_bytes(broker.canonical_bytes({
        "request": request_digest, "sources": sources, "runtime": runtime_digest,
    }))
    key = cache_key[:16]
    seeded = {
        "schema_version": "broker-extraction-bundle/1.0", "run_id": request["run_id"],
        "created_at": "2026-08-13T00:00:00Z", "extractor_version": "fixture/1.0",
        "artifact_root": str(artifact_root), "documents": documents,
        "summary": {
            "document_count": 3, "surface_count": 3, "table_count": 3,
            "cell_count": 18, "numeric_token_count": 6,
            "native_numeric_recall": 1.0, "unresolved_surface_count": 0,
            "duplicate_cell_count": 0, "material_uncovered_region_count": 0,
        },
        "gate_status": "PASS", "findings": [],
    }
    seeded_path = controller_root / f"extract-{key}" / "broker-extraction-bundle.json"
    write_json(seeded_path, seeded)
    extract_input = broker.sha256_bytes(broker.canonical_bytes({
        "request": request_digest, "sources": sources, "runtime": runtime_digest,
    }))
    broker.seal_checkpoint(seeded_path, controller_root / f"extract-{key}.receipt.json", extract_input)
    responses = root / "responses"
    responses.mkdir()
    state = invoke(request_path, controller_root, responses, None)
    assert state["pipeline_status"] == "NEEDS_CROSSWALK", state
    controller_bundle_path = Path(
        state["artifacts"].get("verified_bundle")
        or state["artifacts"]["canonical_bundle"]
    )
    controller_bundle = json.loads(controller_bundle_path.read_text("utf-8"))
    hostile = reference_only_crosswalk(controller_bundle)
    controller_selected = next(
        candidate for candidate in controller_bundle["candidate_manifest"]["candidates"]
        if candidate["house_id"] == "kepler" and candidate["numeric"]
        and candidate["period_basis"] == "annual_forecast"
    )
    controller_entry = next(
        entry for entry in hostile["coverage_ledger"]
        if entry["candidate_id"] == controller_selected["candidate_id"]
    )
    controller_entry.update({
        "economic_domain": "operating", "definition_id": "dict.revenue",
        "concept_id": "revenue", "model_use": "active_input",
        "definition_fingerprint": copy.deepcopy(hostile["metrics"]["revenue"]["definition_fingerprint"]),
        "definition_evidence": "Deliberately contradictory selected mapping for controller fallback proof.",
        "disposition": "mapped_metric", "metric_id": "revenue",
        "mapping_ids": ["m.controller.kepler.revenue"],
        "rationale": "Exercise the independent selected-house fallback path.",
    })
    controller_entry["definition_fingerprint"]["period_basis"] = controller_entry["period_basis"]
    selected_column = next(
        item["column"] for item in controller_selected["period_indexes"]
        if item.get("period_kind") == "annual"
    )
    hostile["mappings"] = [{
        "mapping_id": "m.controller.kepler.revenue", "house_id": "kepler",
        "metric_id": "revenue", "definition_id": "dict.revenue", "period_index": 0,
        "sources": [{
            "table_id": controller_selected["table_id"], "row": controller_selected["row"],
            "column": selected_column, "coefficient": 1,
        }],
        "rationale": "Deliberately contradictory mapping for controller fallback proof.",
        "review_status": "reviewed",
    }]
    hostile_path = root / "controller-crosswalk.json"
    write_json(hostile_path, hostile)
    final_state = invoke(request_path, controller_root, responses, hostile_path)
    assert final_state["pipeline_status"] == "PASS_DEGRADED", final_state
    assert final_state["user_blocking"] is False
    exclusion = json.loads(Path(final_state["artifacts"]["house_exclusion_receipt"]).read_text("utf-8"))
    assert exclusion["excluded_house_ids"] == ["kepler"]
    assert Path(final_state["artifacts"]["broker_pack"]).is_file()
    # The production ingress must recognize this new degraded closure, not
    # require the older physical_degraded_close checkpoint.
    source_tables_json = json.loads(Path(final_state["artifacts"]["source_tables"]).read_text("utf-8"))
    pack_json = json.loads(Path(final_state["artifacts"]["broker_pack"]).read_text("utf-8"))
    pack_house_by_id = {item["house_id"]: item for item in pack_json.get("houses", [])}
    source_inventory = []
    attachments = {}
    for house in source_tables_json.get("houses", []):
        pack_house = pack_house_by_id.get(house.get("house_id"), {})
        source_inventory.append({
            "source_id": house.get("source_id"), "kind": "user_broker_research",
            "status": "used", "text_extractable": (pack_house.get("document") or {}).get("text_extractable"),
        })
        attachments[house.get("source_id")] = {
            "raw_sha256": house.get("content_sha256"), "file_name": house.get("file_name"),
        }
    ingress_driver = root / "ingress-driver.mjs"
    ingress_driver.write_text(
        'import { compileBrokerEvidence } from '
        + json.dumps((Path(__file__).resolve().parent / "lib" / "attachment_ingress.mjs").as_uri())
        + ';\nimport fs from "node:fs/promises";\n'
        'const c=JSON.parse(await fs.readFile(process.argv[2],"utf8"));\n'
        'const evidence={broker_pack:JSON.parse(await fs.readFile(c.broker_pack,"utf8")),source_inventory:c.inventory,case_evidence:{lanes:{}}};\n'
        'try { await compileBrokerEvidence({declaration:c.declaration,specDir:c.spec_dir,evidence,sourceAttachment:new Map(Object.entries(c.attachments))}); console.log(JSON.stringify({ok:true,status:evidence.case_evidence.lanes.broker_evidence.controller_state.pipeline_status})); }'
        ' catch(error) { console.log(JSON.stringify({ok:false,message:String(error.message)})); process.exitCode=1; }\n',
        "utf-8",
    )
    ingress_config = root / "ingress-config.json"
    write_json(ingress_config, {
        "broker_pack": final_state["artifacts"]["broker_pack"],
        "inventory": source_inventory, "attachments": attachments, "spec_dir": str(root),
        "declaration": {
            "run_state_path": str(controller_root / "broker-run-state.json"),
            "extraction_bundle_path": final_state["artifacts"]["verified_bundle"],
            "source_tables_path": final_state["artifacts"]["source_tables"],
            "crosswalk_path": final_state["artifacts"]["crosswalk"],
            "crosswalk_receipt_path": final_state["artifacts"]["broker_crosswalk_receipt"],
            "semantic_verification_path": final_state["artifacts"]["semantic_report"],
        },
    })
    ingress_run = __import__("subprocess").run(
        ["node", str(ingress_driver), str(ingress_config)], cwd=Path(__file__).resolve().parent,
        text=True, capture_output=True, check=False,
    )
    ingress = json.loads(ingress_run.stdout)
    assert ingress_run.returncode == 0 and ingress == {"ok": True, "status": "PASS_DEGRADED"}, ingress

    # A caller cannot strip the degraded-close ownership receipt while keeping
    # the otherwise valid pack/crosswalk/semantic closure.
    stripped_state = copy.deepcopy(final_state)
    stripped_state["artifacts"].pop("house_exclusion_receipt", None)
    stripped_state["artifact_sha256"].pop("house_exclusion_receipt", None)
    stripped_state_path = root / "broker-run-state-without-exclusion-receipt.json"
    write_json(stripped_state_path, stripped_state)
    stripped_config = json.loads(ingress_config.read_text("utf-8"))
    stripped_config["declaration"]["run_state_path"] = str(stripped_state_path)
    stripped_config_path = root / "ingress-config-without-exclusion-receipt.json"
    write_json(stripped_config_path, stripped_config)
    stripped_run = __import__("subprocess").run(
        ["node", str(ingress_driver), str(stripped_config_path)], cwd=Path(__file__).resolve().parent,
        text=True, capture_output=True, check=False,
    )
    stripped_result = json.loads(stripped_run.stdout)
    assert stripped_run.returncode != 0
    assert "missing its exclusion receipt" in stripped_result["message"], stripped_result

    print(json.dumps({
        "status": "PASS", "positive_checks": 14, "mutations_caught": 3,
        "excluded_house": "kepler", "remaining_mapping_count": len(recovered["mappings"]),
        "terminal_candidate_count": len(recovered["terminal_recovery"]["quarantined_candidates"]),
        "controller_status": final_state["pipeline_status"],
    }, sort_keys=True))
