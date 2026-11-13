import { NotFoundException } from '@nestjs/common';
import { loadRosters } from '../optimization/room-eligibility';
import { readOtherSchoolHolds } from '../optimization/other-school-holds';
import { rostersOfYear } from '../year-rollover/projected-rosters';
import { readSwapData } from './swap-snapshot';

jest.mock('../year-rollover/projected-rosters', () => ({ rostersOfYear: jest.fn() }));
jest.mock('../optimization/room-eligibility', () => ({ loadRosters: jest.fn() }));
jest.mock('../optimization/other-school-holds', () => ({ readOtherSchoolHolds: jest.fn() }));

const YEAR = 'y-1';
const SCHOOL = 's-1';
const clock = (h: number, m = 0) => new Date(Date.UTC(1970, 0, 1, h, m));
const user = { userId: 'u', role: 'SCHOOL_ADMIN' } as never;

const lessonRow = (over: Record<string, unknown> = {}) => ({
  id: 'l1',
  subjectId: 'ma',
  studentGroupId: '7A',
  teacherId: 't1',
  coTeacherId: null,
  roomId: 'r1',
  dayOfWeek: 1,
  startTime: clock(8),
  endTime: clock(9),
  isLocked: true,
  isGenerated: false,
  recurrence: 'ODD_WEEKS',
  startDate: new Date('2026-09-01T00:00:00.000Z'),
  endDate: null,
  subject: { name: 'Matematik' },
  studentGroup: { name: '7A' },
  extraGroups: [{ studentGroupId: '7C' }, { studentGroupId: '7B' }],
  participants: [{ studentId: 'p2' }, { studentId: 'p1' }],
  ...over,
});

function tx(over: Record<string, unknown> = {}) {
  return {
    academicYear: {
      findUnique: jest.fn(async () => ({ id: YEAR, schoolId: SCHOOL, isActive: true, predecessorId: null, gradeNumbering: 'NIOARIG' })),
    },
    masterLesson: {
      findMany: jest.fn(async () => [
        lessonRow(),
        // A parked lesson is excluded by the query; one with no length or on a Sunday-plus day by the reader.
        lessonRow({ id: 'zero', endTime: clock(8) }),
        lessonRow({ id: 'eighth-day', dayOfWeek: 8 }),
      ]),
    },
    teachingRequirement: {
      findMany: jest.fn(async () => [
        {
          studentGroupId: '7A',
          subjectId: 'ma',
          blockId: 'b1',
          minutesBefore: 5,
          minutesAfter: 10,
          ownDistribution: true,
          maxLessonsPerDay: 1,
          minDaysBetween: null,
          subject: { maxLessonsPerDay: 3, minDaysBetween: 2 },
        },
        {
          studentGroupId: '7A',
          subjectId: 'sv',
          blockId: null,
          minutesBefore: 0,
          minutesAfter: 0,
          ownDistribution: false,
          maxLessonsPerDay: null,
          minDaysBetween: null,
          subject: { maxLessonsPerDay: 3, minDaysBetween: 2 },
        },
      ]),
    },
    teachingBlock: { findMany: jest.fn(async () => [{ id: 'b1', sameTimesAsBlockId: null }]) },
    studentGroup: {
      findMany: jest.fn(async () => [
        { id: '7A', name: '7A', kind: 'CLASS', halfOfId: null, replacesSubjectId: null, gradeLevel: 7 },
        { id: 'SvA7', name: 'SvA7', kind: 'TEACHING_GROUP', halfOfId: null, replacesSubjectId: 'sv', gradeLevel: null },
      ]),
    },
    availabilityConstraint: {
      findMany: jest.fn(async () => [
        {
          resourceType: 'TEACHER',
          userId: 't1',
          roomId: null,
          studentGroupId: null,
          minGradeLevel: null,
          maxGradeLevel: null,
          dayOfWeek: 2,
          startTime: clock(13),
          endTime: clock(14, 30),
        },
      ]),
    },
    frameTime: {
      findMany: jest.fn(async () => [{ minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: null, startTime: clock(8), endTime: clock(15) }]),
    },
    lunchSetting: {
      findUnique: jest.fn(async () => ({ lunchEnabled: true, lunchStartTime: clock(11), lunchEndTime: clock(13), lunchMinutes: 30 })),
    },
    lunchSitting: {
      findMany: jest.fn(async () => [{ studentGroupId: '7A', dayOfWeek: 1, startTime: clock(11, 30), endTime: clock(12) }]),
    },
    teacherWorkRule: { findMany: jest.fn(async () => [{ userId: 't1', maxTeachingMinutesPerDay: 240 }]) },
    teacherEmployment: {
      findMany: jest.fn(async () => [
        { userId: 't1', maxTeachingDaysPerWeek: 4, maxConsecutiveTeachingMinutes: null, consecutiveBreakMinutes: null },
        { userId: 't3', maxTeachingDaysPerWeek: null, maxConsecutiveTeachingMinutes: 180, consecutiveBreakMinutes: 20 },
      ]),
    },
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (rostersOfYear as jest.Mock).mockResolvedValue({ kind: 'CURRENT' });
  (loadRosters as jest.Mock).mockResolvedValue({ membersByGroup: new Map(), groupsByStudent: new Map() });
  (readOtherSchoolHolds as jest.Mock).mockResolvedValue({ holds: [{ holdId: 'h' }] });
});

