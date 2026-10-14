/**
 * Just enough of PostgREST to answer the reads the web app sends, from the
 * fixture tables in fixtures/tables.ts.
 *
 * The app reads with supabase-js, so what arrives is a small dialect:
 * `select` with renames and embeds (`lesson:CalendarLessons!inner(id, date)`),
 * column filters (`eq`, `in`, `gte`, `is`, `not.…`), embedded filters
 * (`lesson.date=gte.…`), `or=(…)`, `order`, `limit`/`offset` and a
 * single-object Accept header. Embeds are resolved by the schema's naming
 * convention instead of by a catalogue: a to-one embed follows `<alias>Id`,
 * `<singular table>Id` or the column a FK hint names
 * (`AttendanceRecords_studentId_fkey` → studentId), and a to-many embed
 * collects the rows whose `<singular parent table>Id` is the parent's id. So a
 * fixture table holds plain rows, as the database does, and every page that
 * embeds it sees the same data.
 *
 * Anything this does not understand is let through rather than refused: a
 * filter on a column a fixture row lacks keeps the row. The fixtures are there
 * to make every page render its real content for axe, not to prove the
 * queries; the RLS suite and the gateway's tests own that.
 */

export type Row = Record<string, unknown>;
/** Typed rows go in as they are (an interface has no index signature); the engine reads them as Rows. */
export type Tables = Record<string, readonly object[]>;
const rowsOf = (tables: Tables, table: string) => (tables[table] ?? []) as Row[];

interface Embed {
  alias: string;
  table: string;
  hint: string | null;
  inner: boolean;
  columns: SelectItem[];
}

type SelectItem =
  | { kind: "star" }
  | { kind: "column"; alias: string; column: string }
  | { kind: "embed"; embed: Embed };

/** Splits on commas that are not inside parentheses or double quotes. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    if (!quoted && char === "(") depth++;
    if (!quoted && char === ")") depth--;
    if (!quoted && depth === 0 && char === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current !== "") parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

export function parseSelect(select: string | null): SelectItem[] {
  if (!select || select.trim() === "" || select.trim() === "*") return [{ kind: "star" }];
  return splitTop(select).map((part): SelectItem => {
    if (part === "*") return { kind: "star" };
    const open = part.indexOf("(");
    if (open > 0 && part.endsWith(")")) {
      // [alias:]Table[!hint][!inner](columns), or a spread `...Table(columns)`.
      const head = part.slice(0, open).replace(/^\.\.\./, "");
      const inner = part.slice(open + 1, -1);
      const [aliasOrTable, maybeTable] = head.includes(":") ? head.split(":") : [null, head];
      const [table, ...modifiers] = (maybeTable ?? head).split("!");
      const isInner = modifiers.includes("inner");
      const hint = modifiers.find((modifier) => modifier !== "inner" && modifier !== "left") ?? null;
      return {
        kind: "embed",
        embed: {
          alias: aliasOrTable ?? table!,
          table: table!,
          hint,
          inner: isInner,
          columns: parseSelect(inner),
        },
      };
    }
    // [alias:]column[::cast]
    const withoutCast = part.split("::")[0]!;
    const [alias, column] = withoutCast.includes(":") ? withoutCast.split(":") : [withoutCast, withoutCast];
    return { kind: "column", alias: alias!, column: column! };
  });
}

const singular = (table: string) =>
  table.endsWith("ies") ? `${table.slice(0, -3)}y` : table.endsWith("s") ? table.slice(0, -1) : table;
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** `AttendanceRecords_studentId_fkey` → `studentId`; a plain column name is itself. */
function hintColumn(hint: string): string {
  const match = /^[A-Za-z]+_([A-Za-z]+)(?:_[A-Za-z]+)*_fkey$/.exec(hint);
  return match ? match[1]! : hint;
}

