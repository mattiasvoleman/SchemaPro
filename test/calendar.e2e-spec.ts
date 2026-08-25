import { of } from 'rxjs';
import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Publishing a week and then regenerating it, over HTTP.
 *
 * The two operations are owned by different services and only meet in the
 * database, which is where they used to disagree: regeneration deleted the
 * master lessons and left their dated `CalendarLessons` behind (the FK is ON
 * DELETE SET NULL), while publish keys its idempotency set on
 * (masterLessonId, date) and cannot see an orphan. One lesson a week over
 * four weeks came back as eight.
 *
 * The other specs in this suite stub one call at a time; this one keeps a
 * small store across requests instead, because what is under test is what the
 * *rows* look like after regenerate → publish, not the shape of any single
 * query. The store models exactly three database behaviours the services rely
 * on: the SET NULL on the master-lesson FK, delete predicates matching only
 * rows whose template is still there, and the availability predicate deciding
 * which closures a publish window actually sees.
 */

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const SUBJECT_ID = '99999999-9999-4999-8999-999999999999';
const GROUP_ID = '88888888-8888-4888-8888-888888888888';
const TEACHER_ID = '77777777-7777-4777-8777-777777777777';
const ROOM_ID = '66666666-6666-4666-8666-666666666666';
const REQ_ID = '55555555-5555-4555-8555-555555555555';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const toIso = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Four consecutive Mondays, the first at least a week ahead of today.
 *
 * Regeneration only clears *future* materializations — the past is history and
 * stays — so the window has to sit ahead of whichever day the suite runs on,
 * whenever that is.
 */
const MONDAYS = ((): string[] => {
  const first = new Date();
  first.setUTCHours(0, 0, 0, 0);
  first.setUTCDate(first.getUTCDate() + 7 + ((8 - first.getUTCDay()) % 7));
  return Array.from({ length: 4 }, (_unused, week) => {
    const date = new Date(first);
    date.setUTCDate(date.getUTCDate() + week * 7);
    return toIso(date);
  });
})();
/** Through the Sunday after the last Monday, so every weekday recurs 4 times. */
const WINDOW_END = ((): string => {
  const end = day(MONDAYS[3]!);
  end.setUTCDate(end.getUTCDate() + 6);
  return toIso(end);
})();

interface MasterRow {
  id: string;
  isLocked: boolean;
  extraGroups: { studentGroupId: string }[];
  participants: { studentId: string }[];
  dayOfWeek: number;
  startTime: Date;
  endTime: Date;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  recurrence: string;
  startDate: Date | null;
  endDate: Date | null;
}

interface CalendarRow {
  id: string;
  masterLessonId: string | null;
  date: Date;
  startsAt: Date;
  status: string;
  note: string | null;
  /** Attendance rows recorded against this lesson; none, in these tests. */
  attendance: number;
}

/** A row of `AvailabilityConstraints`, as the publish query selects it. */
interface ConstraintRow {
  resourceType: 'TEACHER' | 'ROOM' | 'STUDENT_GROUP' | 'GRADE_LEVEL';
  type: 'UNAVAILABLE' | 'PREFERRED_FREE' | 'PREFERRED_BUSY';
  userId: string | null;
  roomId: string | null;
  studentGroupId: string | null;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  date: Date | null;
  startTime: Date;
  endTime: Date;
}

/** A row of `SchoolBreaks`, as the publish query selects it — no `kind`. */
interface BreakRow {
  startDate: Date;
  endDate: Date;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
}

const time = (hour: number, minute = 0) =>
  new Date(Date.UTC(1970, 0, 1, hour, minute, 0));

/** Locked or hand-built lessons, which regeneration must never replace. */
const isPreserved = (master: MasterRow) =>
  master.isLocked ||
  master.extraGroups.length > 0 ||
  master.participants.length > 0;

/** A dated, full-day closure of the class — the holiday shape. */
const closure = (overrides: Partial<ConstraintRow> = {}): ConstraintRow => ({
  resourceType: 'STUDENT_GROUP',
  type: 'UNAVAILABLE',
  userId: null,
  roomId: null,
  studentGroupId: GROUP_ID,
  minGradeLevel: null,
  maxGradeLevel: null,
  date: day(MONDAYS[1]!),
  startTime: time(0),
  endTime: time(23, 59),
  ...overrides,
});

