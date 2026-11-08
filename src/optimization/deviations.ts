import { createHash } from 'node:crypto';
import type { AiEngineConflictDetail } from './interfaces/ai-engine-payload.interface';
import {
  asParams,
  entriesOf,
  subjectsOf,
  type ConflictView,
  type StoredConflict,
} from './stored-conflicts';
import { DEVIATION_WORK_DAYS_HIDDEN_MESSAGE, TEACHER_WORK_DAYS_HIDDEN, isDaysBearing } from './work-days';

/**
 * BÄSTA MÖJLIGA SCHEMA: THE RULES THAT GAVE WAY, AS A CANDIDATE KEEPS THEM, AS A
 * READER IS SHOWN THEM, AND AS AN ADMINISTRATOR ACCEPTS THEM.
 *
 * With `relaxation: { mode: "BEST_EFFORT" }` the engine places a week whose
 * rules cannot all hold, by turning five of the school's own shaping rules
 * from rows into prices (optimization-engine/app/solver/relaxation.py), and
 * answers with the timetable and `deviations`: one line per rule and place
 * that the timetable breaks, with how far and the value the rule would need
 * for this very timetable to hold. A deviation is a measured breach of a rule
 * the school wrote, not a refusal and not a proof; it never appears under
 * `conflicts`, and a candidate that carries any is applied only when an
 * administrator has accepted exactly that list (ScheduleCandidatesService.apply).
 *
 * THE FIVE, by the engine's code, and what each names:
 *
 *   DEVIATION_TEACHER_DAILY_CAP    a teacher's cap of minutes a day (the work
 *                                  rule's id in `rule`, the teacher beside it)
 *   DEVIATION_TEACHER_WORK_DAYS    a part-timer's days (the post's id in
 *                                  `limit`)
 *   DEVIATION_SUBJECT_PER_DAY      a subject's cap per day (a requirement)
 *   DEVIATION_SUBJECT_DAYS_APART   a subject's days apart (a requirement)
 *   DEVIATION_ROOM_LOCK            a subject's locked rooms (a requirement)
 *
 * STORED AS THE REFUSALS ARE, with the three differences a deviation has:
 *
 * - IT IS A LIST OF ITS OWN (ScheduleCandidates."deviations"), because it is
 *   what the school accepts and the candidate's `conflicts` is what stopped
 *   a timetable. Null: the candidate did not come from the mode. Empty: the
 *   mode ran and nothing gave way.
 * - THE TEACHER A CAP IS ABOUT RIDES AS A USERS ID in the server-only
 *   `subjectIds`, named when the page reads it (deviationsViewOf) and never
 *   stored as a name, as a free-day note keeps its teacher. The cap is no HR
 *   fact: it is on the work rule, which every member of staff reads.
 * - A SENTENCE ABOUT A PART-TIMER'S DAYS IS STORED IN ITS HIDDEN FORM, for
 *   every reader. Its code carries WORK_DAYS, so it is held to the rule every
 *   sentence about a post's days is held to (work-days.ts): the figure is HR
 *   data, the post is the one place it lives, and a candidate is read on a
 *   page with no HR path and no Läslogg row. Stored, it is the hidden
 *   sentence with no figure, no post and no teacher, its category kept, and
 *   its English the deviation's own (DEVIATION_WORK_DAYS_HIDDEN_MESSAGE): the
 *   refusals' hidden sentence says the limit is a reason the timetable could
 *   not be made, which a timetable that was made does not. Its params are
 *   emptied whole and not only of `days`: `taught` less `over` would give the
 *   figure back.
 *
 * NO PERSON'S NAME IS EVER STORED in a deviation. The sentences name a
 * requirement ("Matematik för 7B"), a room, a weekday and numbers; the
 * teacher is an id.
 */

/** The category the engine gives a deviation (optimization-engine/app/schemas/schedule.py). */
export const DEVIATION_CATEGORY = 'DEVIATION' as const;

export const DEVIATION_TEACHER_DAILY_CAP = 'DEVIATION_TEACHER_DAILY_CAP' as const;
export const DEVIATION_TEACHER_WORK_DAYS = 'DEVIATION_TEACHER_WORK_DAYS' as const;
export const DEVIATION_SUBJECT_PER_DAY = 'DEVIATION_SUBJECT_PER_DAY' as const;
export const DEVIATION_SUBJECT_DAYS_APART = 'DEVIATION_SUBJECT_DAYS_APART' as const;
export const DEVIATION_ROOM_LOCK = 'DEVIATION_ROOM_LOCK' as const;

/** Every code the engine's mode reports (relaxation.RELAXABLE_RULES), in the engine's order of mildness. */
export const DEVIATION_CODES: readonly string[] = [
  DEVIATION_SUBJECT_DAYS_APART,
  DEVIATION_SUBJECT_PER_DAY,
  DEVIATION_ROOM_LOCK,
  DEVIATION_TEACHER_DAILY_CAP,
  DEVIATION_TEACHER_WORK_DAYS,
];

/**
 * A deviation as the gateway keeps it between the engine's answer and the
 * candidate row: realised (ids turned back into names), not yet stored.
 * One shape with a conflict, so the helpers of stored-conflicts.ts read it.
 */
export type RealisedDeviation = AiEngineConflictDetail;

/**
 * A deviation as the candidate row keeps it. A part-timer's days are the
 * hidden sentence; the cap keeps its teacher in `subjectIds`; every other
 * deviation is the engine's line with its names put back.
 */
