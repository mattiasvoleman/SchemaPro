import type { ParallelKind, ParallelLink, SwapLesson, SwapSlot, SwapUnit } from './swap-types';

/*
 * THE LESSONS THAT MOVE AS ONE.
 *
 * A move of one lesson is rarely a move of one lesson. The school has laid
 * lessons beside it on purpose: the members of a parallel block (språkval,
 * elevens val), the two halves of a class that take turns, the group that
 * replaces the class's svenska for its pupils. Moving the lesson and leaving
 * those where they stand splits what the school put together, and the write
 * path says so after the fact (BLOCK_SPLIT) or not at all. A proposal does
 * neither: the lessons laid beside a lesson go with it, and the proposal names
 * each of them (SwapProposal.parallels). Nothing follows silently.
 *
 * "BESIDE" IS EXACT. The same day and the same clock, in weeks that can meet,
 * and a relation the school itself recorded: the same block (or a block on the
 * other's times), the two halves of one class, a group and the subject it
 * replaces with a pupil in common. Two lessons that merely start together are
 * two lessons that start together.
 *
 * PURE. The relations arrive as functions, read once by the snapshot.
 */

export interface UnitRelations {
  /** The parallel block a lesson's timplanspost belongs to, if any. */
  blockOf: (lesson: SwapLesson) => string | null;
  /** The block whose times this block takes, if it takes any. */
  sameTimesOf: (blockId: string) => string | null;
  /** halfOfId / replacesSubjectId per group. */
  groupFacts: ReadonlyMap<string, { halfOfId: string | null; replacesSubjectId: string | null }>;
  /** Whether two groups hold a pupil in common (halves of one class do not, by design). */
  sharesPupils: (a: string, b: string) => boolean;
}

/** The same weeks, exactly: what a block card means by "the same slot". */
const sameWeeks = (a: SwapLesson, b: SwapLesson): boolean =>
  a.recurrence === b.recurrence && a.startDate === b.startDate && a.endDate === b.endDate;

/** Whether two lessons can ever fall in one week (lesson-recurrence.ts weeksCanOverlap, on strings). */
export function weeksMeet(
  a: Pick<SwapLesson, 'recurrence' | 'startDate' | 'endDate'>,
  b: Pick<SwapLesson, 'recurrence' | 'startDate' | 'endDate'>,
): boolean {
  if (
    (a.recurrence === 'ODD_WEEKS' && b.recurrence === 'EVEN_WEEKS') ||
    (a.recurrence === 'EVEN_WEEKS' && b.recurrence === 'ODD_WEEKS')
  ) {
    return false;
  }
  if (a.endDate && b.startDate && a.endDate < b.startDate) return false;
  if (b.endDate && a.startDate && b.endDate < a.startDate) return false;
  return true;
}

export const slotOf = (lesson: SwapLesson): SwapSlot => ({
  dayOfWeek: lesson.dayOfWeek,
  startMinutes: lesson.startMinutes,
  endMinutes: lesson.endMinutes,
});

export const slotKey = (slot: SwapSlot): string => `${slot.dayOfWeek}|${slot.startMinutes}|${slot.endMinutes}`;

/** How `a` stands beside `b`, or null when it does not. Both are at one slot. */
function linkKind(a: SwapLesson, b: SwapLesson, relations: UnitRelations): ParallelKind | null {
  const blockA = relations.blockOf(a);
  const blockB = relations.blockOf(b);
  if (blockA !== null && blockA === blockB && sameWeeks(a, b)) return 'BLOCK';
  if (
    blockA !== null &&
    blockB !== null &&
    blockA !== blockB &&
    (relations.sameTimesOf(blockA) === blockB || relations.sameTimesOf(blockB) === blockA) &&
    sameWeeks(a, b)
  ) {
    return 'SAME_TIMES';
  }
  if (!weeksMeet(a, b)) return null;

  const factsA = relations.groupFacts.get(a.studentGroupId);
  const factsB = relations.groupFacts.get(b.studentGroupId);
  if (
    a.studentGroupId !== b.studentGroupId &&
    factsA?.halfOfId != null &&
    factsA.halfOfId === factsB?.halfOfId
  ) {
    return 'HALF';
  }
  // A group replacing the subject of the other lesson, with a pupil on both.
  const replaces = (x: SwapLesson, y: SwapLesson, group: { replacesSubjectId: string | null } | undefined) =>
    group?.replacesSubjectId != null &&
    group.replacesSubjectId === y.subjectId &&
    x.studentGroupId !== y.studentGroupId &&
    relations.sharesPupils(x.studentGroupId, y.studentGroupId);
  if (replaces(a, b, factsA) || replaces(b, a, factsB)) return 'REPLACING';
  return null;
}

/**
 * Every lesson's unit, the lessons of one unit sharing the one object.
 *
 * Connected components over the links between lessons at one slot: a block
 * member, the half beside it and the replacing group beside that are one
 * unit though only some are linked to the first.
 */
export function buildUnits(lessons: readonly SwapLesson[], relations: UnitRelations): Map<string, SwapUnit> {
  const parent = new Map<string, string>(lessons.map((lesson) => [lesson.id, lesson.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cursor = id;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const links: ParallelLink[] = [];

  const bySlot = new Map<string, SwapLesson[]>();
  for (const lesson of lessons) {
    const key = slotKey(slotOf(lesson));
    const bucket = bySlot.get(key);
    if (bucket) bucket.push(lesson);
    else bySlot.set(key, [lesson]);
  }
  for (const bucket of bySlot.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]!;
        const b = bucket[j]!;
        const kind = linkKind(a, b, relations);
        if (kind === null) continue;
        links.push({ kind, lessonId: b.id, viaLessonId: a.id });
        const rootA = find(a.id);
        const rootB = find(b.id);
        if (rootA !== rootB) parent.set(rootB, rootA);
      }
    }
  }

  const membersByRoot = new Map<string, SwapLesson[]>();
  for (const lesson of lessons) {
    const root = find(lesson.id);
    const list = membersByRoot.get(root);
    if (list) list.push(lesson);
    else membersByRoot.set(root, [lesson]);
  }
  const linksByRoot = new Map<string, ParallelLink[]>();
  for (const link of links) {
    const root = find(link.lessonId);
    const list = linksByRoot.get(root);
    if (list) list.push(link);
    else linksByRoot.set(root, [link]);
  }

  const units = new Map<string, SwapUnit>();
  for (const [root, members] of membersByRoot) {
    members.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    const unit: SwapUnit = {
      id: members[0]!.id,
      members,
      links: (linksByRoot.get(root) ?? []).sort(
        (x, y) => (x.lessonId < y.lessonId ? -1 : x.lessonId > y.lessonId ? 1 : x.viaLessonId < y.viaLessonId ? -1 : 1),
      ),
      slot: slotOf(members[0]!),
      locked: members.some((member) => member.isLocked),
    };
    for (const member of members) units.set(member.id, unit);
  }
  return units;
}
