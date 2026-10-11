import { normaliseUuid } from './ids';
import { S1_OPERATIONS, type S1QueryParameter } from './s1-provider.generated';
import { v2Errors } from './errors';

/**
 * The query string of a v2.0 list, item or lookup operation, held to S1.
 *
 * EVERY PARAMETER S1 DEFINES FOR THE OPERATION IS ACCEPTED (A1.3): a
 * consumer's generated client sends standard filters, and refusing one
 * breaks it. A filter on an attribute SchemaPro never holds (civicNo,
 * identifier.*, organisationCode, municipalityCode, parent, the placement
 * relationship types) is answered with an empty page by the resource — the
 * truth, not an invention. A parameter S1 does NOT define for the operation,
 * or a value that is not what S1's schema says (a uuid, an RFC 3339 date or
 * date-time, an enum value, a boolean, an integer of at least the minimum),
 * is 400 INVALID_FILTER. Values are never echoed in a message.
 *
 * Arrays follow OpenAPI 3.0's default for a query array (style form,
 * explode true): `?groupType=Klass&groupType=Undervisning`. A single-valued
 * parameter sent twice is a 400.
 *
 * PAGING (S1 limit/pageToken). limit is an integer >= 1; omitted, the server
 * picks (S1: "så många poster som möjligt"): DEFAULT_LIMIT, and never more
 * than MAX_LIMIT. pageToken is opaque: base64url of {v, k: key id, r:
 * operation, p: the normalised parameters, a: [sort value, id] of the last
 * item}. S1: a token "kan inte kombineras med andra filter men väl med
 * limit". Generated clients always send REQUIRED parameters (calendarEvents'
 * startTime.onOrAfter/onOrBefore), so with a token every other parameter is
 * optional, and one that IS repeated must equal the token's (A1.1): the
 * token governs, only limit may change between pages. A token of another
 * key or operation, or that does not parse, is 400 INVALID_PAGE_TOKEN. It
 * is not signed: it can only restate parameters the key may send anyway,
 * for its own school, and it is validated as strictly as the query.
 */

export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 1000;

export type ParamValue = string | string[] | boolean | number;
export type Params = Record<string, ParamValue>;

export interface ParsedQuery {
  params: Params;
  limit: number;
  /** The keyset position after which this page starts (from the token). */
  after: [string | number | null, string] | null;
}

interface TokenBody {
  v: 1;
  k: string;
  r: string;
  p: Params;
  a: [string | number | null, string];
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/i;

function validDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const day = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

function one(name: string, spec: S1QueryParameter, raw: string): ParamValue {
  if (raw.length > 512) throw v2Errors.invalidFilter(name);
  switch (spec.type) {
    case 'boolean':
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw v2Errors.invalidFilter(name);
    case 'integer': {
      if (!/^\d{1,9}$/.test(raw)) throw v2Errors.invalidFilter(name);
      const value = Number(raw);
      if (spec.minimum !== undefined && value < spec.minimum) throw v2Errors.invalidFilter(name);
      return value;
    }
    default:
      break;
  }
  if (spec.enum) {
    if (!spec.enum.includes(raw)) throw v2Errors.invalidFilter(name);
    return raw;
  }
  if (spec.format === 'uuid') {
    const id = normaliseUuid(raw);
    if (!id) throw v2Errors.invalidFilter(name);
    return id;
  }
  if (spec.format === 'date') {
    if (!validDate(raw)) throw v2Errors.invalidFilter(name);
    return raw;
  }
  if (spec.format === 'date-time') {
    const parsed = new Date(raw);
    if (!DATE_TIME.test(raw) || Number.isNaN(parsed.getTime())) throw v2Errors.invalidFilter(name);
    return parsed.toISOString();
  }
  return raw;
}

/** One parameter's value as S1's schema types it, normalised for comparison. */
function parameter(name: string, spec: S1QueryParameter, raw: unknown): ParamValue {
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.length === 0 || values.length > 50 || !values.every((value) => typeof value === 'string')) {
    throw v2Errors.invalidFilter(name);
  }
  if (!spec.array) {
    if (values.length !== 1) throw v2Errors.invalidFilter(name);
    return one(name, spec, values[0] as string);
  }
  const parsed = (values as string[]).map((value) => one(name, spec, value));
  return [...new Set(parsed.map(String))].sort();
}

const same = (a: ParamValue | undefined, b: ParamValue | undefined) => JSON.stringify(a) === JSON.stringify(b);

export function encodePageToken(keyId: string, operation: string, params: Params, after: [string | number | null, string]): string {
  const body: TokenBody = { v: 1, k: keyId, r: operation, p: params, a: after };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

function decodePageToken(token: string, keyId: string, operation: string): TokenBody {
  if (token.length === 0 || token.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(token)) throw v2Errors.invalidPageToken();
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw v2Errors.invalidPageToken();
  }
  const b = body as Partial<TokenBody> | null;
  if (
    !b ||
    typeof b !== 'object' ||
    b.v !== 1 ||
    b.k !== keyId ||
    b.r !== operation ||
    typeof b.p !== 'object' ||
    b.p === null ||
    Array.isArray(b.p) ||
    !Array.isArray(b.a) ||
    b.a.length !== 2 ||
    typeof b.a[1] !== 'string' ||
    !(b.a[0] === null || typeof b.a[0] === 'string' || typeof b.a[0] === 'number')
  ) {
    throw v2Errors.invalidPageToken();
  }
  return b as TokenBody;
}

