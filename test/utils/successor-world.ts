import { testUser } from './prisma-mock';
import { IDS, defaultRolloverRows, givenRolloverWorld, prismaFor, type RolloverWorld, type Row } from './rollover-world';
import type { PrismaService } from '../../src/database/prisma.service';
import { YearRolloverService } from '../../src/year-rollover/year-rollover.service';

/**
 * The school of rollover-world, rolled into B and then lived in for a
 * spring: the fixture the förberäknade klasslistor are proved on, reader by
 * reader, before and after B's activation.
 *
 * Every case the projection has to get right is in it:
 *
 *  - B is made by executeRollover with the teaching-group members carried
 *    (Ma7 → Ma8), and 7C is skipped, so its pupils have no successor.
 *  - Mid-year class changes after the rollover: p7b1 7B → 7A (lands in 8A,
 *    keeps the Ma8 membership copied from 7B's placement), p7c1 7C → 7A (in
 *    Ma7 but not copied, since 7C had no successor: a MISSING membership),
 *    p8a2 8A → the graduating 9A (copied into Ma8: a STALE membership).
 *  - Graduates (9A), and unplaced pupils of both kinds: p7c2 in the skipped
 *    7C (NO_SUCCESSOR), p7b2 in 7B whose successor 8B an admin has since made
 *    a teaching group (SUCCESSOR_NOT_A_CLASS).
 *  - pGone, inactive in 7A, whom an admin put in Ma8 too.
 *  - pNew, enrolled straight into B's 8A; pSummer in an unrelated year; pNone
 *    in no class.
 *  - A lesson in B kept from regeneration, naming p9a1 — who graduates — one
 *    by one, and a Ma8 lesson on Monday 08:00.
 */
export const SUCCESSOR = {
  g7b: 'b0000000-0000-4000-8000-0000000000b7',
  g7c: 'b0000000-0000-4000-8000-0000000000c7',
  yearS: 'a0000000-0000-4000-8000-0000000000ee',
  gSummer: 'b0000000-0000-4000-8000-0000000000ee',
  p7b1: 'c0000000-0000-4000-8000-0000000007b1',
  p7b2: 'c0000000-0000-4000-8000-0000000007b2',
  p7c1: 'c0000000-0000-4000-8000-0000000007c1',
  p7c2: 'c0000000-0000-4000-8000-0000000007c2',
  p8a2: 'c0000000-0000-4000-8000-000000000082',
  pNew: 'c0000000-0000-4000-8000-0000000000a1',
  pSummer: 'c0000000-0000-4000-8000-0000000000a2',
  pNone: 'c0000000-0000-4000-8000-0000000000a3',
  lessonMa8: 'f3000000-0000-4000-8000-000000000001',
  lessonNamed: 'f3000000-0000-4000-8000-000000000002',
} as const;

/** The day the activation runs: after A (2026/27) has ended. */
export const AFTER_A = { today: '2027-06-14' };

export const schoolAdmin = testUser();

export interface SuccessorWorld {
  world: RolloverWorld;
  prisma: PrismaService;
  rollover: YearRolloverService;
  yearB: string;
  /** B's group id by name. */
  b: (name: string) => string;
  /** Activates B as the admin does: preview, then execute with its hash. */
  activate: () => Promise<void>;
}

const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

