import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import type { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';

/**
 * A row as Prisma returns it: only the fields the query selected. The shared
 * mock resolves whatever a spec stubs, whole, so a field the service stopped
 * selecting would still reach its output here and be undefined in production.
 */
const asSelected = (row: unknown, select?: Record<string, unknown>): unknown => {
  if (!select || row === null || typeof row !== 'object') return row;
  if (Array.isArray(row)) return row.map((item) => asSelected(item, select));
  return Object.fromEntries(
    Object.entries(select)
      .filter(([, wanted]) => Boolean(wanted))
      .map(([field, wanted]) => [
        field,
        asSelected(
          (row as Record<string, unknown>)[field],
          (wanted as { select?: Record<string, unknown> }).select,
        ),
      ]),
  );
};

type Row = Record<string, unknown>;

/**
 * The tables the roster reader asks (calendar/lesson-roster.ts), played by
 * rows: who is a pupil and whether active, the teaching-group memberships and
 * the pupils named on a lesson. Each findMany applies its `where` to them, so
 * a broadcast's studentIds are what the reader answers for these rows, filter
 * included, and not whatever a stub was told to return.
 */
interface World {
  users: { id: string; role: string; isActive: boolean; studentGroupId: string | null }[];
  members?: { studentId: string; studentGroupId: string }[];
  named?: { calendarLessonId: string; studentId: string }[];
}

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const LESSON_ID = '44444444-4444-4444-8444-444444444444';

const pupil = (id: string, studentGroupId: string | null, isActive = true) => ({
  id,
  role: 'STUDENT',
  isActive,
  studentGroupId,
});

describe('RealtimeService', () => {
  let service: RealtimeService;
  let tx: TxMock;
  let gateway: {
    emitMasterTimetableUpdated: jest.Mock;
    emitLessonUpdated: jest.Mock;
    emitCoverBoardUpdated: jest.Mock;
  };
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    tx = createTxMock();
    gateway = {
      emitMasterTimetableUpdated: jest.fn(),
      emitLessonUpdated: jest.fn(),
      emitCoverBoardUpdated: jest.fn(),
    };
    service = new RealtimeService(gateway as unknown as RealtimeGateway);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const client = () => tx as unknown as PrismaClient;

  /** The lesson as the query returns it: only what it selected. */
  const arrangeLesson = (row: Record<string, unknown>) =>
    tx.calendarLesson.findUnique.mockImplementation(
      ({ select }: { select?: Record<string, unknown> }) =>
        Promise.resolve(asSelected(row, select)),
    );

  /** The rows the roster reader reads, answered by each query's own where. */
  const arrangeWorld = (world: World) => {
    const userOf = (id: unknown) => world.users.find((user) => user.id === id) ?? {};
    const matches = (row: Row, where: Row = {}): boolean =>
      Object.entries(where).every(([field, condition]) => {
        // StudentGroupMembers filtered through the member's Users row.
        if (field === 'student') return matches(userOf(row['studentId']), condition as Row);
        if (condition !== null && typeof condition === 'object') {
          const { in: list, ...rest } = condition as { in?: unknown[] };
          // A condition this table cannot answer fails the spec, never passes it.
          if (!Array.isArray(list) || Object.keys(rest).length > 0) throw new Error(`unplayed condition on ${field}`);
          return list.includes(row[field]);
        }
        return row[field] === condition;
      });
    const table = (rows: Row[]) => ({ where, select }: { where?: Row; select?: Record<string, unknown> }) =>
      Promise.resolve(rows.filter((row) => matches(row, where)).map((row) => asSelected(row, select)));
    tx.user.findMany.mockImplementation(table(world.users));
    tx.studentGroupMember.findMany.mockImplementation(table(world.members ?? []));
    tx.calendarLessonStudent.findMany.mockImplementation(table(world.named ?? []));
  };

  /** The studentIds of the n-th broadcast, sorted. */
  const broadcastPupils = (call = 0) => {
    const [, , message] = gateway.emitLessonUpdated.mock.calls[call] as [
      string,
      string[],
      { updatedLesson: { studentIds: string[] } },
    ];
    return [...message.updatedLesson.studentIds].sort();
  };

  const lessonRow = (overrides: Record<string, unknown> = {}) => ({
    id: LESSON_ID,
    schoolId: SCHOOL_ID,
    startsAt: new Date('2026-08-10T08:15:00.000Z'),
    endsAt: new Date('2026-08-10T09:00:00.000Z'),
    status: 'CANCELLED',
    subject: { name: 'Mathematics' },
    room: { name: 'A101' },
    teachers: [{ teacherId: 'teacher-1' }, { teacherId: 'teacher-2' }],
    studentGroupId: '7A',
    extraGroups: [],
    ...overrides,
  });

  /** 7A at home: student-1 and student-2. */
  const homeClass: World = { users: [pupil('student-1', '7A'), pupil('student-2', '7A')] };

  describe('who a lesson update is about', () => {
    it('is the lesson’s roster as the one reader answers it: every class attending, their teaching groups, and the pupils named', async () => {
      // 7A at home and Ma7 joined to it; Ma7 is a nivågrupp, so its pupils are
      // members only, and Cy's home is another class. Dan is named on the
      // lesson; Gus is in no class this lesson reaches.
      arrangeLesson(lessonRow({ extraGroups: [{ studentGroupId: 'Ma7' }] }));
      arrangeWorld({
        users: [pupil('ada', '7A'), pupil('cy', '8B'), pupil('dan', null), pupil('gus', '8B')],
        members: [{ studentId: 'cy', studentGroupId: 'Ma7' }],
        named: [{ calendarLessonId: LESSON_ID, studentId: 'dan' }],
      });

      await service.notifyLessonChanged(client(), LESSON_ID);

      expect(broadcastPupils()).toEqual(['ada', 'cy', 'dan']);
    });

    it('includes a teaching group’s roster, which no home class holds', async () => {
      // Ma71 has no home-class members by construction. The teacher app writes
      // this list straight into its offline cache, so an empty broadcast does
      // not merely fail to help — it wipes the roster the teacher is about to
      // take attendance with.
      arrangeLesson(lessonRow({ studentGroupId: 'Ma71' }));
      arrangeWorld({
        users: [pupil('ma71-1', '7A'), pupil('ma71-2', '7B')],
        members: [
          { studentId: 'ma71-1', studentGroupId: 'Ma71' },
          { studentId: 'ma71-2', studentGroupId: 'Ma71' },
        ],
      });

      await service.notifyLessonChanged(client(), LESSON_ID);

      expect(broadcastPupils()).toEqual(['ma71-1', 'ma71-2']);
    });

    it('lists active pupils only, by every source, as the app’s own fetch of the lesson does', async () => {
      // The app replaces the lesson's pupils in its cache with this list, and
      // mobile/src/services/roster.ts fills the same row with active pupils of
      // the same three sources. Before the reader the named pupils went
      // unfiltered: Eva, named on the lesson after she left, was written back
      // into the cache by every broadcast. Membership as recorded is the
      // attendance check's question (a superset), not the list's.
      arrangeLesson(lessonRow({ extraGroups: [{ studentGroupId: 'Ma7' }] }));
      arrangeWorld({
        users: [
          pupil('ada', '7A'),
          pupil('bo', '7A', false),
          pupil('cy', '8B'),
          pupil('eva', null, false),
          { id: 'tess', role: 'TEACHER', isActive: true, studentGroupId: null },
        ],
        members: [
          { studentId: 'cy', studentGroupId: 'Ma7' },
          { studentId: 'bo', studentGroupId: 'Ma7' },
          { studentId: 'tess', studentGroupId: 'Ma7' },
        ],
        named: [
          { calendarLessonId: LESSON_ID, studentId: 'eva' },
          { calendarLessonId: LESSON_ID, studentId: 'tess' },
        ],
      });

      await service.notifyLessonChanged(client(), LESSON_ID);

      expect(broadcastPupils()).toEqual(['ada', 'cy']);
    });

    it('counts a pupil once when two sources name them', async () => {
      arrangeLesson(lessonRow());
      arrangeWorld({
        users: [pupil('a', '7A')],
        members: [{ studentId: 'a', studentGroupId: '7A' }],
        named: [{ calendarLessonId: LESSON_ID, studentId: 'a' }],
      });

      await service.notifyLessonChanged(client(), LESSON_ID);

      const [, , message] = gateway.emitLessonUpdated.mock.calls[0] as [
        string,
        string[],
        { updatedLesson: { studentIds: string[] } },
      ];
      expect(message.updatedLesson.studentIds).toEqual(['a']);
    });

    it('reads no pupil named on another lesson', async () => {
      arrangeLesson(lessonRow());
      arrangeWorld({
        users: [pupil('a', '7A'), pupil('z', null)],
        named: [{ calendarLessonId: 'another-lesson', studentId: 'z' }],
      });

      await service.notifyLessonChanged(client(), LESSON_ID);

      expect(broadcastPupils()).toEqual(['a']);
    });
  });

  describe('notifyMasterTimetableChanged', () => {
    it('broadcasts the school whose timetable changed', () => {
      service.notifyMasterTimetableChanged(SCHOOL_ID);

      expect(gateway.emitMasterTimetableUpdated).toHaveBeenCalledWith(
        SCHOOL_ID,
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it('swallows a gateway failure so the mutation never fails', () => {
      gateway.emitMasterTimetableUpdated.mockImplementation(() => {
        throw new Error('socket.io down');
      });

      expect(() => service.notifyMasterTimetableChanged(SCHOOL_ID)).not.toThrow();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(SCHOOL_ID),
      );
    });
  });

  describe('notifyCoverBoardChanged', () => {
    it('tells the admins the days that changed, with the instant, and nothing else', () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-14T06:00:00.000Z'));
      try {
        service.notifyCoverBoardChanged(SCHOOL_ID, '2026-10-14', '2026-10-15');
      } finally {
        jest.useRealTimers();
      }
      expect(gateway.emitCoverBoardUpdated).toHaveBeenCalledWith(SCHOOL_ID, {
        from: '2026-10-14',
        to: '2026-10-15',
        changedAt: '2026-10-14T06:00:00.000Z',
      });
    });

    it('swallows a gateway failure so the write never fails', () => {
      gateway.emitCoverBoardUpdated.mockImplementation(() => {
        throw new Error('socket.io down');
      });
      expect(() => service.notifyCoverBoardChanged(SCHOOL_ID, '2026-10-14', '2026-10-14')).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(SCHOOL_ID));
    });
  });

  describe('notifyLessonChanged', () => {
    it('reads the lesson through the caller’s transaction, and who is on it through the roster reader', async () => {
      arrangeLesson(lessonRow({ extraGroups: [{ studentGroupId: 'Ma7' }] }));
      arrangeWorld(homeClass);

      await service.notifyLessonChanged(client(), LESSON_ID);

      const { select } = tx.calendarLesson.findUnique.mock.calls[0]![0] as { select: Record<string, unknown> };
      expect(tx.calendarLesson.findUnique).toHaveBeenCalledWith({ where: { id: LESSON_ID }, select });
      // What the reader takes, and no members of its own: a second
      // definition of who attends is what the reader replaced.
      expect(select).toEqual(
        expect.objectContaining({ studentGroupId: true, extraGroups: { select: { studentGroupId: true } } }),
      );
      expect(select).not.toHaveProperty('studentGroup');
      expect(select).not.toHaveProperty('participants');
      // The reader, on the same transaction, asked about this lesson's class
      // and the group joined to it.
      expect(tx.calendarLessonStudent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { calendarLessonId: { in: [LESSON_ID] } } }),
      );
      expect(tx.studentGroupMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ studentGroupId: { in: ['7A', 'Ma7'] } }) }),
      );
    });

    it('broadcasts the wire payload to the school and its teachers', async () => {
      arrangeLesson(lessonRow());
      arrangeWorld(homeClass);

      await service.notifyLessonChanged(client(), LESSON_ID);

      expect(gateway.emitLessonUpdated).toHaveBeenCalledWith(
        SCHOOL_ID,
        ['teacher-1', 'teacher-2'],
        {
          lessonId: LESSON_ID,
          updatedLesson: {
            id: LESSON_ID,
            startTime: '2026-08-10T08:15:00.000Z',
            endTime: '2026-08-10T09:00:00.000Z',
            subjectName: 'Mathematics',
            roomName: 'A101',
            studentIds: ['student-1', 'student-2'],
            status: 'CANCELLED',
          },
        },
      );
    });

    it('renders a roomless lesson with the em-dash placeholder', async () => {
      arrangeLesson(lessonRow({ room: null }));

      await service.notifyLessonChanged(client(), LESSON_ID);

      expect(gateway.emitLessonUpdated).toHaveBeenCalledWith(
        SCHOOL_ID,
        expect.any(Array),
        expect.objectContaining({
          updatedLesson: expect.objectContaining({ roomName: '—' }),
        }),
      );
    });

    it('stays silent when the lesson has vanished', async () => {
      tx.calendarLesson.findUnique.mockResolvedValue(null);

      await expect(
        service.notifyLessonChanged(client(), LESSON_ID),
      ).resolves.toBeUndefined();
      expect(gateway.emitLessonUpdated).not.toHaveBeenCalled();
      // A lesson deleted in the same transaction is nothing to warn about.
      expect(warn).not.toHaveBeenCalled();
    });

    it('swallows a lookup failure — broadcasting is best-effort', async () => {
      tx.calendarLesson.findUnique.mockRejectedValue(
        new Error('connection reset'),
      );

      await expect(
        service.notifyLessonChanged(client(), LESSON_ID),
      ).resolves.toBeUndefined();
      expect(gateway.emitLessonUpdated).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(LESSON_ID));
    });

    it('sends nothing when the roster read fails, rather than an empty roster', async () => {
      // An empty list is not "nothing known": the app writes it over the
      // lesson's pupils in its cache.
      arrangeLesson(lessonRow());
      tx.user.findMany.mockRejectedValue(new Error('connection reset'));

      await expect(
        service.notifyLessonChanged(client(), LESSON_ID),
      ).resolves.toBeUndefined();
      expect(gateway.emitLessonUpdated).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(LESSON_ID));
    });

    it('swallows an emit failure without rejecting the mutation', async () => {
      arrangeLesson(lessonRow());
      gateway.emitLessonUpdated.mockImplementation(() => {
        throw new Error('socket.io down');
      });

      await expect(
        service.notifyLessonChanged(client(), LESSON_ID),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(LESSON_ID));
    });
  });

  describe('notifyLessonsChanged (a bulk avbokning)', () => {
    it('reads every lesson in ONE statement with the single read’s select, and asks the reader no more for two lessons than for one', async () => {
      arrangeWorld({
        users: [pupil('ada', '7A'), pupil('bo', '8B'), pupil('dan', null)],
        named: [{ calendarLessonId: LESSON_ID, studentId: 'dan' }],
      });
      const rosterReads = () =>
        [tx.calendarLessonStudent.findMany, tx.user.findMany, tx.studentGroupMember.findMany].map(
          (read) => read.mock.calls.length,
        );
      arrangeLesson(lessonRow());
      await service.notifyLessonChanged(client(), LESSON_ID);
      const single = tx.calendarLesson.findUnique.mock.calls[0]![0].select;
      const forOne = rosterReads();

      gateway.emitLessonUpdated.mockClear();
      for (const read of [tx.calendarLessonStudent.findMany, tx.user.findMany, tx.studentGroupMember.findMany]) {
        read.mockClear();
      }
      tx.calendarLesson.findMany.mockImplementation(({ select }: { select?: Record<string, unknown> }) =>
        Promise.resolve([
          asSelected(lessonRow(), select),
          asSelected(lessonRow({ id: 'lesson-2', studentGroupId: '8B' }), select),
        ]),
      );
      await service.notifyLessonsChanged(client(), [LESSON_ID, 'lesson-2']);
      expect(tx.calendarLesson.findMany).toHaveBeenCalledTimes(1);
      expect(tx.calendarLesson.findMany.mock.calls[0]![0]).toEqual({
        where: { id: { in: [LESSON_ID, 'lesson-2'] } },
        select: single,
      });
      // A hundred-lesson batch reads as many statements as one lesson does.
      expect(rosterReads()).toEqual(forOne);
      // Each lesson with its own roster.
      expect(gateway.emitLessonUpdated).toHaveBeenCalledTimes(2);
      expect(gateway.emitLessonUpdated.mock.calls.map(([, , message]) => (message as { lessonId: string }).lessonId)).toEqual([
        LESSON_ID,
        'lesson-2',
      ]);
      expect(broadcastPupils(0)).toEqual(['ada', 'dan']);
      expect(broadcastPupils(1)).toEqual(['bo']);
    });

    it('asks nothing for no lesson, nor of the roster for lessons that have vanished, and swallows a failure', async () => {
      await service.notifyLessonsChanged(client(), []);
      expect(tx.calendarLesson.findMany).not.toHaveBeenCalled();
      tx.calendarLesson.findMany.mockResolvedValue([]);
      await service.notifyLessonsChanged(client(), [LESSON_ID]);
      expect(tx.user.findMany).not.toHaveBeenCalled();
      expect(gateway.emitLessonUpdated).not.toHaveBeenCalled();
      tx.calendarLesson.findMany.mockRejectedValue(new Error('connection reset'));
      await expect(service.notifyLessonsChanged(client(), [LESSON_ID])).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    });
  });
});
