import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaClient } from '@prisma/client';
import { propagateTemplateChange } from './propagate-template';
import { breakDaysOf, closuresByDateOf, type PublishDaysContext } from './publish-days';
import { PUBLISH_NOTE_TEACHER_UNAVAILABLE } from './calendar.service';

const NOW = new Date('2026-10-12T06:00:00.000Z'); // Monday 08:00 in Stockholm
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const time = (h: number, m = 0) => new Date(Date.UTC(1970, 0, 1, h, m));
const OLD_ROOM = 'room-old';
const NEW_ROOM = 'room-new';
const OLD_TEACHER = 'teacher-old';
const NEW_TEACHER = 'teacher-new';

const before = { id: 'master', dayOfWeek: 2, teacherId: OLD_TEACHER, roomId: OLD_ROOM };
const after = {
  dayOfWeek: 3,
  startTime: time(10),
  endTime: time(11),
  roomId: NEW_ROOM,
  teacherId: NEW_TEACHER,
  coTeacherId: null,
  studentGroupId: 'group-7a',
  recurrence: 'ALL_WEEKS' as const,
  startDate: null,
  endDate: null,
};

function landing(overrides: Partial<PublishDaysContext> = {}): PublishDaysContext {
  return {
    breakDays: breakDaysOf([], '2026-10-01', '2026-12-31'),
    closuresByDate: closuresByDateOf([]),
    gradeOfGroup: new Map([['group-7a', 7]]),
    timezone: 'Europe/Stockholm',
    ...overrides,
  };
}

