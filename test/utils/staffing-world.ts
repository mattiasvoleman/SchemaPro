import { rawSql } from './locking-read';
import type { TxMock } from './prisma-mock';

/*
 * A school's tjänstefördelning as the staffing checks read it, for specs of
 * the writes those checks guard (src/staffing/staffing-enforcement.ts): the
 * policy, the läsår, the posts, the timplan, the behörigheter, the groups.
 *
 * Every read answers as the table would for the query it is given: the posts
 * filtered by the `userId: { in }` a lock's pre-read names, a select answered
 * with the fields it asks for, the locking read of TeacherEmployments answered
 * only when it is the statement the service sends — `WHERE "id" = ANY($1::uuid[])
 * ORDER BY "id" FOR NO KEY UPDATE` — and recorded, so a spec can say what was
 * locked and that it was locked BEFORE the year was read.
 */

export interface WorldPolicy {
  qualificationMode: 'OFF' | 'WARN' | 'REFUSE';
  overAllocationMode: 'OFF' | 'WARN' | 'REFUSE';
  overAllocationTolerancePercent: number;
  fullTimeTeachingMinutesPerWeek: number | null;
  unstaffedGeneration: 'ALLOW' | 'REFUSE';
  fullTimeRegulatedHoursPerYear: number;
  workDaysPerYear: number;
}

export interface WorldRequirement {
  id: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  lessonsPerWeek: number;
  minutesPerLesson: number;
  /** Longest first on a split row; the column's '{}' when omitted. */
  lessonLengths?: number[];
  teacherLoadPercent?: number;
  coTeacherLoadPercent?: number;
}

export interface StaffingWorld {
  /** Null: the school has no policy row (the table's defaults apply). */
  policy?: Partial<WorldPolicy> | null;
  year?: { id: string; startDate: Date; endDate: Date };
  employments?: { id: string; userId: string; employmentPercent?: number; teachingTargetMinutesPerWeek?: number | null }[];
  requirements?: WorldRequirement[];
  qualifications?: { userId: string; subjectId: string; minGradeLevel: number; maxGradeLevel: number; kind?: 'LEGITIMATION' | 'BEHORIG' | 'TILLATEN'; validFrom?: Date | null; validTo?: Date | null }[];
  groups?: { id: string; name: string; gradeLevel: number | null }[];
  subjects?: { id: string; name: string; code?: string | null }[];
  duties?: { userId: string; minutesPerWeek: number; countsAsTeaching: boolean }[];
}

type Select = Record<string, unknown> | undefined;

const pick = (row: Record<string, unknown>, select: Select): Record<string, unknown> => {
  if (!select) return row;
  return Object.fromEntries(
    Object.entries(select)
      .filter(([, wanted]) => Boolean(wanted))
      .map(([field, wanted]) => {
        const nested = (wanted as { select?: Select }).select;
        const value = row[field];
        return [field, nested && value && typeof value === 'object' ? pick(value as Record<string, unknown>, nested) : value];
      }),
  );
};

const DEFAULT_POLICY: WorldPolicy = {
  qualificationMode: 'WARN',
  overAllocationMode: 'WARN',
  overAllocationTolerancePercent: 10,
  fullTimeTeachingMinutesPerWeek: 1000,
  unstaffedGeneration: 'ALLOW',
  fullTimeRegulatedHoursPerYear: 1360,
  workDaysPerYear: 194,
};

export const WORLD_YEAR = {
  id: '99999999-9999-4999-8999-999999999999',
  startDate: new Date('2026-08-17T00:00:00.000Z'),
  endDate: new Date('2027-06-11T00:00:00.000Z'),
};

/** The statement the service locks posts with, whitespace collapsed. */
export const EMPLOYMENT_LOCK =
  'SELECT "id" FROM "TeacherEmployments" WHERE "id" = ANY(?::uuid[]) ORDER BY "id" FOR NO KEY UPDATE';

export interface WorldHandle {
  /** The post ids each locking read named, in call order. */
  locked: string[][];
  /** Every statement and read, in order: 'lock', 'year', 'write'. */
  order: string[];
}

/**
 * Stubs `tx` with `world`. `fallback` answers any $queryRaw that is not the
 * post lock (a spec's own FOR SHARE read of the year, say); without one such a
 * statement throws.
 */
