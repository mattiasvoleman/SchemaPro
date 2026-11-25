import type { LessonRecurrence } from '@prisma/client';
import type { AiEngineLesson, AnonymousRequirement, AnonymousStartLesson, DayOfWeek } from './interfaces/ai-engine-payload.interface';

/**
 * Ett schema som start (omgång 15, M9): a schedule that already exists, given to the engine as where the week STARTS
 * instead of as locked lessons.
 *
 * WHAT IT IS. The school picks a schedule (this year's grundschema as it stands, last year's, a saved version of this
 * year's, a schedule read in from a file and saved as a version), and Generera sends its lessons as `startLessons`: the
 * post, the weekday, the start and the end. The engine holds each where it was, lets go of what clashes with THIS week
 * (a teacher in two places, a changed class, a new reservation) and lays only that (optimization-engine/app/solver/
 * staged.py). A week that resembles the schedule is laid by changing the few lessons that no longer fit, and the lessons
 * that stay are the ones the school had.
 *
 * NOT A LOCK. A locked lesson (MasterLesson.isLocked) is a fact about the school: it stays, and the posts around it are
 * laid around it. A start is held only until the week shows that the lesson cannot stay. Nothing here writes a lesson as
 * locked, and nothing the school has locked is ever given as a start: a lock is already in the payload as `fixedLessons`.
 *
 * WHAT THIS FILE IS. The two pure halves of the gateway's side, with no database and no engine:
 *   - startLessonsOf: a schedule's lessons, in real ids, as the entries of the posts of THIS week (and what could not be
 *     given, counted by reason, so a schedule that gives nothing can be told why);
 *   - startOutcomeOf: the engine's answer set against the entries, as how many lessons stayed, how many moved and how
 *     many were laid with nothing to start from.
 * The reads that find a schedule's lessons are start-sources.ts, and the wire is optimization-proxy.service.ts.
 */

/** The schedules a run can start from. Absent from a request is today's Generera, which starts from none. */
export const START_SOURCES = ['CURRENT', 'PREVIOUS_YEAR', 'VERSION'] as const;
export type StartSource = (typeof START_SOURCES)[number];

/** What a request for a start says: the source, and which saved version for VERSION. */
export interface StartRequest {
  source: StartSource;
  /** The saved version of THIS year, for source VERSION and for no other. */
  versionId?: string;
}

/**
 * Why a lesson of the schedule was not given as a start. A closed set: it is stored on the run (`startedFrom.dropped`)
 * and the page has a sentence for each, so one added here needs its sentence in web/messages.
 */
export const START_DROP_REASONS = [
  /** The lesson's group has no successor in this year (last year's class that left, an intake the school has no link for). */
  'NO_SUCCESSOR',
  /** This year has no timplanspost for the lesson's group and subject. */
  'NO_POST',
  /** The post is not in this week: its lessons are all locked or placed by hand, so there is nothing to lay. */
  'NOT_IN_WEEK',
  /** The post runs in other weeks than the lesson did (odd or even weeks, or dates that no longer fit this year). */
  'OTHER_WEEKS',
  /** Two posts of the same group and subject run in the lesson's weeks, and nothing says which the lesson belonged to. */
  'AMBIGUOUS',
  /** The post's lessons have their own teachers, or are placed by hand with a pin: the engine does not start those. */
  'NOT_STARTABLE',
  /** The schedule has more lessons of the post than the week asks for. */
  'MORE_THAN_ASKED',
] as const;
export type StartDropReason = (typeof START_DROP_REASONS)[number];

export type StartDropped = Partial<Record<StartDropReason, number>>;

/**
 * One lesson of a schedule that is to be started from, in REAL ids and in the weeks it ran: what every source reads into
 * before the entries are made, so that the mapping to posts is one function and not one per source.
 */
export interface SourceLesson {
  studentGroupId: string;
  subjectId: string;
  dayOfWeek: number;
  /** HH:MM or HH:MM:SS. */
  startTime: string;
  endTime: string;
  /** Null is every week, the reading a snapshot from before the field gets (VersionLesson.recurrence). */
  recurrence: LessonRecurrence | null;
  /** The weeks it ran, YYYY-MM-DD or null for the year's own bound, AS THE POST HAS THEM THIS YEAR (a source of another year maps them first). */
  startDate: string | null;
  endDate: string | null;
}

/** A timplanspost as this fetch read it: what a lesson is matched against. */
export interface StartPost {
  id: string;
  subjectId: string;
  studentGroupId: string;
  recurrence: LessonRecurrence;
  startDate: string | null;
  endDate: string | null;
}

export interface StartMapping {
  entries: AnonymousStartLesson[];
  /** How many lessons the schedule held (those that could be given and those that could not). */
  offered: number;
  dropped: StartDropped;
}

