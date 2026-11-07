import { CURRENT } from '../../year-rollover/projected-rosters';
import type { SwapData } from '../swap-snapshot';
import type { SwapLesson } from '../swap-types';

/*
 * A small deterministic school for the swap tests: classes, teachers and rooms
 * on an hourly grid, laid so that nothing double-books. Built from a seed, so
 * a difference between two runs is the code's and never the data's.
 *
 * The grid is hourly on purpose: with no partial overlaps between slots, the
 * search's prune is exact, which is what lets the tests hold its answer
 * against a brute force that knows nothing but "does anything overlap".
 */

export interface WorldOptions {
  seed?: number;
  classes?: number;
  teachers?: number;
  rooms?: number;
  subjects?: number;
  /** Lessons per class and week. */
  perClass?: number;
}

export interface World {
  data: SwapData;
  pupilsOf: Map<string, string[]>;
  classIds: string[];
}

function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export const YEAR = '00000000-0000-4000-8000-000000000001';
export const SCHOOL = '00000000-0000-4000-8000-0000000000aa';

export function makeWorld(options: WorldOptions = {}): World {
  const next = random(options.seed ?? 7);
  const classCount = options.classes ?? 5;
  const teacherCount = options.teachers ?? 7;
  const roomCount = options.rooms ?? 5;
  const subjectCount = options.subjects ?? 6;
  const perClass = options.perClass ?? 16;

  const classIds = Array.from({ length: classCount }, (_, i) => `c${i + 1}`);
  const slots: Array<{ day: number; start: number }> = [];
  for (let day = 1; day <= 5; day++) for (let k = 0; k < 6; k++) slots.push({ day, start: 480 + 60 * k });

  const teacherBusy = new Set<string>();
  const roomBusy = new Set<string>();
  const lessons: SwapLesson[] = [];
  let sequence = 0;
  for (const classId of classIds) {
    const chosen = [...slots].sort(() => next() - 0.5).slice(0, perClass);
    for (const slot of chosen) {
      const key = `${slot.day}|${slot.start}`;
      const teacher = Array.from({ length: teacherCount }, (_, i) => `t${i + 1}`)
        .sort(() => next() - 0.5)
        .find((id) => !teacherBusy.has(`${id}|${key}`));
      const room = Array.from({ length: roomCount }, (_, i) => `r${i + 1}`)
        .sort(() => next() - 0.5)
        .find((id) => !roomBusy.has(`${id}|${key}`));
      if (!teacher || !room) continue;
      teacherBusy.add(`${teacher}|${key}`);
      roomBusy.add(`${room}|${key}`);
      const subject = `s${1 + Math.floor(next() * subjectCount)}`;
      sequence += 1;
      lessons.push({
        id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
        subjectId: subject,
        subjectName: `Ämne ${subject}`,
        studentGroupId: classId,
        groupName: classId.toUpperCase(),
        teacherId: teacher,
        coTeacherId: null,
        roomId: room,
        dayOfWeek: slot.day,
        startMinutes: slot.start,
        endMinutes: slot.start + 60,
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
        isLocked: false,
        isGenerated: true,
        extraGroupIds: [],
        studentIds: [],
      });
    }
  }

  const pupilsOf = new Map(classIds.map((id) => [id, [1, 2, 3].map((n) => `p-${id}-${n}`)]));
  const membersByGroup = new Map(classIds.map((id) => [id, new Set(pupilsOf.get(id)!)]));
  const groupsByStudent = new Map<string, Set<string>>();
  const homeMembers: Array<{ id: string; studentGroupId: string | null }> = [];
  const homeClassOf = new Map<string, string | null>();
  for (const [classId, pupils] of pupilsOf) {
    for (const pupil of pupils) {
      groupsByStudent.set(pupil, new Set([classId]));
      homeMembers.push({ id: pupil, studentGroupId: classId });
      homeClassOf.set(pupil, classId);
    }
  }

  const data: SwapData = {
    schoolId: SCHOOL,
    academicYearId: YEAR,
    gradeNumbering: 'NIOARIG',
    basis: CURRENT,
    lessons,
    posts: [],
    blocks: [],
    groups: classIds.map((id) => ({
      id,
      name: id.toUpperCase(),
      kind: 'CLASS' as const,
      halfOfId: null,
      replacesSubjectId: null,
      gradeLevel: 7,
    })),
    rosters: {
      membersByGroup,
      groupsByStudent,
      homeMembers,
      homeClassOf,
      gradeOfGroup: new Map(classIds.map((id) => [id, 7])),
      halfPairs: [],
      unplacedShare: new Map(),
    },
    constraints: [],
    frames: [],
    lunch: null,
    sittings: [],
    holds: [],
    teacherRules: new Map(),
    postLimited: new Set(),
  };
  return { data, pupilsOf, classIds };
}

