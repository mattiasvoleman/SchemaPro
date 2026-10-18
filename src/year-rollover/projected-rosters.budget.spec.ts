import type { PrismaService } from '../database/prisma.service';
import { testUser } from '../../test/utils/prisma-mock';
import {
  IDS,
  defaultRolloverRows,
  givenRolloverWorld,
  prismaFor,
  statementsOf,
  type RolloverWorld,
  type Row,
} from '../../test/utils/rollover-world';
import { MasterLessonsService } from '../calendar/master-lessons.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { LunchSittingsService } from '../resources/lunch-sittings.service';
import { TeachingRequirementsService } from '../resources/teaching-requirements.service';

/**
 * THE ACTIVE YEAR'S COST, PINNED.
 *
 * The roster basis of the active year is decided from what its readers
 * already read (projected-rosters.ts, R1), so the hot paths of this year's
 * planning ask the database nothing more than they did — and the master
 * lesson's PATCH one statement less, now that the refusal's scan of every
 * läsår is gone. Each list below is the SQL statements one call makes in the
 * active year of rollover-world's school, in order, as statementsOf names
 * them: every recorded read and write, and one more for every relation a
 * call selects, because Prisma 7 loads a selected relation with a query of
 * its own (`› school`). That is what a model-call log alone missed: the
 * year's flags read as a selected `academicYear` relation cost a statement
 * that no fake call showed, on the PATCH and on every meal placed.
 *
 * At f5ff8da the same three calls, run against the same world, made exactly
 * these statements — the PATCH with `academicYear.findMany`, the refusal's
 * scan, after its lesson read — and nothing else. The same paths, plus a
 * substitute assigned and suggested, are counted at pg's own Client.query
 * on Postgres by the adapter probe's case (z).
 */

const admin = testUser();
const clock = (value: string) => new Date(`1970-01-01T${value}:00.000Z`);

function school(arrange: (rows: Record<string, Row[]>) => void = () => undefined) {
  const rows = defaultRolloverRows();
  const lesson = (id: string, studentGroupId: string, dayOfWeek: number, extra: Row = {}): Row => ({
    id,
    schoolId: IDS.school,
    academicYearId: IDS.yearA,
    subjectId: IDS.ma,
    studentGroupId,
    teacherId: null,
    coTeacherId: null,
    roomId: null,
    dayOfWeek,
    startTime: clock('08:00'),
    endTime: clock('09:00'),
    isLocked: false,
    isGenerated: false,
    isParked: false,
    recurrence: 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    extraGroups: [],
    participants: [],
    subject: { name: 'Matematik' },
    ...extra,
  });
  rows['masterLesson'] = [
    lesson('f5000000-0000-4000-8000-000000000001', IDS.g7a, 1),
    // On Tuesday at the same hour: 9A shares no pupil with 7A, so the drag
    // below reads both rosters and lands.
    lesson('f5000000-0000-4000-8000-000000000002', IDS.g9a, 2),
  ];
  rows['school'] = [{ id: IDS.school, timezone: 'Europe/Stockholm' }];
  rows['staffingPolicy'] = [
    {
      schoolId: IDS.school,
      qualificationMode: 'WARN',
      overAllocationMode: 'WARN',
      overAllocationTolerancePercent: 10,
      fullTimeTeachingMinutesPerWeek: 1080,
      unstaffedGeneration: 'ALLOW',
    },
  ];
  rows['teacherSubjectQualification'] = [
    { userId: IDS.anna, subjectId: IDS.ma, minGradeLevel: 7, maxGradeLevel: 9, kind: 'BEHORIG', validFrom: null, validTo: null },
  ];
  rows['teacherEmployment'] = [];
  rows['lunchSetting'] = [{ schoolId: IDS.school, lunchEnabled: true, lunchMinutes: 30 }];
  arrange(rows);
  const world = givenRolloverWorld(rows, { strict: true });
  return { world, prisma: prismaFor(world) as unknown as PrismaService };
}

/**
 * The school's PrismaService, but a master lesson's create hands back the
 * class and pupil rows it wrote as Postgres does — the world keeps the
 * nested `{ create: [...] }` as it was given, and toResult reads the rows.
 * The call goes to the world unchanged, so it is recorded, and counted, as
 * it was made.
 */
function writingNested(world: RolloverWorld): PrismaService {
  const tx = new Proxy(world.tx as unknown as Record<string, unknown>, {
    get(target, key) {
      const model = Reflect.get(target, key) as object;
      if (key !== 'masterLesson') return model;
      return new Proxy(model, {
        get(inner, method) {
          const call = Reflect.get(inner, method) as (args: Row) => Promise<Row>;
          if (method !== 'create') return call;
          return async (args: Row) => {
            const row = await call(args);
            const written = (field: string) => (row[field] as { create: Row[] }).create;
            return { ...row, extraGroups: written('extraGroups'), participants: written('participants') };
          };
        },
      });
    },
  });
  return prismaFor({ ...world, tx: tx as unknown as RolloverWorld['tx'] }) as unknown as PrismaService;
}

