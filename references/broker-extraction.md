# Broker extraction and source-table lineage

## Contents

1. Product outcome
2. Evidence chain
3. Extraction waterfall
4. Completeness gates
5. Semantic crosswalk
6. Workbook presentation
7. Runtime commands
8. Failure handling

## Product outcome

Convert three to ten broker documents into two distinct products without
conflating them:

1. a lossless, hash-bound source-table bundle that preserves every extracted
   table, cell, unit, heading, blank, dash, footnote and source location; and
2. the small normalized `broker-pack/1.0` forecast vocabulary consumed by the
   model.

The source-table bundle is evidence. The normalized pack is calculation input.
A value can enter the normalized pack only through a reviewed, cell-addressed
crosswalk back to the evidence. Never discard the full tables merely because
the model uses only a subset of their metrics.

## Evidence chain

The chain is:

```text
raw document bytes
-> broker-extraction-bundle/1.0
-> broker-source-tables/1.0
-> broker-crosswalk/1.0 + PASS receipt
-> broker-pack/1.0
-> model-case broker source mappings
-> values-only broker evidence sheets
-> Brokers sheet
-> Operating Model
```

Every boundary is content-hash-bound. The model case must preserve the source
tables and crosswalk receipt exactly. A table cell must not be retyped into a
later artifact without its table id, row, column and source reference.

## Extraction waterfall

Inventory and hash every document before reading it. Use this fallback order
for each page or sheet:

1. source-native XLSX cell extraction with formulas, cached values, formats,
   merged ranges and used-range geometry;
2. native PDF metadata, text and word coordinates;
3. vector-line table reconstruction;
4. embedded-image extraction;
5. page or table-crop rendering, grid-line removal and cell-level OCR;
6. two independent image-table transcriptions; and
7. an explicit reviewed resolution when the two passes disagree.

Do not run raw whole-page OCR on a dense raster table and accept the resulting
paragraph. Crop the table, identify the grid, remove lines, OCR cells and retain
row/column positions. Raw whole-page OCR is diagnostic only.

Write one surface ledger entry for every PDF page, workbook sheet or text
document. Retain native text and word geometry even when a table was found.
Render a page when it has a material image, sparse native text, or at least six
numeric tokens without a native table. Image-only or difficult pages are not
rejected merely for lacking a text layer; they become unresolved vision tasks
and block normalization until verified.

The deployment-host capability baseline proved all required lanes: Python/Node
handoff, PDF metadata, native text and coordinates, vector tables, embedded
images, page/crop rendering, OCR, image-table transcription, XLSX readback and
atomic hash-bound checkpoints. The controlled fixture achieved exact cells on
native/vector PDF tables, raster tables and XLSX. Keep the fallback ordering;
do not assume an optional library or one extraction lane is universally best.

## Completeness gates

The extraction bundle may be `PASS`, `NEEDS_VISION` or `BLOCKED`.

Require all of the following before `PASS`:

- every input document is represented once by its computed SHA-256;
- every page or sheet has one surface-ledger row;
- every detected table is retained separately rather than flattened into one
  arbitrary matrix;
- every cell retains raw text, typed value, row, column and source reference;
- native table numeric-token recall is 100%; missing and duplicate tokens are
  empty;
- every material raster/table page has two agreeing passes or a reviewed
  resolution bound to the page-image hash;
- blanks, dashes, zeros, parentheses, percentages and multiples remain
  distinct;
- table continuations, landscape pages, units and footnotes are preserved; and
- a gate that visited zero pages, tables or cells cannot report success.

Numeric recall is a completeness test, not a truth test. The semantic mapping
still needs definition, units, period and sign review. Conversely, a clean
semantic mapping does not cure an incomplete source extraction.

## Semantic crosswalk

Create one `broker-crosswalk/1.0` only after the extraction bundle is `PASS`.
Map by stable house id, metric id and forecast period. Each mapped value names
one or more source table cells, a coefficient, optional constant, optional
multiplier, rationale and review status. This declarative form supports a direct
cell, a transparent sum or a documented scale/FX conversion without executing
free-form formulas.

Do not infer a missing broker estimate as zero. Leave the period `null`. Do not
force every source row into the model vocabulary. Unused rows remain visible in
the source evidence. Required normalized metrics remain the existing broker
contract: revenue, D&A, effective tax rate, capex, aggregate working capital and
dividends, plus at least one supported headline anchor such as EBIT or Adjusted
EBITDA. Preserve any additional usable broker metrics; the forecast-authority
graph decides whether the model consumes them.

The compiler must prove:

- three to ten distinct houses;
- exactly three forecast periods;
- no duplicate house/metric/period writer;
- every referenced source cell exists and belongs to the same house;
- the compiled value equals its declared components, constant and multiplier;
- every normalized estimate retains publication and document metadata; and
- the crosswalk receipt is hash-bound to both bundle and crosswalk.

## Workbook presentation

When full broker evidence is supplied, extend the three core sheets with one
optional evidence group:

```text
Operating Model
> Brokers
Brokers
B01 <house name>
...
B10 <house name>
Forward Curves
```

`> Brokers` is a lightweight divider. Each `B01`-`B10` sheet presents the
house's extracted tables in clean blocks with title, source location, units,
publication date, filename and source hash. It contains values only and must not
be an economic calculation surface.

The main `Brokers` sheet links mapped house estimates to those evidence cells.
The Operating Model continues to link only to `Brokers`; it must never reference
a raw evidence sheet directly. Evidence sheets are optional for legacy or
synthetic cases with no full-table bundle, in which case the workbook retains
the three core sheets exactly.

The independent OOXML oracle proves the evidence sheets are values-only, every
sealed source-cell reference is used by `Brokers`, and no other sheet bypasses
that authority direction.

## Runtime commands

Create the raw extraction bundle outside the immutable skill tree:

```text
python3 scripts/extract_broker_evidence.py <broker-extraction-request.json> --out <run-folder>/extract
```

If the result is `NEEDS_VISION`, produce two independent results for every
emitted task and merge them:

```text
python3 scripts/compile_broker_vision.py <bundle.json> --responses <responses-folder> --out <verified-bundle.json>
```

Compile the verified evidence and reviewed crosswalk:

```text
python3 scripts/compile_broker_pack.py <verified-bundle.json> <broker-crosswalk.json> --out <run-folder>/broker
```

Pass the resulting broker pack, source tables, crosswalk and receipt into the
attachment ingress `broker_evidence` declaration before compiling the evidence
run. Do not hand-edit `model_case.broker_pack.raw_tables` or
`source_mappings`.

## Failure handling

Pause once at Stage 2 only when a material ambiguity survives deterministic
extraction: an unreadable table, disagreement between image passes, ambiguous
period/units/sign, or a missing required broker metric across the whole pack.
Present all surviving broker questions together. Do not stop once per document.

If extraction fails, request the smallest corrected source: an unprotected PDF,
the original spreadsheet, a higher-resolution page, or confirmation of one
specific unit/period. Never substitute public consensus for a missing supplied
broker source inside a production evidence run.