/** The rows a database would hand the clash rule, from the world's lessons. */
export function rowOf(lesson: SwapLesson) {
  const clock = (minutes: number) => new Date(Date.UTC(1970, 0, 1, Math.floor(minutes / 60), minutes % 60));
  return {
    id: lesson.id,
    academicYearId: YEAR,
    teacherId: lesson.teacherId,
    coTeacherId: lesson.coTeacherId,
    roomId: lesson.roomId,
    studentGroupId: lesson.studentGroupId,
    subjectId: lesson.subjectId,
    dayOfWeek: lesson.dayOfWeek,
    startTime: clock(lesson.startMinutes),
    endTime: clock(lesson.endMinutes),
    recurrence: lesson.recurrence,
    startDate: null,
    endDate: null,
    isParked: false,
    subject: { name: lesson.subjectName },
    extraGroups: lesson.extraGroupIds.map((studentGroupId) => ({ studentGroupId })),
    participants: lesson.studentIds.map((studentId) => ({ studentId })),
  };
}

/** A transaction that answers the clash rule's reads from the world, as the database would. */
export function fakeTx(world: World, lessons: () => SwapLesson[] = () => world.data.lessons) {
  const inList = (clause: unknown): string[] | null => (clause as { in?: string[] } | undefined)?.in ?? null;
  const pupils = [...world.pupilsOf.entries()].flatMap(([classId, ids]) => ids.map((id) => ({ id, studentGroupId: classId })));
  const groups = world.data.groups.map((group) => ({ ...group, academicYearId: YEAR }));
  return {
    masterLesson: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const found = lessons().find((lesson) => lesson.id === where.id);
        return found ? { id: found.id, academicYearId: YEAR, isParked: false, school: { timezone: 'Europe/Stockholm' } } : null;
      }),
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const idClause = where['id'] as { notIn?: string[]; not?: string } | undefined;
        const notIn = idClause?.notIn ?? [];
        const not = idClause?.not;
        return lessons()
          .filter(
            (lesson) =>
              lesson.dayOfWeek === where['dayOfWeek'] &&
              !notIn.includes(lesson.id) &&
              (not === undefined || lesson.id !== not),
          )
          .map(rowOf);
      }),
    },
    teachingRequirement: { findMany: jest.fn(async () => []) },
    availabilityConstraint: { findMany: jest.fn(async () => []) },
    studentGroup: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const or = (where['OR'] as Array<Record<string, unknown>> | undefined) ?? [where];
        return groups.filter((group) =>
          or.some((clause) => {
            if (clause['id']) return inList(clause['id'])!.includes(group.id);
            if (clause['halfOfId']) return inList(clause['halfOfId'])!.includes(group.halfOfId ?? '');
            return false;
          }),
        );
      }),
    },
    user: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const ofClass = where['studentGroupId'];
        const wanted = typeof ofClass === 'string' ? [ofClass] : inList(ofClass) ?? [];
        return pupils.filter((pupil) => wanted.includes(pupil.studentGroupId));
      }),
      count: jest.fn(async () => 0),
    },
    studentGroupMember: { findMany: jest.fn(async () => []) },
    // The published calendar has no future lesson of the world's, and the school publishes directly.
    calendarLesson: { findMany: jest.fn(async (_args: unknown) => [] as Array<{ masterLessonId: string | null; date: Date }>) },
    $queryRaw: jest.fn(async () => [{ mode: 'DIRECT' }]),
    $executeRaw: jest.fn(async () => 0),
  };
}
