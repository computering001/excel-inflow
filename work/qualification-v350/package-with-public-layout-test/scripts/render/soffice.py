"""LibreOffice PDF conversion with an isolated user profile.

Concurrency: three simultaneous `-env:UserInstallation` profiles were confirmed
to work in the tenant, so parallel builds are safe as long as every conversion
gets its own throwaway profile directory.  A shared profile deadlocks or, worse,
silently reuses another run's settings.

FAIL-CLOSED: every failure mode here raises :class:`ConversionError`.  There is
no "return None and carry on" path.  A render stage that degrades to a warning
on a failed conversion is worse than no render stage, because it turns a hard
failure into a green tick.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from typing import List, Optional


class ConversionError(RuntimeError):
    """Raised for any conversion failure.  Always terminal, never a warning."""

    def __init__(self, message: str, *, kind: str, detail: Optional[dict] = None):
        super().__init__(message)
        self.kind = kind
        self.detail = detail or {}


# Candidate locations, in preference order.  `resolveSoffice` in
# build_dynamic_model.mjs looks next to the Node runtime first; we mirror that
# so a build and a render agree on which binary they used.
def _node_relative_candidates() -> List[str]:
    candidates: List[str] = []
    node = shutil.which("node")
    if node:
        candidates.append(os.path.abspath(os.path.join(os.path.dirname(node), "..", "..", "bin", "override", "soffice")))
    return candidates


_STATIC_CANDIDATES = (
    "/usr/bin/soffice",
    "/usr/lib/libreoffice/program/soffice",
    "/usr/bin/libreoffice",
    "/opt/libreoffice/program/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
)


def resolve_soffice(explicit: Optional[str] = None) -> str:
    """Locate the LibreOffice binary, or raise.  Never returns None."""
    tried: List[str] = []
    if explicit:
        tried.append(explicit)
        if os.path.exists(explicit) and os.access(explicit, os.X_OK):
            return os.path.abspath(explicit)
    env = os.environ.get("SOFFICE_BIN")
    if env:
        tried.append(env)
        if os.path.exists(env) and os.access(env, os.X_OK):
            return os.path.abspath(env)
    for candidate in _node_relative_candidates() + list(_STATIC_CANDIDATES):
        tried.append(candidate)
        if os.path.exists(candidate) and os.access(candidate, os.X_OK):
            return candidate
    for name in ("soffice", "libreoffice"):
        found = shutil.which(name)
        tried.append(name)
        if found:
            return found
    raise ConversionError(
        "LibreOffice not found; render checks cannot run. Tried: %s" % ", ".join(tried),
        kind="soffice_missing",
        detail={"tried": tried},
    )


@dataclass
class ConversionResult:
    pdf_path: str
    soffice_path: str
    profile_dir: str
    duration_s: float
    returncode: int
    stdout: str
    stderr: str
    pdf_bytes: int


def convert_to_pdf(
    workbook_path: str,
    out_dir: str,
    *,
    soffice_path: Optional[str] = None,
    timeout_s: float = 300.0,
    profile_dir: Optional[str] = None,
) -> ConversionResult:
    """Convert `workbook_path` to PDF in `out_dir` using an isolated profile."""
    binary = resolve_soffice(soffice_path)
    os.makedirs(out_dir, exist_ok=True)

    owns_profile = profile_dir is None
    profile_dir = profile_dir or tempfile.mkdtemp(prefix=".render-profile-", dir=out_dir)
    profile_url = "file://" + os.path.abspath(profile_dir)

    argv = [
        binary,
        "-env:UserInstallation=%s" % profile_url,
        "--headless",
        "--norestore",
        "--invisible",
        "--nologo",
        "--nolockcheck",
        "--nodefault",
        "--nofirststartwizard",
        "--convert-to",
        "pdf:calc_pdf_Export",
        "--outdir",
        out_dir,
        os.path.abspath(workbook_path),
    ]

    started = time.time()
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            env={**os.environ, "HOME": profile_dir, "SAL_USE_VCLPLUGIN": "svp"},
        )
    except subprocess.TimeoutExpired as exc:
        raise ConversionError(
            "LibreOffice conversion timed out after %.0fs" % timeout_s,
            kind="timeout",
            detail={"argv": argv, "timeout_s": timeout_s},
        ) from exc
    finally:
        pass
    duration = time.time() - started

    if proc.returncode != 0:
        raise ConversionError(
            "LibreOffice exited %d" % proc.returncode,
            kind="nonzero_exit",
            detail={"argv": argv, "returncode": proc.returncode,
                    "stdout": proc.stdout[-4000:], "stderr": proc.stderr[-4000:]},
        )

    stem = os.path.splitext(os.path.basename(workbook_path))[0]
    pdf_path = os.path.join(out_dir, stem + ".pdf")
    if not os.path.exists(pdf_path):
        raise ConversionError(
            "LibreOffice exited 0 but produced no PDF at %s" % pdf_path,
            kind="missing_pdf",
            detail={"argv": argv, "stdout": proc.stdout[-4000:], "stderr": proc.stderr[-4000:]},
        )
    size = os.path.getsize(pdf_path)
    if size == 0:
        raise ConversionError(
            "LibreOffice produced a zero-byte PDF at %s" % pdf_path,
            kind="zero_byte_pdf",
            detail={"argv": argv},
        )

    if owns_profile:
        shutil.rmtree(profile_dir, ignore_errors=True)

    return ConversionResult(
        pdf_path=pdf_path,
        soffice_path=binary,
        profile_dir=profile_dir,
        duration_s=duration,
        returncode=proc.returncode,
        stdout=proc.stdout[-4000:],
        stderr=proc.stderr[-4000:],
        pdf_bytes=size,
    )


def probe() -> dict:
    """Report whether the render stage's hard dependencies are actually present.

    Used by the CLI to say plainly "LibreOffice is unavailable, therefore X
    remains unverified" instead of claiming a pass it cannot support.
    """
    info = {"soffice": None, "soffice_error": None, "pymupdf": None, "pymupdf_error": None,
            "numpy": None, "pillow": None, "python": sys.version.split()[0]}
    try:
        info["soffice"] = resolve_soffice()
    except ConversionError as exc:
        info["soffice_error"] = str(exc)
    try:
        import fitz  # noqa: F401

        info["pymupdf"] = getattr(fitz, "__doc__", "") or "present"
        info["pymupdf_version"] = getattr(fitz, "VersionBind", None) or getattr(fitz, "__version__", None)
    except Exception as exc:  # pragma: no cover - environment dependent
        info["pymupdf_error"] = repr(exc)
    try:
        import numpy

        info["numpy"] = numpy.__version__
    except Exception:
        pass
    try:
        import PIL

        info["pillow"] = PIL.__version__
    except Exception:
        pass
    return info
