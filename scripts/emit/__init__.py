"""
emit — the L6 renderer.

Consumes a `plan.json` conforming to `assets/plan.schema.json` and produces the
workbook. It contains NO BUSINESS LOGIC. Every determinism-bearing decision was
made upstream by the emitter and is already resolved in the plan; this package
places bytes.

The stages are separable on purpose. In the Node pipeline the emitter,
recalculation and terminal patching are fused inside one `main()` that exports
nothing, so no stage can be run, tested or resumed on its own — and the
architecture's node contract (N10 emit, N11 recalc, N12 patch) requires exactly
that. Here:

    render.render_plan(plan, path)   # N10 — openpyxl writes what it can express
    patch.apply(plan, path)          # N12 — the package-level terminal pass
    verify.compare(plan_a, plan_b)   # N13 — channel-by-channel, counted

Recalculation (N11) is deliberately NOT in this package. openpyxl cannot
compute, and the port note warned that this makes LibreOffice the sole source of
cached values with no fallback. It does not have to be: the plan already carries
the cached value of every formula cell, so `patch` writes them, and the workbook
is cache-correct before LibreOffice is invoked at all. LibreOffice becomes an
independent CHECK on the caches rather than their only origin, which is the
stronger arrangement and the one N13's cache-parity gate wants.
"""

__all__ = ["plan", "styles", "render", "patch", "verify"]
