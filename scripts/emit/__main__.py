"""
CLI for the renderer. The stages are separable and individually runnable.

    python3 -m emit render <plan.json> --out <workbook.xlsx>
    python3 -m emit patch  <plan.json> --out <workbook.xlsx>
    python3 -m emit build  <plan.json> --out <workbook.xlsx>   # render then patch
    python3 -m emit compare <expected.plan.json> <actual.plan.json> [--json report.json]
    python3 -m emit validate <plan.json>

`build` is a convenience over the two stages, not a third code path: the
architecture's node contract wants N10 and N12 individually gated and
checkpointed, and fusing them the way the Node emitter's `main()` does is what
makes a stage impossible to resume or test on its own.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in (None, ""):  # allow `python3 scripts/emit/__main__.py`
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    __package__ = "emit"

from . import plan as plan_module
from . import verify as verify_stage


def _load(path, validate):
    return plan_module.load(path, validate_schema=validate)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="emit", description="Render a plan.json to a workbook.")
    sub = parser.add_subparsers(dest="command", required=True)

    for name in ("render", "patch", "build"):
        stage = sub.add_parser(name)
        stage.add_argument("plan")
        stage.add_argument("--out", required=True)
        stage.add_argument("--no-validate", action="store_true")

    compare = sub.add_parser("compare")
    compare.add_argument("expected")
    compare.add_argument("actual")
    compare.add_argument("--json")
    compare.add_argument("--examples", type=int, default=5)

    validate = sub.add_parser("validate")
    validate.add_argument("plan")

    args = parser.parse_args(argv)

    if args.command == "validate":
        document = json.loads(Path(args.plan).read_text(encoding="utf8"))
        errors = plan_module.validate(document)
        print(json.dumps({"status": "VALID" if not errors else "INVALID", "errors": errors}, indent=2))
        return 0 if not errors else 1

    if args.command == "compare":
        expected = verify_stage.load_plan(args.expected)
        actual = verify_stage.load_plan(args.actual)
        report = verify_stage.compare(expected, actual, examples=args.examples)
        summary = verify_stage.summarise(report)
        if args.json:
            Path(args.json).write_text(json.dumps(report, indent=1), encoding="utf8")
        print(json.dumps(summary, indent=2))
        clean = all(counter["mismatch"] == 0 for counter in summary["channels"].values())
        clean = clean and summary["cells"]["missing"] == 0 and summary["cells"]["extra"] == 0
        # Structural and sheet-level channels are part of the verdict, not
        # commentary: a missing/extra sheet, a workbook-property mismatch or a
        # sheet-level channel difference (widths, freeze, merges, CF) fails.
        clean = clean and all(count == 0 for count in summary.get("structural", {}).values())
        clean = clean and all(
            bucket.get("not_ok", 0) == 0 for bucket in summary.get("sheet_level", {}).values()
        )
        return 0 if clean else 1

    document = _load(args.plan, not args.no_validate)
    report = {}
    if args.command in ("render", "build"):
        # Renderer dependencies belong only to renderer commands. `validate`
        # and `compare` are plan-only gates and must remain runnable in a clean
        # stdlib environment where openpyxl is deliberately absent.
        from . import render as render_stage

        report["render"] = render_stage.render_plan(document, args.out)
    if args.command in ("patch", "build"):
        from . import patch as patch_stage

        report["patch"] = patch_stage.apply(document, args.out)
    print(json.dumps({"status": "OK", "output": str(Path(args.out).resolve()), **report}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
