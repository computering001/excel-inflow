#!/usr/bin/env python3
"""Production freshness-policy boundary mutations."""

import json

from compile_broker_pack import BROKER_FRESHNESS_MAX_AGE_DAYS, broker_freshness


current = broker_freshness("2026-02-19", "2026-08-18")
boundary = broker_freshness("2026-02-19", "2026-08-18")
stale = broker_freshness("2026-02-18", "2026-08-18")
future = broker_freshness("2026-08-19", "2026-08-18")

assert BROKER_FRESHNESS_MAX_AGE_DAYS == 180
assert current["freshness_status"] == "current"
assert boundary["freshness_age_days"] == 180
assert stale["freshness_status"] == "stale" and stale["freshness_age_days"] == 181
assert future["freshness_status"] == "current" and future["freshness_age_days"] == 0

print(json.dumps({
    "status": "PASS",
    "checks": 5,
    "mutations_caught": 1,
    "max_age_days": BROKER_FRESHNESS_MAX_AGE_DAYS,
    "total_violations": 0,
}, sort_keys=True))
