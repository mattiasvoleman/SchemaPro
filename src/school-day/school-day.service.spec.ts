import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { datesOf, MAX_DAYS, SchoolDayService } from './school-day.service';
import type { TeacherView } from './school-day.types';

const admin = testUser({ schoolId: 'school-1' });
const teacher = testUser({ role: 'TEACHER' as never, userId: 'teacher-1', schoolId: 'school-1' });
const student = testUser({ role: 'STUDENT' as never, userId: 'student-1', schoolId: 'school-1' });

type Statement = { strings: string[]; values: unknown[] };
const sql = (statement: unknown) => (statement as Statement).strings.join('?');

// Monday 22 March 2027 is CET (UTC+1), Monday 29 March CEST (UTC+2): the clocks go forward on the Sunday between.
const WINTER = '2027-03-22';
const SUMMER = '2027-03-29';
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
const instant = (value: string) => new Date(value);

interface World {
  view?: TeacherView | null;
  timezone?: string;
  lessons?: Array<Record<string, unknown>>;
  groups?: Array<Record<string, unknown>>;
  rooms?: Array<Record<string, unknown>>;
  subjects?: Array<Record<string, unknown>>;
  users?: Array<Record<string, unknown>>;
  breaks?: Array<Record<string, unknown>>;
  bookings?: Array<Record<string, unknown>>;
  roomConstraints?: Array<Record<string, unknown>>;
  teacherConstraints?: Array<Record<string, unknown>>;
  absences?: Array<Record<string, unknown>>;
  members?: Array<Record<string, unknown>>;
  windows?: Array<Record<string, unknown>>;
  posts?: Array<Record<string, unknown>>;
  years?: Array<Record<string, unknown>>;
  loans?: Array<Record<string, unknown>>;
  marked?: string[];
}

const person = (id: string, firstName: string, lastName: string, isActive = true) => ({ id, firstName, lastName, isActive });

function setup(world: World = {}) {
  const tx = createTxMock();
  const prisma = createPrismaMock(tx);
  const calls: string[] = [];
  const stub = (model: string, method: string, answer: unknown) => {
    tx[model]![method]!.mockImplementation(async (args?: unknown) => {
      calls.push(`${model}.${method}`);
      return typeof answer === 'function' ? (answer as (args?: unknown) => unknown)(args) : answer;
    });
  };
  stub('schoolDaySettings', 'findUnique', world.view === null ? null : { teacherView: world.view ?? 'NONE' });
  stub('school', 'findUnique', { timezone: world.timezone ?? 'Europe/Stockholm' });
  stub('studentGroup', 'findMany', world.groups ?? []);
  stub('room', 'findMany', world.rooms ?? []);
  stub('subject', 'findMany', world.subjects ?? []);
  stub('user', 'findMany', world.users ?? []);
  stub('calendarLesson', 'findMany', world.lessons ?? []);
  stub('schoolBreak', 'findMany', world.breaks ?? []);
  stub('roomBooking', 'findMany', world.bookings ?? []);
  stub('availabilityConstraint', 'findMany', (args: { where?: { resourceType?: string } }) =>
    args?.where?.resourceType === 'ROOM' ? (world.roomConstraints ?? []) : (world.teacherConstraints ?? []),
  );
  stub('teacherAbsence', 'findMany', world.absences ?? []);
  stub('substitutePoolMember', 'findMany', world.members ?? []);
  stub('substituteAvailability', 'findMany', world.windows ?? []);
  stub('teacherEmployment', 'findMany', world.posts ?? []);
  stub('roomLoan', 'findMany', world.loans ?? []);
  stub('academicYear', 'findMany', world.years ?? [{ id: 'year-1', startDate: day('2026-08-17'), endDate: day('2027-06-11'), isActive: true }]);
  stub('academicYear', 'findFirst', { id: 'year-1' });
  tx.$queryRaw = jest.fn(async (statement: unknown) => {
    if (sql(statement).includes('school_day_protected_staff')) return (world.marked ?? []).map((id) => ({ id }));
    return [];
  });
  const service = new SchoolDayService(prisma as unknown as PrismaService);
  return { tx, prisma, service, calls };
}

const lessonRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'l1',
  date: day(WINTER),
  startsAt: instant(`${WINTER}T07:15:00Z`),
  endsAt: instant(`${WINTER}T08:00:00Z`),
  status: 'SCHEDULED',
  cancelCause: null,
  subjectId: 's1',
  studentGroupId: 'g1',
  roomId: 'r1',
  teachers: [{ teacherId: 't1', role: 'LEAD' }],
  extraGroups: [],
  activityLinks: [],
  ...overrides,
});

