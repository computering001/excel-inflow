"""
N12 PATCH — the terminal package pass.

Ordered and terminal: nothing here may be re-fed through LibreOffice, because
these are exactly the properties LibreOffice does not preserve, plus the ones
openpyxl cannot express in the first place.

Three jobs.

1. CACHED FORMULA VALUES. openpyxl holds a formula or a value, never both, so a
   rendered workbook leaves every formula cell with no `<v>`. A reader who does
   not recalculate sees blanks. The port note flagged that `workbook.recalculate()`
   has no openpyxl equivalent and warned this makes the LibreOffice pass the sole
   source of cached values with no fallback — verify rather than assume. It was
   verified, and it does not have to be true: the plan already carries the cached
   value of every formula cell (it is an output of the upstream solver and recalc
   stages), so the caches are written from the plan and the workbook is
   cache-correct before LibreOffice is invoked at all. LibreOffice becomes an
   independent CHECK on those caches rather than their only origin.

2. THREADED COMMENTS. openpyxl writes legacy notes (xl/commentsN.xml plus a VML
   shape) and has no notion of a modern threaded comment. The threaded part, the
   person part, their content types and their relationships are added here, and
   the legacy authors are rewritten to the `tc={guid}` shells Excel uses to tie a
   note to its thread.

Identifiers are DERIVED, not random. A random GUID per comment would make two
builds of the same case differ byte for byte and defeat the determinism
double-build; these are a hash of (sheet, cell, ordinal).

3. SHIPPING PRODUCER MARKER. LibreOffice rewrites docProps/app.xml to identify
itself. The approved shipping geometry uses the Microsoft-compatible row-height
path, and the approved visual baselines are explicitly bound to that path. The
terminal patch therefore restores <Application>Microsoft Excel</Application>
after recalculation and before the final package audit. This is not cosmetic:
LibreOffice paginates the same declared row heights differently depending on
that marker.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import zipfile
from html import unescape as html_unescape
from pathlib import Path

_TAG = re.compile(r"<([A-Za-z_][\w.:-]*)((?:[^>\"']|\"[^\"]*\"|'[^']*')*?)(/?)>")
_ATTR = re.compile(r"([A-Za-z_][\w.:-]*)\s*=\s*\"([^\"]*)\"")

def _escape(text):
    """
    Escape for ELEMENT TEXT, which is not the same job as escaping for an
    attribute value.

    A double quote needs no escaping between tags. Escaping it anyway produces
    XML that parses back to the right string but does not MATCH the reference
    byte for byte — a provenance note reading `income_statement line "revenue"`
    came out as `line &quot;revenue&quot;`. Semantically identical, and
    therefore invisible to any comparison that decodes entities, which is
    exactly why it is worth getting right: the determinism and golden-file
    checks compare bytes, and a diff nobody can see in Excel is still a diff
    somebody has to explain.
    """
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _escape_attribute(text):
    """Escape for an attribute value, where the quote delimiter does matter."""
    return _escape(text).replace('"', "&quot;")


def _local(name):
    return name.split(":", 1)[-1]


def _attrs(source):
    return {match.group(1): match.group(2) for match in _ATTR.finditer(source)}


def _serialise_number(value):
    """
    Write a cached number the way the reference package writes it.

    Both JavaScript's Number#toString and Python's repr emit the shortest string
    that round-trips, so they agree on 11380.574468085104. They disagree on
    integral floats — JS writes `1286`, Python's repr writes `1286.0` — and a
    trailing `.0` is a spurious diff on several thousand cells.
    """
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if float(value).is_integer() and abs(value) < 1e16:
        return str(int(value))
    return repr(float(value))


def _guid(*parts):
    digest = hashlib.sha256("|".join(str(part) for part in parts).encode("utf8")).hexdigest().upper()
    return f"{{{digest[0:8]}-{digest[8:12]}-{digest[12:16]}-{digest[16:20]}-{digest[20:32]}}}"


# ---------------------------------------------------------------------------
# Package plumbing
# ---------------------------------------------------------------------------

def _sheet_parts(members):
    """Sheet name -> worksheet part path, resolved through workbook.xml.rels."""
    workbook_xml = members["xl/workbook.xml"].decode("utf8")
    rels_xml = members.get("xl/_rels/workbook.xml.rels", b"").decode("utf8")
    targets = {}
    for match in _TAG.finditer(rels_xml):
        if _local(match.group(1)) != "Relationship":
            continue
        attrs = _attrs(match.group(2))
        targets[attrs.get("Id")] = attrs.get("Target")
    parts = {}
    for match in _TAG.finditer(workbook_xml):
        if _local(match.group(1)) != "sheet":
            continue
        attrs = _attrs(match.group(2))
        target = targets.get(attrs.get("r:id"))
        if not target:
            continue
        target = target[1:] if target.startswith("/") else (target if target.startswith("xl/") else f"xl/{target}")
        # XML attribute entities are semantic characters.  In particular the
        # divider sheet `> Brokers` is serialized as `&gt; Brokers`; compare
        # its decoded name to the literal plan rather than inventing a missing
        # worksheet defect.
        parts[html_unescape(attrs.get("name") or "")] = target
    return parts


# ---------------------------------------------------------------------------
# 1. Cached formula values
# ---------------------------------------------------------------------------

# Openpyxl's serialisation is not stable across XML writers: an empty formula
# cache can arrive as either `<v></v>` or the equivalent self-closing `<v />`.
# Treat both as one value element.  Missing the self-closing form used to append
# a SECOND `<v>` beside it; Excel then read the first empty node and every
# formula appeared uncached even though the patch report claimed success.
_VALUE_ELEMENT = re.compile(
    r"<(?:[A-Za-z_][\w.:-]*:)?v(?:\s*/>|>(.*?)</(?:[A-Za-z_][\w.:-]*:)?v>)",
    re.S,
)


def _write_values(sheet_xml, cells):
    """
    Write the number every cell is supposed to hold.

    Two distinct repairs, both measured rather than assumed:

    1. CACHED FORMULA RESULTS. openpyxl holds a formula or a value, never both,
       and emits an EMPTY `<v></v>` beside every formula. So "the cell has a
       `<v>`" is not the same question as "the cell is cached"; a check that
       conflated them left every formula cell blank to a reader who does not
       recalculate.

    2. LITERAL FLOATS THAT LOST THEIR LAST BIT. openpyxl serialises a float with
       `%.16g`, which is sixteen significant digits — one short of what an IEEE
       double needs to round-trip. `0.18359999999999999` came back as `0.1836`,
       a DIFFERENT double, on 31 cells across the eight reference cases. Small,
       silent, and exactly the class of drift a numeric fingerprint is meant to
       catch. Any literal whose emitted text does not parse back to the planned
       value is rewritten with Python's shortest round-tripping repr.

    Written against the two things that break a regex reading of a worksheet:
    an optional namespace prefix, and SELF-CLOSING cells (`<c r="C41" s="1"/>`),
    which a pattern requiring `</c>` skips — after which every ref it pairs is
    the wrong one. This scans start tags and finds each cell's own close tag,
    so a self-closing cell is simply a cell with no body and nothing shifts.
    """
    output = []
    cursor = 0
    cached = 0
    corrected = 0
    for match in _TAG.finditer(sheet_xml):
        tag = match.group(1)
        if _local(tag) != "c" or match.start() < cursor:
            continue
        if match.group(3) == "/":
            continue  # style-only cell: nothing to write
        attrs = _attrs(match.group(2))
        record = cells.get(attrs.get("r"))
        if record is None or record.get("v") is None:
            continue
        close = sheet_xml.find(f"</{tag}>", match.end())
        if close == -1:
            continue
        body = sheet_xml[match.end():close]
        existing = _VALUE_ELEMENT.search(body)

        value = record["v"]
        has_formula = "f" in record
        prefix = tag[: tag.index(":") + 1] if ":" in tag else ""
        head = match.group(0)

        if isinstance(value, bool):
            text, value_type = ("1" if value else "0"), "b"
        elif isinstance(value, str):
            text, value_type = _escape(value), "str"
        else:
            text, value_type = _serialise_number(value), None

        if not has_formula:
            # A literal is openpyxl's to write; touch it only when the text it
            # wrote does not parse back to the planned number. Strings are left
            # alone entirely — openpyxl routes them through the shared-string
            # table and the <v> holds an index, not the text.
            if value_type is not None or existing is None:
                continue
            try:
                if existing.group(1) is not None and float(existing.group(1)) == float(value):
                    continue
            except (TypeError, ValueError):
                continue
            body = body[: existing.start()] + f"<{prefix}v>{text}</{prefix}v>" + body[existing.end():]
            corrected += 1
        else:
            if existing is not None and existing.group(1) not in (None, ""):
                continue  # already cached with a real value
            if value_type is not None:
                head = (
                    re.sub(r'\st="[^"]*"', f' t="{value_type}"', head)
                    if 't="' in head
                    else f"{head[:-1]} t=\"{value_type}\">"
                )
            replacement = f"<{prefix}v>{text}</{prefix}v>"
            body = (
                body[: existing.start()] + replacement + body[existing.end():]
                if existing is not None
                else body + replacement
            )
            cached += 1

        output.append(sheet_xml[cursor:match.start()])
        output.append(head)
        output.append(body)
        cursor = close

    output.append(sheet_xml[cursor:])
    return "".join(output), cached, corrected


# ---------------------------------------------------------------------------
# 2. Threaded comments
# ---------------------------------------------------------------------------

_THREADED_NS = "http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"
_THREADED_REL = "http://schemas.microsoft.com/office/2017/10/relationships/threadedComment"
_PERSON_REL = "http://schemas.microsoft.com/office/2017/10/relationships/person"
_PERSON_PART = "xl/persons/person.xml"


def _person_part(display_name, person_id):
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        f'<xltc:personList xmlns:xltc="{_THREADED_NS}">'
        f'<xltc:person displayName="{_escape_attribute(display_name)}" id="{person_id}" />'
        "</xltc:personList>"
    ).encode("utf8")


def _threaded_part(comments, person_id, timestamp):
    body = []
    for record in comments:
        body.append(
            f'<xltc:threadedComment ref="{record["cell"]}" dT="{timestamp}" '
            f'personId="{person_id}" id="{record["id"]}">'
            f"<xltc:text>{_escape(record['text'])}</xltc:text>"
            "</xltc:threadedComment>"
        )
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        f'<xltc:ThreadedComments xmlns:xltc="{_THREADED_NS}">'
        + "".join(body)
        + "</xltc:ThreadedComments>"
    ).encode("utf8")


def _rewrite_legacy_authors(comments_xml, comments):
    """
    A legacy note that backs a threaded comment carries `tc={guid}` as its
    author — that is how Excel ties the shell to the thread. openpyxl writes the
    display name instead, which leaves the two representations unlinked and
    shows the note twice in Excel.
    """
    by_cell = {record["cell"]: record["id"] for record in comments}
    authors = []
    index_of = {}
    for record in comments:
        index_of[record["cell"]] = len(authors)
        authors.append(f"tc={record['id']}")

    del by_cell

    def author_block(_match):
        return "<authors>" + "".join(f"<author>{name}</author>" for name in authors) + "</authors>"

    patched = re.sub(r"<authors>.*?</authors>", author_block, comments_xml, flags=re.S)
    return _retarget_authors(patched, index_of)


def _retarget_authors(xml, index_of):
    def replace(match):
        attrs = _attrs(match.group(2))
        cell = attrs.get("ref")
        if cell not in index_of:
            return match.group(0)
        head = match.group(0)
        if "authorId=" in head:
            return re.sub(r'authorId="\d+"', f'authorId="{index_of[cell]}"', head)
        return head[: -len(">" if match.group(3) != "/" else "/>")] + f' authorId="{index_of[cell]}"' + (
            "/>" if match.group(3) == "/" else ">"
        )

    output = []
    cursor = 0
    for match in _TAG.finditer(xml):
        if _local(match.group(1)) != "comment":
            continue
        output.append(xml[cursor:match.start()])
        output.append(replace(match))
        cursor = match.end()
    output.append(xml[cursor:])
    return "".join(output)


def _add_content_types(xml, overrides):
    additions = "".join(
        f'<Override PartName="{part}" ContentType="{content_type}" />'
        for part, content_type in overrides
        if f'PartName="{part}"' not in xml
    )
    if not additions:
        return xml
    return xml.replace("</Types>", additions + "</Types>")


def _add_relationship(xml, rel_id, rel_type, target):
    if f'Id="{rel_id}"' in xml:
        return xml
    entry = f'<Relationship Id="{rel_id}" Type="{rel_type}" Target="{target}" />'
    return xml.replace("</Relationships>", entry + "</Relationships>")


_DRAWING_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing"
_IMAGE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
_A1 = re.compile(r"^([A-Z]{1,3})([0-9]+)$")


def _column_index(label):
    result = 0
    for char in label:
        result = result * 26 + ord(char) - 64
    return result - 1


def _broker_drawing_part(images):
    anchors = []
    for index, image in enumerate(images, start=1):
        match = _A1.match(image["anchor"])
        if not match:
            raise ValueError(f"Invalid broker image anchor {image['anchor']!r}.")
        column, row = _column_index(match.group(1)), int(match.group(2)) - 1
        cx = int(round(float(image["width_pixels"]) * 9525))
        cy = int(round(float(image["height_pixels"]) * 9525))
        anchors.append(
            f'<xdr:oneCellAnchor><xdr:from><xdr:col>{column}</xdr:col>'
            f'<xdr:colOff>0</xdr:colOff><xdr:row>{row}</xdr:row><xdr:rowOff>0</xdr:rowOff>'
            f'</xdr:from><xdr:ext cx="{cx}" cy="{cy}"/><xdr:pic>'
            f'<xdr:nvPicPr><xdr:cNvPr id="{index}" name="Broker page {int(image["page_number"])}"/>'
            f'<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>'
            f'<xdr:blipFill><a:blip r:embed="rId{index}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>'
            f'<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
            f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>'
            f'<xdr:clientData/></xdr:oneCellAnchor>'
        )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + "".join(anchors) + "</xdr:wsDr>"
    ).encode("utf8")


# ---------------------------------------------------------------------------
# The package audit
# ---------------------------------------------------------------------------

class PackageError(Exception):
    """The written package is not a conformant OPC package."""


def read_package(path):
    """Read every member of the package at `path` into a name -> bytes map."""
    with zipfile.ZipFile(path) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def _rels_part_for(part):
    """The relationship part that belongs to `part` — `a/b.xml` -> `a/_rels/b.xml.rels`."""
    if "/" not in part:
        return f"_rels/{part}.rels"
    directory, name = part.rsplit("/", 1)
    return f"{directory}/_rels/{name}.rels"


def _resolve_target(owner, target):
    """
    Resolve a relationship Target against the part that owns the relationship.

    An absolute target (`/xl/persons/person.xml`) is package-rooted; a relative
    one (`persons/person.xml`, `../comments1.xml`) resolves against the owner
    part's own directory. Both forms are legal and this project writes both, so
    a check that understood only one would report the other as dangling.
    """
    if target.startswith("/"):
        return target[1:]
    directory = owner.rsplit("/", 1)[0] if "/" in owner else ""
    segments = []
    for segment in f"{directory}/{target}".split("/"):
        if segment in ("", "."):
            continue
        if segment == "..":
            if segments:
                segments.pop()
            continue
        segments.append(segment)
    return "/".join(segments)


def audit_package(members):
    """
    Assert the package is coherent: every part reachable, every relationship
    resolvable, every part typed.

    A PART NAME IS A CONVENTION; A RELATIONSHIP IS A FACT. This is exactly the
    defect class the validator names at the external-link and drawing checks,
    and it is the one that shipped: `xl/persons/person.xml` was written with its
    `[Content_Types].xml` override and no workbook relationship pointing at it.
    Every structural check still passed — the part was there, the override was
    there — and an OPC-conformant reader rejected the package outright, which
    aborted the dynamic validator before it wrote a report at all. Zero failing
    checks and zero checks run are not the same result.

    Three predicates, each the inverse of a real way to break a package:

      1. every part is the target of some relationship, reached by walking from
         `_rels/.rels`. A part nothing points at is invisible to a conformant
         reader, so writing it is indistinguishable from not writing it.
      2. every relationship resolves to a part that exists. This is worse than
         an orphan: the reader is told to go somewhere and finds nothing.
      3. every part carries a content type, by `Default` extension or by
         `Override`, and every `Override` names a part that exists. The override
         and the relationship are two halves of one act; the shipped defect was
         precisely one half without the other.

    AND THE AUDIT ASSERTS ITS OWN VISIT. A traversal that starts at a missing
    root, or resolves no parts, or reads no relationships, has an empty result
    set — which is the pass condition for all three predicates above. So the
    visit is asserted before the absences are believed. A check that visited
    nothing has not passed.
    """
    problems = []

    if "[Content_Types].xml" not in members:
        raise PackageError("Package audit: [Content_Types].xml is absent — the package has no content types at all.")
    if "_rels/.rels" not in members:
        raise PackageError("Package audit: _rels/.rels is absent — the traversal has no root and cannot visit anything.")

    # --- walk the relationship graph from the package root -----------------
    reachable = {"_rels/.rels"}
    relationships_read = 0
    queue = ["_rels/.rels"]
    seen_rels = set()
    while queue:
        rels_part = queue.pop()
        if rels_part in seen_rels or rels_part not in members:
            continue
        seen_rels.add(rels_part)
        reachable.add(rels_part)
        owner = "" if rels_part == "_rels/.rels" else rels_part.replace("/_rels/", "/", 1)[: -len(".rels")]
        try:
            rels_xml = members[rels_part].decode("utf8")
        except UnicodeDecodeError as error:
            raise PackageError(f"Package audit: {rels_part} is not decodable XML ({error}).")
        for match in _TAG.finditer(rels_xml):
            if _local(match.group(1)) != "Relationship":
                continue
            attrs = _attrs(match.group(2))
            relationships_read += 1
            if (attrs.get("TargetMode") or "") == "External":
                continue
            target = attrs.get("Target")
            if not target:
                problems.append(f"{rels_part}: relationship {attrs.get('Id')!r} carries no Target.")
                continue
            resolved = _resolve_target(owner, target)
            if resolved not in members:
                problems.append(
                    f"{rels_part}: relationship {attrs.get('Id')!r} targets {target!r} "
                    f"-> {resolved!r}, which is not a part of this package."
                )
                continue
            reachable.add(resolved)
            queue.append(_rels_part_for(resolved))

    # --- the visit, asserted before any absence is believed ----------------
    if relationships_read == 0:
        raise PackageError("Package audit: ZERO relationships were read — the audit visited nothing and cannot pass.")
    if len(reachable) <= 1:
        raise PackageError("Package audit: the traversal resolved NO parts — the audit visited nothing and cannot pass.")

    # A zip DIRECTORY ENTRY is not a part. This renderer writes none, but the
    # other producer in this project does (`xl/`, `xl/worksheets/`), and a check
    # that called them parts would report two orphans about a package that has
    # none — a false finding, which is its own kind of broken check.
    parts = {
        name
        for name in members
        if name != "[Content_Types].xml" and not name.endswith(".rels") and not name.endswith("/")
    }
    if not parts:
        raise PackageError("Package audit: the package contains no parts — the audit visited nothing and cannot pass.")

    for name in sorted(parts - reachable):
        problems.append(
            f"{name}: no relationship points at this part. A part name is a convention; "
            f"a relationship is a fact, and a conformant reader sees only the fact."
        )

    # --- content types: every part typed, every override real --------------
    types_xml = members["[Content_Types].xml"].decode("utf8")
    defaults = set()
    overrides = set()
    for match in _TAG.finditer(types_xml):
        tag = _local(match.group(1))
        attrs = _attrs(match.group(2))
        if tag == "Default" and attrs.get("Extension"):
            defaults.add(attrs["Extension"].lower())
        elif tag == "Override" and attrs.get("PartName"):
            overrides.add(attrs["PartName"])
    if not defaults and not overrides:
        raise PackageError("Package audit: [Content_Types].xml declares no Default and no Override — nothing was visited.")

    for name in sorted(parts):
        if f"/{name}" in overrides:
            continue
        extension = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        if extension in defaults:
            continue
        problems.append(f"{name}: no content type — neither a Default for '.{extension}' nor an Override.")
    for part_name in sorted(overrides):
        if part_name.lstrip("/") not in members:
            problems.append(f"{part_name}: a content-type Override names a part the package does not contain.")

    if problems:
        raise PackageError(
            "Package audit failed with %d problem(s):\n  - %s"
            % (len(problems), "\n  - ".join(problems))
        )

    return {
        "parts": len(parts),
        "relationships": relationships_read,
        "reachable": len(reachable),
        "content_type_overrides": len(overrides),
    }


def _relationship_records(xml):
    """Return the internal relationship records carried by one rels part."""
    records = []
    for match in _TAG.finditer(xml):
        if _local(match.group(1)) != "Relationship":
            continue
        attrs = _attrs(match.group(2))
        records.append((match, attrs))
    return records


def _remove_relationship_ids(xml, relationship_ids):
    """Remove only the named relationships, preserving every unrelated edge."""
    relationship_ids = set(relationship_ids)
    output = []
    cursor = 0
    for match, attrs in _relationship_records(xml):
        if attrs.get("Id") not in relationship_ids:
            continue
        output.append(xml[cursor:match.start()])
        cursor = match.end()
    output.append(xml[cursor:])
    return "".join(output)


def _remove_sheet_drawing_tags(xml, relationship_ids):
    """Remove worksheet drawing elements bound to the named relationship IDs."""
    relationship_ids = set(relationship_ids)
    output = []
    cursor = 0
    for match in _TAG.finditer(xml):
        if _local(match.group(1)) != "drawing":
            continue
        attrs = _attrs(match.group(2))
        if attrs.get("r:id") not in relationship_ids:
            continue
        output.append(xml[cursor:match.start()])
        cursor = match.end()
    output.append(xml[cursor:])
    return "".join(output)


def _remove_content_type_overrides(xml, part_names):
    """Remove overrides for parts intentionally removed by a transactional rewrite."""
    part_names = {f"/{name.lstrip('/')}" for name in part_names}
    output = []
    cursor = 0
    for match in _TAG.finditer(xml):
        if _local(match.group(1)) != "Override":
            continue
        if _attrs(match.group(2)).get("PartName") not in part_names:
            continue
        output.append(xml[cursor:match.start()])
        cursor = match.end()
    output.append(xml[cursor:])
    return "".join(output)


def _remove_existing_sheet_drawings(members, sheet_part):
    """
    Remove the drawing subtree currently owned by one worksheet.

    N10 writes the Bxx screenshots, LibreOffice may rename their media parts,
    and N12 writes the canonical screenshots again.  Adding the second subtree
    over the first is not idempotent: when both use ``drawing1.xml``, the new
    drawing rels replace the old edge while LibreOffice's ``image1.png`` is
    left orphaned.  This function makes N12 a replacement transaction scoped
    to the Bxx worksheet: discover through relationships, remove that exact
    drawing/media subtree, then let the caller install the canonical one.
    """
    sheet_rels_path = _rels_part_for(sheet_part)
    rels_xml = members.get(sheet_rels_path, b"").decode("utf8")
    drawing_records = [
        attrs
        for _match, attrs in _relationship_records(rels_xml)
        if attrs.get("Type") == _DRAWING_REL and attrs.get("Id")
    ]
    if not drawing_records:
        return {"drawings": 0, "media": 0}

    removed_parts = set()
    removed_media = set()
    drawing_ids = {record["Id"] for record in drawing_records}
    for record in drawing_records:
        target = record.get("Target")
        if not target:
            continue
        drawing_part = _resolve_target(sheet_part, target)
        drawing_rels_path = _rels_part_for(drawing_part)
        drawing_rels_xml = members.get(drawing_rels_path, b"").decode("utf8")
        for _match, image_record in _relationship_records(drawing_rels_xml):
            if image_record.get("Type") != _IMAGE_REL or not image_record.get("Target"):
                continue
            media_part = _resolve_target(drawing_part, image_record["Target"])
            if media_part in members:
                removed_media.add(media_part)
                members.pop(media_part)
        for owned_part in (drawing_rels_path, drawing_part):
            if owned_part in members:
                removed_parts.add(owned_part)
                members.pop(owned_part)

    members[sheet_rels_path] = _remove_relationship_ids(rels_xml, drawing_ids).encode("utf8")
    members[sheet_part] = _remove_sheet_drawing_tags(
        members[sheet_part].decode("utf8"), drawing_ids
    ).encode("utf8")

    removed_parts.update(removed_media)
    if removed_parts and "[Content_Types].xml" in members:
        members["[Content_Types].xml"] = _remove_content_type_overrides(
            members["[Content_Types].xml"].decode("utf8"), removed_parts
        ).encode("utf8")
    return {"drawings": len(drawing_records), "media": len(removed_media)}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def apply(plan, path, *, backup=None, asset_root=None):
    """
    Apply the terminal patches to the package at `path`, in place.

    Returns a dict counting what was written, so a caller can gate on it rather
    than trust it.
    """
    path = Path(path)
    asset_root = Path(asset_root).resolve() if asset_root else path.parent.resolve()
    if backup:
        shutil.copyfile(path, backup)

    with zipfile.ZipFile(path) as archive:
        order = archive.namelist()
        members = {name: archive.read(name) for name in order}

    workbook_spec = plan["workbook"]
    parts = _sheet_parts(members)
    report = {"cached_values": 0, "corrected_literals": 0, "threaded_comments": 0, "sheets": {}}

    timestamp = (plan.get("generator") or {}).get("generated_at") or "2026-01-01T00:00:00.000"
    timestamp = timestamp.replace("Z", "")[:23]
    author = workbook_spec.get("comment_author") or "User"
    person_id = _guid("person", author)

    content_type_overrides = []
    threaded_index = 0
    drawing_index = 0
    image_index = 0

    for spec in workbook_spec["sheets"]:
        part = parts.get(spec["name"])
        if part is None or part not in members:
            # A sheet the plan declares but the package lacks is a defect the
            # caller must see, never a silent skip the counted report cannot
            # distinguish from "nothing to patch".
            raise ValueError(
                f"Plan sheet {spec['name']!r} has no worksheet part in the package; "
                "the workbook does not carry the plan it claims to."
            )
        sheet_xml = members[part].decode("utf8")
        sheet_xml, cached, corrected = _write_values(sheet_xml, spec["cells"])
        members[part] = sheet_xml.encode("utf8")
        report["cached_values"] += cached
        report["corrected_literals"] += corrected
        report["sheets"][spec["name"]] = {
            "cached_values": cached,
            "corrected_literals": corrected,
        }

        images = spec.get("images") or []
        if images:
            if not re.match(r"^B\d{2} .+", spec["name"]):
                raise ValueError(
                    f"Raster evidence is permitted only on Bxx sheets, not {spec['name']!r}."
                )
            replaced = _remove_existing_sheet_drawings(members, part)
            report["sheets"][spec["name"]]["replaced_drawings"] = replaced["drawings"]
            report["sheets"][spec["name"]]["replaced_media"] = replaced["media"]
            drawing_index += 1
            drawing_path = f"xl/drawings/drawing{drawing_index}.xml"
            drawing_rels_path = f"xl/drawings/_rels/drawing{drawing_index}.xml.rels"
            drawing_relationships = (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            )
            for local_index, image in enumerate(images, start=1):
                image_path = Path(image["path"]).expanduser()
                if not image_path.is_absolute():
                    image_path = asset_root / image_path
                image_path = image_path.resolve()
                payload = image_path.read_bytes()
                actual = hashlib.sha256(payload).hexdigest()
                if actual != image["sha256"]:
                    raise ValueError(
                        f"Broker page image {image_path} does not match its declared SHA-256."
                    )
                image_index += 1
                media_path = f"xl/media/brokerPage{image_index}.png"
                members[media_path] = payload
                content_type_overrides.append((f"/{media_path}", "image/png"))
                drawing_relationships += (
                    f'<Relationship Id="rId{local_index}" Type="{_IMAGE_REL}" '
                    f'Target="../media/brokerPage{image_index}.png" />'
                )
            drawing_relationships += "</Relationships>"
            members[drawing_path] = _broker_drawing_part(images)
            members[drawing_rels_path] = drawing_relationships.encode("utf8")
            content_type_overrides.append(
                (f"/{drawing_path}", "application/vnd.openxmlformats-officedocument.drawing+xml")
            )

            rels_path = part.rsplit("/", 1)
            rels_path = f"{rels_path[0]}/_rels/{rels_path[1]}.rels"
            rels_xml = members.get(
                rels_path,
                b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
            ).decode("utf8")
            drawing_rel_id = f"rIdBrokerPages{drawing_index}"
            rels_xml = _add_relationship(
                rels_xml,
                drawing_rel_id,
                _DRAWING_REL,
                f"../drawings/drawing{drawing_index}.xml",
            )
            members[rels_path] = rels_xml.encode("utf8")
            sheet_xml = members[part].decode("utf8")
            sheet_xml = sheet_xml.replace(
                "</worksheet>",
                '<drawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
                f'r:id="{drawing_rel_id}"/></worksheet>',
            )
            members[part] = sheet_xml.encode("utf8")
            report["sheets"][spec["name"]]["images"] = len(images)
            report["broker_page_images"] = report.get("broker_page_images", 0) + len(images)

        comments = spec.get("comments") or []
        if not comments:
            continue

        threaded_index += 1
        threaded_path = f"xl/threadedcomments/threadedComment{threaded_index}.xml"
        records = [
            {
                "cell": record["cell"],
                "text": record["text"],
                "id": _guid(spec["name"], record["cell"], ordinal),
            }
            for ordinal, record in enumerate(comments)
        ]
        members[threaded_path] = _threaded_part(records, person_id, timestamp)
        content_type_overrides.append((f"/{threaded_path}", "application/vnd.ms-excel.threadedcomments+xml"))
        report["threaded_comments"] += len(records)
        report["sheets"][spec["name"]]["threaded_comments"] = len(records)

        rels_path = part.rsplit("/", 1)
        rels_path = f"{rels_path[0]}/_rels/{rels_path[1]}.rels"
        if rels_path in members:
            rels_xml = members[rels_path].decode("utf8")
            legacy_target = None
            for match in _TAG.finditer(rels_xml):
                if _local(match.group(1)) != "Relationship":
                    continue
                attrs = _attrs(match.group(2))
                if (attrs.get("Type") or "").endswith("/comments"):
                    legacy_target = attrs.get("Target")
            rels_xml = _add_relationship(
                rels_xml,
                f"rIdThreaded{threaded_index}",
                _THREADED_REL,
                f"/{threaded_path}",
            )
            members[rels_path] = rels_xml.encode("utf8")

            if legacy_target:
                legacy = legacy_target[1:] if legacy_target.startswith("/") else (
                    legacy_target if legacy_target.startswith("xl/") else f"xl/{legacy_target}"
                )
                legacy = legacy.replace("xl/worksheets/../", "xl/")
                if legacy in members:
                    members[legacy] = _rewrite_legacy_authors(
                        members[legacy].decode("utf8"), records
                    ).encode("utf8")

    # DETERMINISM. openpyxl's `save_workbook` overwrites docProps/core.xml's
    # <dcterms:modified> with the wall clock at save time, unconditionally and
    # after any value the caller set — so two builds of the same plan differ in
    # one element and nothing else, which is enough to fail the L4
    # double-build byte-compare for a reason unrelated to the model. Pinned
    # here, in the terminal pass, because here is the only place downstream of
    # that assignment.
    core = members.get("docProps/core.xml")
    if core is not None:
        core_xml = core.decode("utf8")
        stamp = f"{timestamp[:19]}Z"
        core_xml = re.sub(
            r"(<dcterms:(?:created|modified)\b[^>]*>)[^<]*(</dcterms:(?:created|modified)>)",
            lambda m: f"{m.group(1)}{stamp}{m.group(2)}",
            core_xml,
        )
        members["docProps/core.xml"] = core_xml.encode("utf8")

    app = members.get("docProps/app.xml")
    if app is None:
        raise PackageError(
            "docProps/app.xml is absent, so the shipping producer row model cannot be asserted."
        )
    app_xml = app.decode("utf8")
    app_pattern = re.compile(
        r"(<(?:[A-Za-z_][\w.:-]*:)?Application\b[^>]*>)[^<]*(</(?:[A-Za-z_][\w.:-]*:)?Application>)"
    )
    app_xml, application_replacements = app_pattern.subn(
        r"\1Microsoft Excel\2", app_xml, count=1
    )
    if application_replacements != 1:
        raise PackageError(
            "docProps/app.xml has no single Application element to bind to the shipping row model."
        )
    members["docProps/app.xml"] = app_xml.encode("utf8")
    report["producer_application"] = "Microsoft Excel"

    # CALCULATION CONTRACT. The package being patched is the recalculation
    # engine's re-export, and that engine drops calcPr attributes the plan
    # declared — fullCalcOnLoad and forceFullCalc — while preserving the
    # iterate trio, which happens to be all the iteration-contract check
    # reads. A native reader that trusts the shipped caches and never runs a
    # full calculation cannot re-solve the declared circular set: the loop
    # freezes at its cached fixed point and stays frozen through manual
    # recalculation. The terminal pass is the only stage downstream of the
    # re-export, so the declared contract is re-asserted here, and any
    # recalculation-chain part is dropped so the reader rebuilds its own
    # dependency order instead of trusting a foreign one.
    calc_properties = workbook_spec.get("calc_properties") or {}
    workbook_part = members.get("xl/workbook.xml")
    if workbook_part is None:
        raise PackageError(
            "xl/workbook.xml is absent, so the calculation contract cannot be asserted."
        )
    workbook_xml = workbook_part.decode("utf8")
    calc_attrs = []
    if calc_properties.get("calc_id"):
        calc_attrs.append(f'calcId="{calc_properties["calc_id"]}"')
    if calc_properties.get("calc_mode"):
        calc_attrs.append(f'calcMode="{calc_properties["calc_mode"]}"')
    if calc_properties.get("full_calc_on_load", True):
        calc_attrs.append('fullCalcOnLoad="1"')
    if calc_properties.get("force_full_calc"):
        calc_attrs.append('forceFullCalc="1"')
    if calc_properties.get("iterate"):
        calc_attrs.append('iterate="1"')
    if calc_properties.get("iterate_count") is not None:
        calc_attrs.append(f'iterateCount="{calc_properties["iterate_count"]}"')
    if calc_properties.get("iterate_delta") is not None:
        calc_attrs.append(f'iterateDelta="{calc_properties["iterate_delta"]}"')
    calc_pattern = re.compile(r"<calcPr\b[^>]*/?>(?:\s*</calcPr>)?")
    replacement_calc = f"<calcPr {' '.join(calc_attrs)}/>"
    workbook_xml, calc_replacements = calc_pattern.subn(
        replacement_calc, workbook_xml, count=1
    )
    if calc_replacements != 1:
        raise PackageError(
            "xl/workbook.xml has no calcPr element to carry the calculation contract."
        )
    members["xl/workbook.xml"] = workbook_xml.encode("utf8")
    report["calc_properties"] = replacement_calc

    calc_chain = "xl/calcChain.xml"
    if calc_chain in members:
        members.pop(calc_chain)
        workbook_rels_path = "xl/_rels/workbook.xml.rels"
        if workbook_rels_path in members:
            rels_xml = members[workbook_rels_path].decode("utf8")
            rels_xml = re.sub(
                r'<Relationship\b[^>]*Target="[^"]*calcChain\.xml"[^>]*/>',
                "",
                rels_xml,
            )
            members[workbook_rels_path] = rels_xml.encode("utf8")
        content_types = members.get("[Content_Types].xml")
        if content_types is not None:
            content_types_xml = content_types.decode("utf8")
            content_types_xml = re.sub(
                r'<Override\b[^>]*PartName="/xl/calcChain\.xml"[^>]*/>',
                "",
                content_types_xml,
            )
            members["[Content_Types].xml"] = content_types_xml.encode("utf8")
        report["calc_chain_removed"] = True
    else:
        report["calc_chain_removed"] = False

    if content_type_overrides:
        content_type_overrides.append((f"/{_PERSON_PART}", "application/vnd.ms-excel.person+xml"))
        members[_PERSON_PART] = _person_part(author, person_id)
        members["[Content_Types].xml"] = _add_content_types(
            members["[Content_Types].xml"].decode("utf8"), content_type_overrides
        ).encode("utf8")

        # THE PERSON PART IS WORKBOOK-LEVEL AND MUST BE POINTED AT.
        #
        # The threaded parts get their relationship from the worksheet rels
        # above; the person part is the workbook's, and it was written with its
        # content-type override and nothing pointing at it. That is an orphan:
        # a part name is a convention, a relationship is a fact, and a
        # conformant reader that resolves the persons part through the
        # relationship rather than the name finds no person and rejects the
        # package — which is how eight shipping workbooks aborted the dynamic
        # validator before it could write a report.
        #
        # The Id is derived, not sequential. openpyxl owns `rIdN` in this part
        # and a fresh count would collide the moment a sheet is added or
        # removed; `rIdPerson` cannot collide, is stable across builds, and the
        # determinism double-build compares bytes.
        workbook_rels = "xl/_rels/workbook.xml.rels"
        if workbook_rels not in members:
            raise PackageError(
                f"{workbook_rels} is absent, so the person part cannot be related to the workbook."
            )
        rels_xml = members[workbook_rels].decode("utf8")
        if _PERSON_REL not in rels_xml:
            rels_xml = _add_relationship(rels_xml, "rIdPerson", _PERSON_REL, f"/{_PERSON_PART}")
            members[workbook_rels] = rels_xml.encode("utf8")

    # THE TERMINAL PASS AUDITS WHAT IT IS ABOUT TO WRITE. This stage is the last
    # thing that touches the package, so it is the only place that can see the
    # package a reader will actually open. It raises rather than reports: an
    # unreadable package is not a finding to be weighed against others.
    report["package_audit"] = audit_package(members)

    # Rewrite the package. Fixed timestamps so two builds of the same plan are
    # byte-identical; the determinism double-build compares bytes.
    written = [name for name in order if name in members] + [
        name for name in members if name not in order
    ]
    # Write-to-temp-then-replace: the deliverable and its pre-patch original
    # must never coexist as a truncated file. A crash mid-write leaves the
    # original untouched; os.replace is atomic on the same filesystem.
    temporary = path.with_name(path.name + ".patch-tmp")
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
            for name in written:
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o600 << 16
                archive.writestr(info, members[name])
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()

    return report