function resolveEmbed(parentTable: string, parent: Row, embed: Embed, tables: Tables): Row | Row[] | null {
  const rows = rowsOf(tables, embed.table);
  const toOneColumns = embed.hint
    ? [hintColumn(embed.hint)]
    : [`${embed.alias}Id`, `${lowerFirst(singular(embed.table))}Id`];
  const toOne = toOneColumns.find((column) => column in parent);
  if (toOne) {
    const id = parent[toOne];
    return rows.find((row) => row.id === id) ?? null;
  }
  const backColumn = embed.hint ? hintColumn(embed.hint) : `${lowerFirst(singular(parentTable))}Id`;
  return rows.filter((row) => row[backColumn] === parent.id);
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

type Predicate = (row: Row) => boolean;

function parseList(text: string): string[] {
  // in.(a,"b,c",d) → ["a", "b,c", "d"]
  const body = text.replace(/^\(/, "").replace(/\)$/, "");
  return splitTop(body).map((value) => value.replace(/^"(.*)"$/, "$1"));
}

function compare(value: unknown, operand: string): number {
  if (typeof value === "number") return value - Number(operand);
  return String(value) < operand ? -1 : String(value) > operand ? 1 : 0;
}

function equals(value: unknown, operand: string): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return String(value) === operand;
  if (typeof value === "number") return value === Number(operand);
  return String(value) === operand;
}

function likeToRegExp(pattern: string, flags: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/[*%]/g, ".*");
  return new RegExp(`^${escaped}$`, flags);
}

/** `op.value` or `not.op.value` against one value. Unknown operators match. */
function testOperator(value: unknown, expression: string): boolean {
  if (expression.startsWith("not.")) return !testOperator(value, expression.slice(4));
  const dot = expression.indexOf(".");
  const op = dot < 0 ? expression : expression.slice(0, dot);
  const operand = dot < 0 ? "" : expression.slice(dot + 1);
  switch (op) {
    case "eq":
      return equals(value, operand);
    case "neq":
      return !equals(value, operand);
    case "gt":
      return value !== null && value !== undefined && compare(value, operand) > 0;
    case "gte":
      return value !== null && value !== undefined && compare(value, operand) >= 0;
    case "lt":
      return value !== null && value !== undefined && compare(value, operand) < 0;
    case "lte":
      return value !== null && value !== undefined && compare(value, operand) <= 0;
    case "is":
      if (operand === "null") return value === null || value === undefined;
      if (operand === "true") return value === true;
      if (operand === "false") return value === false;
      return true;
    case "in":
      return parseList(operand).some((candidate) => equals(value, candidate));
    case "like":
      return typeof value === "string" && likeToRegExp(operand, "").test(value);
    case "ilike":
      return typeof value === "string" && likeToRegExp(operand, "i").test(value);
    case "cs": {
      const wanted = parseList(operand.replace(/^\{/, "(").replace(/\}$/, ")"));
      return Array.isArray(value) && wanted.every((item) => value.map(String).includes(item));
    }
    case "ov": {
      const wanted = parseList(operand.replace(/^\{/, "(").replace(/\}$/, ")"));
      return Array.isArray(value) && wanted.some((item) => value.map(String).includes(item));
    }
    default:
      return true;
  }
}

/** A filter on a plain column. A column the row does not carry matches. */
function columnPredicate(column: string, expression: string): Predicate {
  return (row) => (column in row ? testOperator(row[column], expression) : true);
}

/** `or=(a.eq.1,b.is.null,and(c.eq.2,d.eq.3))` and `and=(…)`. */
function logicPredicate(kind: "or" | "and", body: string): Predicate {
  const terms = splitTop(body.replace(/^\(/, "").replace(/\)$/, "")).map((term): Predicate => {
    const negated = term.startsWith("not.");
    const bare = negated ? term.slice(4) : term;
    let predicate: Predicate;
    if (bare.startsWith("or(") || bare.startsWith("and(")) {
      const open = bare.indexOf("(");
      predicate = logicPredicate(bare.slice(0, open) as "or" | "and", bare.slice(open));
    } else {
      const dot = bare.indexOf(".");
      predicate = columnPredicate(bare.slice(0, dot), bare.slice(dot + 1));
    }
    return negated ? (row) => !predicate(row) : predicate;
  });
  return kind === "or" ? (row) => terms.some((term) => term(row)) : (row) => terms.every((term) => term(row));
}

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

export interface ReadResult {
  status: number;
  body: unknown;
  contentRange: string;
}

