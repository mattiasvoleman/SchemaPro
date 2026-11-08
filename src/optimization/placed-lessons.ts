import type { LessonRecurrence } from '@prisma/client';
import { placedLessonsOf } from '../requirement-placements/placement-fit';
import type { PlacementVerdict } from '../requirement-placements/placement-judge';
import type {
  AiEngineConflictAnalysis,
  AiEngineConflictDetail,
} from './interfaces/ai-engine-payload.interface';

/*
 * FÖRLAGDA POSTER IN GENERERA: a förläggning as the lock it is to the week.
 *
 * A förläggning (TeachingRequirementPlacement) is one of a timplanspost's
 * lessons the school placed before Generera. To the engine it is what a lesson
 * locked in the grundschema has always been, so the fetch reads each as one:
 * a row of the shape the preserved masters are read in, beside them, and every
 * reader of those — the fixed lessons, the groups at school, the pupils'
 * cohorts, the shared rooms' seats, the post's locked days, a teacher's
 * weekdays — reads it with no second path. Two things differ, and they are
 * here:
 *
 *  1. WHAT IT TAKES OFF THE POST. A preserved lesson cancels a lesson of its
 *     post only when it runs the post's weeks (lockCoversDemand); a
 *     förläggning of odd weeks on an every-week post cancels one TOGETHER with
 *     its even partner (placedLessonsOf, the pair). So a placed row is never
 *     read as a covering lock, and the post loses `placedMinutesOf` instead,
 *     after its locks (withoutPlaced, the order placementsFitBesideLocks
 *     judges in).
 *  2. WHERE IT ENDS. Not a preserved row: a placed lesson is written by the
 *     run, locked and marked as Generera's own (MasterLesson.fromPlacement),
 *     so the next run writes it again from the förläggning as it then stands.
 *     It is kept apart from `preservedRows`, which the candidate basis and an
 *     apply compare with the preserved masters in the database, and it is
 *     written by writeRegeneration beside the engine's lessons.
 */

/** A förläggning as the fetch reads it. */
export interface PlacementRead {
  id: string;
  requirementId: string;
  dayOfWeek: number;
  /** TIME(0), midnight UTC. */
  startTime: Date;
  minutes: number;
  roomId: string;
  recurrence: LessonRecurrence;
}

/** The post's fields a placed lesson takes: who sits it, who teaches it, its window. */
export interface PlacedPost {
  id: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  recurrence: LessonRecurrence;
  startDate: Date | null;
  endDate: Date | null;
}

/**
 * A förläggning as a lock: the preserved masters' shape, so the fetch reads it
 * where it reads them. `id` is the förläggning's own (a placed lesson has no
 * master until the run writes it); no extra class and no named pupil, since
 * the lesson is the post's.
 */
export interface PlacedLessonRow {
  id: string;
  /** The förläggning's post. */
  requirementId: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string;
  dayOfWeek: number;
  startTime: Date;
  endTime: Date;
  recurrence: LessonRecurrence;
  startDate: Date | null;
  endDate: Date | null;
  minutes: number;
  extraGroups: { studentGroupId: string }[];
  participants: { studentId: string }[];
}

/**
 * The förläggningar of the year's posts as locks, in a stable order (post, day,
 * clock, id) so two reads of one school send the same payload in the same
 * order. A row whose post is not among `posts` is left out: the posts are the
 * year's (the key says so), and one missing is a post the fetch did not read.
 */
