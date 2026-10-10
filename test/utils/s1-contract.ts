import { S1_SCHEMAS, type S1Property } from '../../src/integration/ss12000-v2/s1-provider.generated';

/**
 * Walks a value against an S1 schema (s1-provider.generated.ts) and returns
 * every violation as a path and a reason: a key S1 does not define, a
 * required key missing, an enum value S1 does not list, a uuid, date,
 * date-time or email that is not one, an array below its minItems, a type
 * that is not S1's. The contract specs assert the list is empty for every
 * object the provider emits; the e2e suite does the same over HTTP.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkProperty(value: unknown, property: S1Property, path: string, out: string[]): void {
  if (value === null) {
    if (!property.nullable) out.push(`${path}: null`);
    return;
  }
  switch (property.kind) {
    case 'object':
      if (property.ref) checkSchema(value, property.ref, path, out);
      else if (typeof value !== 'object' || Array.isArray(value)) out.push(`${path}: not an object`);
      return;
    case 'array':
      if (!Array.isArray(value)) {
        out.push(`${path}: not an array`);
        return;
      }
      if (property.minItems !== undefined && value.length < property.minItems) out.push(`${path}: fewer than ${property.minItems}`);
      value.forEach((item, at) => checkProperty(item, property.items!, `${path}[${at}]`, out));
      return;
    case 'string':
      if (typeof value !== 'string') {
        out.push(`${path}: not a string`);
        return;
      }
      if (property.enum && !property.enum.includes(value)) out.push(`${path}: ${value} is not in ${property.enumName ?? 'the enum'}`);
      if (property.format === 'uuid' && !UUID.test(value)) out.push(`${path}: not a uuid`);
      if (property.format === 'date' && !DATE.test(value)) out.push(`${path}: not a date`);
      if (property.format === 'date-time' && !DATE_TIME.test(value)) out.push(`${path}: not a date-time`);
      if (property.format === 'email' && !EMAIL.test(value)) out.push(`${path}: not an email`);
      return;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) out.push(`${path}: not an integer`);
      else if (property.minimum !== undefined && value < property.minimum) out.push(`${path}: below ${property.minimum}`);
      return;
    case 'number':
      if (typeof value !== 'number') out.push(`${path}: not a number`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') out.push(`${path}: not a boolean`);
      return;
    default:
      out.push(`${path}: unknown kind`);
  }
}

export function checkSchema(value: unknown, schemaName: string, path = schemaName, out: string[] = []): string[] {
  const schema = S1_SCHEMAS[schemaName];
  if (!schema) {
    out.push(`${path}: no S1 schema ${schemaName}`);
    return out;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    out.push(`${path}: not an object`);
    return out;
  }
  const record = value as Record<string, unknown>;
  for (const key of schema.required) if (record[key] === undefined) out.push(`${path}.${key}: required, missing`);
  for (const [key, item] of Object.entries(record)) {
    const property = schema.properties[key];
    if (!property) {
      out.push(`${path}.${key}: not an S1 property of ${schemaName}`);
      continue;
    }
    if (item === undefined) {
      out.push(`${path}.${key}: undefined`);
      continue;
    }
    checkProperty(item, property, `${path}.${key}`, out);
  }
  return out;
}

/** Every key of every object in a value, recursively: for the privacy scans. */
export function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => allKeys(item, out));
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      allKeys(item, out);
    }
  }
  return out;
}