function orderRows(rows: Row[], order: string | null): Row[] {
  if (!order) return rows;
  const keys = order.split(",").map((part) => {
    const [column, ...flags] = part.split(".");
    return { column: column!, descending: flags.includes("desc"), nullsFirst: flags.includes("nullsfirst") };
  });
  return [...rows].sort((a, b) => {
    for (const key of keys) {
      const left = a[key.column];
      const right = b[key.column];
      if (left === right) continue;
      if (left === null || left === undefined) return key.nullsFirst ? -1 : 1;
      if (right === null || right === undefined) return key.nullsFirst ? 1 : -1;
      const sign = left < right ? -1 : 1;
      return key.descending ? -sign : sign;
    }
    return 0;
  });
}

/**
 * Resolves the embeds of one row, applying the filters aimed at each embed
 * (`lesson.date=gte.…`). Returns null when an `!inner` embed came out empty,
 * which drops the parent row as PostgREST does.
 */
function shapeRow(
  table: string,
  row: Row,
  items: SelectItem[],
  tables: Tables,
  embeddedFilters: Map<string, Predicate[]>,
  path: string,
): Row | null {
  const out: Row = {};
  for (const item of items) {
    if (item.kind === "star") {
      for (const [key, value] of Object.entries(row)) if (!(key in out)) out[key] = value;
    } else if (item.kind === "column") {
      if (item.column in row) out[item.alias] = row[item.column];
    } else {
      const { embed } = item;
      const embedPath = path ? `${path}.${embed.alias}` : embed.alias;
      const filters = embeddedFilters.get(embedPath) ?? [];
      const passes = (candidate: Row) => filters.every((filter) => filter(candidate));
      const resolved = resolveEmbed(table, row, embed, tables);
      if (Array.isArray(resolved)) {
        const kept = resolved
          .filter(passes)
          .map((child) => shapeRow(embed.table, child, embed.columns, tables, embeddedFilters, embedPath))
          .filter((child): child is Row => child !== null);
        if (embed.inner && kept.length === 0) return null;
        out[embed.alias] = kept;
      } else {
        const shaped =
          resolved && passes(resolved)
            ? shapeRow(embed.table, resolved, embed.columns, tables, embeddedFilters, embedPath)
            : null;
        if (embed.inner && !shaped) return null;
        out[embed.alias] = shaped;
      }
    }
  }
  return out;
}

export function read(
  table: string,
  params: URLSearchParams,
  headers: { accept?: string; range?: string },
  tables: Tables,
): ReadResult {
  const items = parseSelect(params.get("select"));
  const topLevel: Predicate[] = [];
  const embeddedFilters = new Map<string, Predicate[]>();

  for (const [key, value] of params) {
    if (RESERVED.has(key) || key.endsWith(".order") || key.endsWith(".limit") || key.endsWith(".offset")) continue;
    if (key === "or" || key === "and") {
      topLevel.push(logicPredicate(key, value));
      continue;
    }
    if (key.endsWith(".or") || key.endsWith(".and")) continue;
    const dot = key.lastIndexOf(".");
    if (dot < 0) {
      topLevel.push(columnPredicate(key, value));
    } else {
      const path = key.slice(0, dot);
      const list = embeddedFilters.get(path) ?? [];
      list.push(columnPredicate(key.slice(dot + 1), value));
      embeddedFilters.set(path, list);
    }
  }

  const filtered = rowsOf(tables, table).filter((row) => topLevel.every((predicate) => predicate(row)));
  let rows = orderRows(filtered, params.get("order"))
    .map((row) => shapeRow(table, row, items, tables, embeddedFilters, ""))
    .filter((row): row is Row => row !== null);

  const total = rows.length;
  let offset = Number(params.get("offset") ?? 0);
  let limit = params.get("limit") === null ? Infinity : Number(params.get("limit"));
  const range = /^(\d+)-(\d+)$/.exec(headers.range ?? "");
  if (range) {
    offset = Number(range[1]);
    limit = Number(range[2]) - offset + 1;
  }
  rows = rows.slice(offset, offset + limit);
  const contentRange = rows.length === 0 ? `*/${total}` : `${offset}-${offset + rows.length - 1}/${total}`;

  if (headers.accept?.includes("application/vnd.pgrst.object+json")) {
    if (rows.length !== 1) {
      return {
        status: 406,
        body: {
          code: "PGRST116",
          details: `The result contains ${rows.length} rows`,
          hint: null,
          message: "JSON object requested, multiple (or no) rows returned",
        },
        contentRange,
      };
    }
    return { status: 200, body: rows[0], contentRange };
  }
  return { status: 200, body: rows, contentRange };
}
