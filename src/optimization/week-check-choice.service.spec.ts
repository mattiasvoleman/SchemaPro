// FIRST, as the built application reads it (see optimization-module.di.spec.ts): the proxy's constructor must see the
// clash rule's file before the proxy's own is read. Kept first on purpose; do not let an import sorter move it.
import { MasterLessonsService } from '../calendar/master-lessons.service';
import { HttpException, HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import { testUser } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { AiEngineConflictAnalysis, AiEngineScheduleRequest, AnonymousRequirement } from './interfaces/ai-engine-payload.interface';
import type { AiEngineWeekCheckResponse } from './interfaces/week-check.interface';
import type { ChoiceWhatIf } from './interfaces/week-check-choice.interface';
import type { OptimizationProxyService, PrepareResult } from './optimization-proxy.service';
import {
  WEEK_CHECK_CHOICE_BUDGET_MS,
  WEEK_CHECK_CHOICE_MIN_CALL_MS,
  WeekCheckChoiceService,
  rankedWhatIfs,
} from './week-check-choice.service';
import { derivedId, MAX_WHAT_IFS } from './week-check-choice';
import { ENGINE_LACKS_WEEK_CHECK, WEEK_CHECK_PATH } from './week-check.service';

void MasterLessonsService;

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const user = testUser();

/** The ids a post has in the engine (anonymous) and in the database (real): never the same. */
const anon = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const real = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TEACHER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEACHER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_A = 'a1a1a1a1-0000-4000-8000-000000000001';
const USER_B = 'b2b2b2b2-0000-4000-8000-000000000002';
const HKK = 'subject-hemkunskap';
const MUSIK = 'subject-musik';
const BILD = 'subject-bild';

const post = (n: number, overrides: Partial<AnonymousRequirement> = {}): AnonymousRequirement => ({
  id: anon(n),
  subjectId: 'engine-subject',
  studentGroupId: 'engine-group',
  teacherId: TEACHER_A,
  lessonsPerWeek: 4,
  minutesPerLesson: 40,
  minutesBefore: 0,
  minutesAfter: 0,
  studentGroupSize: 20,
  requiredRoomType: null,
  coTeacherId: null,
  minGradeLevel: 9,
  maxGradeLevel: 9,
  ...overrides,
});

/** A week of year 9: three Hemkunskap posts of teacher A, two Musik posts of teacher B. */
const week = (): AnonymousRequirement[] => [
  post(1),
  post(2),
  post(3),
  post(4, { teacherId: TEACHER_B }),
  post(5, { teacherId: TEACHER_B }),
];
const weekSubjects = (): Map<number, string> =>
  new Map([
    [1, HKK],
    [2, HKK],
    [3, HKK],
    [4, MUSIK],
    [5, MUSIK],
  ]);

const row = (percent: number, over = false) => ({
  year: 9,
  demandMinutes: Math.round((percent * 2200) / 100),
  capacityMinutes: 2200,
  percent,
  over,
});
const answer = (overrides: Partial<AiEngineWeekCheckResponse> = {}): AiEngineWeekCheckResponse => ({
  requestId: 'r',
  verdict: 'TIGHT',
  years: [row(95)],
  skipped: ['LUNCH_STAGE'],
  elapsedMs: 10,
  conflicts: null,
  ...overrides,
});
const under = (): AiEngineWeekCheckResponse => answer({ verdict: 'OK', years: [] });

describe('WeekCheckChoiceService', () => {
  let tx: {
    academicYear: { findUnique: jest.Mock };
    teacherSubjectQualification: { findMany: jest.Mock; count: jest.Mock };
    subject: { findMany: jest.Mock };
  };
  let proxy: { prepareSchedule: jest.Mock; callAiEngine: jest.Mock; realiseConflicts: jest.Mock };
  let service: WeekCheckChoiceService;
  let requirements: AnonymousRequirement[];
  let subjectsOf: Map<number, string>;
  let payloadOfWeek: Record<string, unknown>;
  let stretches: { from: string; to: string }[][] | null;
  let qualifications: Record<string, unknown>[];
  /** The real teacher who leads post n today, where a test says (the row's teacherId). */
  let leadersOf: Map<number, string>;

  const qualification = (userId: string, subjectId: string, overrides: Record<string, unknown> = {}) => ({
    userId,
    subjectId,
    minGradeLevel: 7,
    maxGradeLevel: 9,
    kind: 'BEHORIG',
    validFrom: null,
    validTo: null,
    ...overrides,
  });

  const build = (storedRules: unknown = null) => {
    payloadOfWeek = { requestId: 'q', academicYearId: YEAR_ID, requirements, rooms: [], constraints: [], teacherWorkRules: [], groupConflicts: [] };
    const prepared = {
      ready: true,
      payload: payloadOfWeek,
      storedRules,
      anonMaps: { requirementAnonMap: new Map(requirements.map((r, i) => [real(i + 1), r.id])) },
      requirementRows: requirements.map((r, i) => ({
        id: real(i + 1),
        subjectId: subjectsOf.get(i + 1) ?? `subject-${i + 1}`,
        teacherId: leadersOf.get(i + 1) ?? null,
      })),
      periodStretches: stretches,
    };
    proxy.prepareSchedule.mockResolvedValue(prepared as unknown as PrepareResult);
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    requirements = week();
    subjectsOf = weekSubjects();
    leadersOf = new Map();
    stretches = null;
    // Hemkunskap has two qualified teachers, Musik one.
    qualifications = [qualification(USER_A, HKK), qualification(USER_B, HKK), qualification(USER_B, MUSIK)];
    tx = {
      academicYear: {
        findUnique: jest.fn(async () => ({
          id: YEAR_ID,
          startDate: new Date('2026-08-17'),
          endDate: new Date('2027-06-11'),
          gradeNumbering: 'NIOARIG',
        })),
      },
      teacherSubjectQualification: {
        findMany: jest.fn(async () => qualifications),
        count: jest.fn(async () => qualifications.length),
      },
      subject: {
        findMany: jest.fn(async () => [
          { id: HKK, name: 'Hemkunskap' },
          { id: MUSIK, name: 'Musik' },
          { id: BILD, name: 'Bild' },
        ]),
      },
    };
    proxy = {
      prepareSchedule: jest.fn(),
      callAiEngine: jest.fn(async () => answer()),
      realiseConflicts: jest.fn((conflicts: AiEngineConflictAnalysis | null | undefined) => conflicts ?? null),
    };
    build();
    const prisma = { withRls: jest.fn(async (_user: unknown, run: (client: unknown) => unknown) => run(tx)) };
    service = new WeekCheckChoiceService(prisma as unknown as PrismaService, proxy as unknown as OptimizationProxyService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** The payload of the n-th engine call, and what answers it: baseline, floor, what-ifs in order. */
  const answers = (...list: AiEngineWeekCheckResponse[]) => {
    let call = 0;
    proxy.callAiEngine.mockImplementation(async () => list[Math.min(call++, list.length - 1)]);
  };
  const sent = (n: number) => proxy.callAiEngine.mock.calls[n]![1] as AiEngineScheduleRequest;

  it('asks the week as it stands, then the floor, then a second teacher in each subject that carries most, and answers by year', async () => {
    // baseline 95 %, floor under 85, a second Hemkunskap teacher 87 %, a second Musik teacher 92 %.
    answers(answer(), under(), answer({ years: [row(87)] }), answer({ years: [row(92)] }));

    const view = await service.choice(YEAR_ID, user);

    expect(proxy.callAiEngine).toHaveBeenCalledTimes(4);
    expect(proxy.callAiEngine.mock.calls.map((call) => call[0])).toEqual(Array(4).fill(WEEK_CHECK_PATH));
    expect(view).toMatchObject({ status: 'DONE', qualificationsRecorded: true, releasedPosts: 3, notRun: 0, calls: 4 });
    const [year] = view.years;
    expect(year!.year).toBe(9);
    expect(year!.today).toMatchObject({ kind: 'LOAD', percent: 95, atLeast: false });
    expect(year!.floor).toEqual({ kind: 'UNDER', below: 85 });
    // Ranked by the week they give: Hemkunskap's 87 before Musik's 92.
    expect(year!.whatIf.map((item) => [item.subject, item.count.kind === 'LOAD' ? item.count.percent : null, item.ranked])).toEqual([
      ['Hemkunskap', 87, true],
      ['Musik', 92, true],
    ]);
    expect(year!.whatIf[0]).toMatchObject({ qualified: 2, moved: 1, of: 3 });
    expect(year!.whatIf[1]).toMatchObject({ qualified: 1, moved: 1, of: 2 });
  });

  it('asks the engine nothing it does not know: the baseline is the payload as Generera sends it, the others differ in leads only', async () => {
    answers(answer(), under(), answer({ years: [row(87)] }), answer({ years: [row(92)] }));

    await service.choice(YEAR_ID, user);

    const base = sent(0);
    expect(base).toEqual(payloadOfWeek);
    for (const n of [1, 2, 3]) {
      const variant = sent(n);
      expect(Object.keys(variant).sort()).toEqual(Object.keys(base).sort());
      variant.requirements.forEach((variantPost, index) => {
        expect({ ...variantPost, teacherId: null, lessonTeacherIds: undefined }).toEqual({
          ...base.requirements[index]!,
          teacherId: null,
          lessonTeacherIds: undefined,
        });
      });
    }
    // The floor: the three Hemkunskap posts have a teacher of their own each, the Musik posts (one qualified) keep theirs.
    expect(sent(1).requirements.map((r) => r.teacherId)).toEqual([
      derivedId(anon(1), 'own-teacher'),
      derivedId(anon(2), 'own-teacher'),
      derivedId(anon(3), 'own-teacher'),
      TEACHER_B,
      TEACHER_B,
    ]);
    // The what-if: one post of A's three to a second teacher.
    const moved = sent(2).requirements.filter((r, i) => r.teacherId !== base.requirements[i]!.teacherId);
    expect(moved).toHaveLength(1);
    expect(moved[0]!.teacherId).not.toBe(TEACHER_A);
  });

  it('sends the school\'s saved lunch rules where the check does', async () => {
    build({ lunchMinutes: 20 });
    answers(under());

    await service.choice(YEAR_ID, user);

    expect(sent(0)).toHaveProperty('rules', { lunchMinutes: 20 });
    expect(sent(0)).toEqual({ ...payloadOfWeek, rules: { lunchMinutes: 20 } });
  });

  describe('the time', () => {
    const FIRST = new Date('2026-11-19T10:00:00Z').getTime();

    it('asks at most the baseline, the floor and ten what-ifs, however many subjects there are', async () => {
      requirements = [];
      for (let subject = 0; subject < 14; subject += 1) {
        requirements.push(post(subject * 2 + 1, { teacherId: `t-${subject}` }), post(subject * 2 + 2, { teacherId: `t-${subject}` }));
      }
      subjectsOf = new Map(requirements.map((r, i) => [i + 1, `subject-${Math.floor(i / 2)}`] as [number, string]));
      build();
      answers(answer());

      const view = await service.choice(YEAR_ID, user);

      expect(MAX_WHAT_IFS).toBe(10);
      // The baseline, no floor (nobody has a qualified second: no row has a behörighet in these subjects) and ten what-ifs.
      expect(proxy.callAiEngine).toHaveBeenCalledTimes(1 + MAX_WHAT_IFS);
      expect(view.years[0]!.whatIf).toHaveLength(MAX_WHAT_IFS);
    });

    it('begins no check it could not finish inside its budget, says how many it did not ask, and still answers with what it has', async () => {
      jest.useFakeTimers({ now: FIRST });
      let call = 0;
      // Each check takes ten seconds of the budget: after the baseline and the floor 4 s are left, less than a check needs.
      proxy.callAiEngine.mockImplementation(async () => {
        jest.setSystemTime(FIRST + (call + 1) * 10_000);
        call += 1;
        return call === 2 ? under() : answer();
      });

      const view = await service.choice(YEAR_ID, user);

      expect(proxy.callAiEngine).toHaveBeenCalledTimes(2);
      expect(WEEK_CHECK_CHOICE_BUDGET_MS - 20_000).toBeLessThan(WEEK_CHECK_CHOICE_MIN_CALL_MS);
      expect(view).toMatchObject({ status: 'DONE', notRun: 2, calls: 2 });
      expect(view.years[0]!.floor).toEqual({ kind: 'UNDER', below: 85 });
      expect(view.years[0]!.whatIf).toEqual([]);
    });

    it('leaves the floor unsaid, and not "under" it, when there was no time for it', async () => {
      jest.useFakeTimers({ now: FIRST });
      proxy.callAiEngine.mockImplementation(async () => {
        jest.setSystemTime(FIRST + 20_000);
        return answer();
      });

      const view = await service.choice(YEAR_ID, user);

      expect(proxy.callAiEngine).toHaveBeenCalledTimes(1);
      expect(view.years[0]!.floor).toEqual({ kind: 'UNKNOWN' });
      expect(view.notRun).toBe(2);
    });

    it('gives each check only the time that is left of the budget, and never more than the check\'s own ceiling', async () => {
      answers(answer(), under(), answer(), answer());

      await service.choice(YEAR_ID, user);

      for (const call of proxy.callAiEngine.mock.calls) {
        const { timeoutMs } = call[3] as { timeoutMs: number };
        expect(timeoutMs).toBeLessThanOrEqual(30_000);
        expect(timeoutMs).toBeGreaterThanOrEqual(WEEK_CHECK_CHOICE_MIN_CALL_MS);
      }
    });

    it('never waits for a check beyond the end of the budget: a call begun with 14 s left waits 14 s at most, so the analysis is over before the page stops waiting', async () => {
      jest.useFakeTimers({ now: FIRST });
      let call = 0;
      proxy.callAiEngine.mockImplementation(async () => {
        jest.setSystemTime(FIRST + (call + 1) * 10_000);
        call += 1;
        return call === 2 ? under() : answer();
      });

      await service.choice(YEAR_ID, user);

      const waits = proxy.callAiEngine.mock.calls.map((entry) => (entry[3] as { timeoutMs: number }).timeoutMs);
      // The baseline begins with the whole budget (the 30 s ceiling is more than it), the floor 10 s later with 14 s.
      expect(waits[0]).toBeLessThanOrEqual(WEEK_CHECK_CHOICE_BUDGET_MS);
      expect(waits[1]).toBeLessThanOrEqual(WEEK_CHECK_CHOICE_BUDGET_MS - 10_000);
    });
  });

  describe('a lower bound is never the value', () => {
    it('says "at least" for a figure the week load\'s seconds cut, and ranks neither it nor the week it is set beside', async () => {
      const cut = (percent: number) => answer({ years: [row(percent)], skipped: ['LUNCH_STAGE', 'WEEK_LOAD_DEADLINE'] });
      answers(answer(), under(), cut(80), answer({ years: [row(92)] }));

      const view = await service.choice(YEAR_ID, user);

      const [year] = view.years;
      const hkk = year!.whatIf.find((item) => item.subject === 'Hemkunskap')!;
      expect(hkk.count).toMatchObject({ kind: 'LOAD', percent: 80, atLeast: true });
      expect(hkk.ranked).toBe(false);
      // The cut one comes after the ranked one though its figure is lower: a deadline-stopped bound ranks nobody.
      expect(year!.whatIf.map((item) => item.subject)).toEqual(['Musik', 'Hemkunskap']);
    });

    it('says "at least" for the week as it stands too, and then ranks no what-if against it', async () => {
      answers(answer({ skipped: ['LUNCH_STAGE', 'WEEK_LOAD_DEADLINE'] }), under(), answer({ years: [row(87)] }), answer({ years: [row(92)] }));

      const view = await service.choice(YEAR_ID, user);

      expect(view.years[0]!.today).toMatchObject({ atLeast: true });
      expect(view.years[0]!.whatIf.every((item) => !item.ranked)).toBe(true);
    });

    it('ranks no what-if that is still over the supply, against the week as it stands or another: the engine counts no period after the first it refuses', async () => {
      // As it stands 114 % (over), Hemkunskap's second teacher 109 % (still over), Musik's 97 %: only Musik's is a value.
      answers(answer({ verdict: 'IMPOSSIBLE', years: [row(114, true)] }), under(), answer({ verdict: 'IMPOSSIBLE', years: [row(109, true)] }), answer({ years: [row(97)] }));

      const view = await service.choice(YEAR_ID, user);

      const list = view.years[0]!.whatIf;
      expect(list.map((item) => [item.subject, item.ranked])).toEqual([
        ['Musik', true],
        ['Hemkunskap', false],
      ]);
      expect(list[1]!.count).toMatchObject({ over: true, atLeast: false });
    });

    it('does not call a year with no row "under 85 %" when the count did not finish', async () => {
      answers(answer(), answer({ verdict: 'OK', years: [], skipped: ['LUNCH_STAGE', 'WEEK_LOAD_DEADLINE'] }));

      const view = await service.choice(YEAR_ID, user);

      expect(view.years[0]!.floor).toEqual({ kind: 'UNKNOWN' });
    });

    it('is decisive only above the supply: a floor over 100 % says that no choice of teachers helps, one under 100 % does not say it fits', async () => {
      answers(answer(), answer({ verdict: 'IMPOSSIBLE', years: [row(104, true)] }));
      const over = await service.choice(YEAR_ID, user);
      expect(over.years[0]!.floor).toMatchObject({ kind: 'LOAD', over: true, percent: 104 });

      answers(answer({ verdict: 'IMPOSSIBLE', years: [row(119, true)] }), answer({ years: [row(94)] }));
      const may = await service.choice(YEAR_ID, user);
      expect(may.years[0]!.today).toMatchObject({ over: true });
      expect(may.years[0]!.floor).toMatchObject({ kind: 'LOAD', over: false, percent: 94, atLeast: false });
    });
  });

  describe('per period', () => {
    it('names the period the tightest week was counted in, from the posts the engine names for it', async () => {
      stretches = [[{ from: '2026-08-17', to: '2026-12-18' }], [{ from: '2027-01-11', to: '2027-06-11' }]];
      requirements = week().map((r) => (r.id === anon(5) ? { ...r, periods: [true, false] } : { ...r }));
      requirements = requirements.map((r) => (r.id === anon(4) ? { ...r, periods: [false, true] } : r));
      build();
      const tightRow = (ids: string[]): AiEngineConflictAnalysis => ({
        summary: '',
        summaryCode: '',
        summaryParams: {},
        conflicts: [
          {
            category: 'REQUIREMENT_DEMAND',
            code: 'TIGHT_WEEK_LOAD',
            params: { grades: '9' },
            message: '',
            requirementIds: ids,
            roomIds: [],
            constraintIds: [],
            resourceIds: [],
          },
        ],
      });
      // The spring holds posts 1, 2, 3 and 4; the autumn 1, 2, 3 and 5. The engine named the spring's.
      answers(answer({ conflicts: tightRow([anon(1), anon(2), anon(3), anon(4)]) }), under());

      const view = await service.choice(YEAR_ID, user);

      expect(view.years[0]!.today).toMatchObject({ period: { from: '2027-01-11', to: '2027-06-11', more: false } });
    });

    it('says no period when the läsår has none, and a figure with no period is still the tightest\'s', async () => {
      answers(answer(), under());
      const view = await service.choice(YEAR_ID, user);
      expect(view.years[0]!.today).toMatchObject({ kind: 'LOAD', period: null });
    });

    it('names the period of a year proved over from the refusal the engine answers with', async () => {
      proxy.realiseConflicts.mockImplementation(() => ({
        summary: '',
        summaryCode: 'DEMAND_YEAR_WEEK_SHORT',
        summaryParams: { periodFrom: '2026-08-17', periodTo: '2026-12-18', periodStretches: 1 },
        conflicts: [],
      }));
      answers(answer({ verdict: 'IMPOSSIBLE', years: [row(112, true)] }), under());

      const view = await service.choice(YEAR_ID, user);

      expect(view.years[0]!.today).toMatchObject({ over: true, period: { from: '2026-08-17', to: '2026-12-18', more: false } });
    });
  });

  describe('who can be released', () => {
    it('asks no floor when the school has recorded no behörighet at all, and says so', async () => {
      qualifications = [];
      answers(answer());

      const view = await service.choice(YEAR_ID, user);

      expect(view).toMatchObject({ status: 'DONE', qualificationsRecorded: false, releasedPosts: 0 });
      expect(view.years[0]!.floor).toBeNull();
      // Not asked: the baseline and the what-ifs only.
      expect(proxy.callAiEngine).toHaveBeenCalledTimes(3);
    });

    it('asks no floor when no subject has a second qualified teacher: a choice cannot change the week', async () => {
      qualifications = [qualification(USER_A, HKK), qualification(USER_B, MUSIK)];
      answers(answer());

      const view = await service.choice(YEAR_ID, user);

      expect(view).toMatchObject({ qualificationsRecorded: true, releasedPosts: 0 });
      expect(view.years[0]!.floor).toBeNull();
    });

    it('releases a post led by someone who is not qualified when one qualified teacher could take it: the floor must lie below every choice', async () => {
      // Hemkunskap: USER_B is the one qualified teacher, the three posts are led by USER_A, who holds nothing.
      qualifications = [qualification(USER_B, HKK), qualification(USER_B, MUSIK)];
      leadersOf = new Map([
        [1, USER_A],
        [2, USER_A],
        [3, USER_A],
        [4, USER_B],
        [5, USER_B],
      ]);
      build();
      answers(answer(), under(), answer(), answer());

      const view = await service.choice(YEAR_ID, user);

      // Giving one post to USER_B and leaving two with USER_A is a choice; a floor that kept all three with USER_A could lie above it.
      expect(view.releasedPosts).toBe(3);
      expect(sent(1).requirements.slice(0, 3).map((r) => r.teacherId)).not.toContain(TEACHER_A);
      // The Musik posts are led by the one qualified teacher: nothing to choose, nothing released.
      expect(sent(1).requirements.slice(3).map((r) => r.teacherId)).toEqual([TEACHER_B, TEACHER_B]);
    });

    it('counts a behörighet valid today and not one that has ended or covers other years', async () => {
      jest.useFakeTimers({ now: new Date('2026-11-19T10:00:00Z') });
      qualifications = [
        qualification(USER_A, HKK),
        qualification(USER_B, HKK, { validTo: new Date('2026-10-31') }),
      ];
      answers(answer());
      const view = await service.choice(YEAR_ID, user);
      expect(view.releasedPosts).toBe(0);

      qualifications = [qualification(USER_A, HKK), qualification(USER_B, HKK, { minGradeLevel: 4, maxGradeLevel: 6 })];
      answers(answer());
      expect((await service.choice(YEAR_ID, user)).releasedPosts).toBe(0);
    });

    it('reads the behörigheter of the week\'s own subjects and of active teachers only', async () => {
      answers(answer(), under(), answer(), answer());

      await service.choice(YEAR_ID, user);

      const where = tx.teacherSubjectQualification.findMany.mock.calls[0]![0].where as {
        subjectId: { in: string[] };
        user: { isActive: boolean };
      };
      expect([...where.subjectId.in].sort()).toEqual([HKK, MUSIK]);
      expect(where.user).toEqual({ isActive: true });
    });
  });

  describe('what is not asked', () => {
    it('asks nothing of an engine the gateway\'s own pre-flight has answered for, or a week with nothing to place', async () => {
      proxy.prepareSchedule.mockResolvedValue({ ready: false, refusal: {}, refusalCode: 'STAFF_UNSTAFFED_REQUIREMENTS' } as unknown as PrepareResult);
      expect(await service.choice(YEAR_ID, user)).toMatchObject({ status: 'NOT_ASKED', years: [] });

      requirements = [];
      build();
      expect(await service.choice(YEAR_ID, user)).toMatchObject({ status: 'NOT_ASKED', years: [] });
      expect(proxy.callAiEngine).not.toHaveBeenCalled();
    });

    it('has no year to ask about when the check counted none at the tight threshold', async () => {
      answers(under());
      const view = await service.choice(YEAR_ID, user);
      expect(view).toMatchObject({ status: 'NO_TIGHT_YEAR', years: [], calls: 1 });
      expect(proxy.callAiEngine).toHaveBeenCalledTimes(1);
    });

    it('asks about at most the three heaviest years', async () => {
      answers(answer({ years: [8, 9, 7, 6].map((year) => ({ ...row(95), year })) }), under());
      const view = await service.choice(YEAR_ID, user);
      expect(view.years.map((year) => year.year)).toEqual([8, 9, 7]);
    });

    it('is a 404 for a year the school has not got', async () => {
      tx.academicYear.findUnique.mockResolvedValue(null);
      await expect(service.choice(YEAR_ID, user)).rejects.toBeInstanceOf(NotFoundException);
      expect(proxy.prepareSchedule).not.toHaveBeenCalled();
    });
  });

  describe('failures', () => {
    it('says the engine is older than the API when the check route is not there (the check says the same)', async () => {
      proxy.callAiEngine.mockRejectedValue(new HttpException('not found', HttpStatus.NOT_FOUND));
      await expect(service.choice(YEAR_ID, user)).rejects.toMatchObject({
        response: { code: ENGINE_LACKS_WEEK_CHECK },
        status: HttpStatus.SERVICE_UNAVAILABLE,
      });
    });

    it('lets the baseline\'s failure through as it is: a 503 from the engine is a 503', async () => {
      proxy.callAiEngine.mockRejectedValue(new HttpException('down', HttpStatus.SERVICE_UNAVAILABLE));
      await expect(service.choice(YEAR_ID, user)).rejects.toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE });
    });

    it('leaves out a floor or a what-if that failed and answers with the rest', async () => {
      let call = 0;
      proxy.callAiEngine.mockImplementation(async () => {
        call += 1;
        if (call === 2 || call === 3) throw new HttpException('boom', HttpStatus.SERVICE_UNAVAILABLE);
        return answer({ years: [row(90)] });
      });

      const view = await service.choice(YEAR_ID, user);

      expect(view.status).toBe('DONE');
      expect(view.years[0]!.floor).toEqual({ kind: 'UNKNOWN' });
      expect(view.notRun).toBe(1);
      expect(view.years[0]!.whatIf).toHaveLength(1);
    });

    it('is a bad gateway when the engine answers something that is not a check', async () => {
      proxy.callAiEngine.mockResolvedValue({ shiny: true });
      await expect(service.choice(YEAR_ID, user)).rejects.toMatchObject({ status: HttpStatus.BAD_GATEWAY });
    });
  });

  describe('what leaves', () => {
    it('names subjects, years and figures, and no person, post or id', async () => {
      answers(answer(), under(), answer({ years: [row(87)] }), answer({ years: [row(92)] }));

      const view = await service.choice(YEAR_ID, user);

      const text = JSON.stringify(view);
      for (const secret of [TEACHER_A, TEACHER_B, USER_A, USER_B, anon(1), real(1), YEAR_ID, derivedId(anon(1), 'own-teacher')]) {
        expect(text).not.toContain(secret);
      }
      expect(Object.keys(view).sort()).toEqual(
        ['calls', 'elapsedMs', 'notRun', 'qualificationsRecorded', 'releasedPosts', 'status', 'years'],
      );
      expect(Object.keys(view.years[0]!).sort()).toEqual(['floor', 'today', 'whatIf', 'year']);
      expect(Object.keys(view.years[0]!.whatIf[0]!).sort()).toEqual(['count', 'moved', 'of', 'qualified', 'ranked', 'subject']);
    });

    it('says the year in the läsår\'s own numbering: the engine\'s åk 9 is the tioåriga läsårets åk 10', async () => {
      tx.academicYear.findUnique.mockResolvedValue({
        id: YEAR_ID,
        startDate: new Date('2028-08-16'),
        endDate: new Date('2029-06-11'),
        gradeNumbering: 'TIOARIG',
      });
      answers(answer(), under());

      const view = await service.choice(YEAR_ID, user);

      expect(view.years[0]!.year).toBe(10);
    });

    it('writes nothing and holds nothing across an engine call: the engine is asked after the transaction has run', async () => {
      const order: string[] = [];
      const prisma = {
        withRls: jest.fn(async (_user: unknown, run: (client: unknown) => unknown) => {
          order.push('transaction begins');
          const result = await run(tx);
          order.push('transaction ends');
          return result;
        }),
      };
      proxy.callAiEngine.mockImplementation(async () => {
        order.push('engine');
        return under();
      });
      const own = new WeekCheckChoiceService(prisma as unknown as PrismaService, proxy as unknown as OptimizationProxyService);

      await own.choice(YEAR_ID, user);

      expect(order).toEqual(['transaction begins', 'transaction ends', 'engine']);
    });
  });
});

describe('rankedWhatIfs', () => {
  const item = (subject: string, percent: number, ranked = true): ChoiceWhatIf => ({
    subject,
    qualified: 1,
    moved: 1,
    of: 2,
    ranked,
    count: { kind: 'LOAD', demandMinutes: percent * 22, capacityMinutes: 2200, percent, over: false, atLeast: !ranked, period: null },
  });

  it('puts the best week first, a year under the tight threshold before any over it, and ties by the school\'s own subject name', () => {
    const list = [
      item('Musik', 92),
      item('Bild', 87),
      { ...item('Teknik', 0), count: { kind: 'UNDER', below: 85 } as const },
      item('Åttonde', 87),
    ];
    expect(rankedWhatIfs(list).map((entry) => entry.subject)).toEqual(['Teknik', 'Bild', 'Åttonde', 'Musik']);
  });

  it('lists a what-if that has a figure but is not ranked (the week as it stands was cut) after the ranked ones, whatever its figure', () => {
    const list = [item('Ovärderad', 60, false), item('Värderad', 99)];
    // Same figure kind: only the flag tells them apart, and a cut week as it stands makes no figure beat another.
    const exact = { ...list[0]!, count: { ...list[0]!.count, atLeast: false } as ChoiceWhatIf['count'] };
    expect(rankedWhatIfs([exact, list[1]!]).map((entry) => entry.subject)).toEqual(['Värderad', 'Ovärderad']);
  });

  it('lists the ones that rank nobody after the ones that do, in the same order every time', () => {
    const list = [item('B', 50, false), item('A', 99), item('C', 40, false)];
    expect(rankedWhatIfs(list).map((entry) => entry.subject)).toEqual(['A', 'B', 'C']);
    expect(rankedWhatIfs([...list].reverse()).map((entry) => entry.subject)).toEqual(['A', 'B', 'C']);
  });
});
