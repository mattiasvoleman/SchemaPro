import type { RecurrenceWindow } from '../calendar/lesson-recurrence';

/*
 * Which of a requirement's lessons the hand-placed ones already answer.
 *
 * The proxy subtracts every preserved lesson that covers a requirement's weeks
 * (coversDemand in optimization-proxy.service.ts) from what it asks the engine
 * to place. With one length per requirement that is a count: each covering
 * lock cancels one lesson, whatever its own length. With lektionslängder it is
 * a question of WHICH lesson — a locked 80 of idrott 1 × 80 + 1 × 40 leaves
 * the 40 to place, not the 80 — so the subtraction is over lengths:
 *
 *  1. Exact matches first. A locked 40 cancels a 40, and nothing a later rule
 *     decides can take that 40 away from it.
 *  2. Every other lock, longest first, cancels the NEAREST remaining length;
 *     on a tie, the SHORTER one. Nearest keeps the week's error as small as
 *     one lock allows, and it can go EITHER way: a locked 70 on 1 × 80 +
 *     1 × 40 cancels the 80 (10 away, not 30), so the week holds 70 + 40 =
 *     110 of 120 — exactly as a locked 45 on a uniform 3 × 60 already leaves
 *     the week 15 short today. Only the tie is decided toward over-delivery
 *     (a locked 60 on 80 + 40 cancels the 40: 140, not 100), the direction
 *     the proxy's coverage paragraph prefers to a lesson quietly missing. A
 *     lock whose length matches none of the requirement's is the
 *     administrator's own placement; the timetable shows its minutes.
 *  3. A lock beyond the demand cancels nothing; the remainder never goes below
 *     empty.
 *
 * For a uniform requirement every rule above reduces to today's: one length,
 * so each covering lock cancels one lesson whatever it lasts. The answer is
 * the remaining lengths, longest first.
 */
export function coverLockedLessons(
  lengths: readonly number[],
  lockedMinutes: readonly number[],
): number[] {
  const remaining = [...lengths].sort((a, b) => b - a);
  const unmatched: number[] = [];
  for (const minutes of lockedMinutes) {
    const at = remaining.indexOf(minutes);
    if (at >= 0) remaining.splice(at, 1);
    else unmatched.push(minutes);
  }
  for (const minutes of unmatched.sort((a, b) => b - a)) {
    if (remaining.length === 0) break;
    let best = 0;
    for (let i = 1; i < remaining.length; i += 1) {
      const distance = Math.abs(remaining[i]! - minutes);
      const bestDistance = Math.abs(remaining[best]! - minutes);
      // Longest first, so a later index is never longer: a tie moves to it.
      if (distance <= bestDistance) best = i;
    }
    remaining.splice(best, 1);
  }
  return remaining;
}

/** One lesson of a shared post and its teacher (src/common/lesson-shares.ts). */
export interface TaughtLesson {
  minutes: number;
  teacherId: string | null;
}

/**
 * Delade lektioner: which of a SHARED post's lessons the hand-placed ones
 * already answer, each with its teacher. Asked only of a post with shares —
 * every other post is coverLockedLessons above, call for call — because on a
 * shared post a locked lesson is somebody's: Bo's own locked 60 answers Bo's
 * 60, not Anna's, and the lesson left to place is then one of hers.
 *
 *  1. A lock taught by one of the post's teachers at one of that teacher's
 *     lengths cancels that lesson first.
 *  2. Every other lock — taught by somebody the post does not name, or at a
 *     length its teacher has none of — falls to the length rule above, exact
 *     match first and then the nearest (a tie toward the shorter), over the
 *     lessons still left; within a length the first in the post's order,
 *     the huvudlärare's before the shares', since a lesson the school placed
 *     by hand with another teacher is most likely one the lead would have had.
 *  3. A lock beyond the demand cancels nothing.
 *
 * The answer keeps the post's order: longest first, the lead's before each
 * share's within a length — lessonTeachersOf's, the engine's lessonTeacherIds.
 */