describe('propagateTemplateChange', () => {
  let tx: TxMock;
  beforeEach(() => {
    tx = createTxMock();
  });

  const run = (mode: 'update' | 'publish', context: PublishDaysContext = landing()) =>
    propagateTemplateChange(tx as unknown as PrismaClient, before, after, {
      timezone: 'Europe/Stockholm',
      schoolId: 'school',
      mode,
      range: { from: '2026-10-13', to: '2026-10-31' },
      landing: context,
      now: NOW,
    });

  it("'update' reads, writes and answers exactly as update() always did", async () => {
    tx.calendarLesson.findMany.mockResolvedValue([{ id: 'r1', date: day('2026-10-13') }]);
    const result = await propagateTemplateChange(tx as unknown as PrismaClient, before, after, {
      timezone: 'Europe/Stockholm',
      schoolId: 'school',
    });
    expect(tx.calendarLesson.findMany.mock.calls[0]![0]).toEqual({
      where: expect.objectContaining({ masterLessonId: 'master', status: 'SCHEDULED' }),
      select: { id: true, date: true },
    });
    expect(tx.calendarLesson.findMany.mock.calls[0]![0].where).not.toHaveProperty('date');
    expect(tx.calendarLesson.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { date: day('2026-10-14'), startsAt: expect.any(Date), endsAt: expect.any(Date), roomId: NEW_ROOM },
    });
    expect(tx.calendarLessonTeacher.deleteMany).toHaveBeenCalledWith({ where: { calendarLessonId: 'r1', role: 'LEAD' } });
    expect(result).toEqual({ moved: 1, removed: 0, cancelled: 0, movedIds: [], lostDayOperations: [] });
  });

  it("'publish' asks only the rows inside the range", async () => {
    await run('publish');
    expect(tx.calendarLesson.findMany.mock.calls[0]![0].where.date).toEqual({ gte: day('2026-10-13'), lte: day('2026-10-31') });
  });

  it("'publish' leaves a room changed for the day, and a vikarie's lesson, as they are", async () => {
    tx.calendarLesson.findMany.mockResolvedValue([
      { id: 'kept-room', date: day('2026-10-13'), roomId: 'room-for-the-day', note: null, teachers: [{ teacherId: OLD_TEACHER, role: 'LEAD' }] },
      { id: 'vikarie', date: day('2026-10-20'), roomId: OLD_ROOM, note: null, teachers: [{ teacherId: 'sub', role: 'SUBSTITUTE' }] },
      { id: 'plain', date: day('2026-10-27'), roomId: OLD_ROOM, note: null, teachers: [{ teacherId: OLD_TEACHER, role: 'LEAD' }] },
    ]);
    const result = await run('publish');
    const writes = Object.fromEntries(
      tx.calendarLesson.update.mock.calls.map(([arg]: [{ where: { id: string }; data: Record<string, unknown> }]) => [arg.where.id, arg.data]),
    );
    expect(writes['kept-room']).not.toHaveProperty('roomId');
    expect(writes['vikarie']).toMatchObject({ roomId: NEW_ROOM, date: day('2026-10-21') });
    expect(writes['plain']).toMatchObject({ roomId: NEW_ROOM });
    // The LEAD moves on the two rows whose LEAD was the old teacher, never beside a vikarie.
    const leadRewrites = tx.calendarLessonTeacher.deleteMany.mock.calls.map(([arg]: [{ where: { calendarLessonId: string } }]) => arg.where.calendarLessonId);
    expect(leadRewrites).toEqual(['kept-room', 'plain']);
    expect(tx.calendarLessonTeacher.create).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ moved: 3, removed: 0, movedIds: ['kept-room', 'vikarie', 'plain'] });
  });

  it("'publish' removes a row that would land on a lov, and reports what the school did on it", async () => {
    tx.calendarLesson.findMany.mockResolvedValue([
      { id: 'onto-lov', date: day('2026-10-27'), roomId: OLD_ROOM, note: 'Ta med gympakläder', teachers: [{ teacherId: 'sub', role: 'SUBSTITUTE' }] },
    ]);
    const result = await run(
      'publish',
      landing({ breakDays: breakDaysOf([{ startDate: day('2026-10-26'), endDate: day('2026-10-30'), minGradeLevel: null, maxGradeLevel: null }], '2026-10-01', '2026-12-31') }),
    );
    expect(tx.calendarLesson.update).not.toHaveBeenCalled();
    expect(tx.calendarLesson.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['onto-lov'] } } });
    expect(result.lostDayOperations).toEqual([
      { calendarLessonId: 'onto-lov', date: '2026-10-27', substitute: true, roomChanged: false, note: true },
    ]);
  });

  it("'publish' writes a row that lands on the teacher's closure CANCELLED, as materialisation would", async () => {
    tx.calendarLesson.findMany.mockResolvedValue([
      { id: 'closed', date: day('2026-10-13'), roomId: OLD_ROOM, note: null, teachers: [{ teacherId: OLD_TEACHER, role: 'LEAD' }] },
    ]);
    const result = await run(
      'publish',
      landing({
        closuresByDate: closuresByDateOf([
          {
            resourceType: 'TEACHER',
            userId: NEW_TEACHER,
            roomId: null,
            studentGroupId: null,
            minGradeLevel: null,
            maxGradeLevel: null,
            date: day('2026-10-14'),
            startTime: time(0),
            endTime: time(23, 59),
          },
        ]),
      }),
    );
    expect(tx.calendarLesson.update.mock.calls[0]![0].data).toMatchObject({
      status: 'CANCELLED',
      cancelCause: 'TEACHER_UNAVAILABLE',
      note: PUBLISH_NOTE_TEACHER_UNAVAILABLE,
    });
    expect(result.cancelled).toBe(1);
  });

  it("'publish' never carries a row into the past", async () => {
    tx.calendarLesson.findMany.mockResolvedValue([
      // Tuesday 13 Oct 08:00 → Wednesday is ahead, but a Monday move would not be.
      { id: 'r', date: day('2026-10-13'), roomId: OLD_ROOM, note: null, teachers: [] },
    ]);
    const result = await propagateTemplateChange(
      tx as unknown as PrismaClient,
      before,
      { ...after, dayOfWeek: 1, startTime: time(7) },
      { timezone: 'Europe/Stockholm', schoolId: 'school', mode: 'publish', landing: landing(), now: NOW },
    );
    expect(result).toMatchObject({ moved: 0, removed: 1 });
  });
});
