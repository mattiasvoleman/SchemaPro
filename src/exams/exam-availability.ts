import { holdsTime, occupancyFindings, poolNotDeclared, type PersonDay, type PersonLesson, type Span } from '../cover/cover-rules';
import { roomFindings, type RoomDay } from '../school-day/school-day-rules';

/*
 * PROVPLANERING: WHO AND WHAT IS FREE FOR AN EXAM, by the rules Skolans dag
 * and the Vikarietavla already answer with (school-day-rules.ts,
 * cover-rules.ts occupancyFindings). Not a second definition of "free": the
 * same function, asked about the exam's own time, with one difference.
 *
 * The exam cancels the lessons of its classes that overlap it. A lesson of a
 * teacher or a room that the exam itself cancels does not make them busy: it
 * is the very thing an invigilator is taken from ("lärare som är lediga eller
 * vars lektioner provet ställer in"), and a classroom emptied by the exam is a
 * room to write in. So for one exam the lessons of the groups it takes
 * (`affected`, the avbokning's own set: the named groups, their halves and the
 * groups wholly inside them) are read as CANCELLED. A lesson of a group the
 * exam does not take, and one of those groups' lessons that the activity would
 * not take (a shared lesson whose own group is not affected), keeps its owner
 * busy: the read errs towards busy, never towards free.
 */

/** An exam's candidate time as instants, and the date it is on. */
export interface SlotSpan extends Span {
  date: string;
}

export interface RoomLessonUse {
  id: string;
  date: string;
  start: number;
  end: number;
  status: 'SCHEDULED' | 'CANCELLED' | 'COMPLETED' | 'RESCHEDULED';
  groupIds: readonly string[];
}

/** One room on one date, with the lessons that use it. */
export interface RoomDayUse {
  lessons: readonly RoomLessonUse[];
  bookings: readonly Span[];
  closures: readonly Span[];
}

const takenByExam = (lesson: PersonLesson, date: string, affected: ReadonlySet<string>): boolean =>
  lesson.date === date && holdsTime(lesson) && affected.has(lesson.studentGroupId);

/** A teacher is free for the span when no rule of the occupancy finds them busy, the exam's own cancellations aside. */
export function teacherFreeFor(day: PersonDay, slot: SlotSpan, affected: ReadonlySet<string>): boolean {
  const lessons: PersonLesson[] = day.lessons.map((lesson) =>
    takenByExam(lesson, slot.date, affected) ? { ...lesson, status: 'CANCELLED' as const } : lesson,
  );
  return occupancyFindings(day, slot, lessons).length === 0 && !poolNotDeclared(day, slot);
}

/** A room is free for the span by the day grid's rules, the lessons of the groups the exam takes aside. */
export function roomFreeFor(
  roomId: string,
  use: RoomDayUse | undefined,
  slot: SlotSpan,
  affected: ReadonlySet<string>,
  loan: (roomId: string, slot: SlotSpan) => boolean,
): boolean {
  if (loan(roomId, slot)) return false;
  const day: RoomDay = {
    roomId,
    lessons: (use?.lessons ?? [])
      .filter((lesson) => lesson.date === slot.date)
      .map((lesson) => ({
        id: lesson.id,
        start: lesson.start,
        end: lesson.end,
        status: lesson.groupIds.some((id) => affected.has(id)) && holdsTime(lesson) ? 'CANCELLED' : lesson.status,
      })),
    bookings: [...(use?.bookings ?? [])],
    closures: [...(use?.closures ?? [])],
  };
  return roomFindings(day, slot).length === 0;
}

/** Each teacher with the indexes of the slots they are busy at; a teacher free at every slot is left out. */
export function teacherBlocks(
  teacherIds: readonly string[],
  days: ReadonlyMap<string, ReadonlyMap<string, PersonDay>>,
  affected: ReadonlySet<string>,
  slots: readonly SlotSpan[],
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const teacherId of teacherIds) {
    const blocked: number[] = [];
    slots.forEach((slot, index) => {
      const day = days.get(slot.date)?.get(teacherId);
      // Nobody is read for a teacher who has no day: they are not at the school then.
      if (!day || !teacherFreeFor(day, slot, affected)) blocked.push(index);
    });
    if (blocked.length > 0) out.set(teacherId, blocked);
  }
  return out;
}

/** Each room with the indexes of the slots it is taken at; a room free at every slot is left out. */
export function roomBlocks(
  roomIds: readonly string[],
  uses: ReadonlyMap<string, RoomDayUse>,
  affected: ReadonlySet<string>,
  slots: readonly SlotSpan[],
  loan: (roomId: string, slot: SlotSpan) => boolean,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const roomId of roomIds) {
    const blocked: number[] = [];
    slots.forEach((slot, index) => {
      if (!roomFreeFor(roomId, uses.get(roomId), slot, affected, loan)) blocked.push(index);
    });
    if (blocked.length > 0) out.set(roomId, blocked);
  }
  return out;
}
