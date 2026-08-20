"""Metric-class tolerance policy, read from the production contract.

THE DEFECT THIS FIXES
---------------------
The pre-fix validate_dynamic_model.mjs set one number:

    const tolerance = Number(options.tolerance ?? 0.05);          // line ~388

and applied it by plain absolute comparison to everything -- currency amounts in
millions, RCF capacities, and `net_leverage`.  0.05 absolute on a 3.0x leverage
is 1.7% of the model's headline metric, recorded as agreement.  The same 0.05 on
a EUR 26,971m debt balance is 1.9e-6 relative -- loose in the other direction.
One scalar cannot serve money and multiples.

CONTRACT SOURCE (RECONCILED)
----------------------------
assets/production-contract-v2.json now carries a `tolerances` block, added by
the concurrently-running Phase 0 agent.  THIS MODULE READS THAT BLOCK AND USES
ITS SHAPE VERBATIM:

    tolerances.unit_scale              {units: 1, thousands: 0.001, millions: 1e-06}
    tolerances.metric_classes.currency {relative, absolute_floor_currency_units}
    tolerances.metric_classes.ratio    {absolute}
    tolerances.metric_classes.rate     {absolute}
    tolerances.checks                  per-check class names
    tolerances.cli_override            --tolerance must be recorded on the report

`LOCAL_TOLERANCES` below mirrors that shape exactly and is used only if the
block is missing (as it was when this port was first written).  It is no longer
the authority; the contract is.  This module never writes to the contract.

The currency floor is stated in reporting-currency units -- one euro, one dollar
-- and multiplied by `unit_scale[issuer.units]` to reach model units, so a model
in millions and a model in units are held to the same economic precision.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional

# Mirror of the contract block, used only when the contract has none.
LOCAL_TOLERANCES: Dict[str, Any] = {
    "unit_scale": {"units": 1, "thousands": 0.001, "millions": 1e-06},
    "metric_classes": {
        "currency": {"relative": 1e-06, "absolute_floor_currency_units": 1},
        "ratio": {"absolute": 1e-04},
        "rate": {"absolute": 1e-06},
    },
}

CONTRACT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "assets",
    "production-contract-v2.json",
)


def numeric(value) -> float:
    """Port of the Node `numeric()` helper, including its JS coercions.

    legacy workbook library hands back a Date object for a handful of date-formatted
    cells and the Node helper converts it to an Excel serial; this reader
    returns the serial directly, so that branch is unnecessary.  Verified
    cell-for-cell against legacy workbook library over every certification workbook: the
    only value-shape differences were date-formatted zeros, which both paths
    reduce to 0.
    """
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        result = float(value)
    else:
        try:
            result = float(str(value).strip() or 0)
        except (TypeError, ValueError):
            return 0.0
    if result != result or result in (float("inf"), float("-inf")):
        return 0.0
    return result


class TolerancePolicy:
    """Resolves an allowed absolute difference for a (metric class, magnitude)."""

    def __init__(self, config: Dict[str, Any], units: Optional[str], source: str):
        self.config = config
        self.units = str(units or "units").lower()
        self.source = source
        scale = config.get("unit_scale") or {}
        self.unit_scale = float(scale.get(self.units, 1.0))
        self.override = None

    @classmethod
    def load(cls, units: Optional[str]) -> "TolerancePolicy":
        block = cls._from_contract()
        if block is not None:
            return cls(block, units, "assets/production-contract-v2.json#/tolerances")
        return cls(
            LOCAL_TOLERANCES,
            units,
            "verify/tolerances.py LOCAL fallback -- contract block absent",
        )

    @staticmethod
    def _from_contract() -> Optional[Dict[str, Any]]:
        try:
            with open(CONTRACT_PATH, "r", encoding="utf-8") as handle:
                contract = json.load(handle)
        except (OSError, ValueError):
            return None
        block = contract.get("tolerances")
        if not isinstance(block, dict) or not block.get("metric_classes"):
            return None
        return block

    def class_for(self, check_id: str, metric_class: str) -> str:
        """Honour the contract's per-check class mapping where it names one."""
        mapping = (self.config.get("checks") or {}).get(check_id)
        if isinstance(mapping, dict) and metric_class in mapping:
            return mapping[metric_class]
        return metric_class

    def allowance(self, metric_class: str, *values) -> float:
        rule = (self.config.get("metric_classes") or {}).get(metric_class)
        if rule is None:
            rule = self.config["metric_classes"]["currency"]
        if "absolute" in rule:
            return float(rule["absolute"])
        magnitude = max([abs(numeric(item)) for item in values] or [0.0])
        floor = float(rule.get("absolute_floor_currency_units", 0.0)) * self.unit_scale
        return max(float(rule.get("relative", 0.0)) * magnitude, floor)

    def equal(self, left, right, metric_class: str) -> bool:
        return abs(numeric(left) - numeric(right)) <= self.allowance(
            metric_class, left, right
        )

    def exceeds(self, value, metric_class: str) -> bool:
        """One-sided threshold test (the Node source's `draw > tolerance`)."""
        return numeric(value) > self.allowance(metric_class, value)

    def describe(self) -> Dict[str, Any]:
        return {
            "source": self.source,
            "issuer_units": self.units,
            "unit_scale": self.unit_scale,
            "metric_classes": self.config.get("metric_classes"),
            "tolerance_override": self.override,
        }


class LegacyTolerancePolicy(TolerancePolicy):
    """The pre-fix behaviour: one absolute scalar for every metric class.

    Kept ONLY so `--tolerance-mode legacy` can demonstrate check-for-check
    agreement with the incumbent Node validator.  Never certify with it: the
    contract's `cli_override` rule requires any loosened tolerance to appear on
    the face of the report, which `describe()` below does.
    """

    def __init__(self, scalar: float = 0.05):
        super().__init__(LOCAL_TOLERANCES, "units", "legacy scalar (Node parity mode)")
        self.scalar = float(scalar)
        self.override = self.scalar

    def allowance(self, metric_class: str, *values) -> float:
        return self.scalar

    def describe(self) -> Dict[str, Any]:
        return {
            "source": self.source,
            "tolerance_override": self.scalar,
            "warning": (
                "NOT THE CONTRACT POLICY: a single absolute tolerance is applied to "
                "ratios and currency alike. Diagnostic use only."
            ),
        }
