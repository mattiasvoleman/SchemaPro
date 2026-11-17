import type { LessonRecurrence, Prisma, PrismaClient } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { TeacherDayRule } from '../common/teacher-day';
import { requireSchoolId } from '../common/utils/request-context';
import { keptMastersWhere } from '../optimization/preserved-lessons';
import { readsHr } from '../staffing/hr-visibility';
import type { JudgedPlacement } from './placement-judge';
import {
  placementWarningsOf,
  type FixedItem,
  type HandMeal,
  type LunchRule,
  type PlacementWarning,
  type RoomFacts,
} from './placement-warnings';

/*
 * WHAT THE WARNINGS READ, AND NOTHING WHEN THERE IS NOTHING TO SAY.
 *
 * placement-warnings.ts counts; this reads what the counting needs, only on the
 * side of each gate it is asked:
 *
 *   teachers   the work rules with a cap and the posts with a limit, of the
 *              teachers the rows name: two statements, and every school
 *              without a rule stops there;
 *   the lunch  the school's setting, and only when it is on the classes the
 *              rows name, and the meals placed by hand;
 *   rooms      only when a row has no room: the subjects' room types and the
 *              rooms, and only when some subject needs a type;
 *   the week   the lessons Generera keeps, read only for the teachers, the
 *              classes and the rooms that a warning could be about, unless the
 *              caller has them already (the week of förläggningar reads every
 *              one of them for the board).
 *
 * A reader of the post's days or limit for teaching in a row has read HR data,
 * so the läslogg is told, as the hand edit tells it (master-lessons.service.ts
 * teacherDayWarnings): every teacher a days or a stretch warning is about, and
 * the hidden wording is a read too, since it says that the post holds a limit.
 */

/** A lesson Generera keeps, as the warnings read it (the board's select carries all of this). */
export interface KeptForWarnings {
  teacherId: string | null;
  coTeacherId: string | null;
  studentGroupId: string;
  extraGroups: readonly { studentGroupId: string }[];
  subjectId: string;
  roomId: string | null;
  dayOfWeek: number;
  startTime: Date;
  endTime: Date;
  recurrence: LessonRecurrence;
  startDate: Date | null;
  endDate: Date | null;
}

/** A meal the school placed by hand, as the week of förläggningar reads them. */
export interface MealForWarnings {
  studentGroupId: string;
  dayOfWeek: number;
  startDate: Date | null;
  endDate: Date | null;
}

export interface WarningReads {
  academicYearId: string;
  year: { startDate: Date; endDate: Date };
  /** The rows to warn about, in the order the answer has them. */
  rows: readonly JudgedPlacement[];
  /** Other rows of the year that are part of the week but are not warned about (the year's other posts' and blocks'). */
  beside: readonly JudgedPlacement[];
  /** Every lesson Generera keeps, when the caller has read them; absent, they are read for what the warnings need. */
  kept?: readonly KeptForWarnings[];
  /** The meals placed by hand (not the ones Generera laid), when the caller has read them. */
  meals?: readonly MealForWarnings[];
  /**
   * Whether any post of the year has a lesson left for the engine to place, which decides whether the class's lunch refuses
   * (placement-warnings.ts, ASKED). The board has counted every post and says so; a read or a save of one post gives the question,
   * asked only when a lunch warning would otherwise say that Generera refuses and no förläggning of the year is a pin (a pin is
   * itself a lesson for the engine). Absent: the engine is taken to be asked.
   */
  lessonsLeft?: boolean | (() => Promise<boolean>);
}

const minutesOfTime = (time: Date): number => time.getUTCHours() * 60 + time.getUTCMinutes();
const dayOf = (date: Date | null): string | null => (date ? date.toISOString().slice(0, 10) : null);
const present = (ids: Iterable<string | null>): string[] => [...new Set([...ids].filter((id): id is string => id !== null))];

/**
 * A förläggning is a PIN to the engine, a lesson it places itself at the time it is given and holds to the school's rules, when
 * it has no room (B2) and when it is a lesson of a parallel block, with the member's room or without: a block's lesson is never a
 * lock (a lock in a block is refused as partly locked), the engine pins it, and a pinned lesson with a room is held to the
 * teacher's cap and days like any lesson it places (measured against the real engine: two block lessons with rooms on a day over
 * the teacher's cap are refused as TEACHER_DAILY_CAP_CANNOT_BE_KEPT). `blockFit` is set on the rows block-placement-judge.ts
 * gives the judge and on no other.
 */
const isPin = (row: JudgedPlacement): boolean => row.roomId === null || row.blockFit !== undefined;

