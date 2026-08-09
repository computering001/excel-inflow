/**
 * plan_builder.mjs — the emitter's OWN record of what it decided.
 *
 * WHY THIS EXISTS. `extract_plan.mjs` reads a finished .xlsx and reports the
 * plan that workbook implies. That is a true statement about the package, and
 * it was the right way to validate the contract, but it is not a way to SHIP
 * one: the package it reads is built by `private workbook library`, which cannot go
 * out with the skill. So a plan could only ever be produced for a workbook that
 * had already been built by a tool deployment host does not have — which is the same as
 * saying deployment host could not build a model for a company it had not already seen.
 *
 * This module closes that. It presents the SAME write surface the emitter
 * already uses — `worksheets.add`, `getRange().values/.formulas/.format.*`,
 * `conditionalFormats.add`, `dataValidation`, `comments.addThread` — and
 * accumulates the decisions instead of forwarding them to a writer. The plan is
 * then SYNTHESISED from those decisions rather than read back out of a file.
 *
 * TWO THINGS BECOME NODE-SIDE HERE.
 *
 *   1. STYLE RESOLUTION. legacy workbook library owned styles.xml and handed out indices.
 *      This interns COMPLETE style records (`assets/plan.schema.json` →
 *      `style`) and hands out indices itself. Because every record is complete,
 *      the two legacy workbook library semantics the emitter had to work around stop
 *      existing at the output: a partial font assignment is merged HERE, at
 *      write time, and what lands in the table is the whole font; a border
 *      assignment states the intended edge set outright, so there is nothing
 *      for a renderer to merge or to clear.
 *
 *   2. FORMATTING CHANNELS THE WRITER DISCARDED. Freeze pane, row outline
 *      levels, `indentLevel` and `horizontalAlignment` were all accepted by
 *      legacy workbook library and emitted as nothing, which is why the Node pipeline
 *      grew four package-level patch passes to put them back. They are ordinary
 *      recorded facts here.
 *
 * WHAT THIS IS NOT. It is not a spreadsheet engine. It does not evaluate a
 * formula, and it deliberately has no opinion about what a formula's cached
 * value should be: `setCachedValue` is the only way a cached value enters, and
 * the build feeds it from the SOLVER. LibreOffice is then an independent check
 * on those caches rather than their only source.
 */

const DEFAULT_FONT = { name: "Calibri", size: 11 };
const DEFAULT_PAGE_MARGINS = {
  left: 0.7,
  right: 0.7,
  top: 0.75,
  bottom: 0.75,
  header: 0.3,
  footer: 0.3,
};
const DEFAULT_ROW_HEIGHT = 15;

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export function columnNumberOf(name) {
  let total = 0;
  for (const character of name) {
    total = total * 26 + (character.charCodeAt(0) - 64);
  }
  return total;
}