export async function givenSuccessorWorld(options: { strict?: boolean } = { strict: true }): Promise<SuccessorWorld> {
  const rows = defaultRolloverRows();
  const pupil = (id: string, studentGroupId: string | null, isActive = true): Row => ({
    id,
    role: 'STUDENT',
    isActive,
    studentGroupId,
  });
  rows['academicYear']!.push({
    id: SUCCESSOR.yearS,
    schoolId: IDS.school,
    name: 'Sommarskola 2027',
    startDate: day('2027-06-14'),
    endDate: day('2027-07-02'),
    isActive: false,
    predecessorId: null,
    graduatingGradeLevel: null,
  });
  rows['studentGroup']!.push(
    { id: SUCCESSOR.g7b, academicYearId: IDS.yearA, name: '7B', kind: 'CLASS', gradeLevel: 7, predecessorId: null },
    { id: SUCCESSOR.g7c, academicYearId: IDS.yearA, name: '7C', kind: 'CLASS', gradeLevel: 7, predecessorId: null },
    { id: SUCCESSOR.gSummer, academicYearId: SUCCESSOR.yearS, name: 'Sommar', kind: 'CLASS', gradeLevel: null, predecessorId: null },
  );
  rows['user']!.push(
    pupil(SUCCESSOR.p7b1, SUCCESSOR.g7b),
    pupil(SUCCESSOR.p7b2, SUCCESSOR.g7b),
    pupil(SUCCESSOR.p7c1, SUCCESSOR.g7c),
    pupil(SUCCESSOR.p7c2, SUCCESSOR.g7c),
    pupil(SUCCESSOR.p8a2, IDS.g8a),
    pupil(SUCCESSOR.pSummer, SUCCESSOR.gSummer),
    pupil(SUCCESSOR.pNone, null),
  );
  const member = (studentId: string) => ({
    studentGroupId: IDS.gMa7,
    studentId,
    student: { studentGroupId: null },
  });
  rows['studentGroupMember']!.push(member(SUCCESSOR.p7b1), member(SUCCESSOR.p7c1), member(SUCCESSOR.p8a2));

  const world = givenRolloverWorld(rows, options);
  const prisma = prismaFor(world) as unknown as PrismaService;
  const rollover = new YearRolloverService(prisma);

  const target = { name: '2027/28', startDate: '2027-08-16', endDate: '2028-06-09' };
  const choices = { ...target, groups: [{ sourceGroupId: SUCCESSOR.g7c, outcome: 'SKIP' as const }] };
  const preview = await rollover.previewRollover(IDS.yearA, choices, schoolAdmin);
  if (preview.blocking) throw new Error(`successor world: the rollover is blocked: ${JSON.stringify(preview.problems)}`);
  const made = await rollover.executeRollover(
    IDS.yearA,
    { ...choices, graduatingGradeLevel: 9, planHash: preview.planHash },
    schoolAdmin,
  );
  const yearB = made.academicYear.id;
  const b = (name: string): string => {
    const found = world.rows['studentGroup']!.find((group) => group['academicYearId'] === yearB && group['name'] === name);
    if (!found) throw new Error(`successor world: B has no group ${name}`);
    return found['id'] as string;
  };

  // The spring, in A, after the rollover.
  const user = (id: string) => world.rows['user']!.find((row) => row['id'] === id)!;
  user(SUCCESSOR.p7b1)['studentGroupId'] = IDS.g7a;
  user(SUCCESSOR.p7c1)['studentGroupId'] = IDS.g7a;
  user(SUCCESSOR.p8a2)['studentGroupId'] = IDS.g9a;
  world.rows['studentGroup']!.find((group) => group['id'] === b('8B'))!['kind'] = 'TEACHING_GROUP';
  world.rows['studentGroupMember']!.push({ studentGroupId: b('Ma8 grupp 1'), studentId: IDS.pGone });
  world.rows['user']!.push(pupil(SUCCESSOR.pNew, b('8A')));
  world.rows['masterLesson'] = [
    lesson(SUCCESSOR.lessonMa8, yearB, b('Ma8 grupp 1'), { isLocked: true }),
    lesson(SUCCESSOR.lessonNamed, yearB, b('9A'), { dayOfWeek: 2, participants: [{ studentId: IDS.p9a1 }] }),
  ];
  // Anna may teach mathematics in åk 8 only: a span of 8–9 is not hers.
  world.rows['teacherSubjectQualification'] = [
    {
      userId: IDS.anna,
      subjectId: IDS.ma,
      minGradeLevel: 8,
      maxGradeLevel: 8,
      kind: 'BEHORIG',
      validFrom: null,
      validTo: null,
    },
  ];
  world.rows['lunchSetting'] = [
    {
      schoolId: IDS.school,
      lunchEnabled: true,
      lunchStartTime: new Date('1970-01-01T10:30:00.000Z'),
      lunchEndTime: new Date('1970-01-01T13:00:00.000Z'),
      lunchMinutes: 30,
      diningSeats: null,
      maxLessonsPerDayPerGroup: null,
    },
  ];
  world.calls.length = 0;

  return {
    world,
    prisma,
    rollover,
    yearB,
    b,
    activate: async () => {
      const activation = await rollover.previewActivation(yearB, schoolAdmin, AFTER_A);
      if (activation.blocking) throw new Error(`successor world: the activation is blocked: ${JSON.stringify(activation.problems)}`);
      await rollover.executeActivation(yearB, { planHash: activation.planHash }, schoolAdmin, AFTER_A);
    },
  };

  function lesson(id: string, academicYearId: string, studentGroupId: string, extra: Row): Row {
    return {
      id,
      schoolId: IDS.school,
      academicYearId,
      subjectId: IDS.ma,
      studentGroupId,
      teacherId: IDS.anna,
      coTeacherId: null,
      roomId: null,
      dayOfWeek: 1,
      startTime: new Date('1970-01-01T08:00:00.000Z'),
      endTime: new Date('1970-01-01T09:00:00.000Z'),
      isLocked: false,
      isGenerated: false,
      isParked: false,
      recurrence: 'ALL_WEEKS',
      startDate: null,
      endDate: null,
      extraGroups: [],
      participants: [],
      subject: { name: 'Matematik', requiredRoomTypeId: null },
      ...extra,
    };
  }
}