const withSeconds = (clock: string): string => (clock.length === 5 ? `${clock}:00` : clock);

const bump = (dropped: StartDropped, reason: StartDropReason, count = 1): void => {
  dropped[reason] = (dropped[reason] ?? 0) + count;
};

const windowKey = (recurrence: LessonRecurrence | null, startDate: string | null, endDate: string | null): string =>
  `${recurrence ?? 'ALL_WEEKS'}|${startDate ?? ''}|${endDate ?? ''}`;

/**
 * A schedule's lessons as the entries of the posts of this week.
 *
 * A lesson is matched to a post by its group, its subject and the weeks it ran, which is how the lessons a run writes
 * come to have them (a generated lesson inherits its post's window). Matched to exactly one post that is IN the week (the
 * payload sends a post only while some of its lessons are left to lay) and that the engine can start; anything else is
 * left out and counted, because a lesson given for a post it does not belong to is a lesson the engine holds in the wrong
 * place.
 *
 * `payload` is the requirements the engine will be sent, so that a post that is not in the week (fully locked) and a post
 * the engine does not start (split lessons, pinned lessons) are told from one that has no lessons in the schedule.
 * `anonOf` is the fetch's own map from a post's id to the id the engine is sent.
 *
 * At most as many entries for a post as the week asks of it: the engine takes no more, and what it would leave out is
 * counted here by the reason it is, not by the engine's log.
 *
 * `already` is what a source read before the lessons got here: lessons it could not map (a class with no successor) and
 * so never handed on, counted into `offered` and `dropped` as the rest.
 */
export function startLessonsOf(
  posts: readonly StartPost[],
  anonOf: ReadonlyMap<string, string>,
  payload: readonly Pick<AnonymousRequirement, 'id' | 'lessonsPerWeek' | 'lessonTeacherIds' | 'pinnedLessons'>[],
  lessons: readonly SourceLesson[],
  already: { offered: number; dropped: StartDropped } = { offered: 0, dropped: {} },
): StartMapping {
  const dropped: StartDropped = { ...already.dropped };
  const inWeek = new Map(payload.map((requirement) => [requirement.id, requirement]));

  // The posts of one group and subject, by weeks: a lesson names one pair and a window, and the post is the one that has both.
  const byPair = new Map<string, StartPost[]>();
  for (const post of posts) {
    const key = `${post.studentGroupId}:${post.subjectId}`;
    byPair.set(key, [...(byPair.get(key) ?? []), post]);
  }

  const entries: AnonymousStartLesson[] = [];
  const perPost = new Map<string, number>();
  // The same order every time, so that which lessons a post's cap keeps does not depend on how a source listed them.
  const ordered = [...lessons].sort(
    (a, b) =>
      a.studentGroupId.localeCompare(b.studentGroupId) ||
      a.subjectId.localeCompare(b.subjectId) ||
      a.dayOfWeek - b.dayOfWeek ||
      a.startTime.localeCompare(b.startTime),
  );
  for (const lesson of ordered) {
    const pair = byPair.get(`${lesson.studentGroupId}:${lesson.subjectId}`);
    if (pair === undefined) {
      bump(dropped, 'NO_POST');
      continue;
    }
    const weeks = windowKey(lesson.recurrence, lesson.startDate, lesson.endDate);
    const matching = pair.filter((post) => windowKey(post.recurrence, post.startDate, post.endDate) === weeks);
    if (matching.length === 0) {
      bump(dropped, 'OTHER_WEEKS');
      continue;
    }
    if (matching.length > 1) {
      bump(dropped, 'AMBIGUOUS');
      continue;
    }
    const post = matching[0]!;
    const anon = anonOf.get(post.id);
    const sent = anon === undefined ? undefined : inWeek.get(anon);
    if (anon === undefined || sent === undefined) {
      bump(dropped, 'NOT_IN_WEEK');
      continue;
    }
    if (sent.lessonTeacherIds !== undefined || sent.pinnedLessons !== undefined) {
      bump(dropped, 'NOT_STARTABLE');
      continue;
    }
    const taken = perPost.get(anon) ?? 0;
    if (taken >= sent.lessonsPerWeek) {
      bump(dropped, 'MORE_THAN_ASKED');
      continue;
    }
    perPost.set(anon, taken + 1);
    entries.push({
      requirementId: anon,
      dayOfWeek: lesson.dayOfWeek as DayOfWeek,
      startTime: withSeconds(lesson.startTime),
      endTime: withSeconds(lesson.endTime),
    });
  }
  return { entries, offered: already.offered + lessons.length, dropped };
}

/** What a run that started from a schedule did with it, counted from the engine's answer. */
export interface StartOutcome {
  /** Lessons of the answer that stand where the schedule had them. */
  held: number;
  /** Lessons the schedule had that the answer put at another time. */
  moved: number;
  /** Lessons of the answer that had no lesson of the schedule to replace: the post had none, or fewer than the week asks. */
  laid: number;
}