const model = (tx: TxMock, name: string, method: string) => tx[name]![method]!;

describe('datesOf', () => {
  it('lists the days of the range, inclusive, and refuses a backwards or too long one', () => {
    expect(datesOf('2027-03-27', '2027-03-29')).toEqual(['2027-03-27', '2027-03-28', '2027-03-29']);
    expect(datesOf('2027-03-29', '2027-03-29')).toEqual(['2027-03-29']);
    expect(() => datesOf('2027-03-29', '2027-03-28')).toThrow(BadRequestException);
    expect(datesOf('2027-03-22', '2027-03-28')).toHaveLength(MAX_DAYS);
    expect(() => datesOf('2027-03-22', '2027-03-29')).toThrow(BadRequestException);
  });
});

describe('SchoolDayService', () => {
  describe('settings', () => {
    it('answers NONE for a school that has not decided, and what it decided otherwise', async () => {
      expect(await setup({ view: null }).service.settings(admin)).toEqual({ teacherView: 'NONE', guardianNoticeOnMove: false });
      expect(await setup({ view: 'ROOMS' }).service.settings(teacher)).toEqual({ teacherView: 'ROOMS', guardianNoticeOnMove: false });
    });

    it('answers the school’s choice about telling a guardian of a move, off until it says so (Elevens lektion för dagen)', async () => {
      const on = setup({ view: 'ROOMS' });
      model(on.tx, 'schoolDaySettings', 'findUnique').mockResolvedValue({ teacherView: 'ROOMS', guardianNoticeOnMove: true });
      expect(await on.service.settings(admin)).toEqual({ teacherView: 'ROOMS', guardianNoticeOnMove: true });
    });

    it('saves the decision as one row per school', async () => {
      const { service, tx } = setup({ view: 'ALL' });
      expect(await service.updateSettings({ teacherView: 'ALL' }, admin)).toEqual({ teacherView: 'ALL', guardianNoticeOnMove: false });
      // A choice that is not sent is left as it is: the upsert does not carry it.
      expect(model(tx, 'schoolDaySettings', 'upsert')).toHaveBeenCalledWith({
        where: { schoolId: 'school-1' },
        create: { schoolId: 'school-1', teacherView: 'ALL' },
        update: { teacherView: 'ALL' },
      });
    });

    it('saves the school’s choice about telling a guardian of a move beside the view, when it is sent', async () => {
      const { service, tx } = setup({ view: 'ALL' });
      await service.updateSettings({ teacherView: 'ALL', guardianNoticeOnMove: true }, admin);
      expect(model(tx, 'schoolDaySettings', 'upsert')).toHaveBeenCalledWith({
        where: { schoolId: 'school-1' },
        create: { schoolId: 'school-1', teacherView: 'ALL', guardianNoticeOnMove: true },
        update: { teacherView: 'ALL', guardianNoticeOnMove: true },
      });
    });
  });

  describe('who may ask', () => {
    it.each([
      ['a teacher whose school chose NONE', teacher, 'NONE' as const],
      ['a teacher whose school has not decided', teacher, null],
      ['a pupil, whatever the school chose', student, 'ALL' as const],
    ])('refuses %s with SCHOOL_DAY_NOT_OPEN, the grids and the search alike', async (_label, user, view) => {
      const { service } = setup({ view });
      await expect(service.grid({ from: SUMMER }, user)).rejects.toThrow(ForbiddenException);
      await expect(service.free({ date: SUMMER, from: '10:00', to: '11:00' }, user)).rejects.toThrow(ForbiddenException);
      await expect(service.grid({ from: SUMMER }, user)).rejects.toMatchObject({ response: { code: 'SCHOOL_DAY_NOT_OPEN' } });
    });

    it('refuses a school-less login before anything is read', async () => {
      const { service, tx } = setup();
      await expect(service.grid({ from: SUMMER }, testUser({ schoolId: undefined }))).rejects.toThrow(ForbiddenException);
      expect(model(tx, 'calendarLesson', 'findMany')).not.toHaveBeenCalled();
    });
  });

  describe('grid for an administrator', () => {
    const world: World = {
      groups: [
        { id: 'g2', name: '8B', kind: 'CLASS', gradeLevel: 8, halfOfId: null },
        { id: 'g1', name: '7A', kind: 'CLASS', gradeLevel: 7, halfOfId: null },
      ],
      rooms: [{ id: 'r10', name: 'Sal 10', code: null }, { id: 'r2', name: 'Sal 2', code: 'B2' }],
      subjects: [{ id: 's1', name: 'Matematik' }, { id: 's9', name: 'Aldrig använd' }],
      users: [person('t1', 'Anna', 'Berg'), person('t2', 'Åke', 'Ek'), person('t3', 'Bo', 'Pool'), person('t4', 'Cia', 'Slutat', false)],
      members: [{ userId: 't3' }],
    };

    it('reads the lessons as /admin/lessons does and tells their minutes by the wall clock, on both sides of the clock change', async () => {
      // The stored instants differ by an hour; the wall clock does not.
      const winter = await setup({ ...world, lessons: [lessonRow()] }).service.grid({ from: WINTER }, admin);
      const summer = await setup({
        ...world,
        lessons: [lessonRow({ id: 'l2', date: day(SUMMER), startsAt: instant(`${SUMMER}T06:15:00Z`), endsAt: instant(`${SUMMER}T07:00:00Z`) })],
      }).service.grid({ from: SUMMER }, admin);
      expect([...winter.lessons, ...summer.lessons].map((lesson) => [lesson.id, lesson.date, lesson.start, lesson.end])).toEqual([
        ['l1', WINTER, 495, 540],
        ['l2', SUMMER, 495, 540],
      ]);
      const view = await setup(world).service.grid({ from: '2027-03-26', to: '2027-03-29' }, admin);
      expect(view.days.map((one) => [one.date, one.weekday])).toEqual([['2027-03-26', 5], ['2027-03-27', 6], ['2027-03-28', 7], ['2027-03-29', 1]]);
      expect(view.timezone).toBe('Europe/Stockholm');
      expect(view.access).toEqual({ admin: true, grids: true, freeTeachers: true });
    });

    it('carries what the lesson is: status and cause, the extra groups, a vikarie, and the replacement lesson of an activity', async () => {
      const { service } = setup({
        ...world,
        lessons: [
          lessonRow({
            id: 'cancelled',
            status: 'CANCELLED',
            cancelCause: 'EVENT',
            extraGroups: [{ studentGroupId: 'g2' }],
            teachers: [{ teacherId: 't2', role: 'SUBSTITUTE' }, { teacherId: 't1', role: 'ASSISTANT' }],
          }),
          lessonRow({ id: 'activity', roomId: null, activityLinks: [{ activityId: 'a1' }] }),
        ],
      });
      const view = await service.grid({ from: WINTER }, admin);
      const [cancelled, activity] = view.lessons;
      expect(cancelled).toMatchObject({
        status: 'CANCELLED',
        cancelCause: 'EVENT',
        extraGroupIds: ['g2'],
        activity: false,
        teachers: [{ id: 't2', role: 'SUBSTITUTE' }, { id: 't1', role: 'ASSISTANT' }],
      });
      expect(activity).toMatchObject({ activity: true, roomId: null });
    });

    it('names the rows in Swedish order, keeps the subjects in use, and leaves a pool member out unless they teach', async () => {
      const { service } = setup({ ...world, lessons: [lessonRow()] });
      const view = await service.grid({ from: WINTER }, admin);
      expect(view.groups.map((group) => group.name)).toEqual(['7A', '8B']);
      expect(view.rooms.map((room) => room.name)).toEqual(['Sal 2', 'Sal 10']);
      expect(view.subjects).toEqual([{ id: 's1', name: 'Matematik' }]);
      // Cia has left but t4 holds no lesson here; Bo is in the pool and has none.
      expect(view.teachers.map((row) => row.name)).toEqual(['Anna Berg', 'Åke Ek']);
      const taught = await setup({
        ...world,
        lessons: [lessonRow({ teachers: [{ teacherId: 't3', role: 'SUBSTITUTE' }, { teacherId: 't4', role: 'LEAD' }] })],
      }).service.grid({ from: WINTER }, admin);
      expect(taught.teachers.map((row) => row.name)).toEqual(['Anna Berg', 'Bo Pool', 'Cia Slutat', 'Åke Ek']);
    });

    it('draws a booking on the room and on the person who booked it, cut at midnight', async () => {
      const { service } = setup({
        ...world,
        bookings: [
          { roomId: 'r2', bookedById: 't1', title: 'Föräldramöte', startsAt: instant(`${WINTER}T22:00:00Z`), endsAt: instant(`2027-03-23T08:30:00Z`) },
          { roomId: 'r2', bookedById: 't2', title: 'Möte', startsAt: instant(`${WINTER}T09:00:00Z`), endsAt: instant(`${WINTER}T10:00:00Z`) },
        ],
      });
      const view = await service.grid({ from: WINTER, to: '2027-03-23' }, admin);
      const booking = view.blocks.filter((block) => block.kind === 'BOOKING');
      expect(booking.filter((block) => block.resource === 'ROOM' && block.date === WINTER).map((block) => [block.start, block.end])).toEqual([
        [23 * 60, 1440],
        [10 * 60, 11 * 60],
      ]);
      expect(booking.filter((block) => block.resource === 'TEACHER' && block.resourceId === 't1').map((block) => [block.date, block.start, block.end, block.label])).toEqual([
        [WINTER, 23 * 60, 1440, 'Föräldramöte'],
        ['2027-03-23', 0, 9 * 60 + 30, 'Föräldramöte'],
      ]);
    });

    it('draws a day of an external hire on the room and on nobody: the administrator who registered it is not busy for it (Lokal)', async () => {
      const { service } = setup({
        ...world,
        bookings: [
          { roomId: 'r2', bookedById: 't1', externalBookingId: 'x1', title: 'Extern bokning', startsAt: instant(`${WINTER}T17:00:00Z`), endsAt: instant(`${WINTER}T19:00:00Z`) },
          { roomId: 'r2', bookedById: 't2', externalBookingId: null, title: 'Möte', startsAt: instant(`${WINTER}T09:00:00Z`), endsAt: instant(`${WINTER}T10:00:00Z`) },
        ],
      });
      const view = await service.grid({ from: WINTER }, admin);
      const booking = view.blocks.filter((block) => block.kind === 'BOOKING');
      expect(booking.filter((block) => block.resource === 'ROOM').map((block) => block.label)).toEqual(['Extern bokning', 'Möte']);
      expect(booking.filter((block) => block.resource === 'TEACHER').map((block) => [block.resourceId, block.label])).toEqual([['t2', 'Möte']]);
    });

    it('closes a room on its dated day and on its weekday, and on no other', async () => {
      const wall = (value: string) => new Date(`1970-01-01T${value}:00.000Z`);
      const { service } = setup({
        ...world,
        roomConstraints: [
          { roomId: 'r2', date: day(WINTER), dayOfWeek: null, startTime: wall('12:00'), endTime: wall('13:00') },
          { roomId: 'r10', date: null, dayOfWeek: 2, startTime: wall('00:00'), endTime: wall('23:59') },
          { roomId: null, date: day(WINTER), dayOfWeek: null, startTime: wall('12:00'), endTime: wall('13:00') },
        ],
      });
      const view = await service.grid({ from: WINTER, to: '2027-03-23' }, admin);
      const closed = view.blocks.filter((block) => block.kind === 'CLOSED').map((block) => [block.resourceId, block.date, block.start, block.end]);
      expect(closed).toEqual([
        ['r2', WINTER, 720, 780],
        ['r10', '2027-03-23', 0, 1440],
      ]);
    });

    it('draws a lent room as lent in each approved window, and a borrowed one as closed outside them', async () => {
      const wall = (value: string) => new Date(`1970-01-01T${value}:00.000Z`);
      const window = { status: 'APPROVED', dayOfWeek: 1, startDate: day('2027-03-01'), endDate: day('2027-06-01') };
      const { service } = setup({
        ...world,
        loans: [
          { ...window, roomId: 'r2', localRoomId: null, startTime: wall('10:00'), endTime: wall('12:00') },
          { ...window, roomId: 'other-room', localRoomId: 'r10', startTime: wall('13:00'), endTime: wall('15:00') },
        ],
      });
      const view = await service.grid({ from: SUMMER, to: '2027-03-30' }, admin);
      const rows = view.blocks.map((block) => [block.resourceId, block.date, block.kind, block.start, block.end]);
      expect(rows).toEqual([
        ['r2', SUMMER, 'LOAN', 600, 720],
        ['r10', SUMMER, 'CLOSED', 0, 780],
        ['r10', SUMMER, 'CLOSED', 900, 1440],
        // Tuesday: no loan runs, so the borrowed room is no one’s to use all day.
        ['r10', '2027-03-30', 'CLOSED', 0, 1440],
      ]);
    });

    it('tells a lov by the publication’s own rule: the whole school, or the groups of its årskurs', async () => {
      const { service } = setup({
        ...world,
        breaks: [
          { name: 'Sportlov', kind: 'HOLIDAY', startDate: day(WINTER), endDate: day(WINTER), minGradeLevel: null, maxGradeLevel: null },
          { name: 'Prao åk 8', kind: 'STAFF_DAY', startDate: day('2027-03-23'), endDate: day('2027-03-24'), minGradeLevel: 8, maxGradeLevel: 9 },
        ],
      });
      const view = await service.grid({ from: WINTER, to: '2027-03-24' }, admin);
      expect(view.days.map((one) => one.breaks)).toEqual([
        [{ name: 'Sportlov', kind: 'HOLIDAY', groupIds: null, minGradeLevel: null, maxGradeLevel: null }],
        [{ name: 'Prao åk 8', kind: 'STAFF_DAY', groupIds: ['g2'], minGradeLevel: 8, maxGradeLevel: 9 }],
        [{ name: 'Prao åk 8', kind: 'STAFF_DAY', groupIds: ['g2'], minGradeLevel: 8, maxGradeLevel: 9 }],
      ]);
    });

    it('draws who is away, an uppdrag and a closure on the teacher rows, and records the absence read', async () => {
      const wall = (value: string) => new Date(`1970-01-01T${value}:00.000Z`);
      const { service, tx } = setup({
        ...world,
        absences: [{ userId: 't1', startsAt: instant(`${WINTER}T07:00:00Z`), endsAt: instant(`${WINTER}T11:00:00Z`) }],
        teacherConstraints: [
          { id: 'c1', userId: 't2', type: 'UNAVAILABLE', startTime: wall('13:00'), endTime: wall('14:00') },
        ],
      });
      const view = await service.grid({ from: WINTER }, admin);
      const teacherBlocks = view.blocks.filter((block) => block.resource === 'TEACHER');
      expect(teacherBlocks).toEqual(
        expect.arrayContaining([
          { resource: 'TEACHER', resourceId: 't1', date: WINTER, start: 8 * 60, end: 12 * 60, kind: 'ABSENT', label: null },
          { resource: 'TEACHER', resourceId: 't2', date: WINTER, start: 13 * 60, end: 14 * 60, kind: 'UNAVAILABLE', label: null },
        ]),
      );
      const recorded = tx.$executeRaw.mock.calls.map(([statement]) => statement as Statement);
      expect(recorded.some((statement) => sql(statement).includes('personal_data_read') && JSON.stringify(statement.values).includes('STAFF_ABSENCES') && JSON.stringify(statement.values).includes('t1'))).toBe(true);
    });
  });

  describe('grid for a teacher', () => {
    const wall = (value: string) => new Date(`1970-01-01T${value}:00.000Z`);
    const world: World = {
      groups: [{ id: 'g1', name: '7A', kind: 'CLASS', gradeLevel: 7, halfOfId: null }],
      rooms: [{ id: 'r1', name: 'Sal 1', code: null }],
      subjects: [{ id: 's1', name: 'Matematik' }],
      users: [person('t1', 'Anna', 'Berg'), person('t2', 'Skyddad', 'Person')],
      lessons: [lessonRow({ teachers: [{ teacherId: 't1', role: 'LEAD' }, { teacherId: 't2', role: 'ASSISTANT' }] })],
      absences: [{ userId: 't1', startsAt: instant(`${WINTER}T07:00:00Z`), endsAt: instant(`${WINTER}T11:00:00Z`) }],
      teacherConstraints: [{ id: 'c1', userId: 't1', type: 'UNAVAILABLE', startTime: wall('13:00'), endTime: wall('14:00') }],
      bookings: [
        { roomId: 'r1', bookedById: 't1', title: 'Möte', startsAt: instant(`${WINTER}T09:00:00Z`), endsAt: instant(`${WINTER}T10:00:00Z`) },
        { roomId: 'r1', bookedById: 't2', title: 'Samtal', startsAt: instant(`${WINTER}T11:00:00Z`), endsAt: instant(`${WINTER}T12:00:00Z`) },
      ],
      marked: ['t2'],
    };

    it('ALL: names a colleague who is not marked, leaves out one who is (no id, no count), and shows no absence or uppdrag', async () => {
      const { service, calls } = setup({ ...world, view: 'ALL' });
      const view = await service.grid({ from: WINTER }, teacher);
      expect(view.access).toEqual({ admin: false, grids: true, freeTeachers: false });
      expect(view.lessons[0]!.teachers).toEqual([{ id: 't1', role: null }]);
      expect(view.teachers.map((row) => row.id)).toEqual(['t1']);
      expect(JSON.stringify(view)).not.toContain('t2');
      // A booking is the room's and its booker's, but the marked one's block is the room's alone; absence and uppdrag are not read at all.
      expect(view.blocks.map((block) => [block.resource, block.resourceId, block.kind])).toEqual([
        ['ROOM', 'r1', 'BOOKING'],
        ['TEACHER', 't1', 'BOOKING'],
        ['ROOM', 'r1', 'BOOKING'],
      ]);
      expect(calls).not.toContain('teacherAbsence.findMany');
    });

    it('does not tell a teacher that someone was left out: the lessons of a marked teacher are drawn without her, with no count anywhere', async () => {
      // Hers alone, hers with a colleague, and one nobody holds: the first reads as the third, and no field says a teacher is missing.
      const { service } = setup({
        ...world,
        view: 'ALL',
        lessons: [
          lessonRow({ id: 'hers', teachers: [{ teacherId: 't2', role: 'LEAD' }] }),
          lessonRow({ id: 'shared', teachers: [{ teacherId: 't2', role: 'LEAD' }, { teacherId: 't1', role: 'ASSISTANT' }] }),
          lessonRow({ id: 'nobody', teachers: [] }),
        ],
      });
      const view = await service.grid({ from: WINTER }, teacher);
      const byId = new Map(view.lessons.map((lesson) => [lesson.id, lesson]));
      expect(byId.get('hers')!.teachers).toEqual([]);
      expect(byId.get('shared')!.teachers).toEqual([{ id: 't1', role: null }]);
      // No field says that a teacher is missing: nothing to count, on a lesson or on the answer.
      expect([...byId.values()].every((lesson) => !('hiddenTeachers' in lesson))).toBe(true);
      expect(view).not.toHaveProperty('heldOut');
      expect(JSON.stringify(view)).not.toContain('t2');
    });

    it('tells a teacher that a lesson is cancelled and who holds it, not why or in whose place (cause and role are the administrators’)', async () => {
      const lessons = [
        lessonRow({ id: 'away', status: 'CANCELLED', cancelCause: 'TEACHER_UNAVAILABLE', teachers: [{ teacherId: 't1', role: 'LEAD' }] }),
        lessonRow({ id: 'cover', teachers: [{ teacherId: 't1', role: 'SUBSTITUTE' }] }),
        lessonRow({ id: 'event', status: 'CANCELLED', cancelCause: 'EVENT', teachers: [] }),
      ];
      for (const form of ['ALL', 'ROOMS'] as const) {
        const view = await setup({ ...world, view: form, lessons }).service.grid({ from: WINTER }, teacher);
        const byId = new Map(view.lessons.map((lesson) => [lesson.id, lesson]));
        expect(byId.get('away')).toMatchObject({ status: 'CANCELLED', cancelCause: null });
        expect(byId.get('event')).toMatchObject({ status: 'CANCELLED', cancelCause: null });
        // The status stays whatever the form: a cancelled lesson is drawn as one.
        expect(byId.get('cover')!.status).toBe('SCHEDULED');
        const text = JSON.stringify(view);
        expect(text).not.toContain('TEACHER_UNAVAILABLE');
        expect(text).not.toContain('SUBSTITUTE');
        expect(text).not.toContain('EVENT');
        if (form === 'ALL') {
          expect(byId.get('away')!.teachers).toEqual([{ id: 't1', role: null }]);
          expect(byId.get('cover')!.teachers).toEqual([{ id: 't1', role: null }]);
        } else {
          expect(byId.get('away')!.teachers).toEqual([]);
        }
      }
      // An administrator reads both: why, and in whose place.
      const admin_ = await setup({ ...world, lessons }).service.grid({ from: WINTER }, admin);
      const away = admin_.lessons.find((lesson) => lesson.id === 'away')!;
      const cover = admin_.lessons.find((lesson) => lesson.id === 'cover')!;
      expect(away.cancelCause).toBe('TEACHER_UNAVAILABLE');
      expect(cover.teachers).toEqual([{ id: 't1', role: 'SUBSTITUTE' }]);
    });

    it('ROOMS: only the lessons that use a room, without their teachers, and nobody else’s name', async () => {
      const { service, tx } = setup({ ...world, view: 'ROOMS' });
      const view = await service.grid({ from: WINTER }, teacher);
      expect(view.access).toEqual({ admin: false, grids: false, freeTeachers: false });
      expect(view.teachers).toEqual([]);
      expect(view.lessons[0]!.teachers).toEqual([]);
      expect(view.blocks.map((block) => [block.resource, block.kind])).toEqual([['ROOM', 'BOOKING'], ['ROOM', 'BOOKING']]);
      expect(model(tx, 'calendarLesson', 'findMany').mock.calls[0]![0].where).toEqual(expect.objectContaining({ roomId: { not: null } }));
      expect(model(tx, 'user', 'findMany')).not.toHaveBeenCalled();
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    });

    it('leaves the marks alone when the teacher’s form shows no teachers', async () => {
      const { tx, service } = setup({ ...world, view: 'ROOMS', marked: ['t2'] });
      await service.grid({ from: WINTER }, teacher);
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('free', () => {
    const wall = (value: string) => new Date(`1970-01-01T${value}:00.000Z`);
    const rooms = [
      { id: 'r1', name: 'Sal 1', code: null },
      { id: 'r2', name: 'Sal 2', code: null },
      { id: 'r3', name: 'Sal 3', code: null },
      { id: 'r4', name: 'Sal 4', code: null },
    ];
    const world: World = {
      rooms,
      users: [person('t1', 'Anna', 'Berg'), person('t2', 'Åke', 'Ek'), person('t3', 'Bo', 'Pool')],
      members: [{ userId: 't3' }],
      lessons: [{ id: 'l1', roomId: 'r1', startsAt: instant(`${SUMMER}T08:00:00Z`), endsAt: instant(`${SUMMER}T09:00:00Z`), status: 'SCHEDULED' }, { id: 'l2', roomId: 'r2', startsAt: instant(`${SUMMER}T08:00:00Z`), endsAt: instant(`${SUMMER}T09:00:00Z`), status: 'CANCELLED' }],
      bookings: [{ roomId: 'r3', bookedById: 't1', title: 'Möte', startsAt: instant(`${SUMMER}T08:30:00Z`), endsAt: instant(`${SUMMER}T09:30:00Z`) }],
      roomConstraints: [{ roomId: 'r4', date: null, dayOfWeek: 1, startTime: wall('10:00'), endTime: wall('12:00') }],
      absences: [{ userId: 't2', startsAt: instant(`${SUMMER}T06:00:00Z`), endsAt: instant(`${SUMMER}T15:00:00Z`) }],
    };

    it('answers who and what is free over the interval, by summer time, with the reasons for an administrator', async () => {
      const { service, tx } = setup(world);
      const view = await service.free({ date: SUMMER, from: '10:00', to: '11:00' }, admin);
      expect(view.rooms.map((room) => room.id)).toEqual(['r2']);
      expect(view.busyRooms!.map((room) => [room.id, room.reasons])).toEqual([
        ['r1', ['ROOM_IN_USE']],
        ['r3', ['ROOM_BOOKED']],
        ['r4', ['ROOM_CLOSED']],
      ]);
      // Anna holds the booking of Sal 3, Åke is away, and Bo is a pool member with no window.
      expect(view.teachers).toEqual([]);
      expect(view.busyTeachers!.map((one) => [one.id, one.reasons])).toEqual([
        ['t1', ['BOOKED_ROOM']],
        ['t3', ['POOL_NOT_DECLARED']],
        ['t2', ['ABSENT']],
      ]);
      expect(view.poolLeftOut).toBe(1);
      expect(view.rules.teachers).toEqual(['ABSENT', 'BUSY_LESSON', 'BUSY_SUPERVISION', 'BUSY_DUTY', 'UNAVAILABLE', 'BOOKED_ROOM', 'POOL_NOT_DECLARED']);
      // Åke’s absence is read and so recorded.
      const recorded = tx.$executeRaw.mock.calls.map(([statement]) => JSON.stringify((statement as Statement).values));
      expect(recorded.some((values) => values.includes('STAFF_ABSENCES') && values.includes('t2'))).toBe(true);
    });

    it('lists the free teachers, a pool member too once a window of theirs holds the interval', async () => {
      const { service } = setup({
        ...world,
        bookings: [],
        absences: [],
        windows: [{ userId: 't3', startTime: wall('09:00'), endTime: wall('12:00') }],
      });
      const view = await service.free({ date: SUMMER, from: '10:00', to: '11:00' }, admin);
      expect(view.teachers!.map((one) => one.name)).toEqual(['Anna Berg', 'Bo Pool', 'Åke Ek']);
      expect(view.poolLeftOut).toBe(0);
    });

    it('leaves a room out that is lent to another school then, or is the school’s only inside a borrowed loan, and says which', async () => {
      const wall = (value: string) => new Date(`1970-01-01T${value}:00.000Z`);
      const window = { status: 'APPROVED', dayOfWeek: 1, startDate: day('2027-03-01'), endDate: day('2027-06-01') };
      const { service } = setup({
        ...world,
        bookings: [],
        lessons: [],
        roomConstraints: [],
        loans: [
          // Sal 1 is lent to another school on Mondays 10:00-12:00.
          { ...window, roomId: 'r1', localRoomId: null, startTime: wall('10:00'), endTime: wall('12:00') },
          // Sal 2 is this school’s room for a borrowed one: its own only Mondays 13:00-15:00.
          { ...window, roomId: 'other-room', localRoomId: 'r2', startTime: wall('13:00'), endTime: wall('15:00') },
        ],
      });
      const morning = await service.free({ date: SUMMER, from: '10:00', to: '11:00' }, admin);
      expect(morning.rooms.map((room) => room.id)).toEqual(['r3', 'r4']);
      expect(morning.busyRooms!.map((room) => [room.id, room.reasons])).toEqual([
        ['r1', ['ROOM_LENT']],
        ['r2', ['ROOM_BORROWED_OUTSIDE_LOAN']],
      ]);
      const afternoon = await service.free({ date: SUMMER, from: '13:00', to: '14:00' }, admin);
      expect(afternoon.rooms.map((room) => room.id)).toEqual(['r1', 'r2', 'r3', 'r4']);
      expect(morning.rules.rooms).toContain('ROOM_LENT');
    });

    it('answers nobody free on a lov that closes the school, and everyone as usual on a studiedag', async () => {
      const holiday = { name: 'Påsklov', kind: 'HOLIDAY', startDate: day(SUMMER), endDate: day(SUMMER), minGradeLevel: null, maxGradeLevel: null };
      const closed = await setup({ ...world, breaks: [holiday] }).service.free({ date: SUMMER, from: '10:00', to: '11:00' }, admin);
      expect(closed).toMatchObject({ teachers: [], rooms: [], busyTeachers: [], busyRooms: [] });
      expect(closed.breaks).toEqual([{ name: 'Påsklov', kind: 'HOLIDAY', groupIds: null, minGradeLevel: null, maxGradeLevel: null }]);
      const studiedag = await setup({ ...world, breaks: [{ ...holiday, name: 'Studiedag', kind: 'STAFF_DAY' }] }).service.free({ date: SUMMER, from: '10:00', to: '11:00' }, admin);
      expect(studiedag.rooms.length).toBeGreaterThan(0);
      expect(studiedag.breaks[0]!.kind).toBe('STAFF_DAY');
    });

    it('does not let a narrowed lov close the school', async () => {
      const prao = { name: 'Prao', kind: 'HOLIDAY', startDate: day(SUMMER), endDate: day(SUMMER), minGradeLevel: 9, maxGradeLevel: 9 };
      const view = await setup({ ...world, breaks: [prao] }).service.free({ date: SUMMER, from: '10:00', to: '11:00' }, admin);
      expect(view.rooms.map((room) => room.id)).toEqual(['r2']);
      expect(view.breaks).toEqual([{ name: 'Prao', kind: 'HOLIDAY', groupIds: [], minGradeLevel: 9, maxGradeLevel: 9 }]);
    });

    it('gives a teacher the free rooms and never the free teachers or who is busy', async () => {
      const { service, calls } = setup({ ...world, view: 'ROOMS' });
      const view = await service.free({ date: SUMMER, from: '10:00', to: '11:00' }, teacher);
      expect(view.access).toEqual({ admin: false, grids: false, freeTeachers: false });
      expect(view.teachers).toBeNull();
      expect(view.busyTeachers).toBeNull();
      expect(view.busyRooms).toBeNull();
      expect(view.rules.teachers).toEqual([]);
      expect(view.rooms.map((room) => room.id)).toEqual(['r2']);
      expect(calls).not.toContain('teacherAbsence.findMany');
    });

    it('refuses an interval that ends before it begins', async () => {
      await expect(setup(world).service.free({ date: SUMMER, from: '11:00', to: '10:00' }, admin)).rejects.toThrow(BadRequestException);
      await expect(setup(world).service.free({ date: SUMMER, from: '10:00', to: '10:00' }, admin)).rejects.toThrow(BadRequestException);
    });
  });
});