describe('the active year’s statement budget', () => {
  it('a master lesson dragged to another day, with its teacher changed: 31 statements (30 before Schemaförslag’s edit lock, 29 before Halvklasser’s groups read, 28 before the block’s read, 27 before the ämnesfördelning’s read, 26 before Publicering’s mode read)', async () => {
    const { world, prisma } = school();
    const service = new MasterLessonsService(
      prisma,
      { notifyMasterTimetableChanged: jest.fn() } as unknown as RealtimeService,
      { recipientsForLessons: jest.fn(async () => []), notifyUsers: jest.fn() } as unknown as NotificationsService,
    );
    await service.update('f5000000-0000-4000-8000-000000000001', { dayOfWeek: 2, teacherId: IDS.anna }, admin);
    expect(statementsOf(world.calls)).toEqual([
      // Publicering: app.enter_grundschema_write — the shared publication
      // lock and the school's mode, one statement, first (publish-mode.ts).
      '$queryRaw.$queryRaw',
      'masterLesson.findUnique',
      'masterLesson.findUnique › extraGroups',
      'masterLesson.findUnique › participants',
      // The school, which now also counts whether the lesson's year is one
      // R1 or R2 settles: a `_count` inside this statement, not a relation
      // select of the year after it. And, since Lärarens dag, whether the
      // school has a cap or the year a day limit: two more counts in it.
      'masterLesson.findUnique › school',
      // Schemaförslag: the lesson's year's share of the regeneration lock
      // (app.lock_years_for_grundschema_edit), one statement, before any row
      // is locked — an edit beside an apply answers 409 within 5 s.
      '$executeRaw.$executeRaw',
      'masterLesson.findMany',
      'masterLesson.findMany › subject',
      'masterLesson.findMany › extraGroups',
      'masterLesson.findMany › participants',
      'teachingRequirement.findMany',
      // rosterOf: which of the groups in play are halves or have halves
      // (Halvklasser, class-halves.ts), one statement; this school has none,
      // so no second read for a half's siblings. Then, CURRENT, the reader's
      // own two reads.
      'studentGroup.findMany',
      'user.findMany',
      'studentGroupMember.findMany',
      'availabilityConstraint.findMany',
      'staffingPolicy.findUnique',
      'teacherSubjectQualification.findMany',
      'subject.findUnique',
      'academicYear.findUnique',
      // attendanceSpan, on the basis the PATCH already holds.
      'studentGroup.findMany',
      'user.findMany',
      'studentGroupMember.findMany',
      'user.findMany',
      // Block i schemat: the lesson's parallel block and the other members'
      // lessons, joined in ONE statement — asked because the lesson moved
      // (block-lessons.ts). This school has no block, so the answer is no row.
      '$queryRaw.$queryRaw',
      'masterLesson.update',
      'masterLesson.update › row',
      'masterLesson.update › extraGroups',
      'masterLesson.update › participants',
      'calendarLesson.findMany',
      // Ämnesfördelning: the timplanspost, its subject's default and both
      // names, joined in ONE statement — asked because the lesson moved to
      // another day. The school has no rule, so its week is never read.
      '$queryRaw.$queryRaw',
      // Lärarens dag: no cap and no day limit counted above, so nothing.
      'scheduleChangeLog.create',
    ]);
  });

  it('the same drag where the new teacher has a cap and a day limit: 33 statements, three where a rule is', async () => {
    // What a school that sets Lärarens dag pays on a drag: the teachers' caps,
    // their posts' day limits for the lesson's year, and their week — after
    // the ämnesfördelning's read, before the change log. Anna's week holds
    // the one lesson, which breaks neither rule, so no read is recorded.
    const { world, prisma } = school((rows) => {
      rows['teacherWorkRule'] = [
        {
          id: 'f6000000-0000-4000-8000-000000000001',
          schoolId: IDS.school,
          userId: IDS.anna,
          maxTeachingMinutesPerDay: 360,
        },
      ];
      rows['teacherEmployment'] = [
        {
          id: 'f6000000-0000-4000-8000-000000000002',
          schoolId: IDS.school,
          userId: IDS.anna,
          academicYearId: IDS.yearA,
          employmentPercent: 100,
          reductionPercent: 0,
          maxTeachingDaysPerWeek: 5,
        },
      ];
    });
    const service = new MasterLessonsService(
      prisma,
      { notifyMasterTimetableChanged: jest.fn() } as unknown as RealtimeService,
      { recipientsForLessons: jest.fn(async () => []), notifyUsers: jest.fn() } as unknown as NotificationsService,
    );
    const updated = await service.update(
      'f5000000-0000-4000-8000-000000000001',
      { dayOfWeek: 2, teacherId: IDS.anna },
      admin,
    );
    expect(updated.warnings).toEqual([]);
    const statements = statementsOf(world.calls);
    expect(statements).toHaveLength(33);
    expect(statements.slice(-5)).toEqual([
      '$queryRaw.$queryRaw',
      'teacherWorkRule.findMany',
      'teacherEmployment.findMany',
      'masterLesson.findMany',
      'scheduleChangeLog.create',
    ]);
  });

  it('a master lesson created with a teacher, in a school without a rule: 14 statements, one of them the teacher’s cap', async () => {
    const ROOM = '00000000-0000-4000-8000-0000000000e1';
    // THE ONE STATEMENT A CREATE PAYS FOR LÄRARENS DAG WHERE NO RULE IS SET,
    // pinned because it cannot be carried. A PATCH and a card move count the
    // gate inside the school statement they send anyway (teacherDayCounts);
    // a create reads no row the school's caps can be counted in — the year
    // has no relation to the work rules, and its school selected for the
    // count would be a statement of its own, +1 on every create, teacher or
    // not. So the create asks the named teachers' caps directly, the gate
    // and the rule in one indexed statement, and only when the lesson names
    // a teacher; the posts' day limits ride on the year's read as a `_count`.
    // Counted at Postgres too: the adapter probe's (z), 'POST a lesson with
    // a teacher'.
    const statementsOfCreate = async (teacherId?: string, roomId?: string) => {
      const { world } = school();
      const service = new MasterLessonsService(
        writingNested(world),
        { notifyMasterTimetableChanged: jest.fn() } as unknown as RealtimeService,
        { recipientsForLessons: jest.fn(async () => []), notifyUsers: jest.fn() } as unknown as NotificationsService,
      );
      // Thursday 10:00, where 7A meets nobody: no roster is read.
      const created = await service.create(
        {
          academicYearId: IDS.yearA,
          subjectId: IDS.ma,
          studentGroupId: IDS.g7a,
          ...(teacherId ? { teacherId } : {}),
          ...(roomId ? { roomId } : {}),
          dayOfWeek: 4,
          startTime: '10:00',
          endTime: '11:00',
        },
        admin,
      );
      expect(created.warnings).toEqual([]);
      return statementsOf(world.calls);
    };
    const withoutTeacher = [
      // Publicering's mode read, then the year with its flags and the count
      // of day limits on the named teachers' posts, in one statement.
      '$queryRaw.$queryRaw',
      'academicYear.findUnique',
      // The clash scan of the day.
      'masterLesson.findMany',
      'masterLesson.findMany › subject',
      'masterLesson.findMany › extraGroups',
      'masterLesson.findMany › participants',
      'availabilityConstraint.findMany',
      'masterLesson.create',
      'masterLesson.create › row',
      'masterLesson.create › extraGroups',
      'masterLesson.create › participants',
      'scheduleChangeLog.create',
      // Ämnesfördelning: the timplanspost, joined; it has no rule.
      '$queryRaw.$queryRaw',
    ];
    expect(await statementsOfCreate()).toEqual(withoutTeacher);
    // Lärarens dag: the teacher has no cap, so nothing is asked after it.
    expect(await statementsOfCreate(IDS.anna)).toEqual([...withoutTeacher, 'teacherWorkRule.findMany']);
    // Skolområden och restid: a lesson in a room asks whether the school has
    // a travel figure, one indexed statement that ends it where none is
    // (readSiteMap reads the pairs first). A lesson without a room walks
    // nowhere and asks nothing, so the two above are unchanged.
    expect(await statementsOfCreate(IDS.anna, ROOM)).toEqual([
      ...withoutTeacher,
      'teacherWorkRule.findMany',
      'siteTravelTime.findMany',
    ]);
  });

  it('a timplanspost given a teacher under a WARN policy: 18 statements, as before', async () => {
    const { world, prisma } = school();
    // r2 is Bo's (who has left): Anna is newly assigned, so behörighet is asked.
    const r2 = world.rows['teachingRequirement']![1]!['id'] as string;
    await new TeachingRequirementsService(prisma).update(r2, { teacherId: IDS.anna }, admin);
    expect(statementsOf(world.calls)).toEqual([
      'teachingRequirement.findUnique',
      'staffingPolicy.findUnique',
      'teacherEmployment.findMany',
      // readLoadInput's year row, which now carries the flags too.
      'academicYear.findUnique',
      'teachingRequirement.findMany',
      'teachingRequirement.findMany › subject',
      'teachingRequirement.findMany › studentGroup',
      'teacherEmployment.findMany',
      'staffingPolicy.findUnique',
      'schoolBreak.findMany',
      'teacherSubjectQualification.findMany',
      'user.findMany',
      'teacherDuty.findMany',
      'studentGroup.findMany',
      'user.findMany',
      'studentGroupMember.findMany',
      'user.findMany',
      'teachingRequirement.update',
    ]);
  });

  it('a meal placed by hand: 4 statements, as before', async () => {
    const { world, prisma } = school();
    await new LunchSittingsService(prisma).place(
      { academicYearId: IDS.yearA, studentGroupId: IDS.g7a, dayOfWeek: 1, startTime: '11:00' },
      admin,
    );
    expect(statementsOf(world.calls)).toEqual([
      'lunchSetting.findUnique',
      // The class check, asked of the year with the class as a relation
      // filter, so the year's flags come in the same statement. As
      // `studentGroup.findFirst › academicYear` it was one more.
      'academicYear.findFirst',
      'user.count',
      'lunchSitting.upsert',
    ]);
  });
});