/**
 * The parameters of `operation` (an S1_OPERATIONS key such as
 * 'GET /persons') from an Express query object. `keyId` binds a page token
 * to the key that was given it.
 */
export function parseQuery(operation: string, raw: Record<string, unknown>, keyId: string): ParsedQuery {
  const op = S1_OPERATIONS[operation];
  if (!op) throw new Error(`no S1 operation ${operation}`);
  const specs = op.query;
  const given: Params = {};
  for (const [name, value] of Object.entries(raw)) {
    if (name === 'limit' || name === 'pageToken') continue;
    const spec = specs[name];
    if (!spec) throw v2Errors.invalidFilter(name);
    given[name] = parameter(name, spec, value);
  }

  let limit = DEFAULT_LIMIT;
  if (raw['limit'] !== undefined) {
    if (!specs['limit']) throw v2Errors.invalidFilter('limit');
    limit = Math.min(parameter('limit', specs['limit'], raw['limit']) as number, MAX_LIMIT);
  }

  if (raw['pageToken'] === undefined) {
    for (const [name, spec] of Object.entries(specs)) {
      if (spec.required && given[name] === undefined) throw v2Errors.invalidFilter(name);
    }
    return { params: given, limit, after: null };
  }

  if (!specs['pageToken'] || typeof raw['pageToken'] !== 'string') throw v2Errors.invalidPageToken();
  const token = decodePageToken(raw['pageToken'], keyId, operation);
  // The token's own parameters, held to the same rules as a query.
  const params: Params = {};
  for (const [name, value] of Object.entries(token.p)) {
    const spec = specs[name];
    if (!spec || name === 'limit' || name === 'pageToken') throw v2Errors.invalidPageToken();
    const restated = Array.isArray(value) ? value.map(String) : String(value);
    let parsed: ParamValue;
    try {
      parsed = parameter(name, spec, restated);
    } catch {
      throw v2Errors.invalidPageToken();
    }
    if (!same(parsed, value)) throw v2Errors.invalidPageToken();
    params[name] = parsed;
  }
  for (const [name, value] of Object.entries(given)) {
    if (!same(value, params[name])) throw v2Errors.invalidPageToken();
  }
  // A token always carries what the first request had to: one without a
  // required parameter (calendarEvents' window) was never ours.
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.required && params[name] === undefined) throw v2Errors.invalidPageToken();
  }
  return { params, limit, after: token.a };
}

/** The parameters of an item or lookup operation (no paging). */
export function parseItemQuery(operation: string, raw: Record<string, unknown>): Params {
  const op = S1_OPERATIONS[operation];
  if (!op) throw new Error(`no S1 operation ${operation}`);
  const params: Params = {};
  for (const [name, value] of Object.entries(raw)) {
    const spec = op.query[name];
    if (!spec) throw v2Errors.invalidFilter(name);
    params[name] = parameter(name, spec, value);
  }
  return params;
}

/** A list parameter as an array (absent: undefined). */
export function list(params: Params, name: string): string[] | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [String(value)];
}

export function text(params: Params, name: string): string | undefined {
  const value = params[name];
  return typeof value === 'string' ? value : undefined;
}

export function flag(params: Params, name: string): boolean {
  return params[name] === true;
}

// ---------------------------------------------------------------------------
// Sorting and keyset paging, in memory over a school's objects.
// ---------------------------------------------------------------------------

const collator = new Intl.Collator('sv', { sensitivity: 'variant', numeric: false });

export interface SortKey<T> {
  value: (item: T) => string | number | null;
  direction: 1 | -1;
  /** Strings compare with Swedish collation; numbers and ISO dates as they are. */
  collate?: boolean;
}

function compareValues(a: string | number | null, b: string | number | null, collate: boolean): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (collate) {
    const c = collator.compare(String(a), String(b));
    if (c !== 0) return c;
  }
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/**
 * One page: `items` sorted by the key (nulls last), ties by id ascending —
 * the order is total, so a walk neither skips nor repeats an object that
 * does not change during it. Without a sortkey the order is id ascending
 * (A5.9). ModifiedDesc can skip or repeat an object modified mid-walk; that
 * is inherent in sorting by a value that moves, and the docs say so.
 */
export function page<T extends { id: string }>(
  items: readonly T[],
  key: SortKey<T> | null,
  query: ParsedQuery,
  makeToken: (after: [string | number | null, string]) => string,
): { data: T[]; pageToken: string | null } {
  const sortValue = (item: T) => (key ? key.value(item) : null);
  const compare = (av: string | number | null, aid: string, bv: string | number | null, bid: string) => {
    if (key) {
      const c = compareValues(av, bv, key.collate === true);
      if (c !== 0) return c * key.direction;
    }
    return aid < bid ? -1 : aid > bid ? 1 : 0;
  };
  const sorted = [...items].sort((a, b) => compare(sortValue(a), a.id, sortValue(b), b.id));
  const after = query.after;
  const rest = after ? sorted.filter((item) => compare(sortValue(item), item.id, after[0], after[1]) > 0) : sorted;
  const data = rest.slice(0, query.limit);
  const last = data[data.length - 1];
  const more = rest.length > data.length && last !== undefined;
  return { data, pageToken: more ? makeToken([sortValue(last), last.id]) : null };
}