export function columnNameOf(number) {
  let name = "";
  let value = number;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

const ADDRESS = /^\$?([A-Z]{1,3})\$?(\d{1,7})(?::\$?([A-Z]{1,3})\$?(\d{1,7}))?$/;

function parseAddress(address) {
  const match = ADDRESS.exec(String(address).trim());
  if (!match) throw new Error(`plan_builder: unparseable range "${address}".`);
  const firstColumn = columnNumberOf(match[1]);
  const firstRow = Number(match[2]);
  const lastColumn = match[3] ? columnNumberOf(match[3]) : firstColumn;
  const lastRow = match[4] ? Number(match[4]) : firstRow;
  return {
    firstColumn: Math.min(firstColumn, lastColumn),
    lastColumn: Math.max(firstColumn, lastColumn),
    firstRow: Math.min(firstRow, lastRow),
    lastRow: Math.max(firstRow, lastRow),
  };
}

/** `C5` -> `C5:C5`. The writer spelled a single-cell sqref as a degenerate range. */
function sqrefOf(box) {
  return (
    `${columnNameOf(box.firstColumn)}${box.firstRow}:` +
    `${columnNameOf(box.lastColumn)}${box.lastRow}`
  );
}

// ---------------------------------------------------------------------------
// Colour
//
// The emitter names colours as `#RRGGBB`. Every colour in the plan is ARGB,
// upper case, with no theme or indexed colours — the schema forbids those,
// because they resolve against a theme part a renderer must not have to reason
// about.
// ---------------------------------------------------------------------------

function argb(colour) {
  if (colour === null || colour === undefined) return undefined;
  if (typeof colour !== "string") {
    throw new Error(`plan_builder: colour must be a string, got ${typeof colour}.`);
  }
  const hex = colour.replace(/^#/, "").toUpperCase();
  if (/^[0-9A-F]{6}$/.test(hex)) return `FF${hex}`;
  if (/^[0-9A-F]{8}$/.test(hex)) return hex;
  throw new Error(`plan_builder: unrecognised colour "${colour}".`);
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86400000;

/**
 * A date is stored as a SERIAL NUMBER with a date number format, never as a
 * date object: the plan contract says so, and a renderer that had to decide
 * which epoch a date object meant would be making a determinism-bearing choice
 * of its own.
 */
function excelSerial(date) {
  return (date.getTime() - EXCEL_EPOCH_MS) / MS_PER_DAY;
}

function literal(value) {
  if (value === null || value === undefined) return { v: undefined, t: undefined };
  if (value instanceof Date) return { v: excelSerial(value), t: "n" };
  if (typeof value === "number") {
    return { v: value, t: "n" };
  }
  if (typeof value === "boolean") return { v: value, t: "b" };
  return { v: String(value), t: "s" };
}

// ---------------------------------------------------------------------------
// Cell state
// ---------------------------------------------------------------------------

function newCell() {
  return {
    value: undefined,
    type: undefined,
    formula: undefined,
    cachedValue: undefined,
    cachedType: undefined,
    // Style channels. `undefined` means "never stated", which is not the same
    // as "stated as empty": a cell that was never given a font takes the
    // workbook default, and a cell explicitly given no fill takes patternType
    // none. Both land as the same plan record, but only one of them is a
    // decision, and the distinction is what makes `styled` meaningful.
    numberFormat: undefined,
    font: undefined,
    fill: undefined,
    border: undefined,
    alignment: undefined,
    styled: false,
    touched: false,
  };
}

// ---------------------------------------------------------------------------
// Format facade
// ---------------------------------------------------------------------------

class PlanFormat {
  constructor(range) {
    this._range = range;
  }

  set numberFormat(code) {
    this._range._eachCell((cell) => {
      cell.numberFormat = code;
      cell.styled = true;
    });
  }

  set font(font) {
    // PARTIAL FONT ASSIGNMENT IS MERGED, HERE, AT WRITE TIME.
    //
    // `assertFormulaProvenance()` writes `{ color }` alone and relies on bold,
    // size and name set by an earlier pass surviving; `applyTotalHierarchy`
    // writes `{ bold: true }` alone and relies on the provenance colour
    // surviving. Both are load-bearing. The merge happens on the way IN so that
    // what lands in the style table is a complete record and no renderer ever
    // has to reproduce the semantics.
    this._range._eachCell((cell) => {
      const base = cell.font ?? { ...DEFAULT_FONT };
      const merged = { ...base };
      for (const [key, value] of Object.entries(font)) {
        if (value === undefined) continue;
        if (key === "color") merged.color = argb(value);
        else merged[key] = value;
      }
      cell.font = merged;
      cell.styled = true;
    });
  }

  set fill(colour) {
    const record =
      colour === null || colour === undefined
        ? null
        : { pattern: "solid", fg_color: argb(colour) };
    this._range._eachCell((cell) => {
      cell.fill = record;
      cell.styled = true;
    });
  }

  /**
   * A BORDER ASSIGNMENT IS A FRAME AROUND A REGION, NOT A GRID OVER IT.
   *
   * This is the one channel where the emitter's write does not resolve to a
   * per-cell fact at the moment it is made, and getting it wrong is not a
   * rounding error: assigning all four edges to every covered cell instead of
   * to the region's perimeter turns the Operating Model's boxed panels into 644
   * cells of cage. `getRange("B2:D4").format.borders = { left, right, top,
   * bottom }` puts the left edge on column B alone, the right on D alone, the
   * top on row 2 alone and the bottom on row 4 alone; C3, in the middle, has no
   * edges at all.
   *
   * So a frame is recorded AS A FRAME — the region and the edges it draws — and
   * the edges are painted onto the cells of its perimeter. Two composition
   * rules matter, and both were established by reading what the writer actually
   * emitted for a matrix of overlapping frames, not from its API:
   *
   *   REDRAWING FROM THE SAME CORNER AMENDS THE FRAME. A frame that starts at
   *   the same top-left cell as one already drawn is the same frame, restated:
   *   its region becomes the new one and its edges are the union. This is what
   *   makes the instrument-terms block work — `C75:E75` is ruled underneath,
   *   then `C75:E81` is boxed, and the header keeps its rule while the box
   *   closes on row 81.
   *
   *   A FRAME REDRAWN ACROSS THE SAME ROWS SUPERSEDES THE RULES IT WIDENS. On
   *   the model's last row, `C140:L140` takes a section-closing rule and then
   *   `B140:L140` takes the total's rule; one row band, redrawn wider, so the
   *   wider statement is the one that stands. A frame over DIFFERENT rows is a
   *   different region and both stand — which is why the column-block left edge
   *   running down J survives every row rule that crosses it.
   *
   * KNOWN LIMIT, stated rather than papered over. The writer also drops a
   * region's RIGHT edge in some overlaps where it keeps the LEFT, and drops a
   * one-column region's bottom. Neither shape occurs in this model — the
   * N-vs-Y comparison across all eight cases is what says so — so neither is
   * reproduced here, and a future frame of that shape would need this note
   * revisited rather than trusted.
   *
   * The emitter's draw-order discipline — restating left and top when adding a
   * bottom rule — is therefore the emitter saying what each frame IS, and the
   * plan states the resulting edge set outright. No renderer merges anything.
   */
  set borders(borders) {
    const edges = {};
    for (const edge of ["left", "right", "top", "bottom", "diagonal"]) {
      const spec = borders?.[edge];
      if (!spec || !spec.style || spec.style === "none") continue;
      const entry = { style: spec.style };
      const colour = argb(spec.color);
      if (colour) entry.color = colour;
      edges[edge] = entry;
    }
    this._range._sheet._drawFrame(this._range._box, edges);
    this._range._eachCell((cell) => {
      cell.styled = true;
    });
  }

  set horizontalAlignment(horizontal) {
    this._range._eachCell((cell) => {
      cell.alignment = { ...(cell.alignment ?? {}), horizontal };
      cell.styled = true;
    });
  }

  set verticalAlignment(vertical) {
    this._range._eachCell((cell) => {
      cell.alignment = { ...(cell.alignment ?? {}), vertical };
      cell.styled = true;
    });
  }

  set indentLevel(indent) {
    this._range._eachCell((cell) => {
      cell.alignment = { ...(cell.alignment ?? {}), indent: Number(indent) };
      cell.styled = true;
    });
  }

  set wrapText(wrap) {
    this._range._eachCell((cell) => {
      cell.alignment = { ...(cell.alignment ?? {}), wrap_text: Boolean(wrap) };
      cell.styled = true;
    });
  }

  /**
   * Column width and row height are SHEET facts, not cell facts, and setting
   * one does not bring a cell into existence — the writer emitted `<col>` and
   * `<row>` records for them and no `<c>`. Recording them against cells would
   * populate the sheet with thousands of empty cells nobody asked for and
   * change the rendered face of the model.
   */
  set columnWidth(width) {
    const box = this._range._box;
    for (let index = box.firstColumn; index <= box.lastColumn; index += 1) {
      this._range._sheet._columnWidths.set(index, Number(width));
    }
  }

  set rowHeight(height) {
    const box = this._range._box;
    for (let row = box.firstRow; row <= box.lastRow; row += 1) {
      this._range._sheet._rowHeights.set(row, Number(height));
    }
  }
}

class PlanConditionalFormats {
  constructor(range) {
    this._range = range;
  }

  /**
   * `add(type, options)` mirrors the writer's own signature. The rule's
   * differential style is recorded as a dxf record — partial BY CONTRACT,
   * which is the OOXML meaning of a dxf and not a merge hazard.
   */
  add(type, options = {}) {
    const sheet = this._range._sheet;
    const dxf = {};
    const format = options.format ?? {};
    if (format.font && Object.keys(format.font).length > 0) {
      const font = {};
      for (const [key, value] of Object.entries(format.font)) {
        if (value === undefined) continue;
        if (key === "color") font.color = argb(value);
        else font[key] = value;
      }
      if (Object.keys(font).length > 0) dxf.font = font;
    }
    if (format.fill !== undefined) {
      // A dxf fill names the colour in bgColor, not fgColor. That is the OOXML
      // convention for a differential style and is what the writer emitted.
      dxf.fill =
        format.fill === null
          ? null
          : { pattern: "solid", bg_color: argb(format.fill) };
    }
    if (format.numberFormat) dxf.number_format = format.numberFormat;
    if (format.borders) {
      const border = {};
      for (const edge of ["left", "right", "top", "bottom", "diagonal"]) {
        const spec = format.borders[edge];
        if (!spec || !spec.style) continue;
        const entry = { style: spec.style };
        const colour = argb(spec.color);
        if (colour) entry.color = colour;
        border[edge] = entry;
      }
      if (Object.keys(border).length > 0) dxf.border = border;
    }

    const rule = { type, dxf };
    if (options.operator) rule.operator = options.operator;
    const formulas = [];
    for (const key of ["formula", "formula1", "formula2"]) {
      if (options[key] === undefined) continue;
      // A rule formula is stored WITHOUT the leading `=`; the emitter writes it
      // with one on the expression rules and without one on the cellIs rules.
      formulas.push(String(options[key]).replace(/^=/, ""));
    }
    if (Array.isArray(options.formulas)) {
      for (const entry of options.formulas) {
        formulas.push(String(entry).replace(/^=/, ""));
      }
    }
    if (formulas.length > 0) rule.formulas = formulas;
    if (options.stopIfTrue) rule.stop_if_true = true;

    sheet._conditionalFormats.push({ sqref: sqrefOf(this._range._box), rule });
  }
}

class PlanRange {
  constructor(sheet, address) {
    this._sheet = sheet;
    this._address = address;
    this._box = parseAddress(address);
    this.format = new PlanFormat(this);
    this.conditionalFormats = new PlanConditionalFormats(this);
  }

  get address() {
    return this._address;
  }

  _eachCell(visit) {
    const box = this._box;
    for (let row = box.firstRow; row <= box.lastRow; row += 1) {
      for (let column = box.firstColumn; column <= box.lastColumn; column += 1) {
        visit(this._sheet._cell(columnNameOf(column) + row), row, column);
      }
    }
  }

  set values(rows) {
    const box = this._box;
    for (let row = box.firstRow; row <= box.lastRow; row += 1) {
      const source = rows[row - box.firstRow] ?? [];
      for (let column = box.firstColumn; column <= box.lastColumn; column += 1) {
        const cell = this._sheet._cell(columnNameOf(column) + row);
        const { v, t } = literal(source[column - box.firstColumn]);
        cell.value = v;
        cell.type = t;
        cell.formula = undefined;
        cell.cachedValue = undefined;
        cell.cachedType = undefined;
        cell.touched = true;
      }
    }
  }

  set formulas(rows) {
    const box = this._box;
    for (let row = box.firstRow; row <= box.lastRow; row += 1) {
      const source = rows[row - box.firstRow] ?? [];
      for (let column = box.firstColumn; column <= box.lastColumn; column += 1) {
        const text = source[column - box.firstColumn];
        if (text === undefined || text === null) continue;
        const cell = this._sheet._cell(columnNameOf(column) + row);
        cell.formula = String(text).replace(/^=/, "");
        cell.value = undefined;
        cell.type = undefined;
        cell.touched = true;
      }
    }
  }

  set dataValidation(validation) {
    const rule = validation?.rule ?? {};
    const record = {
      // The writer spelled a validation's sqref as a plain cell, not as a
      // degenerate range — unlike a conditional format's.
      sqref:
        this._box.firstColumn === this._box.lastColumn &&
        this._box.firstRow === this._box.lastRow
          ? `${columnNameOf(this._box.firstColumn)}${this._box.firstRow}`
          : sqrefOf(this._box),
      type: rule.type,
      // openpyxl emits both flags explicitly as false when callers do not
      // request prompts. Record that package fact in the production plan so
      // an independently extracted authority plan is byte-semantically equal
      // instead of differing only because one side made the default explicit.
      show_error_message: Boolean(validation?.showErrorMessage ?? false),
      show_input_message: Boolean(validation?.showInputMessage ?? false),
    };
    if (rule.operator) record.operator = rule.operator;
    if (rule.type === "list") {
      // Quoted comma-joined literal set, exactly as it lands in the XML, so a
      // renderer never has to decide how to quote it.
      record.formula1 = `"${(rule.values ?? []).join(",")}"`;
    } else {
      if (rule.formula1 !== undefined) record.formula1 = String(rule.formula1);
      if (rule.formula2 !== undefined) record.formula2 = String(rule.formula2);
    }
    this._sheet._dataValidations.push(record);
  }

  merge() {
    this._sheet._merges.push(sqrefOf(this._box));
  }

  unmerge() {
    const target = sqrefOf(this._box);
    this._sheet._merges = this._sheet._merges.filter((entry) => entry !== target);
  }
}

class PlanFreezePanes {
  constructor(sheet) {
    this._sheet = sheet;
  }

  freezeRows(count) {
    this._sheet._freeze.rows = Number(count);
  }

  freezeColumns(count) {
    this._sheet._freeze.columns = Number(count);
  }

  freezeAt() {
    throw new Error("plan_builder: freezeAt is not part of the emitter's surface.");
  }
}

export class PlanWorksheet {
  constructor(workbook, name) {
    this.workbook = workbook;
    this.name = name;
    this.showGridLines = true;
    this.freezePanes = new PlanFreezePanes(this);
    this._freeze = { rows: 0, columns: 0 };
    this._cells = new Map();
    this._columnWidths = new Map();
    this._rowHeights = new Map();
    this._rowOutlineLevels = new Map();
    this._frames = [];
    this._conditionalFormats = [];
    this._dataValidations = [];
    this._comments = [];
    this._merges = [];
    // These are the OOXML defaults openpyxl writes even on a sheet with no
    // grouped rows. Keeping them in the plan makes the plan a complete account
    // of the emitted package; sheets that opt out overwrite them explicitly.
    this._outline = { summary_below: true, summary_right: true };
    this._pageMargins = { ...DEFAULT_PAGE_MARGINS };
    this._defaultRowHeight = DEFAULT_ROW_HEIGHT;
  }

  getRange(address) {
    return new PlanRange(this, address);
  }

  getCell(row, column) {
    return this.getRange(`${columnNameOf(column + 1)}${row + 1}`);
  }

  _cell(address) {
    let cell = this._cells.get(address);
    if (!cell) {
      cell = newCell();
      this._cells.set(address, cell);
    }
    return cell;
  }

  /** See the note on `PlanFormat.borders` for what a frame is and how two compose. */
  _drawFrame(box, edges) {
    const anchor = `${box.firstColumn}:${box.firstRow}`;
    const existing = this._frames.find((frame) => frame.anchor === anchor);
    let effective;
    if (existing) {
      existing.box = box;
      Object.assign(existing.edges, edges);
      effective = existing.edges;
    } else {
      // Same row band, redrawn at least as wide: the earlier statement about
      // those rows is superseded, so lift its rules off the cells before the
      // new one goes down.
      const superseded = this._frames.filter(
        (frame) =>
          frame.box.firstRow === box.firstRow &&
          frame.box.lastRow === box.lastRow &&
          frame.box.firstColumn >= box.firstColumn &&
          frame.box.lastColumn <= box.lastColumn,
      );
      for (const frame of superseded) this._eraseHorizontalEdges(frame);
      if (superseded.length > 0) {
        this._frames = this._frames.filter((frame) => !superseded.includes(frame));
      }
      effective = { ...edges };
      this._frames.push({ anchor, box, edges: effective });
    }
    this._paintFrame(box, effective);
  }

  _eraseHorizontalEdges(frame) {
    const { box, edges } = frame;
    for (let column = box.firstColumn; column <= box.lastColumn; column += 1) {
      if (edges.top) {
        const cell = this._cells.get(columnNameOf(column) + box.firstRow);
        if (cell?.border) delete cell.border.top;
      }
      if (edges.bottom) {
        const cell = this._cells.get(columnNameOf(column) + box.lastRow);
        if (cell?.border) delete cell.border.bottom;
      }
    }
  }

  _paintFrame(box, edges) {
    for (let row = box.firstRow; row <= box.lastRow; row += 1) {
      for (let column = box.firstColumn; column <= box.lastColumn; column += 1) {
        const onLeft = edges.left && column === box.firstColumn;
        const onRight = edges.right && column === box.lastColumn;
        const onTop = edges.top && row === box.firstRow;
        const onBottom = edges.bottom && row === box.lastRow;
        if (!onLeft && !onRight && !onTop && !onBottom && !edges.diagonal) {
          continue;
        }
        const cell = this._cell(columnNameOf(column) + row);
        const record = cell.border ?? {};
        if (onLeft) record.left = edges.left;
        if (onRight) record.right = edges.right;
        if (onTop) record.top = edges.top;
        if (onBottom) record.bottom = edges.bottom;
        // A diagonal is a property of a cell, not of a region's perimeter.
        if (edges.diagonal) record.diagonal = edges.diagonal;
        cell.border = record;
      }
    }
  }

  /** Read-only view, for the build's own patch passes. */
  cellAt(address) {
    return this._cells.get(address) ?? null;
  }

  hasCell(address) {
    return this._cells.has(address);
  }

  cellAddresses() {
    return this._cells.keys();
  }

  /**
   * THE ONLY DOOR A CACHED VALUE COMES THROUGH.
   *
   * A cached value is the number a reader sees before Excel recalculates. This
   * builder computes nothing, so every one of them is supplied — by the solver,
   * which already knows them, rather than read back out of a file another tool
   * wrote.
   */
  setCachedValue(address, value) {
    const cell = this._cells.get(address);
    if (!cell || cell.formula === undefined) return false;
    const { v, t } = literal(value);
    if (v === undefined) return false;
    cell.cachedValue = v;
    cell.cachedType = t;
    return true;
  }

  setFormulaText(address, formula) {
    const cell = this._cells.get(address);
    if (!cell || cell.formula === undefined) return false;
    cell.formula = String(formula).replace(/^=/, "");
    return true;
  }

  setRowOutlineLevel(row, level) {
    const depth = Number(level);
    if (!Number.isFinite(depth) || depth < 1) return false;
    const target = Number(row);
    if (!Number.isInteger(target) || target < 1) return false;
    this._rowOutlineLevels.set(
      target,
      Math.max(this._rowOutlineLevels.get(target) ?? 0, Math.min(depth, 7)),
    );
    return true;
  }

  setOutlineProperties(properties) {
    this._outline = { ...(this._outline ?? {}), ...properties };
  }
}

class PlanComments {
  constructor(workbook) {
    this._workbook = workbook;
  }

  setSelf(person) {
    this._workbook._commentAuthor = person?.displayName ?? "User";
  }

  /**
   * Threaded comments are recorded as a LIST, never as a map keyed by cell. The
   * emitter attaches two identical threads to some provenance cells and the
   * writer permitted it; a builder that deduplicated them would be making a
   * decision the emitter did not make, and would hide it.
   */
  addThread(target, text) {
    const range = target?.cell;
    if (!range) throw new Error("plan_builder: addThread needs a { cell } range.");
    const sheet = range._sheet;
    const box = range._box;
    sheet._comments.push({
      cell: `${columnNameOf(box.firstColumn)}${box.firstRow}`,
      text: String(text),
    });
  }
}

export class PlanWorkbook {
  constructor() {
    this.sheets = [];
    this._commentAuthor = undefined;
    this._calcProperties = undefined;
    this._defaultFont = { ...DEFAULT_FONT };
    this.comments = new PlanComments(this);
    const sheets = this.sheets;
    this.worksheets = {
      add: (name) => {
        const sheet = new PlanWorksheet(this, name);
        sheets.push(sheet);
        return sheet;
      },
      getItem: (name) => sheets.find((sheet) => sheet.name === name) ?? null,
    };
  }

  static create() {
    return new PlanWorkbook();
  }

  sheetByName(name) {
    return this.sheets.find((sheet) => sheet.name === name) ?? null;
  }

  /**
   * A NO-OP, AND SAYING SO IS THE POINT.
   *
   * legacy workbook library's `recalculate()` was where every cached value came from; the
   * emitter called it and the writer filled the `<v>` nodes in. Nothing here
   * evaluates a formula. Cached values arrive through `setCachedValue`, from the
   * solver, and a formula cell that never receives one is REPORTED by
   * `toPlan()` rather than silently shipping without a cache.
   */
  recalculate() {}

  setCalcProperties(properties) {
    this._calcProperties = { ...properties };
  }

  setDefaultFont(font) {
    this._defaultFont = { ...font };
  }

  // -------------------------------------------------------------------------
  // Style table
  // -------------------------------------------------------------------------

  _resolveStyle(cell, border) {
    const style = {
      number_format: cell.numberFormat ?? "General",
      font: cell.font ? { ...cell.font } : { ...this._defaultFont },
      fill: cell.fill ?? null,
      border: border ?? {},
    };
    if (cell.alignment && Object.keys(cell.alignment).length > 0) {
      const alignment = {};
      if (cell.alignment.horizontal) alignment.horizontal = cell.alignment.horizontal;
      if (cell.alignment.vertical) alignment.vertical = cell.alignment.vertical;
      if (Number(cell.alignment.indent) > 0) {
        alignment.indent = Number(cell.alignment.indent);
      }
      if (cell.alignment.wrap_text) alignment.wrap_text = true;
      if (cell.alignment.shrink_to_fit) alignment.shrink_to_fit = true;
      if (Object.keys(alignment).length > 0) style.alignment = alignment;
    }
    return style;
  }

  toPlan(options = {}) {
    const styles = [];
    const styleIndex = new Map();
    // Index 0 is the workbook default and must be present whether or not a cell
    // references it: `cellStyleXfs[0]` points at it and the schema requires it.
    const intern = (style) => {
      const key = stableKey(style);
      const existing = styleIndex.get(key);
      if (existing !== undefined) return existing;
      const index = styles.length;
      styles.push(style);
      styleIndex.set(key, index);
      return index;
    };
    intern({
      number_format: "General",
      font: { ...this._defaultFont },
      fill: null,
      border: {},
    });

    const differential = [];
    const uncachedFormulas = [];

    const sheets = this.sheets.map((sheet) => {
      const record = {
        name: sheet.name,
        show_gridlines: Boolean(sheet.showGridLines),
        default_row_height: sheet._defaultRowHeight,
        freeze_pane: freezePaneOf(sheet),
        columns: columnsOf(sheet),
        rows: rowsOf(sheet),
        merges: [...sheet._merges],
        conditional_formats: conditionalFormatsOf(sheet, differential),
        data_validations: sheet._dataValidations.map((entry) => ({ ...entry })),
        comments: sheet._comments.map((entry) => ({ ...entry })),
        page_margins: { ...sheet._pageMargins },
        cells: {},
      };
      const outline = outlineOf(sheet);
      if (outline) record.outline = outline;

      for (const [address, cell] of sortedCells(sheet)) {
        if (!cell.styled && !cell.touched) continue;
        const entry = {};
        if (cell.styled) entry.s = intern(this._resolveStyle(cell, cell.border));
        if (cell.formula !== undefined) {
          entry.f = cell.formula;
          if (cell.cachedValue !== undefined) {
            entry.v = cell.cachedValue;
            entry.t = cell.cachedType;
          } else {
            uncachedFormulas.push(`${sheet.name}!${address}`);
          }
        } else if (cell.value !== undefined) {
          entry.v = cell.value;
          entry.t = cell.type;
        }
        record.cells[address] = entry;
      }
      return record;
    });

    const workbook = {
      styles,
      differential_styles: differential,
      sheets,
    };
    workbook.default_font = { ...this._defaultFont };
    if (this._calcProperties) workbook.calc_properties = { ...this._calcProperties };
    if (this._commentAuthor !== undefined) {
      workbook.comment_author = this._commentAuthor;
    }

    const plan = { plan_version: "1" };
    if (options.caseId) plan.case_id = options.caseId;
    if (options.generator) plan.generator = { ...options.generator };
    plan.workbook = workbook;
    return { plan, uncached_formulas: uncachedFormulas };
  }
}

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------

/** Key-order-independent identity for a style record. */
function stableKey(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableKey(value[key])}`).join(",")}}`;
}

function sortedCells(sheet) {
  return [...sheet._cells.entries()].sort((left, right) => {
    const a = parseAddress(left[0]);
    const b = parseAddress(right[0]);
    if (a.firstRow !== b.firstRow) return a.firstRow - b.firstRow;
    return a.firstColumn - b.firstColumn;
  });
}

function freezePaneOf(sheet) {
  const rows = sheet._freeze?.rows ?? 0;
  const columns = sheet._freeze?.columns ?? 0;
  if (!rows && !columns) return null;
  const record = { top_left_cell: `${columnNameOf(columns + 1)}${rows + 1}` };
  if (columns) record.x_split = columns;
  if (rows) record.y_split = rows;
  record.active_pane = columns ? "bottomRight" : "bottomLeft";
  record.state = "frozen";
  return record;
}

function columnsOf(sheet) {
  return [...sheet._columnWidths.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([index, width]) => ({
      min: index,
      max: index,
      width,
      hidden: false,
      custom_width: true,
    }));
}

function rowsOf(sheet) {
  const rows = new Set([...sheet._rowHeights.keys(), ...sheet._rowOutlineLevels.keys()]);
  return [...rows]
    .sort((left, right) => left - right)
    .map((row) => {
      const record = { row };
      const height = sheet._rowHeights.get(row);
      if (height !== undefined) {
        record.height = height;
        record.custom_height = true;
      }
      const level = sheet._rowOutlineLevels.get(row);
      if (level) record.outline_level = level;
      return record;
    });
}

function outlineOf(sheet) {
  const record = {};
  if (sheet._outline) Object.assign(record, sheet._outline);
  const levels = [...sheet._rowOutlineLevels.values()];
  if (levels.length > 0) record.outline_level_row = Math.max(...levels);
  return Object.keys(record).length > 0 ? record : null;
}

/**
 * Rules are grouped into one `<conditionalFormatting>` block per sqref, in the
 * order they were added, and priorities run from 1 within each sheet — the same
 * shape the writer emitted, so a plan from either side reads the same.
 */
function conditionalFormatsOf(sheet, differential) {
  const blocks = [];
  const byRef = new Map();
  let priority = 1;
  for (const { sqref, rule } of sheet._conditionalFormats) {
    let block = byRef.get(sqref);
    if (!block) {
      block = { sqref, rules: [] };
      byRef.set(sqref, block);
      blocks.push(block);
    }
    const index = differential.length;
    differential.push(rule.dxf);
    const record = { type: rule.type };
    if (rule.operator) record.operator = rule.operator;
    record.priority = priority;
    priority += 1;
    record.dxf = index;
    if (rule.formulas) record.formulas = [...rule.formulas];
    if (rule.stop_if_true) record.stop_if_true = true;
    block.rules.push(record);
  }
  return blocks;
}
