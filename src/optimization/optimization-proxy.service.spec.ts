import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import type { HttpService } from '@nestjs/axios';
import type { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { of, throwError, timer } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import type { PrismaClient } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type {
  AiEngineLunch,
  AiEngineScheduleRequest,
  AiEngineScheduleResponse,
} from './interfaces/ai-engine-payload.interface';
import { OptimizationProxyService } from './optimization-proxy.service';
import * as eligibility from './room-eligibility';

const ACADEMIC_YEAR = '44444444-4444-4444-8444-444444444444';
/** One requirement, as the database holds it and as the engine sees it. */
const REAL_REQ = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ANON_REQ = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const makeConfigService = () =>
  ({
    getOrThrow: jest.fn().mockReturnValue({
      baseUrl: 'http://solver.test',
      apiKey: 'k'.repeat(32),
      timeoutMs: 50,
    }),
  }) as unknown as ConfigService;

describe('OptimizationProxyService', () => {
  let service: OptimizationProxyService;
  let tx: TxMock;
  let http: { post: jest.Mock };

  beforeEach(() => {
    tx = createTxMock();
    http = { post: jest.fn() };

    service = new OptimizationProxyService(
      {} as unknown as PrismaService,
      http as unknown as HttpService,
      makeConfigService(),
    );
  });

  /**
   * `persistMasterLessons` is private, and reaching it through
   * `triggerScheduling` would mean mocking the entire fetch-and-anonymize
   * pipeline. It is exercised directly because what it guards is the most
   * destructive path in the codebase: a delete-and-recreate of a school's
   * timetable. Testing it through six layers of setup would obscure that.
   */
  const persist = (
    response: Partial<AiEngineScheduleResponse>,
    {
      user = testUser(),
      /** The demand the engine was sent, which its answer must match. */
      requirements = [] as { id: string; lessonsPerWeek: number }[],
      requirementAnonMap = new Map<string, string>(),
      /** Sittings carrying REAL group ids, as realiseLunches hands them over. */
      lunches = [] as AiEngineLunch[],
      headcountByGroup = new Map<string, number>(),
    } = {},
  ) =>
    (
      service as unknown as {
        persistMasterLessons: (
          tx: PrismaClient,
          academicYearId: string,
          user: unknown,
          response: AiEngineScheduleResponse,
          requirements: { id: string; lessonsPerWeek: number }[],
          requirementAnonMap: Map<string, string>,
          roomAnonMap: Map<string, string>,
          lunches: AiEngineLunch[],
          headcountByGroup: Map<string, number>,
        ) => Promise<void>;
      }
    ).persistMasterLessons(
      tx as unknown as PrismaClient,
      ACADEMIC_YEAR,
      user,
      { status: 'FEASIBLE', lessons: [], ...response } as AiEngineScheduleResponse,
      requirements,
      requirementAnonMap,
      new Map(),
      lunches,
      headcountByGroup,
    );

  /** A placement of `ANON_REQ`, as the engine words it. */
  const placement = (requirementId = ANON_REQ) => ({
    requirementId,
    roomId: null,
    dayOfWeek: 1,
    startTime: '08:00:00',
    endTime: '09:00:00',
  });

  /** One requirement asking for `lessonsPerWeek`, wired anon → real. */
  const oneRequirement = (lessonsPerWeek: number) => {
    tx.teachingRequirement.findMany.mockResolvedValue([
      {
        id: REAL_REQ,
        subjectId: 'subject-1',
        studentGroupId: 'group-1',
        teacherId: null,
        coTeacherId: null,
      },
    ]);
    return {
      requirements: [{ id: ANON_REQ, lessonsPerWeek }],
      requirementAnonMap: new Map([[REAL_REQ, ANON_REQ]]),
    };
  };

  describe('persistMasterLessons — destructive-path guards', () => {
    it.each(['INFEASIBLE', 'TIMEOUT'])(
      'writes nothing and deletes nothing when the solver returns %s',
      async (status) => {
        await persist({ status: status as AiEngineScheduleResponse['status'] });

        // The regression this guards: a run that produced no lessons must not
        // wipe the school's existing unlocked timetable on its way out.
        expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
        expect(tx.masterLesson.createMany).not.toHaveBeenCalled();
        expect(tx.masterLesson.create).not.toHaveBeenCalled();
      },
    );

    it('refuses to persist when the principal carries no tenant', async () => {
      await expect(
        persist({ status: 'FEASIBLE' }, { user: testUser({ schoolId: undefined }) }),
      ).rejects.toThrow('schoolId missing from JWT');

      expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
    });

    it('checks the tenant before deleting anything', async () => {
      // Ordering matters: the schoolId guard sits after the status check but
      // before deleteMany, so a tokenless request cannot destroy data either.
      tx.teachingRequirement.findMany.mockResolvedValue([]);

      await expect(
        persist({ status: 'OPTIMAL' }, { user: testUser({ schoolId: undefined }) }),
      ).rejects.toThrow();
      expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
    });
  });

  /**
   * The engine places every lesson it is asked for or none at all, so a
   * response that does not match the demand it was sent is not an answer to
   * this request — and must be refused *before* the delete, not dropped after
   * it. Each case below is a well-formed, schema-valid FEASIBLE body: schema
   * validation would pass every one of them, and every one of them used to
   * empty out the year's machine-owned timetable.
   */
  describe('persistMasterLessons — verifying the solution before replacing', () => {
    beforeEach(() => {
      tx.masterLesson.deleteMany.mockResolvedValue({ count: 40 });
      tx.calendarLesson.deleteMany.mockResolvedValue({ count: 0 });
      tx.masterLesson.count.mockResolvedValue(0);
    });

    const expectNothingTouched = () => {
      expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
      expect(tx.calendarLesson.deleteMany).not.toHaveBeenCalled();
      expect(tx.masterLesson.create).not.toHaveBeenCalled();
      expect(tx.scheduleChangeLog.create).not.toHaveBeenCalled();
    };

    it('refuses an empty solution and leaves the timetable standing', async () => {
      await expect(
        persist({ status: 'FEASIBLE', lessons: [] }, oneRequirement(3)),
      ).rejects.toMatchObject({ status: 502 });

      expectNothingTouched();
    });

    it('names the refusal in the error the caller sees', async () => {
      await expect(
        persist({ status: 'FEASIBLE', lessons: [] }, oneRequirement(1)),
      ).rejects.toThrow('does not match the requested timetable');
    });

    it('refuses a solution that places fewer lessons than were asked for', async () => {
      // Three a week requested, one placed: accepting it would replace the
      // whole year with a third of a timetable.
      await expect(
        persist(
          { status: 'FEASIBLE', lessons: [placement()] },
          oneRequirement(3),
        ),
      ).rejects.toMatchObject({ status: 502 });

      expectNothingTouched();
    });

    it('refuses a solution that places more lessons than were asked for', async () => {
      await expect(
        persist(
          { status: 'OPTIMAL', lessons: [placement(), placement()] },
          oneRequirement(1),
        ),
      ).rejects.toMatchObject({ status: 502 });

      expectNothingTouched();
    });

    it('refuses a solution naming a requirement this request never sent', async () => {
      await expect(
        persist(
          {
            status: 'FEASIBLE',
            lessons: [placement('ffffffff-ffff-4fff-8fff-ffffffffffff')],
          },
          oneRequirement(1),
        ),
      ).rejects.toMatchObject({ status: 502 });

      expectNothingTouched();
    });

    it('refuses when a requirement was deleted while the solver ran', async () => {
      const asked = oneRequirement(1);
      // The anon id still resolves, but the row it names is gone from the
      // year: the solution describes a timetable that no longer exists.
      tx.teachingRequirement.findMany.mockResolvedValue([]);

      await expect(
        persist({ status: 'FEASIBLE', lessons: [placement()] }, asked),
      ).rejects.toMatchObject({ status: 502 });

      expectNothingTouched();
    });

    it('replaces the timetable when the solution covers the demand exactly', async () => {
      await persist(
        { status: 'OPTIMAL', lessons: [placement(), placement()] },
        oneRequirement(2),
      );

      expect(tx.masterLesson.deleteMany).toHaveBeenCalledTimes(1);
      expect(tx.masterLesson.create).toHaveBeenCalledTimes(2);
      // Built before the delete, written after it — and every create must land
      // after the delete, or the new lessons would be deleted with the old.
      expect(tx.masterLesson.create.mock.invocationCallOrder[0]).toBeGreaterThan(
        tx.masterLesson.deleteMany.mock.invocationCallOrder[0]!,
      );
    });

    it('still clears leftovers when every lesson was already placed by hand', async () => {
      // No requirement reaches the engine, so nothing is demanded and nothing
      // is placed — the one empty solution that is a correct answer.
      await persist({ status: 'FEASIBLE', lessons: [] });

      expect(tx.masterLesson.deleteMany).toHaveBeenCalledTimes(1);
      expect(tx.masterLesson.create).not.toHaveBeenCalled();
    });
  });

  describe('persistMasterLessons — the sittings', () => {
    beforeEach(() => {
      tx.masterLesson.deleteMany.mockResolvedValue({ count: 0 });
      tx.calendarLesson.deleteMany.mockResolvedValue({ count: 0 });
      tx.masterLesson.count.mockResolvedValue(0);
      tx.lunchSitting.deleteMany.mockResolvedValue({ count: 0 });
      tx.calendarLunch.deleteMany.mockResolvedValue({ count: 0 });
      // Which of the year's groups are classes. A sitting is written for a
      // class and for nothing else, so an unstubbed lookup here means no
      // sittings at all rather than a merge — see the teaching-group test.
      tx.studentGroup.findMany.mockResolvedValue([{ id: 'g-7a' }]);
    });

    const sitting = (groupId = 'g-7a', dayOfWeek = 1) => ({
      studentGroupId: groupId,
      dayOfWeek,
      startTime: '11:30:00',
      endTime: '12:00:00',
    });

    it("replaces the solver's sittings and only the solver's", async () => {
      /*
       * A run deletes what it wrote. A meal the school placed by hand went to
       * the engine as a pin on the lunch variable it builds anyway — one
       * reservation, not the fixed lesson beside a live variable that would be
       * two — so it is an instruction to keep, not an output to replace.
       */
      await persist(
        { status: 'OPTIMAL', lessons: [placement()] },
        {
          ...oneRequirement(1),
          lunches: [sitting()],
          headcountByGroup: new Map([['g-7a', 24]]),
        },
      );

      expect(tx.lunchSitting.deleteMany).toHaveBeenCalledWith({
        where: { academicYearId: ACADEMIC_YEAR, isGenerated: true },
      });
      expect(tx.lunchSitting.createMany).toHaveBeenCalledWith({
        data: [
          {
            schoolId: testUser().schoolId,
            academicYearId: ACADEMIC_YEAR,
            studentGroupId: 'g-7a',
            dayOfWeek: 1,
            startTime: new Date('1970-01-01T11:30:00.000Z'),
            endTime: new Date('1970-01-01T12:00:00.000Z'),
            headcount: 24,
            isGenerated: true,
          },
        ],
      });
    });

    it('keeps a meal the school placed by hand, and writes nothing over it', async () => {
      /*
       * The engine reports a pinned meal back like any other, so its answer for
       * a hand-placed day lands on a row that already exists. Creating over it
       * would break LunchSittings_group_day_key inside this transaction, after
       * a solve the school watched succeed. The hand row keeps its start and
       * takes the length and headcount from the answer instead.
       */
      tx.lunchSitting.findMany.mockResolvedValue([
        {
          id: 'hand-1',
          studentGroupId: 'g-7a',
          dayOfWeek: 1,
          startTime: new Date('1970-01-01T11:30:00.000Z'),
        },
      ]);

      await persist(
        { status: 'OPTIMAL', lessons: [placement()] },
        {
          ...oneRequirement(1),
          lunches: [sitting('g-7a', 1), sitting('g-7a', 2)],
          headcountByGroup: new Map([['g-7a', 26]]),
        },
      );

      const created = tx.lunchSitting.createMany.mock.calls[0][0].data;
      expect(created.map((row: { dayOfWeek: number }) => row.dayOfWeek)).toEqual([2]);
      expect(tx.lunchSitting.update).toHaveBeenCalledWith({
        where: { id: 'hand-1' },
        data: { endTime: new Date('1970-01-01T12:00:00.000Z'), headcount: 26 },
      });
    });

    it('stores the headcount the engine was told, not a zero', async () => {
      // Kept so the kitchen's own list needs no re-derivation of a roster that
      // may have changed since the run.
      await persist(
        { status: 'OPTIMAL', lessons: [placement()] },
        {
          ...oneRequirement(1),
          lunches: [sitting()],
          headcountByGroup: new Map([['g-7a', 27]]),
        },
      );

      expect(tx.lunchSitting.createMany.mock.calls[0][0].data[0].headcount).toBe(27);
    });

    it('writes no sitting for a teaching group', async () => {
      // The engine gives a lunch interval to every group carrying a requirement
      // — its own comment says EVERY HOME CLASS EATS EVERY SCHOOL DAY, and the
      // set it walks unions the groups with lessons — so Ma71 arrives with
      // headcount 0 and a sitting every school day. Right in the engine, where
      // the interval keeps a teaching group's lessons out of its members' meal.
      // Wrong in this table, which is the kitchen's list and the pupil's band.
      await persist(
        { status: 'OPTIMAL', lessons: [placement()] },
        {
          ...oneRequirement(1),
          lunches: [sitting(), { ...sitting(), studentGroupId: 'g-ma71' }],
          headcountByGroup: new Map([['g-7a', 24]]),
        },
      );

      const [call] = tx.lunchSitting.createMany.mock.calls;
      expect(call[0].data).toHaveLength(1);
      expect(call[0].data[0].studentGroupId).toBe('g-7a');
    });

    it('drops a meal placed by hand that the run did not honour', async () => {
      /*
       * With lunch switched off the engine builds no meal and pins nothing, so
       * the lessons were placed straight across the hand-placed row. Kept, it
       * would sit on the grid and reach the pupil's calendar on top of one.
       */
      tx.lunchSitting.findMany.mockResolvedValue([
        {
          id: 'hand-1',
          studentGroupId: 'g-7a',
          dayOfWeek: 1,
          startTime: new Date('1970-01-01T13:00:00.000Z'),
        },
      ]);

      await persist(
        { status: 'OPTIMAL', lessons: [placement()] },
        { ...oneRequirement(1), lunches: [] },
      );

      expect(tx.lunchSitting.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['hand-1'] } },
      });
      expect(tx.lunchSitting.update).not.toHaveBeenCalled();
    });

    it('says so loudly when a hand-placed meal came back somewhere else', async () => {
      /*
       * The pin is the whole contract across this seam: the gateway sends the
       * school's start, the engine holds its own lunch variable there. An
       * answer at another start means the two halves have drifted — and the row
       * is still the school's, so it keeps the school's start rather than
       * quietly taking the engine's.
       */
      const logger = (service as unknown as { logger: { error: (message: string) => void } })
        .logger;
      const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
      tx.lunchSitting.findMany.mockResolvedValue([
        {
          id: 'hand-1',
          studentGroupId: 'g-7a',
          dayOfWeek: 1,
          startTime: new Date('1970-01-01T13:00:00.000Z'),
        },
      ]);

      await persist(
        { status: 'OPTIMAL', lessons: [placement()] },
        { ...oneRequirement(1), lunches: [sitting('g-7a', 1)] },
      );

      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0][0]).toContain('did not bind');
      expect(tx.lunchSitting.update.mock.calls[0][0].data).not.toHaveProperty('startTime');
    });

    it('says nothing when the engine held the meal where it was placed', async () => {
      const logger = (service as unknown as { logger: { error: (message: string) => void } })
        .logger;
      const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
      tx.lunchSitting.findMany.mockResolvedValue([
        {
          id: 'hand-1',
          studentGroupId: 'g-7a',
          dayOfWeek: 1,
          startTime: new Date('1970-01-01T11:30:00.000Z'),
        },
      ]);

      await persist(
        { status: 'OPTIMAL', lessons: [placement()] },
        { ...oneRequirement(1), lunches: [sitting('g-7a', 1)] },
      );

      expect(error).not.toHaveBeenCalled();
    });

    it("drops the year's already-published meals in the same transaction", async () => {
      // This file's own header states the rule: whoever replaces a generated
      // timetable deletes its future materializations in the same transaction.
      // The half for the lessons was written; the half for the meal was not, so
      // a republished week kept last month's lunch time for ever.
      await persist(
        { status: 'OPTIMAL', lessons: [placement()] },
        { ...oneRequirement(1), lunches: [sitting()] },
      );

      const [call] = tx.calendarLunch.deleteMany.mock.calls;
      // Reached through the group's year rather than a column of its own: a
      // backfilled academicYearId would join on (schoolId, studentGroupId,
      // dayOfWeek) while LunchSittings' unique key includes the year, so a
      // school in its second läsår has two matching rows.
      expect(call[0].where.studentGroup).toEqual({ is: { academicYearId: ACADEMIC_YEAR } });
      expect(call[0].where.date.gte).toBeInstanceOf(Date);
    });

    it('leaves a meal that has already been eaten alone', async () => {
      await persist({ status: 'OPTIMAL', lessons: [placement()] }, oneRequirement(1));

      // Only the future. A meal on a day that has been is a fact about that
      // day, and there is no reason to rewrite it.
      const [call] = tx.calendarLunch.deleteMany.mock.calls;
      const cutoff: Date = call[0].where.date.gte;
      expect(cutoff.getUTCHours()).toBe(0);
      expect(cutoff.getUTCMinutes()).toBe(0);
    });

    it('clears the sittings when a run produces none', async () => {
      // A school that switched lunch off must not keep last term's flow on the
      // grid: the delete runs whether or not there is anything to write.
      await persist({ status: 'OPTIMAL', lessons: [placement()] }, oneRequirement(1));

      expect(tx.lunchSitting.deleteMany).toHaveBeenCalledTimes(1);
      expect(tx.lunchSitting.createMany).not.toHaveBeenCalled();
    });

    it('leaves the sittings alone when the engine found no timetable', async () => {
      // Both verdicts bail out before anything is deleted. A failed run that
      // wiped the flow would leave the kitchen with nothing while the timetable
      // it belongs to is still standing.
      await persist({ status: 'INFEASIBLE', lessons: [] }, { lunches: [sitting()] });

      expect(tx.lunchSitting.deleteMany).not.toHaveBeenCalled();
      expect(tx.lunchSitting.createMany).not.toHaveBeenCalled();
    });

    it('leaves the sittings alone when the solution is rejected', async () => {
      // The 502 path: the whole replacement is built and checked before a
      // single row is deleted, and the sittings are inside that guarantee.
      tx.teachingRequirement.findMany.mockResolvedValue([]);

      await expect(
        persist(
          { status: 'FEASIBLE', lessons: [placement()] },
          { ...oneRequirement(2), lunches: [sitting()] },
        ),
      ).rejects.toMatchObject({ status: 502 });

      expect(tx.lunchSitting.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('persistMasterLessons — non-destructive regeneration', () => {
    beforeEach(() => {
      tx.teachingRequirement.findMany.mockResolvedValue([]);
      tx.masterLesson.deleteMany.mockResolvedValue({ count: 3 });
      tx.calendarLesson.deleteMany.mockResolvedValue({ count: 7 });
      tx.masterLesson.count.mockResolvedValue(2);
    });

    /** A master lesson row, in the columns the preserve rule reads. */
    const lessonRow = (overrides: Record<string, unknown> = {}) => ({
      isGenerated: false,
      isLocked: false,
      extraGroups: [] as unknown[],
      participants: [] as unknown[],
      recurrence: 'ALL_WEEKS',
      startDate: null as Date | null,
      endDate: null as Date | null,
      ...overrides,
    });

    /**
     * The delete's own where-clause, applied to a row as Prisma would apply it.
     *
     * That clause is what decides whether a school's lesson is still there
     * after a regeneration, and asserting its literal shape only proves nobody
     * mistyped it. Four clause kinds are all it may contain; an unrecognised
     * one throws rather than quietly reading as "not preserved", which is the
     * direction that deletes somebody's lesson.
     */
    const survivesRegeneration = (lesson: Record<string, unknown>): boolean => {
      const call = tx.masterLesson.deleteMany.mock.calls[0]![0] as {
        where: { NOT: { OR: Array<Record<string, unknown>> } };
      };
      return call.where.NOT.OR.some((clause) => {
        if ('isGenerated' in clause) return lesson.isGenerated === clause.isGenerated;
        if ('isLocked' in clause) return lesson.isLocked === clause.isLocked;
        if ('extraGroups' in clause) return (lesson.extraGroups as unknown[]).length > 0;
        if ('participants' in clause) return (lesson.participants as unknown[]).length > 0;
        throw new Error(`Unhandled preserve clause: ${JSON.stringify(clause)}`);
      });
    };

    const springTerm = {
      startDate: new Date('2026-01-07T00:00:00.000Z'),
      endDate: new Date('2026-06-11T00:00:00.000Z'),
    };

    it('deletes its own windowed output instead of stacking a copy on it', async () => {
      await persist({ status: 'FEASIBLE', lessons: [] });

      // The whole reason ownership is a column. Inferred from the row looking
      // untouched, this lesson read as handmade — odd weeks, dates set — and so
      // it was preserved, its requirement still counted as unmet, and the next
      // run put a second copy beside it. Every press of generate added one.
      expect(
        survivesRegeneration(
          lessonRow({ isGenerated: true, recurrence: 'ODD_WEEKS', ...springTerm }),
        ),
      ).toBe(false);
    });

    it('keeps a half-term course a half-term course', async () => {
      await persist({ status: 'FEASIBLE', lessons: [] });

      // "Kemi bara på vårterminen", placed by hand. The engine has no week
      // model, so a regenerated replacement always comes back as an ordinary
      // weekly lesson: the course would quietly become a year-long one, with
      // nothing in the audit trail to say a school's decision was reversed.
      // It is the hand that saves it now, not the window.
      expect(survivesRegeneration(lessonRow(springTerm))).toBe(true);
    });

    it('keeps a generated lesson somebody has since taken over', async () => {
      await persist({ status: 'FEASIBLE', lessons: [] });

      // Locking it, adding a second class or naming students are all decisions
      // the solver cannot express and could not put back.
      expect(survivesRegeneration(lessonRow({ isGenerated: true, isLocked: true }))).toBe(true);
      expect(
        survivesRegeneration(lessonRow({ isGenerated: true, extraGroups: [{}] })),
      ).toBe(true);
      expect(
        survivesRegeneration(lessonRow({ isGenerated: true, participants: [{}] })),
      ).toBe(true);
      // …while one nobody has touched is still the machine's to replace.
      expect(survivesRegeneration(lessonRow({ isGenerated: true }))).toBe(false);
    });

    it('preserves locked lessons and manual multi-class constructs', async () => {
      await persist({ status: 'FEASIBLE', lessons: [] });

      const preserved = {
        OR: [
          // Everything the optimizer did not write, whatever it looks like.
          { isGenerated: false },
          { isLocked: true },
          { extraGroups: { some: {} } },
          { participants: { some: {} } },
        ],
      };
      // Machine-owned lessons are replaced; anything a human locked or built
      // by hand is excluded from the delete.
      expect(tx.masterLesson.deleteMany).toHaveBeenCalledWith({
        where: { academicYearId: ACADEMIC_YEAR, NOT: preserved },
      });
      expect(tx.masterLesson.count).toHaveBeenCalledWith({
        where: { academicYearId: ACADEMIC_YEAR, ...preserved },
      });
    });

    it('scopes the delete to the requested academic year only', async () => {
      await persist({ status: 'FEASIBLE', lessons: [] });

      const call = tx.masterLesson.deleteMany.mock.calls[0]![0] as {
        where: { academicYearId: string };
      };
      expect(call.where.academicYearId).toBe(ACADEMIC_YEAR);
    });

    it('takes the dated lessons of the replaced templates with them', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-12T08:00:00.000Z'));
      try {
        await persist({ status: 'FEASIBLE', lessons: [] });
      } finally {
        jest.useRealTimers();
      }

      // Without this the FK sets masterLessonId to null and the rows survive
      // as orphans the publish idempotency set cannot see — the next publish
      // then materializes the same week a second time.
      expect(tx.calendarLesson.deleteMany).toHaveBeenCalledWith({
        where: {
          masterLesson: {
            is: {
              academicYearId: ACADEMIC_YEAR,
              NOT: {
                OR: [
                  { isGenerated: false },
                  { isLocked: true },
                  { extraGroups: { some: {} } },
                  { participants: { some: {} } },
                ],
              },
            },
          },
          status: 'SCHEDULED',
          date: { gte: new Date('2026-08-12T00:00:00.000Z') },
          attendanceRecords: { none: {} },
        },
      });
    });

    it('clears the dated lessons before the templates they hang off', async () => {
      await persist({ status: 'FEASIBLE', lessons: [] });

      // The other order loses them: deleting the template first nulls the
      // link, and the relation filter then matches nothing.
      expect(
        tx.calendarLesson.deleteMany.mock.invocationCallOrder[0]!,
      ).toBeLessThan(tx.masterLesson.deleteMany.mock.invocationCallOrder[0]!);
    });
  });

  describe('callAiEngine — failure mapping', () => {
    /** Maps a refusal can name something through; empty unless a test fills one. */
    const maps = () => ({
      requirementAnonMap: new Map<string, string>(),
      roomAnonMap: new Map<string, string>(),
      groupAnonMap: new Map<string, string>(),
      roomTypeAnonMap: new Map<string, string>(),
      constraintAnonMap: new Map<string, string>(),
      nameById: new Map<string, string>(),
      lessonAnonMap: new Map<string, string>(),
    });

    const call = (payload = {}, anonMaps = maps()) =>
      (
        service as unknown as {
          callAiEngine: (path: string, p: unknown, m: unknown) => Promise<AiEngineScheduleResponse>;
        }
      ).callAiEngine('/v1/schedule', payload, anonMaps);

    it('returns the engine payload on success', async () => {
      http.post.mockReturnValue(
        of({ data: { status: 'OPTIMAL', lessons: [] } }),
      );

      await expect(call()).resolves.toEqual({ status: 'OPTIMAL', lessons: [] });
    });

    it('maps a slow engine to 503 rather than hanging the request', async () => {
      // Emits after the configured 50ms timeout, so the timeout operator wins.
      http.post.mockReturnValue(timer(500).pipe(mergeMap(() => of({ data: {} }))));

      await expect(call()).rejects.toThrow(ServiceUnavailableException);
      await expect(call()).rejects.toThrow('did not respond in time');
    });

    it('says the engine could not be REACHED when nothing answered', async () => {
      /*
       * The ordinary local failure: the engine is a separate service and it is
       * easy to forget to start. An AxiosError with no `response` is a request
       * that never arrived — ECONNREFUSED, or a host that does not resolve.
       *
       * It used to be reported as "The AI engine returned an error" with a 502,
       * which sent whoever read it looking at the engine's own logs. Those are
       * empty, because it was never running.
       */
      const refused = new AxiosError('connect ECONNREFUSED 127.0.0.1:8000');
      refused.code = 'ECONNREFUSED';
      http.post.mockReturnValue(throwError(() => refused));

      await expect(call()).rejects.toThrow(ServiceUnavailableException);
      await expect(call()).rejects.toThrow('could not be reached');
      // And NOT the message that means the engine answered.
      await expect(call()).rejects.not.toThrow('returned an error');
    });

    it('keeps a 500 from the engine a 500, not a 502', async () => {
      // The status is what separates "this request was wrong" from "the engine
      // broke", and flattening both into 502 loses it.
      const broke = new AxiosError('boom');
      broke.response = { status: 500 } as never;
      http.post.mockReturnValue(throwError(() => broke));

      await expect(call()).rejects.toMatchObject({ status: 500 });
    });

    it('propagates the engine status code on an HTTP error', async () => {
      const axiosError = new AxiosError('boom');
      axiosError.response = { status: 422 } as never;
      http.post.mockReturnValue(throwError(() => axiosError));

      await expect(call()).rejects.toThrow(HttpException);
      await expect(call()).rejects.toMatchObject({ status: 422 });
    });

    it('answers 503 and not 502 when the engine never responded', async () => {
      /*
       * This used to assert 502, and 502 was the wrong answer.
       *
       * "Bad Gateway" says the upstream replied with something unusable. An
       * AxiosError carrying no `response` says it replied with nothing at all,
       * which is 503 — and the distinction is the difference between reading
       * the engine's logs and starting the engine.
       */
      http.post.mockReturnValue(throwError(() => new AxiosError('no response')));

      await expect(call()).rejects.toMatchObject({ status: 503 });
      await expect(call()).rejects.toThrow('could not be reached');
    });

    it('forwards the engine\'s own sentence on a 4xx', async () => {
      /*
       * Every named refusal the engine can produce arrived here and was
       * replaced by "The AI engine returned an error." — which is what the
       * generate page then rendered. The messages exist and name the
       * requirement, the group and the day; they were thrown away one layer
       * below the screen that shows them.
       */
      const refused = new AxiosError('boom');
      refused.response = {
        status: 400,
        data: {
          code: 'INVALID_SCHEDULE_INPUT',
          message:
            'An availability rule leaves student group 7A no 30-minute lunch break on day 1.',
        },
      } as never;
      http.post.mockReturnValue(throwError(() => refused));

      await expect(call()).rejects.toThrow('no 30-minute lunch break on day 1');
      await expect(call()).rejects.toMatchObject({ status: 400 });
    });

    it('turns an anonymous id in a refusal back into the real one', async () => {
      /*
       * Every named refusal the engine can produce carries an id the engine
       * minted. Forwarded verbatim it is a uuid that exists in no table, which
       * is the state the conflict MESSAGES are still in — the school reads a
       * precise sentence about something it cannot look up.
       *
       * A substitution, not a second implementation of the rule: rebuilding the
       * lock resolution here to phrase a nicer sentence would be two
       * implementations of one meaning, and the one that drifts is the one
       * nobody runs.
       */
      const anonRequirement = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
      const realRequirement = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
      const refused = new AxiosError('boom');
      refused.response = {
        status: 400,
        data: {
          code: 'INVALID_SCHEDULE_INPUT',
          message: `A room lock leaves requirement ${anonRequirement} nowhere to go.`,
        },
      } as never;
      http.post.mockReturnValue(throwError(() => refused));

      await expect(
        call({}, { ...maps(), requirementAnonMap: new Map([[realRequirement, anonRequirement]]) }),
      ).rejects.toThrow(realRequirement);
    });

    it('translates a room type, which is the part of that sentence a school reads', async () => {
      /*
       * "No room satisfies capacity/type/years for requirement X (…, required
       * type Y, …)" names an anonymised TYPE. Leaving it out left the one piece
       * of that sentence an administrator would actually go and look up as a
       * uuid belonging to nothing.
       */
      const anonType = 'dddddddd-4444-4444-8444-dddddddddddd';
      const realType = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
      const refused = new AxiosError('boom');
      refused.response = {
        status: 400,
        data: { code: 'X', message: `… required type ${anonType}, years 4-4).` },
      } as never;
      http.post.mockReturnValue(throwError(() => refused));

      await expect(
        call({}, { ...maps(), roomTypeAnonMap: new Map([[realType, anonType]]) }),
      ).rejects.toThrow(realType);
    });

    it('turns a lesson id in a room-optimisation refusal back into the real one', async () => {
      // The room route names placed lessons, not requirements; the same
      // translation has to reach them or the refusal names a row in no table.
      const anonLesson = 'aaaaaaaa-6666-4666-8666-aaaaaaaaaaaa';
      const realLesson = 'bbbbbbbb-7777-4777-8777-bbbbbbbbbbbb';
      const refused = new AxiosError('boom');
      refused.response = {
        status: 422,
        data: { code: 'X', message: `Lesson ${anonLesson} names a room not in rooms.` },
      } as never;
      http.post.mockReturnValue(throwError(() => refused));

      await expect(
        call({}, { ...maps(), lessonAnonMap: new Map([[realLesson, anonLesson]]) }),
      ).rejects.toThrow(realLesson);
    });

    it('leaves a uuid it has no mapping for exactly as it was', async () => {
      // Half a translation would be worse than none: an id that looks real and
      // resolves to nothing sends somebody searching.
      const stranger = 'cccccccc-3333-4333-8333-cccccccccccc';
      const refused = new AxiosError('boom');
      refused.response = {
        status: 400,
        data: { code: 'X', message: `Requirement ${stranger} is impossible.` },
      } as never;
      http.post.mockReturnValue(throwError(() => refused));

      await expect(call()).rejects.toThrow(stranger);
    });

    it('keeps the generic sentence for a 5xx, whatever the body says', async () => {
      // An internal failure's detail is ours to read in the logs. Forwarding it
      // would put the engine's stack-trace text in a school's toast.
      const broke = new AxiosError('boom');
      broke.response = {
        status: 500,
        data: { code: 'SOLVER_BUILD_ERROR', message: 'CP-SAT rejected the model: ...' },
      } as never;
      http.post.mockReturnValue(throwError(() => broke));

      await expect(call()).rejects.toThrow('The AI engine returned an error.');
      await expect(call()).rejects.not.toThrow('CP-SAT');
    });

    it('falls back to the generic sentence when the body carries no message', async () => {
      // A proxy or a load balancer can answer 4xx with HTML, or nothing.
      const odd = new AxiosError('boom');
      odd.response = { status: 413, data: '<html>too large</html>' } as never;
      http.post.mockReturnValue(throwError(() => odd));

      await expect(call()).rejects.toThrow('The AI engine returned an error.');
      await expect(call()).rejects.toMatchObject({ status: 413 });
    });

    it('maps an unrecognised transport failure to 503', async () => {
      http.post.mockReturnValue(throwError(() => new Error('socket closed')));

      await expect(call()).rejects.toThrow(ServiceUnavailableException);
    });

    it('never leaks the API key in the thrown error', async () => {
      http.post.mockReturnValue(throwError(() => new Error('kkkk')));

      await expect(call()).rejects.not.toThrow(/k{32}/);
    });
  });

  describe('triggerScheduling — PII-stripping pipeline', () => {
    const REQ_ID = '11111111-aaaa-4aaa-8aaa-111111111111';
    const SUBJECT_ID = '22222222-aaaa-4aaa-8aaa-222222222222';
    const GROUP_ID = '33333333-aaaa-4aaa-8aaa-333333333333';
    const TEACHER_ID = '44444444-aaaa-4aaa-8aaa-444444444444';
    const ROOM_ID = '55555555-aaaa-4aaa-8aaa-555555555555';
    const EXTRA_GROUP_ID = '66666666-aaaa-4aaa-8aaa-666666666666';

    const eightAm = new Date('1970-01-01T08:00:00.000Z');
    const nineAm = new Date('1970-01-01T09:00:00.000Z');

    let prisma: PrismaMock;

    beforeEach(() => {
      prisma = createPrismaMock(tx);
      service = new OptimizationProxyService(
        prisma as unknown as PrismaService,
        http as unknown as HttpService,
        makeConfigService(),
      );
    });

    const requirement = (overrides: Record<string, unknown> = {}) => ({
      id: REQ_ID,
      subjectId: SUBJECT_ID,
      studentGroupId: GROUP_ID,
      teacherId: TEACHER_ID,
      coTeacherId: null,
      lessonsPerWeek: 3,
      minutesPerLesson: 60,
      // As the columns default: every week, all year. Spelled out because a row
      // that omits them is not a row the database can produce, and both the
      // subtraction and the lessons the run writes read them.
      recurrence: 'ALL_WEEKS',
      startDate: null,
      endDate: null,
      subject: { requiredRoomTypeId: 'room-type-lab' },
      ...overrides,
    });

    const lockedLesson = (overrides: Record<string, unknown> = {}) => ({
      id: 'locked-1',
      subjectId: SUBJECT_ID,
      studentGroupId: GROUP_ID,
      teacherId: TEACHER_ID,
      coTeacherId: null,
      roomId: ROOM_ID,
      dayOfWeek: 2,
      startTime: eightAm,
      endTime: nineAm,
      // As the column defaults: every week, no period. Spelled out because a
      // row that omits them is not a row the database can produce, and the
      // subtraction below reads them.
      recurrence: 'ALL_WEEKS',
      startDate: null,
      endDate: null,
      extraGroups: [],
      ...overrides,
    });

    const constraintRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'constraint-real-id',
      resourceType: 'TEACHER',
      userId: null,
      roomId: null,
      studentGroupId: null,
      minGradeLevel: null,
      maxGradeLevel: null,
      dayOfWeek: 1,
      date: null,
      startTime: eightAm,
      endTime: nineAm,
      type: 'UNAVAILABLE',
      ...overrides,
    });

    type Arrangement = {
      requirements?: unknown[];
      /** Rows of { id, studentGroupId }: students whose HOME class is the group. */
      homeMembers?: unknown[];
      /** Rows of { studentId, studentGroupId }: teaching-group memberships. */
      teachingMembers?: unknown[];
      lockedLessons?: unknown[];
      unlockedLessons?: unknown[];
      rooms?: unknown[];
      constraints?: unknown[];
      /**
       * Rows of { id, gradeLevel, kind }. The year each group belongs to, and
       * whether it is a home class — only a CLASS is sent to the engine as a
       * group that eats.
       */
      groups?: unknown[];
      /** Soft room wishes, as stored. */
      roomPreferences?: unknown[];
      /** The school's saved lunch rules, or null when nobody has defined them. */
      lunchSettings?: unknown;
    };

    const arrange = (overrides: Arrangement = {}) => {
      tx.teachingRequirement.findMany.mockResolvedValue(
        overrides.requirements ?? [requirement()],
      );
      // Group sizes and the group-conflict relation both derive from the two
      // membership queries: home-class students and teaching-group rows.
      tx.user.findMany.mockResolvedValue(
        overrides.homeMembers ??
          Array.from({ length: 24 }, (_, i) => ({
            id: `00000000-0000-4000-8000-9000000000${String(i).padStart(2, '0')}`,
            studentGroupId: GROUP_ID,
          })),
      );
      tx.studentGroupMember.findMany.mockResolvedValue(
        overrides.teachingMembers ?? [],
      );
      const locked = overrides.lockedLessons ?? [];
      const unlocked = overrides.unlockedLessons ?? [];
      // fetchAndAnonymize queries masterLesson twice: the locked/manual set
      // (where.OR) and the previous unlocked placements (where.isLocked=false).
      tx.masterLesson.findMany.mockImplementation(({ where }: any) =>
        Promise.resolve(where?.isLocked === false ? unlocked : locked),
      );
      tx.room.findMany.mockResolvedValue(
        overrides.rooms ?? [{ id: ROOM_ID, capacity: 30, type: 'CLASSROOM' }],
      );
      tx.availabilityConstraint.findMany.mockResolvedValue(
        overrides.constraints ?? [],
      );
      // Year spans for rooms limited to a stage are derived from these.
      // The default is the one class the default requirement belongs to, so a
      // payload built with no overrides still names somebody who eats.
      tx.studentGroup.findMany.mockResolvedValue(
        overrides.groups ?? [{ id: GROUP_ID, gradeLevel: null, kind: 'CLASS' }],
      );
      tx.roomPreference.findMany.mockResolvedValue(overrides.roomPreferences ?? []);
      tx.lunchSetting.findUnique.mockResolvedValue(overrides.lunchSettings ?? null);
      tx.masterLesson.deleteMany.mockResolvedValue({ count: 2 });
      tx.calendarLesson.deleteMany.mockResolvedValue({ count: 4 });
      tx.masterLesson.count.mockResolvedValue(1);
      tx.masterLesson.create.mockResolvedValue({});
      tx.scheduleChangeLog.create.mockResolvedValue({});
    };

    /**
     * Engine echo: places every forwarded requirement in the first room, as
     * many times a week as it asked for. The count is part of the contract —
     * the engine creates one decision variable per lesson-per-week and emits
     * all of them — and a response carrying any other number is refused.
     */
    const echoEngine = (
      status: AiEngineScheduleResponse['status'] = 'OPTIMAL',
    ) => {
      http.post.mockImplementation((_url: string, payload: any) =>
        of({
          data: {
            requestId: payload.requestId,
            status,
            lessons: payload.requirements.flatMap((r: any) =>
              Array.from({ length: r.lessonsPerWeek }, () => ({
                requirementId: r.id,
                roomId: payload.rooms[0]?.id ?? null,
                dayOfWeek: 1,
                startTime: '08:00:00',
                endTime: '09:15:00',
              })),
            ),
            conflicts: null,
          },
        }),
      );
    };

    const postedPayload = (): AiEngineScheduleRequest =>
      http.post.mock.calls[0][1] as AiEngineScheduleRequest;

    it('reads a requirement’s room needs through the derivation the room optimisation shares', async () => {
      /*
       * The room optimisation may only move a lesson into a room this run
       * could have given it, and that holds only while both read group size,
       * years and room type through one function. A copy inlined here would
       * pass every other test in this file and drift the first time either
       * side is fixed.
       */
      const needs = jest.spyOn(eligibility, 'roomNeedsOf');
      try {
        arrange();
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(needs).toHaveBeenCalledWith(
          expect.anything(),
          { groupIds: [GROUP_ID] },
          expect.anything(),
        );
        expect(postedPayload().requirements[0].studentGroupSize).toBe(
          needs.mock.results[0]!.value.studentGroupSize,
        );
      } finally {
        needs.mockRestore();
      }
    });

    it('sends a meal the school placed as a pin, under the class\u2019s anonymous id', async () => {
      /*
       * Only the rows the school wrote, and only as a start: the engine pins the
       * lunch variable it builds anyway. The id is the same anonymous id the
       * class carries in \`groups\` — a pin under any other id would have no
       * variable to pin, and a pin under the real one would be a real id
       * reaching the engine.
       */
      arrange();
      tx.lunchSitting.findMany.mockResolvedValue([
        {
          studentGroupId: GROUP_ID,
          dayOfWeek: 2,
          startTime: new Date('1970-01-01T13:00:00.000Z'),
        },
      ]);
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      const { lunchPlacements, groups } = postedPayload();
      expect(lunchPlacements).toHaveLength(1);
      expect(lunchPlacements[0]).toMatchObject({ dayOfWeek: 2, startTime: '13:00:00' });
      expect(lunchPlacements[0].studentGroupId).not.toBe(GROUP_ID);
      expect(groups.map((group) => group.id)).toContain(lunchPlacements[0].studentGroupId);
      expect(tx.lunchSitting.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ isGenerated: false }) }),
      );
    });

    it('sends a rast as its stage, its day and its clock times, and never its name', async () => {
      /*
       * The engine subtracts minutes and has nothing to say about what they
       * are called, and a name is one more thing that could identify a school
       * in a payload built to be anonymous. The row below carries one anyway —
       * as it would the day somebody widens the select — so the mapping has to
       * leave it behind on its own.
       */
      arrange();
      tx.rast.findMany.mockResolvedValue([
        {
          name: 'Förmiddagsrast',
          minGradeLevel: 4,
          maxGradeLevel: 6,
          dayOfWeek: null,
          startTime: new Date('1970-01-01T09:40:00.000Z'),
          endTime: new Date('1970-01-01T10:00:00.000Z'),
          requiresLessonBefore: true,
        },
      ]);
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().rasts).toEqual([
        {
          minGradeLevel: 4,
          maxGradeLevel: 6,
          dayOfWeek: null,
          startTime: '09:40:00',
          endTime: '10:00:00',
          requiresLessonBefore: true,
        },
      ]);
      // Through the year's school, as the frames and the sittings are read, so
      // a request naming another school's year cannot pull this school's rows.
      const query = tx.rast.findMany.mock.calls[0][0];
      expect(query.where).toEqual({ school: { academicYears: { some: { id: ACADEMIC_YEAR } } } });
      expect(query.select).not.toHaveProperty('name');
    });

    // -----------------------------------------------------------------------
    // Sittningarna, on their way back
    // -----------------------------------------------------------------------

    /** Engine echo that also answers with a sitting for every group it saw. */
    const echoWithLunches = () => {
      http.post.mockImplementation((_url: string, payload: any) =>
        of({
          data: {
            requestId: payload.requestId,
            status: 'OPTIMAL',
            lessons: payload.requirements.flatMap((r: any) =>
              Array.from({ length: r.lessonsPerWeek }, () => ({
                requirementId: r.id,
                roomId: payload.rooms[0]?.id ?? null,
                dayOfWeek: 1,
                startTime: '08:00:00',
                endTime: '09:15:00',
              })),
            ),
            lunches: payload.groups.map((g: any) => ({
              studentGroupId: g.id,
              dayOfWeek: 1,
              startTime: '11:30:00',
              endTime: '12:00:00',
            })),
            conflicts: null,
          },
        }),
      );
    };

    it('hands the sittings back with real group ids, not anonymous ones', async () => {
      /*
       * The engine only ever sees re-keyed ids, so a caller given the raw reply
       * would get a uuid that exists in no table — the same unactionable shape
       * the engine's conflict messages still have. The assertion is on the
       * exact id, because "contains a uuid" would pass for the anonymous one.
       */
      arrange();
      echoWithLunches();

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(result.lunches).toEqual([
        {
          studentGroupId: GROUP_ID,
          dayOfWeek: 1,
          startTime: '11:30:00',
          endTime: '12:00:00',
        },
      ]);
    });

    it('drops a sitting for a group the payload never carried', async () => {
      // An id the gateway cannot resolve means the engine invented one. A lunch
      // pointing at a group that does not exist is worse than no lunch: it
      // would be stored, drawn, and unexplainable.
      arrange();
      http.post.mockImplementation((_url: string, payload: any) =>
        of({
          data: {
            requestId: payload.requestId,
            status: 'OPTIMAL',
            lessons: payload.requirements.flatMap((r: any) =>
              Array.from({ length: r.lessonsPerWeek }, () => ({
                requirementId: r.id,
                roomId: payload.rooms[0]?.id ?? null,
                dayOfWeek: 1,
                startTime: '08:00:00',
                endTime: '09:15:00',
              })),
            ),
            lunches: [
              {
                studentGroupId: '99999999-9999-4999-8999-999999999999',
                dayOfWeek: 1,
                startTime: '11:30:00',
                endTime: '12:00:00',
              },
            ],
            conflicts: null,
          },
        }),
      );

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(result.lunches).toEqual([]);
    });

    it('answers with an empty list when the engine sends no sittings', async () => {
      // An older engine omits the field entirely. `undefined` must not reach a
      // caller that will iterate it.
      arrange();
      echoEngine();

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(result.lunches).toEqual([]);
    });

    it('sends the engine no parked lesson as a fixed placement', async () => {
      // A parked lesson is preserved like any hand-made one — regeneration
      // does not own it — but blocking the engine out of a slot nobody is in
      // would be reading its memory of where it was as where it is.
      arrange({ lockedLessons: [lockedLesson()] });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(tx.masterLesson.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isParked: false, OR: expect.any(Array) }),
        }),
      );
    });

    it('forwards no real database id — every resource is re-keyed anonymously', async () => {
      arrange({
        lockedLessons: [lockedLesson()],
        constraints: [
          constraintRow({ userId: TEACHER_ID, resourceType: 'TEACHER' }),
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      const serialized = JSON.stringify(postedPayload());
      for (const realId of [
        REQ_ID,
        SUBJECT_ID,
        GROUP_ID,
        TEACHER_ID,
        ROOM_ID,
        'constraint-real-id',
        'locked-1',
      ]) {
        expect(serialized).not.toContain(realId);
      }
    });

    it('keeps the non-PII scheduling facts on the anonymized requirement', async () => {
      arrange();
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().requirements[0]).toMatchObject({
        lessonsPerWeek: 3,
        minutesPerLesson: 60,
        studentGroupSize: 24,
        coTeacherId: null,
      });

      // Room types are school-authored words ("Trä- och metallslöjd"), so the
      // token that crosses to the engine must be anonymised like every other
      // id — never the real row id, and never the name.
      const posted = postedPayload().requirements[0].requiredRoomType;
      expect(posted).toEqual(expect.any(String));
      expect(posted).not.toBe('room-type-lab');
    });

    it('maps each real resource to one stable anonymous id across the payload', async () => {
      arrange({
        lockedLessons: [lockedLesson()],
        constraints: [
          constraintRow({ userId: TEACHER_ID, resourceType: 'TEACHER' }),
          constraintRow({ roomId: ROOM_ID, resourceType: 'ROOM' }),
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const payload = postedPayload();
      const [req] = payload.requirements;
      const [fixed] = payload.fixedLessons;
      const [room] = payload.rooms;
      const [teacherConstraint, roomConstraint] = payload.constraints;

      // The engine can only respect "same teacher / same room" collisions if
      // one real id always maps to the same anonymous id within a request.
      expect(fixed.teacherId).toBe(req.teacherId);
      expect(fixed.studentGroupId).toBe(req.studentGroupId);
      expect(fixed.roomId).toBe(room.id);
      expect(teacherConstraint.resourceId).toBe(req.teacherId);
      expect(roomConstraint.resourceId).toBe(room.id);
    });

    it('subtracts locked lessons from the weekly demand sent to the engine', async () => {
      arrange({ lockedLessons: [lockedLesson()] });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().requirements[0].lessonsPerWeek).toBe(2);
    });

    it('skips the engine when locked lessons already cover all demand', async () => {
      arrange({
        requirements: [requirement({ lessonsPerWeek: 1 })],
        lockedLessons: [lockedLesson()],
      });

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(http.post).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'FEASIBLE', lessons: [] });
      // The persist phase still runs so stale unlocked leftovers are removed.
      expect(tx.masterLesson.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ academicYearId: ACADEMIC_YEAR }),
        }),
      );
    });

    /*
     * A locked lesson only cancels demand it covers for the requirement's
     * whole period.
     *
     * The engine knows nothing about weeks, so a subtraction applies to all of
     * them. Subtracting for a lesson that is absent from part of the period
     * leaves the class one lesson short on those weeks, for the whole year,
     * with nothing anywhere saying so. Over-delivering instead puts an extra
     * lesson on the timetable, where somebody can see it.
     */
    it('does not let an alternating locked lesson cancel a weekly lesson', async () => {
      arrange({ lockedLessons: [lockedLesson({ recurrence: 'ODD_WEEKS' })] });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const payload = postedPayload();

      // Timplanen says three a week; the odd-week lesson covers none of the
      // even weeks, so all three are still the engine's to place.
      expect(payload.requirements[0].lessonsPerWeek).toBe(3);
      // And it is still a fixed placement, so its slot stays blocked in every
      // week — that is what makes over-delivery cost packing room, not a clash.
      expect(payload.fixedLessons).toHaveLength(1);
    });

    it('does not let a part-of-the-year locked lesson cancel a weekly lesson', async () => {
      arrange({
        lockedLessons: [
          lockedLesson({
            startDate: new Date('2026-01-07T00:00:00.000Z'),
            endDate: new Date('2026-06-11T00:00:00.000Z'),
          }),
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      // A subject read for one term is absent for the other one, so it covers
      // no more of a full-year requirement than an alternating lesson does.
      expect(postedPayload().requirements[0].lessonsPerWeek).toBe(3);
    });

    it('does not let a locked lesson cancel demand outside its own window', async () => {
      const autumnStart = new Date('2025-08-18T00:00:00.000Z');
      arrange({
        requirements: [
          requirement({
            startDate: autumnStart,
            endDate: new Date('2026-06-11T00:00:00.000Z'),
          }),
        ],
        lockedLessons: [
          lockedLesson({
            // Autumn term only, against a requirement read all year: the spring
            // half of it has no lesson in it at all. The lesson looks like a
            // perfectly good match on (group, subject) and covers two thirds of
            // what was asked for, which is exactly why the comparison has to be
            // against the requirement's own period rather than the default.
            startDate: autumnStart,
            endDate: new Date('2025-12-19T00:00:00.000Z'),
          }),
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().requirements[0].lessonsPerWeek).toBe(3);
    });

    it('lets a locked lesson matching the requirement period cancel a lesson', async () => {
      const spring = {
        startDate: new Date('2026-01-07T00:00:00.000Z'),
        endDate: new Date('2026-06-11T00:00:00.000Z'),
      };
      arrange({
        requirements: [requirement({ recurrence: 'ODD_WEEKS', ...spring })],
        lockedLessons: [lockedLesson({ recurrence: 'ODD_WEEKS', ...spring })],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      // The counterweight to the refusals above: a rule that never counted
      // anything would send the full demand every time and quietly double a
      // half-term subject on every regeneration.
      expect(postedPayload().requirements[0].lessonsPerWeek).toBe(2);
    });

    it('lets an all-year locked lesson cancel a lesson of a one-term requirement', async () => {
      arrange({
        requirements: [
          requirement({
            startDate: new Date('2026-01-07T00:00:00.000Z'),
            endDate: new Date('2026-06-11T00:00:00.000Z'),
          }),
        ],
        lockedLessons: [lockedLesson()],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      // An absent bound is the open one, so a lesson with neither encloses any
      // period a requirement can name — it is there every week the requirement
      // is, and then some.
      expect(postedPayload().requirements[0].lessonsPerWeek).toBe(2);
    });

    it('still asks the engine when only alternating lessons cover the demand', async () => {
      arrange({
        requirements: [requirement({ lessonsPerWeek: 1 })],
        lockedLessons: [lockedLesson({ recurrence: 'EVEN_WEEKS' })],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      // The counterpart of the skip above: demand that only looks covered must
      // not take the shortcut past the solver, or the odd weeks get nothing.
      expect(http.post).toHaveBeenCalled();
      expect(postedPayload().requirements).toHaveLength(1);
      expect(postedPayload().requirements[0].lessonsPerWeek).toBe(1);
    });

    it('forwards locked lessons as fixed placements with HH:MM:SS times', async () => {
      arrange({
        lockedLessons: [
          lockedLesson({ extraGroups: [{ studentGroupId: EXTRA_GROUP_ID }] }),
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const [fixed] = postedPayload().fixedLessons;

      expect(fixed).toMatchObject({
        dayOfWeek: 2,
        startTime: '08:00:00',
        endTime: '09:00:00',
      });
      expect(fixed.extraGroupIds).toHaveLength(1);
      expect(fixed.extraGroupIds).not.toContain(EXTRA_GROUP_ID); // anonymized
    });

    it('forwards previous unlocked slots for minimal disruption, dropping orphans', async () => {
      arrange({
        unlockedLessons: [
          {
            subjectId: SUBJECT_ID,
            studentGroupId: GROUP_ID,
            dayOfWeek: 4,
            startTime: eightAm,
          },
          {
            // No requirement exists for this subject — must be skipped.
            subjectId: 'retired-subject',
            studentGroupId: GROUP_ID,
            dayOfWeek: 5,
            startTime: nineAm,
          },
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const payload = postedPayload();

      expect(payload.previousLessons).toEqual([
        {
          requirementId: payload.requirements[0].id,
          dayOfWeek: 4,
          startTime: '08:00:00',
        },
      ]);
    });

    it('forwards weights and rules only when the caller supplied them', async () => {
      arrange();
      echoEngine();

      await service.triggerScheduling(
        ACADEMIC_YEAR,
        testUser(),
        { spread: 7 },
        { lunchMinutes: 30 },
      );
      expect(postedPayload()).toMatchObject({
        weights: { spread: 7 },
        rules: { lunchMinutes: 30 },
      });

      http.post.mockClear();
      await service.triggerScheduling(ACADEMIC_YEAR, testUser(), null, null);
      expect(postedPayload()).not.toHaveProperty('weights');
      expect(postedPayload()).not.toHaveProperty('rules');
    });

    it('authenticates to the engine with the service key at the configured URL', async () => {
      arrange();
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(http.post).toHaveBeenCalledWith(
        'http://solver.test/v1/schedule',
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-API-Key': 'k'.repeat(32) }),
        }),
      );
    });

    it('translates the anonymous solution back to real ids before persisting', async () => {
      arrange();
      echoEngine('OPTIMAL');

      await service.triggerScheduling(
        ACADEMIC_YEAR,
        testUser({ schoolId: 'school-A' }),
      );

      // Three lessons a week were asked for, so three come back and three are
      // written — the whole solution, not a sample of it.
      expect(tx.masterLesson.create).toHaveBeenCalledTimes(3);
      expect(tx.masterLesson.create).toHaveBeenCalledWith({
        data: {
          schoolId: 'school-A',
          academicYearId: ACADEMIC_YEAR,
          subjectId: SUBJECT_ID,
          studentGroupId: GROUP_ID,
          teacherId: TEACHER_ID,
          coTeacherId: null,
          roomId: ROOM_ID,
          dayOfWeek: 1,
          startTime: new Date('1970-01-01T08:00:00.000Z'),
          endTime: new Date('1970-01-01T09:15:00.000Z'),
          recurrence: 'ALL_WEEKS',
          startDate: null,
          endDate: null,
          isGenerated: true,
        },
      });
    });

    it('gives a windowed requirement windowed lessons, stamped as its own', async () => {
      const springStart = new Date('2026-01-07T00:00:00.000Z');
      const springEnd = new Date('2026-06-11T00:00:00.000Z');
      arrange({
        requirements: [
          requirement({
            lessonsPerWeek: 1,
            recurrence: 'ODD_WEEKS',
            startDate: springStart,
            endDate: springEnd,
          }),
        ],
      });
      echoEngine('OPTIMAL');

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      // The engine is never told about weeks — it packs the requirement as if
      // it ran all year — so the period can only be stamped on here, from the
      // requirement. Without it "slöjd udda veckor" comes back weekly and
      // all-year, and the timplan is quietly rewritten by a regeneration.
      expect(tx.masterLesson.create).toHaveBeenCalledTimes(1);
      expect(tx.masterLesson.create.mock.calls[0]![0].data).toMatchObject({
        recurrence: 'ODD_WEEKS',
        startDate: springStart,
        endDate: springEnd,
        // And the row says whose it is, so the next run may delete it. Inferred
        // ownership would read these very columns as a human's handiwork.
        isGenerated: true,
      });
    });

    it('refuses a solution whose anonymous requirement is unknown', async () => {
      // It used to drop the lesson and carry on — having already deleted the
      // year's unlocked timetable to make room for it.
      arrange();
      http.post.mockImplementation(() =>
        of({
          data: {
            requestId: 'r',
            status: 'FEASIBLE',
            lessons: [
              {
                requirementId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
                roomId: null,
                dayOfWeek: 1,
                startTime: '08:00:00',
                endTime: '09:00:00',
              },
            ],
            conflicts: null,
          },
        }),
      );

      await expect(
        service.triggerScheduling(ACADEMIC_YEAR, testUser()),
      ).rejects.toMatchObject({ status: 502 });

      expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
      expect(tx.masterLesson.create).not.toHaveBeenCalled();
      expect(tx.scheduleChangeLog.create).not.toHaveBeenCalled();
    });

    it('appends a REGENERATE audit entry with the replacement counts', async () => {
      arrange();
      echoEngine('OPTIMAL');
      const user = testUser({ schoolId: 'school-A', userId: 'admin-1' });

      await service.triggerScheduling(ACADEMIC_YEAR, user);

      expect(tx.scheduleChangeLog.create).toHaveBeenCalledWith({
        data: {
          schoolId: 'school-A',
          academicYearId: ACADEMIC_YEAR,
          masterLessonId: null,
          actorId: 'admin-1',
          action: 'REGENERATE',
          after: {
            solverStatus: 'OPTIMAL',
            lessonsCreated: 3,
            unlockedReplaced: 2,
            lockedPreserved: 1,
            calendarLessonsRemoved: 4,
          },
        },
      });
    });

    it('runs the fetch and persist phases under the caller RLS session', async () => {
      arrange();
      echoEngine();
      const user = testUser();

      await service.triggerScheduling(ACADEMIC_YEAR, user);

      expect(prisma.withRls).toHaveBeenCalledTimes(2);
      expect(prisma.withRls.mock.calls[0][0]).toBe(user);
      expect(prisma.withRls.mock.calls[1][0]).toBe(user);
    });

    it('defaults an empty group to size 1 rather than zero', async () => {
      arrange({ homeMembers: [], teachingMembers: [] });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().requirements[0].studentGroupSize).toBe(1);
    });

    it('sends a class taught only through teaching groups as a group, with its headcount', async () => {
      /*
       * The school in the screenshot: every lesson on 4ma1, 4sv1, 4no1 — not
       * one on 4.1 itself. Such a class has no requirement and no preserved
       * lesson, so it never reached `groups`, so the engine owed it no lunch;
       * the sittings it DID place, for the teaching groups, were dropped at
       * persist because a pupil eats with their class. Zero rows, and a notice
       * saying no lunch had been placed for the year.
       */
      const MA71 = '99999999-9999-4999-8999-999999999999';
      const pupils = Array.from({ length: 24 }, (_, i) => ({
        id: `00000000-0000-4000-8000-9000000000${String(i).padStart(2, '0')}`,
        studentGroupId: GROUP_ID,
      }));
      arrange({
        requirements: [requirement({ studentGroupId: MA71 })],
        groups: [
          { id: GROUP_ID, gradeLevel: 4, kind: 'CLASS' },
          { id: MA71, gradeLevel: null, kind: 'TEACHING_GROUP' },
        ],
        homeMembers: pupils,
        teachingMembers: pupils.map((pupil) => ({ studentId: pupil.id, studentGroupId: MA71 })),
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      const payload = postedPayload();
      // Exactly one: the class. The teaching group is not sent as a group at
      // all — a second mandatory meal for the same children would reserve
      // thirty minutes of Ma71's day for a lunch nobody takes there.
      expect(payload.groups).toHaveLength(1);
      expect(payload.groups[0]).toMatchObject({ lunchHeadcount: 24, minGradeLevel: 4, maxGradeLevel: 4 });
      // And the class's meal is kept clear of the teaching group's lessons:
      // the shared-pupil pair reaches the payload even though the class has no
      // requirement of its own, because the class got its anonymous id first.
      expect(payload.groupConflicts).toHaveLength(1);
      const [pair] = payload.groupConflicts;
      expect(new Set(pair)).toEqual(new Set([payload.groups[0].id, payload.requirements[0].studentGroupId]));
    });

    it('derives group-conflict pairs from students shared across groups', async () => {
      // Two scheduled groups: home class 7A and teaching group Ma71. Student
      // S1 has 7A as home class AND a Ma71 membership -> exactly one pair.
      const CLASS_7A = GROUP_ID;
      const MA71 = '99999999-9999-4999-8999-999999999999';
      arrange({
        requirements: [
          requirement(),
          requirement({ id: '88888888-8888-4888-8888-888888888888', studentGroupId: MA71 }),
        ],
        homeMembers: [
          { id: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: CLASS_7A },
          { id: 'aaaaaaa2-0000-4000-8000-000000000002', studentGroupId: CLASS_7A },
        ],
        teachingMembers: [
          { studentId: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: MA71 },
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      const payload = postedPayload();
      expect(payload.groupConflicts).toHaveLength(1);
      const [a, b] = payload.groupConflicts[0];
      // The pair uses the SAME anonymous ids as the requirements do…
      const anonGroups = payload.requirements.map((r) => r.studentGroupId);
      expect(anonGroups).toContain(a);
      expect(anonGroups).toContain(b);
      expect(a).not.toBe(b);
      // …and no real id leaks through the pair list.
      const serialized = JSON.stringify(payload.groupConflicts);
      expect(serialized).not.toContain(CLASS_7A);
      expect(serialized).not.toContain(MA71);
    });

    it('emits no pair for groups without shared students', async () => {
      const OTHER = '99999999-9999-4999-8999-999999999999';
      arrange({
        requirements: [
          requirement(),
          requirement({ id: '88888888-8888-4888-8888-888888888888', studentGroupId: OTHER }),
        ],
        homeMembers: [
          { id: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: GROUP_ID },
          { id: 'aaaaaaa2-0000-4000-8000-000000000002', studentGroupId: OTHER },
        ],
        teachingMembers: [],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().groupConflicts).toEqual([]);
    });

    describe('soft room wishes', () => {
      it('anonymises the subject, type and rooms a wish names', async () => {
        arrange({
          roomPreferences: [
            {
              id: 'pref-1',
              subjectId: SUBJECT_ID,
              roomTypeId: null,
              weight: 200,
              rooms: [{ roomId: ROOM_ID }],
            },
          ],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        const [wish] = postedPayload().roomPreferences;
        expect(wish.weight).toBe(200);
        // Nothing recognisable leaves the gateway: every id is a stand-in.
        expect(wish.subjectId).not.toBe(SUBJECT_ID);
        expect(JSON.stringify(wish)).not.toContain(ROOM_ID);
      });

      it('maps a wish to the same anonymous room the payload uses', async () => {
        arrange({
          roomPreferences: [
            {
              id: 'pref-1',
              subjectId: SUBJECT_ID,
              roomTypeId: null,
              weight: 50,
              rooms: [{ roomId: ROOM_ID }],
            },
          ],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        const payload = postedPayload();
        // A wish pointing at an id the rooms list does not contain would be a
        // rule about a room the engine cannot see.
        expect(payload.roomPreferences[0].roomIds).toEqual([payload.rooms[0].id]);
      });

      it('drops a room the payload does not carry', async () => {
        arrange({
          roomPreferences: [
            {
              id: 'pref-1',
              subjectId: SUBJECT_ID,
              roomTypeId: null,
              weight: 50,
              rooms: [{ roomId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }],
            },
          ],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(postedPayload().roomPreferences[0].roomIds).toEqual([]);
      });

      it('sends an empty list when the school has stated no wishes', async () => {
        arrange();
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(postedPayload().roomPreferences).toEqual([]);
      });
    });

    describe('year spans for stage-limited rooms', () => {
      /** A second group, for the teaching-group cases. */
      const OTHER = '99999999-9999-4999-8999-999999999999';
      const student = (n: number, groupId: string) => ({
        id: `00000000-0000-4000-8000-90000000${String(n).padStart(4, '0')}`,
        studentGroupId: groupId,
      });

      it('derives the span from the students home classes', async () => {
        arrange({
          homeMembers: [student(1, GROUP_ID), student(2, GROUP_ID)],
          groups: [{ id: GROUP_ID, gradeLevel: 5 }],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(postedPayload().requirements[0]).toMatchObject({
          minGradeLevel: 5,
          maxGradeLevel: 5,
        });
      });

      it('gives a teaching group the years of its members, not its own blank', async () => {
        // The case the whole derivation exists for: Ma71 carries no gradeLevel,
        // but its students are year 7 and it must not be let into a 4-6 room.
        arrange({
          requirements: [requirement({ studentGroupId: OTHER })],
          homeMembers: [student(1, GROUP_ID)],
          teachingMembers: [{ studentId: student(1, GROUP_ID).id, studentGroupId: OTHER }],
          groups: [
            { id: GROUP_ID, gradeLevel: 7 },
            { id: OTHER, gradeLevel: null },
          ],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(postedPayload().requirements[0]).toMatchObject({
          minGradeLevel: 7,
          maxGradeLevel: 7,
        });
      });

      it('spans every year its members come from', async () => {
        arrange({
          requirements: [requirement({ studentGroupId: OTHER })],
          homeMembers: [student(1, GROUP_ID), student(2, 'gggggggg-0000-4000-8000-000000000003')],
          teachingMembers: [
            { studentId: student(1, GROUP_ID).id, studentGroupId: OTHER },
            {
              studentId: student(2, 'gggggggg-0000-4000-8000-000000000003').id,
              studentGroupId: OTHER,
            },
          ],
          groups: [
            { id: GROUP_ID, gradeLevel: 6 },
            { id: 'gggggggg-0000-4000-8000-000000000003', gradeLevel: 7 },
            { id: OTHER, gradeLevel: null },
          ],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(postedPayload().requirements[0]).toMatchObject({
          minGradeLevel: 6,
          maxGradeLevel: 7,
        });
      });

      it('falls back to the group own year when no member carries one', async () => {
        arrange({
          homeMembers: [{ id: student(1, GROUP_ID).id, studentGroupId: null }],
          groups: [{ id: GROUP_ID, gradeLevel: 4 }],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(postedPayload().requirements[0]).toMatchObject({
          minGradeLevel: 4,
          maxGradeLevel: 4,
        });
      });

      it('sends no span at all when nothing carries a year', async () => {
        // Null, not a guess: the engine reads it as "nothing to check against"
        // and lets the group into any room rather than none.
        arrange({ groups: [{ id: GROUP_ID, gradeLevel: null }] });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(postedPayload().requirements[0]).toMatchObject({
          minGradeLevel: null,
          maxGradeLevel: null,
        });
      });

      it('passes each room own limits through untouched', async () => {
        arrange({
          rooms: [
            { id: ROOM_ID, capacity: 30, type: 'CLASSROOM', minGradeLevel: 4, maxGradeLevel: 6 },
          ],
        });
        echoEngine();

        await service.triggerScheduling(ACADEMIC_YEAR, testUser());

        expect(postedPayload().rooms[0]).toMatchObject({
          minGradeLevel: 4,
          maxGradeLevel: 6,
        });
      });
    });

    it('counts a teaching group size as its distinct members, not zero', async () => {
      // Ma71 has no home-class members at all — its size must come from the
      // membership rows, and a student in both kinds must not count twice for
      // the home class either.
      const MA71 = '99999999-9999-4999-8999-999999999999';
      arrange({
        requirements: [
          requirement({ studentGroupId: MA71 }),
        ],
        homeMembers: [],
        teachingMembers: [
          { studentId: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: MA71 },
          { studentId: 'aaaaaaa2-0000-4000-8000-000000000002', studentGroupId: MA71 },
          { studentId: 'aaaaaaa3-0000-4000-8000-000000000003', studentGroupId: MA71 },
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().requirements[0].studentGroupSize).toBe(3);
    });

    it('formats date-bound constraints as YYYY-MM-DD', async () => {
      arrange({
        constraints: [
          constraintRow({
            userId: TEACHER_ID,
            date: new Date('2026-12-24T00:00:00.000Z'),
          }),
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const [constraint] = postedPayload().constraints;

      expect(constraint).toMatchObject({
        date: '2026-12-24',
        startTime: '08:00:00',
        endTime: '09:00:00',
        kind: 'UNAVAILABLE',
      });
      expect(constraint.id).not.toBe('constraint-real-id');
    });

    it('sends the school’s saved lunch rules, so every admin generates the same week', async () => {
      // They used to live in one browser's localStorage: a colleague pressing
      // generate ran under different rules and nothing said so.
      arrange({
        lunchSettings: {
          lunchEnabled: true,
          lunchStartTime: eightAm,
          lunchEndTime: nineAm,
          lunchMinutes: 30,
          diningSeats: 180,
          maxLessonsPerDayPerGroup: 7,
        },
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().rules).toEqual({
        lunchStartTime: '08:00:00',
        lunchEndTime: '09:00:00',
        lunchMinutes: 30,
        diningSeats: 180,
        maxLessonsPerDayPerGroup: 7,
      });
    });

    it('reads a switched-off lunch as no lunch rule, not as a zero-minute one', async () => {
      arrange({
        lunchSettings: {
          lunchEnabled: false,
          lunchStartTime: eightAm,
          lunchEndTime: nineAm,
          lunchMinutes: 30,
          diningSeats: 180,
          maxLessonsPerDayPerGroup: null,
        },
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      // Nothing left to say once lunch is off, so no rules key at all rather
      // than an empty object that reads as "considered, came to nothing".
      expect(postedPayload()).not.toHaveProperty('rules');
    });

    it('omits the seat count when the school has no limit worth modelling', async () => {
      arrange({
        lunchSettings: {
          lunchEnabled: true,
          lunchStartTime: eightAm,
          lunchEndTime: nineAm,
          lunchMinutes: 30,
          diningSeats: null,
          maxLessonsPerDayPerGroup: null,
        },
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().rules).not.toHaveProperty('diningSeats');
    });

    it('lets a caller’s own rules win over the stored ones', async () => {
      arrange({
        lunchSettings: {
          lunchEnabled: true,
          lunchStartTime: eightAm,
          lunchEndTime: nineAm,
          lunchMinutes: 30,
          diningSeats: 180,
          maxLessonsPerDayPerGroup: null,
        },
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser(), null, {
        lunchMinutes: 45,
      });

      // Body wins whole, not field by field: two half-specified rule sets
      // combining into a third nobody wrote would be worse than either.
      expect(postedPayload().rules).toEqual({ lunchMinutes: 45 });
    });

    it('counts a home class once for the dining hall and a teaching group not at all', async () => {
      // A child eats once. Ma71's students are already counted in 7A, so
      // sending its size too would fill the hall twice with the same children.
      const MA71 = '99999999-9999-4999-8999-999999999999';
      arrange({
        requirements: [
          requirement(),
          requirement({
            id: '88888888-8888-4888-8888-888888888888',
            studentGroupId: MA71,
          }),
        ],
        homeMembers: [
          { id: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: GROUP_ID },
          { id: 'aaaaaaa2-0000-4000-8000-000000000002', studentGroupId: GROUP_ID },
        ],
        teachingMembers: [
          { studentId: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: MA71 },
        ],
        groups: [
          { id: GROUP_ID, gradeLevel: 7, kind: 'CLASS' },
          { id: MA71, gradeLevel: null, kind: 'TEACHING_GROUP' },
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      // The class alone. The teaching group used to be sent with headcount 0
      // and was then owed a mandatory meal of its own by the engine — thirty
      // minutes reserved on Ma71's day for a lunch nobody takes there. Now it
      // is not a group that eats at all; its lessons keep 7A's meal clear
      // through the shared-pupil pair instead.
      expect(postedPayload().groups.map((g: any) => g.lunchHeadcount)).toEqual([2]);
      // The fact belongs to the group, and is carried in exactly one place.
      expect(postedPayload().requirements[0]).not.toHaveProperty("lunchHeadcount");
    });

    it('counts a class that reaches the payload only through a locked lesson', async () => {
      // Its every lesson is placed by hand, so the subtraction leaves it no
      // requirement at all — and it used to fall out of the payload with them,
      // while its thirty children kept eating.
      const HANDPLACED = '77777777-7777-4777-8777-777777777777';
      arrange({
        requirements: [requirement()],
        lockedLessons: [
          {
            id: 'ml-1',
            subjectId: SUBJECT_ID,
            studentGroupId: HANDPLACED,
            teacherId: null,
            coTeacherId: null,
            roomId: null,
            dayOfWeek: 1,
            startTime: eightAm,
            endTime: nineAm,
            extraGroups: [],
          },
        ],
        homeMembers: [
          { id: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: GROUP_ID },
          { id: 'aaaaaaa2-0000-4000-8000-000000000002', studentGroupId: HANDPLACED },
          { id: 'aaaaaaa3-0000-4000-8000-000000000003', studentGroupId: HANDPLACED },
        ],
        groups: [
          { id: GROUP_ID, gradeLevel: null, kind: 'CLASS' },
          { id: HANDPLACED, gradeLevel: null, kind: 'CLASS' },
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(
        postedPayload()
          .groups.map((g: any) => g.lunchHeadcount)
          .sort(),
      ).toEqual([1, 2]);
    });

    it('sends to the hall only the classes whose pupils have a lesson this week', async () => {
      // The register at Kunskapsskolan: twenty-four home classes, none with a
      // requirement of its own, every lesson on teaching groups drawn from two
      // of them. For one release every class of the year ate — 530 children in
      // 115 seats — and the school was told its dining hall could not feed the
      // two classes it was scheduling. A class is at school when the week has
      // a lesson its pupils sit in, on the class or on a teaching group.
      const TG_ID = '66666666-6666-4666-8666-666666666666';
      const IDLE = '55555555-5555-4555-8555-555555555555';
      const HANDPLACED = '77777777-7777-4777-8777-777777777777';
      arrange({
        requirements: [requirement({ studentGroupId: TG_ID })],
        lockedLessons: [
          {
            id: 'ml-1',
            subjectId: SUBJECT_ID,
            studentGroupId: HANDPLACED,
            teacherId: null,
            coTeacherId: null,
            roomId: null,
            dayOfWeek: 1,
            startTime: eightAm,
            endTime: nineAm,
            extraGroups: [],
          },
        ],
        homeMembers: [
          { id: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: GROUP_ID },
          { id: 'aaaaaaa2-0000-4000-8000-000000000002', studentGroupId: GROUP_ID },
          { id: 'aaaaaaa3-0000-4000-8000-000000000003', studentGroupId: IDLE },
          { id: 'aaaaaaa4-0000-4000-8000-000000000004', studentGroupId: IDLE },
          { id: 'aaaaaaa5-0000-4000-8000-000000000005', studentGroupId: IDLE },
          { id: 'aaaaaaa6-0000-4000-8000-000000000006', studentGroupId: HANDPLACED },
        ],
        // One pupil of the first class sits in the teaching group that has
        // the week's only requirement. That is what puts the class at school.
        teachingMembers: [
          { studentId: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: TG_ID },
        ],
        groups: [
          { id: GROUP_ID, gradeLevel: 4, kind: 'CLASS' },
          { id: IDLE, gradeLevel: 5, kind: 'CLASS' },
          { id: HANDPLACED, gradeLevel: 6, kind: 'CLASS' },
          { id: TG_ID, gradeLevel: null, kind: 'TEACHING_GROUP' },
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      // The class with a pupil in the teaching group (two children) and the
      // hand-placed class (one) eat. The idle class, five children strong, is
      // not at school as far as this week knows, and takes no seat.
      expect(
        postedPayload()
          .groups.map((g: any) => g.lunchHeadcount)
          .sort(),
      ).toEqual([1, 2]);
    });

    it('brings a refusal back with real ids, the school\'s names in the text, and the classes named', async () => {
      // The engine names a class only by its anonymous id — in the summary's
      // text and in resourceIds. Both are turned back here: the text says
      // "student group 4A", and the detail carries resourceNames for the page
      // to show under "the classes named here".
      arrange({
        groups: [{ id: GROUP_ID, gradeLevel: 4, kind: 'CLASS', name: '4A' }],
      });
      http.post.mockImplementation((_url: string, payload: any) =>
        of({
          data: {
            requestId: payload.requestId,
            status: 'INFEASIBLE',
            lessons: [],
            conflicts: {
              summary: `Too many lessons for the hours: student group ${payload.groups[0].id} needs more.`,
              summaryCode: 'DEMAND_CLIQUE_HOURS_SHORT',
              summaryParams: { group: payload.groups[0].id, sharingGroups: 2 },
              conflicts: [
                {
                  category: 'DINING_CAPACITY',
                  code: 'LUNCH_CLASSES_FILL_THE_HALL_DAILY',
                  params: { group: payload.groups[0].id, seats: 115 },
                  message: 'The classes named here bring their students to the hall every school day.',
                  requirementIds: [],
                  roomIds: [],
                  constraintIds: [],
                  resourceIds: [payload.groups[0].id],
                },
              ],
            },
          },
        }),
      );

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(result.conflicts?.summary).toBe(
        'Too many lessons for the hours: student group 4A needs more.',
      );
      // The VALUES go through the same substitution as the text: a Swedish
      // sentence renders {group} itself, and an anonymous uuid there would
      // name a row that exists in no table. Numbers are left alone.
      expect(result.conflicts?.summaryParams).toEqual({ group: '4A', sharingGroups: 2 });
      expect(result.conflicts?.conflicts[0]).toMatchObject({
        code: 'LUNCH_CLASSES_FILL_THE_HALL_DAILY',
        params: { group: '4A', seats: 115 },
        resourceIds: [GROUP_ID],
        resourceNames: ['4A'],
      });
    });

    it('names a timplan row by its subject and group, and a room type by its name', async () => {
      // A refusal that said "Timplansposten 8f2c…" named something a rektor
      // could not look up. A timplan row carries no name of its own, so it is
      // named the way the Timplan page names it — and the subject and the
      // room type ride along on joins the fetch was already making.
      arrange({
        requirements: [
          requirement({ subject: { requiredRoomTypeId: 'room-type-lab', name: 'Matematik', requiredRoomType: { name: 'Slöjdsal' } } }),
        ],
        groups: [{ id: GROUP_ID, gradeLevel: 4, kind: 'CLASS', name: '4A' }],
      });
      http.post.mockImplementation((_url: string, payload: any) =>
        of({
          data: {
            requestId: payload.requestId,
            status: 'INFEASIBLE',
            lessons: [],
            conflicts: {
              summary: `No room fits requirement ${payload.requirements[0].id}.`,
              summaryCode: 'ROOM_NONE_ELIGIBLE_FOR_REQUIREMENT',
              summaryParams: {
                requirement: payload.requirements[0].id,
                roomType: payload.requirements[0].requiredRoomType,
              },
              conflicts: [],
            },
          },
        }),
      );

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(result.conflicts?.summaryParams).toEqual({
        requirement: 'Matematik för 4A',
        roomType: 'Slöjdsal',
      });
      expect(result.conflicts?.summary).toBe('No room fits requirement Matematik för 4A.');
    });

    it('brings a refusal back naming a reservation and a room that are real rows', async () => {
      /*
       * Two ids used to leave this method meaning nothing.
       *
       * The anonymous constraint was minted with a bare randomUUID(), recorded
       * in no map — so the id the engine put in its sentence and in
       * `constraintIds` existed in NO table in either id space, and could not
       * be looked up by the school, by this gateway, or by a developer holding
       * the database. And `resourceIds` was read through the GROUP map alone,
       * although a reservation puts whatever it is about in there: a teacher's
       * or a room's anonymous uuid was handed to the client unchanged.
       */
      arrange({
        constraints: [
          constraintRow({ id: 'constraint-real-id', resourceType: 'ROOM', roomId: ROOM_ID }),
        ],
        rooms: [{ id: ROOM_ID, capacity: 30, type: 'CLASSROOM', name: 'Aulan', roomType: null }],
      });
      http.post.mockImplementation((_url: string, payload: any) =>
        of({
          data: {
            requestId: payload.requestId,
            status: 'INFEASIBLE',
            lessons: [],
            conflicts: {
              summary: 'blocked',
              summaryCode: 'CONFLICT_CORE_SUMMARY',
              summaryParams: {},
              conflicts: [
                {
                  category: 'AVAILABILITY',
                  code: 'AVAIL_CONSTRAINT_BLOCKS_LESSONS',
                  params: {
                    constraint: payload.constraints[0].id,
                    resource: payload.constraints[0].resourceId,
                  },
                  message: `A constraint ${payload.constraints[0].id} on room ${payload.constraints[0].resourceId}.`,
                  requirementIds: [],
                  roomIds: [],
                  constraintIds: [payload.constraints[0].id],
                  resourceIds: [payload.constraints[0].resourceId],
                },
              ],
            },
          },
        }),
      );

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const detail = (await service.triggerScheduling(ACADEMIC_YEAR, testUser()))
        .conflicts!.conflicts[0];

      expect(detail.params.constraint).toBe('constraint-real-id');
      expect(detail.resourceIds).toEqual([ROOM_ID]);
      // And the room, which the school named itself, is named.
      expect(detail.params.resource).toBe('Aulan');
      expect(detail.resourceNames).toEqual(['Aulan']);
    });

    it('sends a class to the hall when one of its pupils attends a lesson as a participant', async () => {
      // A hand-placed lesson may name pupils one by one rather than through a
      // group. Those pupils are in the building for it, and so their home
      // class eats — a panel found it going without, while a class reached
      // through an extra group or a membership ate as it should.
      const CLASS_B = '55555555-5555-4555-8555-555555555555';
      arrange({
        requirements: [requirement()],
        lockedLessons: [
          {
            ...lockedLesson(),
            participants: [{ studentId: 'aaaaaaa2-0000-4000-8000-000000000002' }],
          },
        ],
        homeMembers: [
          { id: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: GROUP_ID },
          { id: 'aaaaaaa2-0000-4000-8000-000000000002', studentGroupId: CLASS_B },
          { id: 'aaaaaaa3-0000-4000-8000-000000000003', studentGroupId: CLASS_B },
        ],
        groups: [
          { id: GROUP_ID, gradeLevel: 4, kind: 'CLASS' },
          { id: CLASS_B, gradeLevel: 5, kind: 'CLASS' },
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(
        postedPayload()
          .groups.map((g: any) => g.lunchHeadcount)
          .sort(),
      ).toEqual([1, 2]);
    });

    it("leaves the previous run's sittings standing when the engine is skipped", async () => {
      // Every requirement hand-placed: nothing to solve, so the engine is not
      // asked — and a reply built here carries no sittings. Wiping the table
      // on that reply left a wholly hand-placed school with no lunch at all.
      arrange({
        requirements: [requirement({ lessonsPerWeek: 1 })],
        lockedLessons: [lockedLesson()],
      });

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(http.post).not.toHaveBeenCalled();
      expect(result.lunches).toEqual([]);
      expect(tx.lunchSitting.deleteMany).not.toHaveBeenCalled();
      expect(tx.lunchSitting.createMany).not.toHaveBeenCalled();
      expect(tx.calendarLunch.deleteMany).not.toHaveBeenCalled();
      // The lessons' own clean-up still runs, and so does the audit entry.
      expect(tx.masterLesson.deleteMany).toHaveBeenCalled();
      expect(tx.scheduleChangeLog.create).toHaveBeenCalled();
    });

    it('drops a constraint whose declared type names no resource', async () => {
      // This used to be forwarded with a freshly minted uuid, which the engine
      // could never match against anything: the rule was saved, listed and
      // enforced nowhere, with no error at any layer. The API refuses to write
      // such a row now, and a survivor from before it is dropped rather than
      // sent as something the engine will silently ignore.
      arrange({
        constraints: [
          constraintRow({ userId: null, roomId: null, studentGroupId: null }),
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().constraints).toEqual([]);
    });

    it('sends a year-range lock with its bounds and no resource id', async () => {
      // The one target that is not a row anywhere: the engine matches the range
      // against each group's own span, which is how a lock on åk 4-6 also
      // catches a teaching group whose own gradeLevel is null.
      arrange({
        constraints: [
          constraintRow({
            resourceType: 'GRADE_LEVEL',
            userId: null,
            minGradeLevel: 4,
            maxGradeLevel: 6,
          }),
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const [constraint] = postedPayload().constraints;

      expect(constraint).toMatchObject({
        resourceKind: 'GRADE_LEVEL',
        minGradeLevel: 4,
        maxGradeLevel: 6,
      });
      expect(constraint.resourceId).toBeUndefined();
    });
  });


});
