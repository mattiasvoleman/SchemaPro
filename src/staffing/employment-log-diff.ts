/*
 * What one version of a tjänst changed, field by field — for the Historik card
 * and for the protokoll that cites it.
 *
 * A log row (TeacherEmploymentLogs, migration 20261010090000) holds the row
 * before and after as JSON. The card reads "Tjänst: tjänstgöringsgrad 100 →
 * 80 %", so the answer is the list of fields that differ, in a FIXED order —
 * the order the drawer's form lists them — rather than whatever order the
 * JSON's keys came in: two reads of one version must read alike, and a
 * protokoll citing "version 7" must find the same sentence there next year.
 *
 *   CREATE  every field the row was created with (before null)
 *   UPDATE  the fields whose value changed
 *   DELETE  every field the row had (after null)
 *
 * A note's TEXT is never in the log (migration 20261010090000: free HR text
 * must stay correctable on the row); a version whose note was written or
 * changed carries `noteChanged: true` in its after, and that is the change
 * listed, in the place the note has in the form.
 *
 * The row's own identity (id, userId, academicYearId) is not a change: the
 * log row carries the teacher and the year, and entityId the row. A key this
 * list does not know — a column added after Fas 3 — goes last, alphabetically,
 * and is never dropped: the history must not hide a change because its
 * reader is older than the write.
 *
 * PURE. Values are passed through as the JSON holds them (numbers, strings,
 * booleans, null); the web formats them.
 */

export type LogEntity = 'EMPLOYMENT' | 'DUTY';

export interface LogChange {
  field: string;
  before: unknown;
  after: unknown;
}

export const EMPLOYMENT_FIELDS = [
  'employmentPercent',
  'reductionPercent',
  'contractKind',
  'teachingTargetMinutesPerWeek',
  'signature',
  'noteChanged',
] as const;

export const DUTY_FIELDS = [
  'kind',
  'label',
  'minutesPerWeek',
  'countsAsTeaching',
  'subjectId',
  'studentGroupId',
  'blockedConstraintId',
  'noteChanged',
] as const;

const IDENTITY = new Set(['id', 'userId', 'academicYearId', 'schoolId', 'createdAt', 'updatedAt']);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function diffLogEntry(entity: LogEntity, before: unknown, after: unknown): LogChange[] {
  const old = asRecord(before);
  const next = asRecord(after);
  const known: readonly string[] = entity === 'EMPLOYMENT' ? EMPLOYMENT_FIELDS : DUTY_FIELDS;
  const present = new Set([...Object.keys(old ?? {}), ...Object.keys(next ?? {})]);
  const unknown = [...present].filter((key) => !known.includes(key) && !IDENTITY.has(key)).sort();
  const changes: LogChange[] = [];
  for (const field of [...known.filter((key) => present.has(key)), ...unknown]) {
    const was = old ? (old[field] ?? null) : null;
    const is = next ? (next[field] ?? null) : null;
    // A created or deleted row states every field it had; an update only what moved.
    if (old && next && same(was, is)) continue;
    changes.push({ field, before: was, after: is });
  }
  return changes;
}