export function givenStaffingWorld(
  tx: TxMock,
  world: StaffingWorld,
  fallback?: (...call: unknown[]) => unknown,
): WorldHandle {
  const handle: WorldHandle = { locked: [], order: [] };
  const year = world.year ?? WORLD_YEAR;
  const policy = world.policy === null ? null : { ...DEFAULT_POLICY, ...(world.policy ?? {}) };
  const groups = world.groups ?? [];
  const subjects = world.subjects ?? [];
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const subjectById = new Map(subjects.map((subject) => [subject.id, subject]));
  const employments = (world.employments ?? []).map((row) => ({
    academicYearId: year.id,
    employmentPercent: 100,
    reductionPercent: 0,
    contractKind: 'FERIE',
    teachingTargetMinutesPerWeek: null,
    signature: null,
    ...row,
  }));

  tx.staffingPolicy.findUnique.mockImplementation((query: { select?: Select }) =>
    Promise.resolve(policy ? pick(policy as unknown as Record<string, unknown>, query?.select) : null),
  );
  tx.academicYear.findUnique.mockImplementation((query: { where: { id: string }; select?: Select }) => {
    handle.order.push('year');
    return Promise.resolve(
      query.where.id === year.id ? pick(year as unknown as Record<string, unknown>, query.select) : null,
    );
  });
  tx.teacherEmployment.findMany.mockImplementation(
    (query: { where?: { userId?: { in: string[] } }; select?: Select }) => {
      const wanted = query?.where?.userId?.in;
      const rows = wanted ? employments.filter((row) => wanted.includes(row.userId)) : employments;
      return Promise.resolve(rows.map((row) => pick(row, query?.select)));
    },
  );
  tx.teachingRequirement.findMany.mockImplementation((query: { where?: { teacherId?: null }; select?: Select }) => {
    const rows = (world.requirements ?? [])
      .filter((row) => !(query?.where && 'teacherId' in query.where) || row.teacherId === null)
      .map((row) => ({
        teacherLoadPercent: 100,
        coTeacherLoadPercent: 100,
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
        minutesBefore: 0,
        minutesAfter: 0,
        lessonLengths: [],
        academicYearId: year.id,
        ...row,
        subject: { name: subjectById.get(row.subjectId)?.name ?? '?' },
        studentGroup: {
          name: groupById.get(row.studentGroupId)?.name ?? '?',
          gradeLevel: groupById.get(row.studentGroupId)?.gradeLevel ?? null,
        },
      }));
    return Promise.resolve(rows.map((row) => pick(row as Record<string, unknown>, query?.select)));
  });
  tx.teacherSubjectQualification.findMany.mockImplementation((query: { select?: Select }) =>
    Promise.resolve(
      (world.qualifications ?? []).map((row) =>
        pick({ kind: 'LEGITIMATION', validFrom: null, validTo: null, ...row }, query?.select),
      ),
    ),
  );
  tx.teacherDuty.findMany.mockResolvedValue(world.duties ?? []);
  tx.schoolBreak.findMany.mockResolvedValue([]);
  tx.studentGroup.findMany.mockImplementation((query: { select?: Select }) =>
    Promise.resolve(groups.map((group) => pick({ ...group, kind: 'CLASS' }, query?.select))),
  );
  tx.studentGroup.findUnique.mockImplementation((query: { where: { id: string }; select?: Select }) => {
    const group = groupById.get(query.where.id);
    return Promise.resolve(group ? pick({ ...group, academicYearId: year.id }, query.select) : null);
  });
  tx.subject.findUnique.mockImplementation((query: { where: { id: string }; select?: Select }) => {
    const subject = subjectById.get(query.where.id);
    return Promise.resolve(subject ? pick(subject, query.select) : null);
  });
  // Rosters: nobody enrolled, so a group's span is its own gradeLevel.
  tx.studentGroupMember.findMany.mockResolvedValue([]);

  const queryRaw = jest.fn((...call: unknown[]) => {
    const sql = rawSql(call).replace(/\s+/g, ' ').trim();
    if (sql.includes('"TeacherEmployments"')) {
      if (sql !== EMPLOYMENT_LOCK) throw new Error(`Not the post lock: ${sql}`);
      const ids = call[1] as string[];
      handle.locked.push(ids);
      handle.order.push('lock');
      return Promise.resolve(employments.filter((row) => ids.includes(row.id)).map(({ id }) => ({ id })));
    }
    // A grundschema writer's first statement: the publication lock and the
    // school's mode (src/publication/publish-mode.ts). DIRECT in this world.
    if (sql.includes('app.enter_grundschema_write') || sql.includes('app.school_publish_mode')) {
      return Promise.resolve([{ mode: 'DIRECT' }]);
    }
    if (fallback) return fallback(...call);
    throw new Error(`Unexpected raw statement: ${sql}`);
  });
  Object.assign(tx, { $queryRaw: queryRaw });
  return handle;
}

/** Every stub givenStaffingWorld installs, as [model, method]. */
const WORLD_STUBS: [string, string][] = [
  ['staffingPolicy', 'findUnique'],
  ['academicYear', 'findUnique'],
  ['teacherEmployment', 'findMany'],
  ['teachingRequirement', 'findMany'],
  ['teacherSubjectQualification', 'findMany'],
  ['teacherDuty', 'findMany'],
  ['schoolBreak', 'findMany'],
  ['studentGroup', 'findMany'],
  ['studentGroup', 'findUnique'],
  ['subject', 'findUnique'],
  ['studentGroupMember', 'findMany'],
];

/**
 * Puts back what givenStaffingWorld replaced: the e2e harness shares one `tx`
 * across a whole file and jest.clearAllMocks keeps implementations, so a world
 * one test set up would otherwise answer the next test's reads. A findMany goes
 * back to the empty table createTxMock starts it as; everything else to a bare
 * mock; the raw-statement stub is removed.
 */
export function forgetStaffingWorld(tx: TxMock): void {
  for (const [model, method] of WORLD_STUBS) {
    const stub = tx[model]![method]!;
    stub.mockReset();
    if (method === 'findMany') stub.mockResolvedValue([]);
  }
  delete (tx as Record<string, unknown>)['$queryRaw'];
}