export function placedLessonRowsOf(
  placements: readonly PlacementRead[],
  posts: ReadonlyMap<string, PlacedPost>,
): PlacedLessonRow[] {
  return placements
    .flatMap((row): PlacedLessonRow[] => {
      const post = posts.get(row.requirementId);
      if (!post) return [];
      return [
        {
          id: row.id,
          requirementId: row.requirementId,
          subjectId: post.subjectId,
          studentGroupId: post.studentGroupId,
          teacherId: post.teacherId,
          coTeacherId: post.coTeacherId,
          roomId: row.roomId,
          dayOfWeek: row.dayOfWeek,
          startTime: row.startTime,
          endTime: new Date(row.startTime.getTime() + row.minutes * 60_000),
          recurrence: row.recurrence,
          startDate: post.startDate,
          endDate: post.endDate,
          minutes: row.minutes,
          extraGroups: [],
          participants: [],
        },
      ];
    })
    .sort(
      (a, b) =>
        compare(a.requirementId, b.requirementId) ||
        a.dayOfWeek - b.dayOfWeek ||
        a.startTime.getTime() - b.startTime.getTime() ||
        compare(a.id, b.id),
    );
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Each post's lessons its förläggningar place, one length each (placedLessonsOf). */
export function placedMinutesOf(
  rows: readonly PlacedLessonRow[],
  posts: ReadonlyMap<string, PlacedPost>,
): Map<string, number[]> {
  const byPost = new Map<string, PlacedLessonRow[]>();
  for (const row of rows) {
    const list = byPost.get(row.requirementId);
    if (list) list.push(row);
    else byPost.set(row.requirementId, [row]);
  }
  const placed = new Map<string, number[]>();
  for (const [postId, list] of byPost) {
    const post = posts.get(postId);
    if (post) placed.set(postId, placedLessonsOf(post, list));
  }
  return placed;
}

/**
 * The post's lessons left once its förläggningar are taken off, each the exact
 * length it places. A length with no lesson left takes nothing: the judge has
 * refused that förläggning by name before (OVER_DEMAND), so this is never
 * reached with one, and taking the nearest instead would answer a question the
 * school did not ask.
 */
export function withoutPlaced(remaining: readonly number[], placed: readonly number[]): number[] {
  const left = [...remaining];
  for (const minutes of placed) {
    const at = left.indexOf(minutes);
    if (at >= 0) left.splice(at, 1);
  }
  return left;
}

/** The weekday's clock as HH:MM. */
const clockOf = (time: Date): string => time.toISOString().slice(11, 16);

/**
 * GENERERA'S PRE-FLIGHT REFUSAL: the förläggningar that cannot stand where
 * they are placed, judged at this run (placement-judge.ts) since the week
 * moves under a row after it was saved — a teacher changed on the post, a
 * reservation written, a lesson locked. Said in the ids the payload uses, so
 * it reaches the school through realiseConflicts as the engine's own refusals
 * do: `requirement` and `room` are named back, the day and clock are the
 * row's. One line per row that does not stand, under one summary.
 */
export function placementsRefusalOf(
  rows: readonly PlacedLessonRow[],
  verdicts: readonly PlacementVerdict[],
  anon: { requirement: (realId: string) => string; room: (realId: string) => string },
): AiEngineConflictAnalysis | null {
  const refused = verdicts.filter((verdict) => !verdict.ok);
  if (refused.length === 0) return null;
  const conflicts: AiEngineConflictDetail[] = refused.flatMap((verdict): AiEngineConflictDetail[] => {
    const row = rows[verdict.index];
    if (!row) return [];
    const requirement = anon.requirement(row.requirementId);
    const room = anon.room(row.roomId);
    const params: Record<string, string | number> = {
      requirement,
      room,
      day: row.dayOfWeek,
      start: clockOf(row.startTime),
      end: clockOf(row.endTime),
      reason: verdict.reason ?? 'UNKNOWN',
      ...sentenceParams(verdict.params),
    };
    return [
      {
        category: 'PLACEMENT',
        code: PLACEMENT_CANNOT_STAND,
        params,
        message: `A placed lesson cannot stand where it is placed (${params.reason}).`,
        requirementIds: [requirement],
        roomIds: [room],
        constraintIds: [],
        resourceIds: [],
      },
    ];
  });
  return {
    summary:
      `${refused.length} placed lesson(s) on the timplan can no longer stand where they are placed, ` +
      'so the week was not sent. A placed lesson never gives way: move or remove the placement on its timplanspost.',
    summaryCode: PLACEMENTS_REFUSED_SUMMARY,
    summaryParams: { count: refused.length },
    conflicts,
  };
}

/**
 * What the sentence takes from the verdict, beside the row's own day and clock:
 * the lesson it meets as one neutral phrase, "8B Matematik" (class and subject,
 * never a person), the reservation's resource and the other schools. The
 * verdict's `day`, `start` and `end` are the OTHER lesson's, and must not stand
 * in for the förläggning's own in "placed on {day} {start}–{end}".
 */
function sentenceParams(params: PlacementVerdict['params']): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const className = params?.['className'];
  const subjectName = params?.['subjectName'];
  const other = [className, subjectName].filter((part) => typeof part === 'string' && part !== '').join(' ');
  if (other !== '') out['other'] = other;
  for (const key of ['resource', 'schools'] as const) {
    const value = params?.[key];
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  return out;
}

/** The pre-flight's codes, in the engine's catalogue (app/messages.py). */
export const PLACEMENTS_REFUSED_SUMMARY = 'PLACEMENTS_REFUSED_SUMMARY';
export const PLACEMENT_CANNOT_STAND = 'PLACEMENT_CANNOT_STAND';

/**
 * A placed lesson as Generera writes it: the post's lesson at the
 * förläggning's day, clock, room and weeks, locked and marked as the run's
 * own. The one place outside the fetch that turns a förläggning into a master
 * lesson.
 *
 * WHO TEACHES IT AND ITS WINDOW ARE THE POST'S AS THE WRITE READS IT, the way
 * the engine's lessons of the same post are stamped (writeRegeneration): a
 * teacher changed while the solver ran reaches both alike. A förläggning whose
 * post the write no longer finds is null, and the caller refuses the write.
 */
export function placedLessonWritesOf(
  rows: readonly PlacedLessonRow[],
  posts: ReadonlyMap<string, Pick<PlacedPost, 'teacherId' | 'coTeacherId' | 'startDate' | 'endDate'>>,
  ids: { schoolId: string; academicYearId: string },
) {
  const writes = [];
  for (const row of rows) {
    const post = posts.get(row.requirementId);
    if (!post) return null;
    writes.push({
      schoolId: ids.schoolId,
      academicYearId: ids.academicYearId,
      subjectId: row.subjectId,
      studentGroupId: row.studentGroupId,
      teacherId: post.teacherId ?? null,
      coTeacherId: post.coTeacherId ?? null,
      roomId: row.roomId,
      dayOfWeek: row.dayOfWeek,
      startTime: row.startTime,
      endTime: row.endTime,
      recurrence: row.recurrence,
      startDate: post.startDate ?? null,
      endDate: post.endDate ?? null,
      // Generera's own, so the next run replaces it (PRESERVED_FROM_REGENERATION),
      // and locked, so nothing between two runs moves it.
      isGenerated: true,
      isLocked: true,
      fromPlacement: true,
    });
  }
  return writes;
}

/**
 * The year's förläggningar as one comparable string, by what a write writes
 * from them: Generera reads them again under the year's lock and refuses a
 * write (GENERATE_STALE) when they moved while the solver ran, since the
 * week it was handed was laid around the old ones.
 */
export function placementsKeyOf(
  rows: readonly Pick<PlacementRead, 'id' | 'requirementId' | 'dayOfWeek' | 'startTime' | 'minutes' | 'roomId' | 'recurrence'>[],
): string {
  return rows
    .map((row) =>
      [row.id, row.requirementId, row.dayOfWeek, row.startTime.toISOString(), row.minutes, row.roomId, row.recurrence].join('|'),
    )
    .sort()
    .join('\n');
}