/**
 * The answer set against the entries, post by post. A lesson of the answer at the very time an entry of its post had is
 * HELD; of what is left on both sides, as many as there are on the shorter side are MOVED (an entry that did not stay and
 * a lesson that stands elsewhere are one lesson that moved), and the rest of the answer is LAID.
 *
 * Counted from the answer and the entries alone, which both leave the gateway's hands unchanged, so a count cannot
 * disagree with what was written: the lessons written are the answer's.
 */
export function startOutcomeOf(
  entries: readonly AnonymousStartLesson[],
  answer: readonly Pick<AiEngineLesson, 'requirementId' | 'dayOfWeek' | 'startTime' | 'endTime'>[],
): StartOutcome {
  const key = (lesson: { dayOfWeek: number; startTime: string; endTime: string }): string =>
    `${lesson.dayOfWeek}|${withSeconds(lesson.startTime)}|${withSeconds(lesson.endTime)}`;
  const started = new Map<string, Map<string, number>>();
  for (const entry of entries) {
    const times = started.get(entry.requirementId) ?? new Map<string, number>();
    times.set(key(entry), (times.get(key(entry)) ?? 0) + 1);
    started.set(entry.requirementId, times);
  }
  const placed = new Map<string, Map<string, number>>();
  for (const lesson of answer) {
    const times = placed.get(lesson.requirementId) ?? new Map<string, number>();
    times.set(key(lesson), (times.get(key(lesson)) ?? 0) + 1);
    placed.set(lesson.requirementId, times);
  }

  let held = 0;
  let moved = 0;
  let laid = 0;
  for (const [requirementId, times] of placed) {
    const had = started.get(requirementId) ?? new Map<string, number>();
    let stayed = 0;
    let placedHere = 0;
    for (const [time, count] of times) {
      placedHere += count;
      stayed += Math.min(count, had.get(time) ?? 0);
    }
    let startedHere = 0;
    for (const count of had.values()) startedHere += count;
    const movedHere = Math.min(startedHere - stayed, placedHere - stayed);
    held += stayed;
    moved += movedHere;
    laid += placedHere - stayed - movedHere;
  }
  return { held, moved, laid };
}

/**
 * What a run stores of its start and the page reads back (OptimizationJobs.startedFrom): a small closed object, with no
 * lesson and no name of a person in it. `held`, `moved` and `laid` are null when the run laid nothing (a refused week, a
 * TIMEOUT) or when the engine was older than the field and the week was laid from nothing.
 */
export interface StartedFrom {
  source: StartSource;
  /** The name the school gave the saved version, for source VERSION. */
  versionName: string | null;
  /**
   * USED: the engine was given the schedule. OLDER: the engine predates `startLessons` and the week was laid as Generera
   * lays it with no start, which the page says rather than let a school believe the schedule was held.
   */
  engine: 'USED' | 'OLDER';
  /** Lessons the schedule held. */
  offered: number;
  /** Lessons given to the engine as a start. */
  used: number;
  held: number | null;
  moved: number | null;
  laid: number | null;
  dropped: StartDropped;
}

/** The longest a version's name is kept: it is the school's own text, stored on a row the page reads. */
export const START_VERSION_NAME_MAX = 120;

const COUNT_MAX = 1_000_000;

const countOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= COUNT_MAX ? value : null;

/**
 * A stored `startedFrom` as the page may read it, or null: every field checked, every unknown key dropped, a source or a
 * reason this gateway does not know left out (a row an older or a newer API wrote). Never the column as it stands.
 */
export function startedFromOf(stored: unknown): StartedFrom | null {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return null;
  const row = stored as Record<string, unknown>;
  const source = START_SOURCES.find((candidate) => candidate === row['source']);
  const engine = row['engine'] === 'USED' || row['engine'] === 'OLDER' ? row['engine'] : null;
  const offered = countOf(row['offered']);
  const used = countOf(row['used']);
  if (source === undefined || engine === null || offered === null || used === null) return null;
  const dropped: StartDropped = {};
  const given = row['dropped'];
  if (typeof given === 'object' && given !== null && !Array.isArray(given)) {
    for (const reason of START_DROP_REASONS) {
      const count = countOf((given as Record<string, unknown>)[reason]);
      if (count !== null && count > 0) dropped[reason] = count;
    }
  }
  const name = row['versionName'];
  return {
    source,
    versionName: typeof name === 'string' && name.length > 0 ? name.slice(0, START_VERSION_NAME_MAX) : null,
    engine,
    offered,
    used,
    held: countOf(row['held']),
    moved: countOf(row['moved']),
    laid: countOf(row['laid']),
    dropped,
  };
}