describe('readSwapData', () => {
  it('reads the year’s placed lessons, in minutes and dates, with their classes and pupils in a stable order', async () => {
    const data = await readSwapData(tx() as never, user, YEAR);
    expect(data.schoolId).toBe(SCHOOL);
    expect(data.gradeNumbering).toBe('NIOARIG');
    expect(data.lessons).toEqual([
      {
        id: 'l1',
        subjectId: 'ma',
        subjectName: 'Matematik',
        studentGroupId: '7A',
        groupName: '7A',
        teacherId: 't1',
        coTeacherId: null,
        roomId: 'r1',
        dayOfWeek: 1,
        startMinutes: 480,
        endMinutes: 540,
        recurrence: 'ODD_WEEKS',
        startDate: '2026-09-01',
        endDate: null,
        isLocked: true,
        isGenerated: false,
        extraGroupIds: ['7B', '7C'],
        studentIds: ['p1', 'p2'],
      },
    ]);
  });

  it('reads the pupils through the year’s basis, for every group the lessons name and every pupil they name', async () => {
    const database = tx();
    await readSwapData(database as never, user, YEAR);
    expect(rostersOfYear).toHaveBeenCalledWith(database, user, YEAR, expect.objectContaining({ id: YEAR }));
    const [, basis, groupIds, groups, named] = (loadRosters as jest.Mock).mock.calls[0]!;
    expect(basis).toEqual({ kind: 'CURRENT' });
    expect([...groupIds].sort()).toEqual(['7A', '7B', '7C', 'SvA7']);
    expect(groups.map((g: { id: string }) => g.id)).toEqual(['7A', 'SvA7']);
    expect([...named].sort()).toEqual(['p1', 'p2']);
  });

  it('takes the post’s own distribution rule or the subject’s, its block and its pupil buffers', async () => {
    const data = await readSwapData(tx() as never, user, YEAR);
    expect(data.posts).toEqual([
      { studentGroupId: '7A', subjectId: 'ma', blockId: 'b1', minutesBefore: 5, minutesAfter: 10, distribution: { maxLessonsPerDay: 1, minDaysBetween: null } },
      { studentGroupId: '7A', subjectId: 'sv', blockId: null, minutesBefore: 0, minutesAfter: 0, distribution: { maxLessonsPerDay: 3, minDaysBetween: 2 } },
    ]);
    expect(data.blocks).toEqual([{ id: 'b1', sameTimesAsBlockId: null }]);
  });

  it('reads the weekly rows, frames, lunch rule, sittings and holds in minutes', async () => {
    const data = await readSwapData(tx() as never, user, YEAR);
    expect(data.constraints).toEqual([
      { resourceType: 'TEACHER', userId: 't1', roomId: null, studentGroupId: null, minGradeLevel: null, maxGradeLevel: null, dayOfWeek: 2, startMinutes: 780, endMinutes: 870 },
    ]);
    expect(data.frames).toEqual([{ min: 7, max: 9, day: null, start: 480, end: 900 }]);
    expect(data.lunch).toEqual({ start: 660, end: 780, minutes: 30 });
    expect(data.sittings).toEqual([{ studentGroupId: '7A', dayOfWeek: 1, startMinutes: 690, endMinutes: 720 }]);
    expect(data.holds).toEqual([{ holdId: 'h' }]);
    expect(readOtherSchoolHolds).toHaveBeenCalledWith(expect.anything(), YEAR, SCHOOL);
  });

  it('reads the weeks each meal holds, and carries them into the sittings as days (20270209090000)', async () => {
    const findMany = jest.fn(async () => [
      { studentGroupId: '7A', dayOfWeek: 1, startTime: clock(11), endTime: clock(11, 30), startDate: null, endDate: new Date('2026-12-20T00:00:00.000Z') },
      { studentGroupId: '7A', dayOfWeek: 1, startTime: clock(11, 30), endTime: clock(12), startDate: new Date('2027-01-11T00:00:00.000Z'), endDate: null },
      { studentGroupId: '7B', dayOfWeek: 2, startTime: clock(11), endTime: clock(11, 30), startDate: null, endDate: null },
    ]);
    const data = await readSwapData(tx({ lunchSitting: { findMany } }) as never, user, YEAR);
    // The query asks for the dates: a column left out of the select is a meal of the whole läsår, silently.
    expect(findMany).toHaveBeenCalledWith({
      where: { academicYearId: YEAR },
      select: { studentGroupId: true, dayOfWeek: true, startTime: true, endTime: true, startDate: true, endDate: true },
    });
    expect(data.sittings).toEqual([
      { studentGroupId: '7A', dayOfWeek: 1, startMinutes: 660, endMinutes: 690, startDate: null, endDate: '2026-12-20' },
      { studentGroupId: '7A', dayOfWeek: 1, startMinutes: 690, endMinutes: 720, startDate: '2027-01-11', endDate: null },
      // A meal of the whole läsår is the object it always was.
      { studentGroupId: '7B', dayOfWeek: 2, startMinutes: 660, endMinutes: 690 },
    ]);
  });

  it('has no lunch rule when lunch is off, the window is empty, or there is no row; and never longer than the window', async () => {
    const lunch = (row: unknown) => readSwapData(tx({ lunchSetting: { findUnique: jest.fn(async () => row) } }) as never, user, YEAR).then((d) => d.lunch);
    expect(await lunch(null)).toBeNull();
    expect(await lunch({ lunchEnabled: false, lunchStartTime: clock(11), lunchEndTime: clock(13), lunchMinutes: 30 })).toBeNull();
    expect(await lunch({ lunchEnabled: true, lunchStartTime: clock(13), lunchEndTime: clock(11), lunchMinutes: 30 })).toBeNull();
    expect(await lunch({ lunchEnabled: true, lunchStartTime: clock(11), lunchEndTime: clock(11, 20), lunchMinutes: 30 })).toEqual({ start: 660, end: 680, minutes: 20 });
    expect(await lunch({ lunchEnabled: true, lunchStartTime: clock(11), lunchEndTime: clock(12), lunchMinutes: -5 })).toEqual({ start: 660, end: 720, minutes: 0 });
  });

  it('holds a teacher to the cap of their work rule and the limits of their post, and says which are HR data', async () => {
    const data = await readSwapData(tx() as never, user, YEAR);
    expect(data.teacherRules.get('t1')).toEqual({
      maxTeachingMinutesPerDay: 240,
      maxTeachingDaysPerWeek: 4,
      maxConsecutiveTeachingMinutes: null,
      consecutiveBreakMinutes: null,
    });
    // t3 has a post but teaches no placed lesson: not asked about.
    expect(data.teacherRules.has('t3')).toBe(false);
    expect([...data.postLimited]).toEqual(['t1']);
  });

  it('asks the database nothing about teachers when no lesson has one', async () => {
    const database = tx({ masterLesson: { findMany: jest.fn(async () => [lessonRow({ teacherId: null })]) } });
    const data = await readSwapData(database as never, user, YEAR);
    expect(database.teacherWorkRule.findMany).not.toHaveBeenCalled();
    expect(database.teacherEmployment.findMany).not.toHaveBeenCalled();
    expect(data.teacherRules.size).toBe(0);
  });

  it('is a 404 for a year that is not there', async () => {
    const database = tx({ academicYear: { findUnique: jest.fn(async () => null) } });
    await expect(readSwapData(database as never, user, YEAR)).rejects.toBeInstanceOf(NotFoundException);
  });
});
