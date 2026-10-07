import type { PrismaService } from '../database/prisma.service';
import { testUser } from '../../test/utils/prisma-mock';
import { IDS, defaultRolloverRows, givenRolloverWorld, prismaFor, type Row } from '../../test/utils/rollover-world';
import { MasterLessonsService } from '../calendar/master-lessons.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { LunchSittingsService } from '../resources/lunch-sittings.service';
import { TeachingRequirementsService } from '../resources/teaching-requirements.service';

/**
 * THE ACTIVE YEAR'S COST, PINNED.
 *
 * The roster basis of the active year is decided from flags its readers
 * already read (projected-rosters.ts, R1), so the hot paths of this year's
 * planning ask the database nothing more than they did — and the master
 * lesson's PATCH one statement less, now that the refusal's scan of every
 * läsår is gone. Each number below is the statements one call makes in the
 * active year of rollover-world's school, every one recorded: reads, writes
 * and raw SQL, in order. At f5ff8da the same three calls, run against the
 * same world, made exactly these statements — the PATCH with
 * academicYear.findMany second, the refusal's scan — and nothing else.
 */

const admin = testUser();
const clock = (value: string) => new Date(`1970-01-01T${value}:00.000Z`);

function school() {
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
  const world = givenRolloverWorld(rows, { strict: true });
  return { world, prisma: prismaFor(world) as unknown as PrismaService };
}

describe('the active year’s statement budget', () => {
  it('a master lesson dragged to another day, with its teacher changed: 17 statements (18 before, the refusal’s scan gone)', async () => {
    const { world, prisma } = school();
    const service = new MasterLessonsService(
      prisma,
      { notifyMasterTimetableChanged: jest.fn() } as unknown as RealtimeService,
      { recipientsForGroups: jest.fn(async () => []), notifyUsers: jest.fn() } as unknown as NotificationsService,
    );
    await service.update('f5000000-0000-4000-8000-000000000001', { dayOfWeek: 2, teacherId: IDS.anna }, admin);
    expect(world.calls.map((call) => `${call.model}.${call.method}`)).toEqual([
      'masterLesson.findUnique',
      'masterLesson.findMany',
      'teachingRequirement.findMany',
      // rosterOf, CURRENT: the reader's own two reads.
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
      'masterLesson.update',
      'calendarLesson.findMany',
      'scheduleChangeLog.create',
    ]);
  });

  it('a timplanspost given a teacher under a WARN policy: 16 statements, as before', async () => {
    const { world, prisma } = school();
    // r2 is Bo's (who has left): Anna is newly assigned, so behörighet is asked.
    const r2 = world.rows['teachingRequirement']![1]!['id'] as string;
    await new TeachingRequirementsService(prisma).update(r2, { teacherId: IDS.anna }, admin);
    expect(world.calls.map((call) => `${call.model}.${call.method}`)).toEqual([
      'teachingRequirement.findUnique',
      'staffingPolicy.findUnique',
      'teacherEmployment.findMany',
      // readLoadInput's year row, which now carries the flags too.
      'academicYear.findUnique',
      'teachingRequirement.findMany',
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
    expect(world.calls.map((call) => `${call.model}.${call.method}`)).toEqual([
      'lunchSetting.findUnique',
      // The class check, which now reads the year's flags on the same row.
      'studentGroup.findFirst',
      'user.count',
      'lunchSitting.upsert',
    ]);
  });
});