export function coverLockedSharedLessons(
  lessons: readonly TaughtLesson[],
  locked: readonly TaughtLesson[],
): TaughtLesson[] {
  const remaining = [...lessons];
  const unmatched: TaughtLesson[] = [];
  for (const lock of locked) {
    const at = remaining.findIndex((lesson) => lesson.minutes === lock.minutes && lesson.teacherId === lock.teacherId);
    if (at >= 0) remaining.splice(at, 1);
    else unmatched.push(lock);
  }
  const later: TaughtLesson[] = [];
  for (const lock of unmatched) {
    const at = remaining.findIndex((lesson) => lesson.minutes === lock.minutes);
    if (at >= 0) remaining.splice(at, 1);
    else later.push(lock);
  }
  for (const lock of later.sort((a, b) => b.minutes - a.minutes)) {
    if (remaining.length === 0) break;
    // The nearest length, a tie toward the shorter, as coverLockedLessons;
    // then that length's first lesson in the post's order.
    let best = remaining[0]!.minutes;
    for (const lesson of remaining) {
      const distance = Math.abs(lesson.minutes - lock.minutes);
      const bestDistance = Math.abs(best - lock.minutes);
      if (distance < bestDistance || (distance === bestDistance && lesson.minutes < best)) best = lesson.minutes;
    }
    remaining.splice(
      remaining.findIndex((lesson) => lesson.minutes === best),
      1,
    );
  }
  return remaining;
}

/**
 * How much of the weekly demand is already placed by hand.
 *
 * Only a lesson that is there for every week the requirement is can cancel
 * one of its lessons a week. The engine places each lesson of a requirement
 * once, for every week the requirement runs, so whatever is subtracted here
 * is subtracted from all of them alike — there is no way to say "one lesson,
 * but only on odd ones". That leaves only the
 * choice of which way to be wrong, and the two directions are not
 * symmetric.
 *
 * Counting a lesson that is absent for part of the requirement
 * under-delivers, invisibly: lessonsPerWeek 2 with one locked odd-week
 * lesson sends 1 to the solver, and the class quietly gets one lesson on
 * even weeks for the rest of the year while the timplan says two. Nothing
 * on any screen says so. Not counting it over-delivers: an extra lesson on
 * odd weeks, sitting on the timetable in front of the administrator, who
 * can unlock or remove it. That costs packing room and not correctness —
 * the preserved lesson is forwarded as a fixed placement either way, so its
 * slot stays blocked in every week, and what the engine adds carries the
 * requirement's own window.
 *
 * So this test is a covering test, and everything it cannot be sure of
 * falls on the visible side: equal recurrence, and a date window enclosing
 * the requirement's. Equal rather than covering recurrences on purpose —
 * an ALL_WEEKS lesson does cover an ODD_WEEKS requirement, and counting it
 * would buy one lesson of packing room in exchange for a second comparison
 * that has to stay right forever. Equality also keeps a recurrence added to
 * the enum later on the safe side without this line being touched: two
 * lessons with the same recurrence run the same weeks whatever it is, and
 * anything unequal is simply not counted. calendar/lesson-recurrence.ts
 * reads a missing recurrence as ALL_WEEKS because there the wrong guess
 * would drop half a school's lessons; here the wrong guess would hide them,
 * so an absent column on either side counts for nothing.
 */
export function lockCoversDemand(lesson: RecurrenceWindow, requirement: RecurrenceWindow): boolean {
  if (!lesson.recurrence || !requirement.recurrence) return false;
  if (lesson.recurrence !== requirement.recurrence) return false;

  // Both columns are `@db.Date`, so both sides arrive at midnight UTC and
  // compare as plain instants. A null bound is the open one — "from the
  // start of the year", "until it ends" — so it encloses whatever the
  // requirement asks for, while a bound on the lesson and none on the
  // requirement encloses nothing: the requirement outlives the lesson.
  if (
    lesson.startDate &&
    (!requirement.startDate || lesson.startDate > requirement.startDate)
  ) {
    return false;
  }
  if (
    lesson.endDate &&
    (!requirement.endDate || lesson.endDate < requirement.endDate)
  ) {
    return false;
  }
  return true;
}