const itemOfRow = (row: JudgedPlacement, index: number | null): FixedItem => ({
  row: index,
  pin: isPin(row),
  teacherIds: present([row.teacherId, row.coTeacherId]),
  groupIds: [row.studentGroupId],
  subjectId: row.subjectId,
  roomId: row.roomId,
  dayOfWeek: row.dayOfWeek,
  startMinutes: row.startMinutes,
  endMinutes: row.startMinutes + row.minutes,
  recurrence: row.recurrence,
  startDate: dayOf(row.startDate),
  endDate: dayOf(row.endDate),
});

const itemOfKept = (lesson: KeptForWarnings): FixedItem => ({
  row: null,
  pin: false,
  teacherIds: present([lesson.teacherId, lesson.coTeacherId]),
  groupIds: [lesson.studentGroupId, ...lesson.extraGroups.map((entry) => entry.studentGroupId)],
  subjectId: lesson.subjectId,
  roomId: lesson.roomId,
  dayOfWeek: lesson.dayOfWeek,
  startMinutes: minutesOfTime(lesson.startTime),
  endMinutes: minutesOfTime(lesson.endTime),
  recurrence: lesson.recurrence,
  startDate: dayOf(lesson.startDate),
  endDate: dayOf(lesson.endDate),
});

const KEPT_SELECT = {
  teacherId: true,
  coTeacherId: true,
  studentGroupId: true,
  extraGroups: { select: { studentGroupId: true } },
  subjectId: true,
  roomId: true,
  dayOfWeek: true,
  startTime: true,
  endTime: true,
  recurrence: true,
  startDate: true,
  endDate: true,
} as const;

