#!/usr/bin/env node
/*
 * Writes src/integration/ss12000-v2/s1-provider.generated.ts from SIS's
 * SS12000 OpenAPI 2.1.0 (S1). The YAML is not in the repository; fetch it
 * into a directory of its own and pass its path:
 *
 *   curl -o /tmp/s1/openapi.yaml \
 *     https://www.sis.se/globalassets/standardutveckling/tksidor/tk-450/openapi_ss12000_version2_1_0.yaml
 *   node scripts/ss12000/generate-s1-provider.cjs /tmp/s1/openapi.yaml \
 *     src/integration/ss12000-v2/s1-provider.generated.ts
 *
 * The output records the file's sha256; s1-provider.spec.ts pins it to
 * aee9a95a4c5bd25cebaf357d266592f94e9388ae785ee9ac3b58e1992acccd28, the copy
 * the consumer (src/integration/ss12000-sync/s1.ts) was written against.
 */
const path = require('path');
const yaml = require(path.join(__dirname, '..', '..', 'node_modules', 'js-yaml'));
const fs = require('fs');
const crypto = require('crypto');
const file = process.argv[2];
const raw = fs.readFileSync(file);
const sha = crypto.createHash('sha256').update(raw).digest('hex');
const d = yaml.load(raw.toString('utf8'));
const S = d.components.schemas;
const deref = (x) => { if (x && x.$ref) { const parts = x.$ref.replace('#/', '').split('/'); let o = d; for (const p of parts) o = o[p]; return deref(o); } return x; };
const refName = (x) => (x && x.$ref ? x.$ref.split('/').pop() : null);
// Flatten a schema into {properties, required}; allOf merged.
function flat(name) {
  const s = S[name];
  const out = { properties: {}, required: [] };
  const merge = (x) => {
    x = deref(x);
    if (x.allOf) { for (const part of x.allOf) merge(part); return; }
    for (const [k, v] of Object.entries(x.properties || {})) out.properties[k] = v;
    for (const r of x.required || []) if (!out.required.includes(r)) out.required.push(r);
  };
  merge(s);
  return out;
}
function describe(v) {
  // -> {kind, format?, enum?, ref?, items?}
  const rn = refName(v);
  if (rn) {
    const t = deref(v);
    if (t.enum) return { kind: 'string', enum: t.enum, enumName: rn };
    if (t.type === 'array') return { kind: 'array', items: describe(t.items) };
    return { kind: 'object', ref: rn };
  }
  if (v.allOf) { // allOf(ref & {}) used for references with descriptions
    const r = v.allOf.find((x) => x.$ref);
    return describe(r);
  }
  if (v.type === 'array') return { kind: 'array', items: describe(v.items), ...(v.minItems ? { minItems: v.minItems } : {}) };
  const o = { kind: v.type };
  if (v.format) o.format = v.format;
  if (v.enum) o.enum = v.enum;
  if (v.nullable) o.nullable = true;
  if (v.minimum !== undefined) o.minimum = v.minimum;
  return o;
}
const wanted = new Set();
const queue = ['Organisations', 'PersonsExpanded', 'Duties', 'GroupsExpanded', 'Activities', 'CalendarEvents', 'Rooms', 'Syllabuses', 'Subscriptions', 'DeletedEntities', 'CreateSubscription', '_subscriptions_get_request', 'Error', 'IdLookup', '_organisations_lookup_post_request', '_persons_lookup_post_request', '_activities_lookup_post_request', '_calendarEvents_lookup_post_request', 'Subscription'];
const schemas = {};
while (queue.length) {
  const n = queue.shift();
  if (wanted.has(n)) continue;
  wanted.add(n);
  const f = flat(n);
  const props = {};
  for (const [k, v] of Object.entries(f.properties)) {
    const dsc = describe(v);
    props[k] = dsc;
    const walk = (x) => { if (!x) return; if (x.ref) queue.push(x.ref); if (x.items) walk(x.items); };
    walk(dsc);
  }
  schemas[n] = { properties: props, required: f.required };
}
// Parameters per served operation.
const ops = {};
for (const [p, methods] of Object.entries(d.paths)) {
  if (!/^\/(organisations|persons|groups|duties|activities|calendarEvents|rooms|syllabuses|deletedEntities|subscriptions)(\/|$)/.test(p)) continue;
  for (const [m, op] of Object.entries(methods)) {
    if (m === 'parameters') continue;
    const params = [...(methods.parameters || []), ...(op.parameters || [])].map(deref).filter((x) => x.in === 'query');
    const list = {};
    for (const x of params) {
      const s = deref(x.schema || {});
      const array = s.type === 'array';
      const item = array ? deref(s.items) : s;
      list[x.name] = { array, type: item.type, ...(item.format ? { format: item.format } : {}), ...(item.enum ? { enum: item.enum } : {}), ...(x.required ? { required: true } : {}), ...(s.minimum !== undefined ? { minimum: s.minimum } : {}) };
    }
    const responses = {};
    for (const [code, r] of Object.entries(op.responses)) {
      const rr = deref(r);
      const sch = rr.content ? Object.values(rr.content)[0].schema : null;
      responses[code] = sch ? (refName(sch) || 'inline') : null;
    }
    const body = op.requestBody ? refName(Object.values(deref(op.requestBody).content)[0].schema) : null;
    ops[`${m.toUpperCase()} ${p}`] = { query: list, body, responses };
  }
}
const header = `/*
 * GENERATED from S1 by scripts/ss12000/generate-s1-provider.cjs — do not edit
 * by hand (js-yaml over the YAML below, allOf merged, $refs named): every
 * schema the v2.0 provider emits or reads, and every query parameter of every
 * operation it serves, exactly as S1 states them.
 *
 * S1: SIS TK450, "SS12000 OpenAPI 3.0", openapi_ss12000_version2_1_0.yaml,
 * info.version ${d.info.version}, openapi ${d.openapi},
 * https://www.sis.se/globalassets/standardutveckling/tksidor/tk-450/openapi_ss12000_version2_1_0.yaml
 * sha256 ${sha}.
 *
 * Spellings are S1's own, misspellings included: DeletedEntities_data.activitites,
 * the callback body's modifiedEntites. POST /calendarEvents/lookup answers
 * AttendancesArray in S1, an evident slip the provider does not copy (it
 * answers CalendarEvent[]; docs/integration-api.md says so).
 */
/* eslint-disable */
`;
const body = `${header}
export const S1_SHA256 = '${sha}' as const;
export const S1_VERSION = '${d.info.version}' as const;

export interface S1Property {
  kind: 'string' | 'integer' | 'boolean' | 'number' | 'object' | 'array';
  format?: string;
  enum?: readonly string[];
  enumName?: string;
  ref?: string;
  items?: S1Property;
  minItems?: number;
  nullable?: boolean;
  minimum?: number;
}

export interface S1Schema {
  properties: Record<string, S1Property>;
  required: readonly string[];
}

export const S1_SCHEMAS: Record<string, S1Schema> = ${JSON.stringify(schemas, null, 2)};

export interface S1QueryParameter {
  array: boolean;
  type: 'string' | 'integer' | 'boolean';
  format?: string;
  enum?: readonly string[];
  required?: boolean;
  minimum?: number;
}

export interface S1Operation {
  query: Record<string, S1QueryParameter>;
  body: string | null;
  responses: Record<string, string | null>;
}

export const S1_OPERATIONS: Record<string, S1Operation> = ${JSON.stringify(ops, null, 2)};
`;
fs.writeFileSync(process.argv[3], body);
console.log('schemas', Object.keys(schemas).length, 'ops', Object.keys(ops).length, sha);
