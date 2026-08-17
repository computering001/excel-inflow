#!/usr/bin/env python3

import json
import time

from extract_broker_evidence import (
    PDF_LANE_MAX_SECONDS,
    PDF_LANE_MIN_SECONDS,
    bounded_table_find,
    pdf_document_table_budget,
    pdf_lane_timeout_budget,
)


class Finder:
    tables = []


class Page:
    def __init__(self, delay: float):
        self.delay = delay

    def find_tables(self, **_kwargs):
        time.sleep(self.delay)
        return Finder()


checks = 0
small = pdf_lane_timeout_budget(page_count=1, word_count=20, target_count=1, lane_id="lines")
dense = pdf_lane_timeout_budget(page_count=80, word_count=2500, target_count=12, lane_id="text")
assert small >= PDF_LANE_MIN_SECONDS and small > 0.5
assert dense > small and dense <= PDF_LANE_MAX_SECONDS
assert pdf_document_table_budget(page_count=1, target_count=1) >= 30
assert pdf_document_table_budget(page_count=100, target_count=20) > pdf_document_table_budget(page_count=1, target_count=1)
checks += 4

# A valid native read that exceeded the retired 0.5-second fixed alarm still
# receives the policy minimum and completes.
started = time.monotonic()
bounded_table_find(Page(0.55), {}, small)
assert time.monotonic() - started >= 0.5
checks += 1

# The supervisor remains real and finite: an injected pathological lane is
# interrupted at its supplied test budget rather than hanging the controller.
try:
    bounded_table_find(Page(0.2), {}, 0.02)
    raise AssertionError("Pathological native PDF lane was not interrupted")
except TimeoutError as error:
    assert "evidence-sized budget" in str(error)
checks += 1

print(json.dumps({"status": "PASS", "checks": checks, "mutations_rejected": 1}))