/**
 * A lov over the second week: Monday through the Friday after it.
 *
 * Deliberately wider than the one day the closure above names, because a
 * range is the whole reason breaks exist — a sportlov used to need a
 * constraint row per day per group.
 */
const schoolBreak = (overrides: Partial<BreakRow> = {}): BreakRow => {
  const endDate = day(MONDAYS[1]!);
  endDate.setUTCDate(endDate.getUTCDate() + 4);
  return {
    startDate: day(MONDAYS[1]!),
    endDate,
    minGradeLevel: null,
    maxGradeLevel: null,
    ...overrides,
  };
};

describe('Publish and regenerate (e2e)', () => {
  let harness: TestHarness;
  let masters: MasterRow[];
  let calendar: CalendarRow[];
  let constraints: ConstraintRow[];
  let breaks: BreakRow[];
  let sequence: number;

  const http = () => harness.app.getHttpServer();
  const admin = () => asUser({});

  const publish = () =>
    request(http())
      .post('/api/v1/calendar/publish')
      .set('x-test-user', admin())
      .send({ academicYearId: YEAR_ID, fromDate: MONDAYS[0], toDate: WINDOW_END });

  const regenerate = () =>
    request(http())
      .post('/api/v1/optimization/trigger')
      .set('x-test-user', admin())
      .send({ academicYearId: YEAR_ID });

  /** Every dated lesson in the store, as "YYYY-MM-DD" — orphans included. */
  const publishedDates = () => calendar.map((row) => toIso(row.date)).sort();

  /** The solver's answer: every requirement placed on the given weekday. */
  const engineMoves = (dayOfWeek: number) => {
    harness.http.post.mockImplementation((_url: string, payload: any) =>
      of({
        data: {
          requestId: payload.requestId,
          status: 'OPTIMAL',
          lessons: payload.requirements.flatMap((requirement: any) =>
            Array.from({ length: requirement.lessonsPerWeek }, () => ({
              requirementId: requirement.id,
              roomId: payload.rooms[0]?.id ?? null,
              dayOfWeek,
              startTime: '08:00:00',
              endTime: '09:00:00',
            })),
          ),
          conflicts: null,
        },
      }),
    );
  };

  beforeAll(async () => {
    harness = await createTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();

    sequence = 0;
    calendar = [];
    constraints = [];
    breaks = [];
    masters = [
      {
        id: 'master-monday',
        isLocked: false,
        extraGroups: [],
        participants: [],
        dayOfWeek: 1,
        startTime: time(8),
        endTime: time(9),
        subjectId: SUBJECT_ID,
        studentGroupId: GROUP_ID,
        teacherId: TEACHER_ID,
        coTeacherId: null,
        roomId: ROOM_ID,
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
      },
    ];

    const tx = harness.tx;

    tx['academicYear']!['findUnique']!.mockResolvedValue({
      id: YEAR_ID,
      startDate: day(MONDAYS[0]!),
      endDate: day(WINDOW_END),
      school: { timezone: 'UTC' },
    });

    tx['teachingRequirement']!['findMany']!.mockImplementation(async () => [
      {
        id: REQ_ID,
        subjectId: SUBJECT_ID,
        studentGroupId: GROUP_ID,
        teacherId: TEACHER_ID,
        coTeacherId: null,
        lessonsPerWeek: 1,
        minutesPerLesson: 60,
        subject: { requiredRoomTypeId: null },
      },
    ]);
    tx['room']!['findMany']!.mockImplementation(async () => [
      {
        id: ROOM_ID,
        capacity: 30,
        roomTypeId: null,
        minGradeLevel: null,
        maxGradeLevel: null,
      },
    ]);

    // The two shapes the proxy asks for (locked/manual, then the previous
    // unlocked placements) plus publish's whole-year read.
    tx['masterLesson']!['findMany']!.mockImplementation(async ({ where }: any) => {
      if (where?.isLocked === false) return masters.filter((row) => !row.isLocked);
      if (where?.OR) return masters.filter(isPreserved);
      return masters;
    });
    tx['masterLesson']!['count']!.mockImplementation(
      async () => masters.filter(isPreserved).length,
    );
    tx['masterLesson']!['create']!.mockImplementation(async ({ data }: any) => {
      const row: MasterRow = {
        ...data,
        id: `master-${++sequence}`,
        isLocked: false,
        extraGroups: [],
        participants: [],
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
      };
      masters.push(row);
      return row;
    });
    tx['masterLesson']!['deleteMany']!.mockImplementation(async () => {
      const removed = masters.filter((row) => !isPreserved(row));
      masters = masters.filter(isPreserved);
      // The live constraint, and the whole reason this spec exists:
      // CalendarLessons.masterLessonId is ON DELETE SET NULL, so the dated
      // lessons outlive their template instead of going with it.
      for (const lesson of calendar) {
        if (removed.some((row) => row.id === lesson.masterLessonId)) {
          lesson.masterLessonId = null;
        }
      }
      return { count: removed.length };
    });

    tx['calendarLesson']!['findMany']!.mockImplementation(async ({ where }: any) => {
      const ids: string[] = where?.masterLessonId?.in ?? [];
      return calendar
        .filter(
          (row) =>
            row.masterLessonId !== null &&
            ids.includes(row.masterLessonId) &&
            row.date >= where.date.gte &&
            row.date <= where.date.lte,
        )
        .map((row) => ({ masterLessonId: row.masterLessonId, date: row.date }));
    });
    tx['calendarLesson']!['create']!.mockImplementation(async ({ data }: any) => {
      const row: CalendarRow = {
        id: `lesson-${++sequence}`,
        masterLessonId: data.masterLessonId,
        date: data.date,
        startsAt: data.startsAt,
        status: data.status,
        note: data.note ?? null,
        attendance: 0,
      };
      calendar.push(row);
      return { id: row.id };
    });

    // Modelled rather than stubbed, so the predicate the service sends is the
    // thing that decides what comes back: a preference row or a row dated
    // outside the window is filtered out here exactly as Postgres would.
    tx['availabilityConstraint']!['findMany']!.mockImplementation(
      async ({ where }: any) =>
        constraints.filter(
          (row) =>
            row.type === where.type &&
            row.date !== null &&
            row.date >= where.date.gte &&
            row.date <= where.date.lte,
        ),
    );
    // Modelled the same way, and for the same reason: what a break query
    // returns has to be decided by the predicate the service sends, or a test
    // that a lov "overlapping the window" bites would pass on any predicate.
    tx['schoolBreak']!['findMany']!.mockImplementation(
      async ({ where }: any) =>
        breaks.filter(
          (row) =>
            row.startDate <= where.startDate.lte && row.endDate >= where.endDate.gte,
        ),
    );
    tx['studentGroup']!['findMany']!.mockImplementation(async () => [
      { id: GROUP_ID, gradeLevel: 7 },
    ]);
    tx['calendarLesson']!['deleteMany']!.mockImplementation(async ({ where }: any) => {
      const before = calendar.length;
      calendar = calendar.filter((lesson) => {
        // A relation filter matches nothing for a row whose template is gone,
        // exactly as `masterLesson: { is: ... }` does in Postgres.
        const master = masters.find((row) => row.id === lesson.masterLessonId);
        const targeted =
          master !== undefined &&
          !isPreserved(master) &&
          lesson.status === where.status &&
          lesson.date >= where.date.gte &&
          lesson.attendance === 0;
        return !targeted;
      });
      return { count: before - calendar.length };
    });

    engineMoves(2); // the solver moves the lesson from Monday to Tuesday
  });

  it('materializes one dated lesson per week of the window', async () => {
    const response = await publish().expect(200);

    expect(response.body).toMatchObject({ created: 4, cancelled: 0, skipped: 0 });
    expect(publishedDates()).toEqual(MONDAYS);
  });

  it('publishing the same window twice changes nothing the second time', async () => {
    await publish().expect(200);
    const second = await publish().expect(200);

    expect(second.body).toMatchObject({ created: 0, skipped: 4 });
    expect(calendar).toHaveLength(4);
  });

  it('leaves no ghost lessons when a published week is regenerated', async () => {
    await publish().expect(200);
    expect(publishedDates()).toEqual(MONDAYS);

    await regenerate().expect(202);
    await publish().expect(200);

    // Before the reconciliation this asserts, the four Mondays survived as
    // orphans and the second publish stacked four Tuesdays on top of them:
    // eight rows for one lesson a week, half at a slot no timetable mentions
    // any more, and every one of them visible in the school's calendar.
    const tuesdays = MONDAYS.map((monday) => {
      const date = day(monday);
      date.setUTCDate(date.getUTCDate() + 1);
      return toIso(date);
    });
    expect(publishedDates()).toEqual(tuesdays);
    expect(calendar.every((row) => row.masterLessonId !== null)).toBe(true);
  });

  describe('a date the school has already said is not available', () => {
    /** Status per date, so "gone" and "still there" are read off one object. */
    const statusByDate = () =>
      Object.fromEntries(calendar.map((row) => [toIso(row.date), row.status]));

    it('publishes the lesson cancelled when its teacher is away that day', async () => {
      constraints.push(
        closure({
          resourceType: 'TEACHER',
          studentGroupId: null,
          userId: TEACHER_ID,
          // Part of a day, and only the part the 08:00 lesson sits in.
          startTime: time(7, 30),
          endTime: time(8, 30),
        }),
      );

      const response = await publish().expect(200);

      expect(response.body).toMatchObject({ created: 3, cancelled: 1, skipped: 0 });
      // The absent Monday is still on the calendar — cancelled, and saying so —
      // and the other three weeks are untouched.
      expect(publishedDates()).toEqual(MONDAYS);
      expect(statusByDate()).toEqual({
        [MONDAYS[0]!]: 'SCHEDULED',
        [MONDAYS[1]!]: 'CANCELLED',
        [MONDAYS[2]!]: 'SCHEDULED',
        [MONDAYS[3]!]: 'SCHEDULED',
      });
      expect(calendar.find((row) => toIso(row.date) === MONDAYS[1])?.note).toBe(
        'Inställd: läraren är inte tillgänglig detta datum.',
      );
    });

    it('writes no lesson at all when the class itself is closed', async () => {
      constraints.push(closure());

      const response = await publish().expect(200);

      expect(response.body).toMatchObject({ created: 3, cancelled: 0, skipped: 1 });
      expect(publishedDates()).toEqual([MONDAYS[0], MONDAYS[2], MONDAYS[3]]);
    });

    it('ignores a preference, which is a wish and not a closure', async () => {
      constraints.push(closure({ type: 'PREFERRED_FREE' }));

      const response = await publish().expect(200);

      expect(response.body).toMatchObject({ created: 4, cancelled: 0, skipped: 0 });
      expect(publishedDates()).toEqual(MONDAYS);
    });
  });

  describe('a week the school is on lov', () => {
    it('writes no lesson on any day the break covers', async () => {
      breaks.push(schoolBreak());

      const response = await publish().expect(200);

      // The lov is a range over the second week, and the Monday inside it is
      // simply absent — not cancelled: there was no lesson to hold.
      expect(response.body).toMatchObject({ created: 3, cancelled: 0, skipped: 1 });
      expect(publishedDates()).toEqual([MONDAYS[0], MONDAYS[2], MONDAYS[3]]);
    });

    it('closes the days inside the window of a lov that began before it', async () => {
      // Ends on the window's own first day, inclusive, and starts a week
      // earlier — the half of the overlap predicate a containment query drops.
      const startDate = day(MONDAYS[0]!);
      startDate.setUTCDate(startDate.getUTCDate() - 7);
      breaks.push(schoolBreak({ startDate, endDate: day(MONDAYS[0]!) }));

      const response = await publish().expect(200);

      expect(response.body).toMatchObject({ created: 3, skipped: 1 });
      expect(publishedDates()).toEqual([MONDAYS[1], MONDAYS[2], MONDAYS[3]]);
    });

    it('leaves the class teaching when the lov names other years', async () => {
      // Prao för åk 1-3; this group sits in åk 7 and is in school as usual.
      breaks.push(schoolBreak({ minGradeLevel: 1, maxGradeLevel: 3 }));

      const response = await publish().expect(200);

      expect(response.body).toMatchObject({ created: 4, cancelled: 0, skipped: 0 });
      expect(publishedDates()).toEqual(MONDAYS);
    });
  });

  it('keeps the published week when the solver answers with nothing', async () => {
    await publish().expect(200);

    // Schema-valid, and the engine cannot produce it for a year that still has
    // a requirement in it: one lesson a week was asked for and none came back.
    harness.http.post.mockImplementation(() =>
      of({ data: { requestId: 'r', status: 'FEASIBLE', lessons: [], conflicts: null } }),
    );

    await regenerate().expect(502);

    expect(masters.map((row) => row.id)).toEqual(['master-monday']);
    expect(publishedDates()).toEqual(MONDAYS);
  });
});