export function storedDeviationOf(detail: RealisedDeviation): StoredConflict {
  if (isDaysBearing(detail.code)) {
    return { category: DEVIATION_CATEGORY, code: TEACHER_WORK_DAYS_HIDDEN, params: {}, message: DEVIATION_WORK_DAYS_HIDDEN_MESSAGE, resourceNames: [] };
  }
  return {
    category: DEVIATION_CATEGORY,
    code: detail.code,
    params: detail.params ?? {},
    message: detail.message,
    resourceNames: detail.resourceNames ?? [],
    ...(detail.code === DEVIATION_TEACHER_DAILY_CAP && detail.subjectIds && detail.subjectIds.length > 0
      ? { subjectIds: [...detail.subjectIds] }
      : {}),
  };
}

/** The engine's `deviations` as the candidate row stores them. */
export function storedDeviationsOf(details: readonly RealisedDeviation[]): StoredConflict[] {
  return details.map(storedDeviationOf);
}

/** The teachers a stored list's caps are about: whom the view names (deviationsViewOf). */
export function deviationTeachersOf(stored: unknown): string[] {
  return entriesOf(stored)
    .filter((entry) => entry.code === DEVIATION_TEACHER_DAILY_CAP)
    .flatMap(subjectsOf);
}

/**
 * A stored list as a reader is shown it: each entry through the whitelist,
 * and the cap's `rule` (a work rule's id, which no screen resolves) said as
 * the teacher it belongs to, wherever the sentence and its fallback print it.
 * A teacher not in `names` — since removed, or one the caller left out (a
 * person with a protected identity is named by nobody) — leaves the id where
 * it was, as a refusal about a work rule has always shown it.
 *
 * Null when the column holds nothing that is a list: a candidate that did
 * not come from the mode, a candidate with no timetable, and a hand-edited
 * value say nothing about deviations, which is different from saying none.
 */
export function deviationsViewOf(stored: unknown, names: ReadonlyMap<string, string>): ConflictView[] | null {
  if (!Array.isArray(stored)) return null;
  return entriesOf(stored).map((entry): ConflictView => {
    const params = asParams(entry.params);
    const teacher = subjectsOf(entry).map((id) => names.get(id)).find((name): name is string => name !== undefined);
    const rule = entry.code === DEVIATION_TEACHER_DAILY_CAP ? params?.['rule'] : undefined;
    // The cap's sentence says whose it is only when the id is a string to put a name in place of, and a name is known.
    const said = typeof rule === 'string' && teacher !== undefined ? { rule, teacher } : null;
    return {
      category: entry.category as ConflictView['category'],
      ...(typeof entry.code === 'string' ? { code: entry.code } : {}),
      ...(params !== null ? { params: said ? { ...params, rule: said.teacher } : params } : {}),
      message: said && typeof entry.message === 'string' ? entry.message.split(said.rule).join(said.teacher) : (entry.message as string),
      resourceNames: [...(entry.resourceNames ?? [])],
    };
  });
}

/** Keys sorted at every depth, so two equal values print alike. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

/**
 * THE DIGEST OF A CANDIDATE'S DEVIATIONS: what an administrator accepts, and
 * what the apply compares it with.
 *
 * sha256 (hex) over the candidate's id and, for each deviation in the order
 * the row keeps them, the sentence's code, its scalar params and the names it
 * puts beside it, keys sorted. The sentence's English and the server-only
 * `subjectIds` are not in it: the first is the code and params said another
 * way, and the second is a person the page names when it reads, so a rename
 * moves no digest. The candidate's id is, so a digest accepted for one
 * candidate is accepted for no other, whatever the two lists say.
 *
 * Null when there is nothing to accept: no list, or an empty one. The apply
 * asks for the digest of exactly the row it is about to write from, so a
 * value read out of the page, or a row changed by hand since, differs.
 */
export function deviationsDigestOf(candidateId: string, stored: unknown): string | null {
  if (!Array.isArray(stored) || stored.length === 0) return null;
  const lines = entriesOf(stored).map((entry) => ({
    category: entry.category,
    code: entry.code ?? null,
    params: asParams(entry.params) ?? {},
    resourceNames: entry.resourceNames ?? [],
  }));
  return createHash('sha256').update(JSON.stringify(canonical({ v: 1, candidate: candidateId, deviations: lines }))).digest('hex');
}

/** How many deviations a stored list holds; a value that is no list holds none. */
export function deviationCountOf(stored: unknown): number {
  return Array.isArray(stored) ? stored.length : 0;
}

/**
 * The accepted list as the change log keeps it (the REGENERATE entry's
 * `after`): the whitelist of a stored entry and nothing else. NOT the
 * `subjectIds` of the candidate's copy, because `after` is JSON that no
 * person-removal reaches by column, and not a name. Who accepted is the
 * entry's own actorId, and when is its createdAt.
 */
export function acceptedDeviationsOf(stored: unknown): Array<Pick<StoredConflict, 'category' | 'code' | 'params' | 'message' | 'resourceNames'>> {
  return entriesOf(stored).map((entry) => ({
    category: entry.category as StoredConflict['category'],
    ...(typeof entry.code === 'string' ? { code: entry.code } : {}),
    params: asParams(entry.params) ?? {},
    message: entry.message as string,
    resourceNames: [...(entry.resourceNames ?? [])],
  }));
}
