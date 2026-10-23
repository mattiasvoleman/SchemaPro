import type { AiEngineConflictDetail } from './interfaces/ai-engine-payload.interface';

/*
 * A RUN'S SENTENCES AS THEY ARE STORED, AND AS A READER IS SHOWN THEM.
 *
 * Generera's job row (OptimizationJobsService) and a schemaförslag's
 * candidate (ScheduleCandidatesService) keep the engine's conflicts, and the
 * gateway's notes about the free-day wishes a timetable breaks
 * (free-day-wishes.ts), in one conflict-shaped JSON entry. What a reader is
 * shown of one is built field by field from it (conflictView), never spread
 * from it, so a field kept for the server — the teachers in `subjectIds` —
 * cannot leave beside one that may. Here so both services read a note by the
 * one rule without importing each other.
 */

/**
 * What of a refusal the job row keeps: the category, the sentence, and the
 * names of the groups the sentence is about. Not the id arrays — they are
 * meaningless once the run is over, and were meaningless before too, when
 * they were the engine's anonymous ones.
 */
export interface StoredConflict {
  category: AiEngineConflictDetail['category'];
  /**
   * The sentence's name and values, so the screen renders it in the reader's
   * language. Optional because a row written before the engine named its
   * sentences has neither, and the screen then shows `message` — the same
   * path a sentence takes when the web has no translation for it yet.
   */
  code?: string;
  params?: Record<string, string | number>;
  message: string;
  resourceNames: string[];
  /**
   * SERVER-ONLY: whose post a days-bearing sentence names, as Users ids
   * (work-days.ts). Kept, unlike the id arrays, because the sentence was
   * stored without its figure and the post is where a reader with HR-läs is
   * shown it from; never in a view (conflictView is a whitelist). On a note,
   * whose free-day wish it was (free-day-wishes.ts), named when it is read.
   */
  subjectIds?: string[];
}

/** One sentence as a reader is shown it: StoredConflict's whitelist. */
export interface ConflictView {
  category: AiEngineConflictDetail['category'];
  code?: string;
  params?: Record<string, string | number>;
  message: string;
  resourceNames: string[];
}

/**
 * A stored params blob, read back as the scalars the engine promised.
 *
 * Prisma hands a Json column back as `unknown`, and the column is written by
 * this service alone — but a hand-edited row must not put an object where a
 * message expects a number, because next-intl renders that as [object Object]
 * in the middle of a school's refusal. Anything that is not a scalar is
 * dropped, and the sentence falls back to the engine's English.
 */
export function asParams(value: unknown): Record<string, string | number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const params: Record<string, string | number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' || typeof entry === 'number') params[key] = entry;
  }
  return params;
}

/**
 * The teachers a stored params blob, or a stored conflict or note, is about,
 * from its server-only key.
 *
 * A run's row has one column per part of a refusal and none for whose post
 * the summary or the error names, so those ride inside their own params blob
 * under `subjectIds` — an array, which asParams drops, so it never reaches a
 * reader. A conflict and a note keep them beside their params instead
 * (StoredConflict). Only strings: a hand-edited row with anything else in the
 * list must not reach a read as a teacher.
 */
export function subjectsOf(stored: unknown): string[] {
  const ids = (stored as { subjectIds?: unknown } | null | undefined)?.subjectIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/** One conflict-shaped entry of the engine's answer, as a job row keeps it, and a candidate its notes. */
export function storedOf(detail: AiEngineConflictDetail): StoredConflict {
  return {
    category: detail.category,
    code: detail.code,
    params: detail.params ?? {},
    message: detail.message,
    resourceNames: detail.resourceNames ?? [],
    ...(detail.subjectIds && detail.subjectIds.length > 0 ? { subjectIds: detail.subjectIds } : {}),
  };
}

/** A stored list of conflict-shaped entries; anything but a list is none. */
export function entriesOf(value: unknown): Partial<StoredConflict>[] {
  return Array.isArray(value) ? (value as Partial<StoredConflict>[]) : [];
}

/** A stored conflict-shaped entry, through the whitelist and nothing else. */
export function conflictView(entry: Partial<StoredConflict>): ConflictView {
  const params = asParams(entry.params);
  return {
    category: entry.category as ConflictView['category'],
    ...(typeof entry.code === 'string' ? { code: entry.code } : {}),
    ...(params !== null ? { params } : {}),
    message: entry.message as string,
    // Rows written before names were kept carry none; read as an empty
    // list rather than as undefined, which the page would have to guard.
    resourceNames: entry.resourceNames ?? [],
  };
}

/** Users rows as the names a view puts beside a sentence: first and last, as the days sentence's. */
export function namesOf(rows: ReadonlyArray<{ id: string; firstName: string; lastName: string }>): ReadonlyMap<string, string> {
  return new Map(rows.map((row) => [row.id, `${row.firstName} ${row.lastName}`]));
}

/** The teachers stored notes are about: whom their view names (notesViewOf). Anything but a list is nobody. */
export function notedTeachersOf(stored: unknown): string[] {
  return entriesOf(stored).flatMap(subjectsOf);
}

/**
 * Stored notes as a reader is shown them: each through the whitelist, and
 * whose wish it was beside the sentence, as a conflict's classes are — after
 * any name the note kept, the name the school gives the teacher now (`names`,
 * Users id → first and last name), never a stored copy. A teacher not in
 * `names` — gone, or a row naming somebody another school has — is named by
 * nobody. Anything but a list is none.
 */
export function notesViewOf(stored: unknown, names: ReadonlyMap<string, string>): ConflictView[] {
  return entriesOf(stored).map((entry) => {
    const note = conflictView(entry);
    const named = subjectsOf(entry).flatMap((id) => names.get(id) ?? []);
    return { ...note, resourceNames: [...note.resourceNames, ...named] };
  });
}
