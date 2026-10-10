import { createHash } from 'node:crypto';

/**
 * Ids as the v2.0 provider emits and accepts them.
 *
 * S1 L5061 (Person.id): "Ett objekt ska ha samma överförings-ID mellan
 * samtliga ingående system och således är det ett enda namespace för de
 * gemensamma ID:na." Hence:
 *
 *   * a linked person or group is emitted under the SOURCE's id
 *     (Users.ss12000Id / StudentGroups.ss12000Id), anything else under
 *     SchemaPro's own (ids-space.ts);
 *   * an object SchemaPro derives and has no row of its own for — today the
 *     Activity of an ad-hoc lesson, which S1's CalendarEvent.activity
 *     requires — gets a name-based UUID (RFC 4122 §4.3, version 5, SHA-1)
 *     in a namespace of SchemaPro's, never the id of the row it is derived
 *     from: one uuid as both a CalendarEvent and an Activity would be two
 *     objects under one id in that single namespace.
 *
 * Incoming ids (path, filters, lookups) are uuids of ANY RFC 4122 version
 * and are compared lowercased: IST's ids are not promised to be version 4,
 * so the house's ParseUUIDPipe({ version: '4' }) is not used here.
 */

/** SchemaPro's namespace for derived SS12000 objects (a fixed, random v4). */
export const SCHEMAPRO_SS12000_NAMESPACE = '5c1e2f7a-0b94-4d3e-9a51-7c2d8e6f4b10';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The id lowercased, if it is an RFC 4122 uuid of any version; else null. */
export function normaliseUuid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase();
  return UUID.test(lower) ? lower : null;
}

/** RFC 4122 version 5 (SHA-1, name-based) of `name` in `namespace`. */
export function uuidV5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(ns).update(Buffer.from(name, 'utf8')).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The Activity id of an ad-hoc lesson (a CalendarLesson with no master and no pending removal). */
export function adhocActivityId(calendarLessonId: string): string {
  return uuidV5(SCHEMAPRO_SS12000_NAMESPACE, `adhoc-activity:${calendarLessonId}`);
}