/** The warnings of each row, in the rows' order: an empty list for a row with nothing to say. */
export async function placementWarnings(tx: PrismaClient, user: AuthenticatedUser, reads: WarningReads): Promise<PlacementWarning[][]> {
  const { rows } = reads;
  const none = (): PlacementWarning[][] => rows.map(() => []);
  if (rows.length === 0) return none();
  const schoolId = requireSchoolId(user);

  // THE TEACHERS: a rule is a cap on the work rule or a limit on the post.
  const teachers = present(rows.flatMap((row) => [row.teacherId, row.coTeacherId]));
  const teacherRules = new Map<string, TeacherDayRule>();
  if (teachers.length > 0) {
    const [capped, limited] = await Promise.all([
      tx.teacherWorkRule.findMany({
        where: { userId: { in: teachers }, maxTeachingMinutesPerDay: { not: null } },
        select: { userId: true, maxTeachingMinutesPerDay: true },
      }),
      tx.teacherEmployment.findMany({
        where: {
          academicYearId: reads.academicYearId,
          userId: { in: teachers },
          OR: [{ maxTeachingDaysPerWeek: { not: null } }, { maxConsecutiveTeachingMinutes: { not: null } }],
        },
        select: { userId: true, maxTeachingDaysPerWeek: true, maxConsecutiveTeachingMinutes: true, consecutiveBreakMinutes: true },
      }),
    ]);
    const capOf = new Map(capped.map((rule) => [rule.userId, rule.maxTeachingMinutesPerDay]));
    const limitOf = new Map(limited.map((post) => [post.userId, post]));
    // In id order, so that a row with two teachers' warnings says them in the same order at every read.
    for (const teacherId of [...new Set([...capOf.keys(), ...limitOf.keys()])].sort()) {
      teacherRules.set(teacherId, {
        maxTeachingMinutesPerDay: capOf.get(teacherId) ?? null,
        maxTeachingDaysPerWeek: limitOf.get(teacherId)?.maxTeachingDaysPerWeek ?? null,
        maxConsecutiveTeachingMinutes: limitOf.get(teacherId)?.maxConsecutiveTeachingMinutes ?? null,
        consecutiveBreakMinutes: limitOf.get(teacherId)?.consecutiveBreakMinutes ?? null,
      });
    }
  }

  // THE LUNCH: the school's setting, the classes (the groups that eat) among the rows' own, the meals placed by hand.
  let lunch: { rule: LunchRule; classes: Set<string>; meals: HandMeal[]; year: { startDate: string; endDate: string } } | null = null;
  const rowGroups = present(rows.map((row) => row.studentGroupId));
  const setting = await tx.lunchSetting.findUnique({
    where: { schoolId },
    select: { lunchEnabled: true, lunchStartTime: true, lunchEndTime: true, lunchMinutes: true, placementSharedMode: true },
  });
  if (setting?.lunchEnabled) {
    const classes = new Set((await tx.studentGroup.findMany({ where: { id: { in: rowGroups }, kind: 'CLASS' }, select: { id: true } })).map((group) => group.id));
    if (classes.size > 0) {
      const meals =
        reads.meals ??
        (await tx.lunchSitting.findMany({
          where: { academicYearId: reads.academicYearId, isGenerated: false, studentGroupId: { in: [...classes] } },
          select: { studentGroupId: true, dayOfWeek: true, startDate: true, endDate: true },
        }));
      lunch = {
        rule: { startMinutes: minutesOfTime(setting.lunchStartTime), endMinutes: minutesOfTime(setting.lunchEndTime), minutes: setting.lunchMinutes },
        classes,
        meals: meals.map((meal) => ({ groupId: meal.studentGroupId, dayOfWeek: meal.dayOfWeek, startDate: dayOf(meal.startDate), endDate: dayOf(meal.endDate) })),
        year: { startDate: dayOf(reads.year.startDate)!, endDate: dayOf(reads.year.endDate)! },
      };
    }
  }

  // THE ROOMS: only for a row with no room, and only a subject that needs a type.
  let rooms: RoomFacts | null = null;
  const pins = [...rows, ...reads.beside].filter((row) => row.roomId === null);
  if (rows.some((row) => row.roomId === null)) {
    const subjects = await tx.subject.findMany({
      where: { id: { in: present(pins.map((row) => row.subjectId)) }, requiredRoomTypeId: { not: null } },
      select: { id: true, requiredRoomTypeId: true },
    });
    if (subjects.length > 0) {
      const allRooms = await tx.room.findMany({
        select: { id: true, roomTypeId: true, capacity: true, canBeShared: true, roomType: { select: { name: true } } },
      });
      const roomsOfType = new Map<string, number>();
      const nameOfType = new Map<string, string>();
      // Placeringsregler, rule 3: while it is on (SOFT or HARD), a room marked shareable that has a capacity takes several lessons at
      // once, so the engine can put a pin beside a lesson in it, and a count of one lesson to a room is no longer the engine's. A type
      // with such a room is not counted at all, which leaves the warning quieter than the engine (measured: a lock and a pin in one
      // shareable room at one hour are laid, OPTIMAL, under both SOFT and HARD).
      const sharing = setting?.placementSharedMode === 'SOFT' || setting?.placementSharedMode === 'HARD';
      const shareable = new Set<string>();
      for (const room of allRooms) {
        if (room.roomTypeId === null) continue;
        roomsOfType.set(room.roomTypeId, (roomsOfType.get(room.roomTypeId) ?? 0) + 1);
        if (room.roomType) nameOfType.set(room.roomTypeId, room.roomType.name);
        if (sharing && room.canBeShared === true && room.capacity !== null && room.capacity > 0) shareable.add(room.roomTypeId);
      }
      rooms = {
        typeOfRoom: new Map(allRooms.map((room) => [room.id, room.roomTypeId])),
        roomsOfType,
        typeOfSubject: new Map(subjects.map((subject) => [subject.id, subject.requiredRoomTypeId])),
        nameOfType,
        shareable,
      };
    }
  }

  if (teacherRules.size === 0 && lunch === null && rooms === null) return none();

  // THE WEEK: the lessons Generera keeps, for what a warning could be about.
  let kept = reads.kept;
  if (kept === undefined) {
    const arms: Prisma.MasterLessonWhereInput[] = [];
    if (teacherRules.size > 0) {
      const ruled = [...teacherRules.keys()];
      arms.push({ teacherId: { in: ruled } }, { coTeacherId: { in: ruled } });
    }
    if (lunch !== null) {
      const eating = [...lunch.classes];
      arms.push({ studentGroupId: { in: eating } }, { extraGroups: { some: { studentGroupId: { in: eating } } } });
    }
    if (rooms !== null) {
      const needed = new Set(rooms.typeOfSubject.values());
      const inRooms = [...rooms.typeOfRoom].filter(([, type]) => type !== null && needed.has(type)).map(([id]) => id);
      if (inRooms.length > 0) arms.push({ roomId: { in: inRooms } });
    }
    kept = arms.length === 0 ? [] : await tx.masterLesson.findMany({ where: { AND: [keptMastersWhere(reads.academicYearId), { OR: arms }] }, select: KEPT_SELECT });
  }

  const items = [
    ...kept.map(itemOfKept),
    ...reads.beside.map((row) => itemOfRow(row, null)),
    ...rows.map((row, index) => itemOfRow(row, index)),
  ];
  const input = { items, rows: rows.length, teacherRules, showsHr: readsHr(user), lunch, rooms };
  let counted = placementWarningsOf({ ...input, ...(typeof reads.lessonsLeft === 'boolean' ? { lessonsLeft: reads.lessonsLeft } : {}) });
  // The year's lessons are counted only when it changes an answer: a lunch warning that says Generera refuses, in a year with no pin.
  const refusesLunch = counted.byRow.some((list) => list.some((warning) => warning.code === 'CLASS_HAS_NO_LUNCH' && warning.refuses));
  if (typeof reads.lessonsLeft === 'function' && refusesLunch && !items.some((item) => item.pin)) {
    if (!(await reads.lessonsLeft())) counted = placementWarningsOf({ ...input, lessonsLeft: false });
  }
  await recordRead(tx, 'EMPLOYMENT', counted.hrTold, user.channel);
  return counted.byRow;
}
