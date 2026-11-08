import {
  DEVIATION_CODES,
  DEVIATION_ROOM_LOCK,
  DEVIATION_SUBJECT_DAYS_APART,
  DEVIATION_SUBJECT_PER_DAY,
  DEVIATION_TEACHER_DAILY_CAP,
  DEVIATION_TEACHER_WORK_DAYS,
  acceptedDeviationsOf,
  deviationCountOf,
  deviationTeachersOf,
  deviationsDigestOf,
  deviationsViewOf,
  storedDeviationOf,
  storedDeviationsOf,
  type RealisedDeviation,
} from './deviations';
import { DEVIATION_WORK_DAYS_HIDDEN_MESSAGE, TEACHER_WORK_DAYS_HIDDEN, WORK_DAYS_HIDDEN_MESSAGE, isDaysBearing } from './work-days';

const CANDIDATE = '66666666-6666-4666-8666-666666666666';
const OTHER_CANDIDATE = '77777777-7777-4777-8777-777777777777';
const ANNA = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const RULE = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const POST = 'cccccccc-3333-4333-8333-cccccccccccc';

/** A deviation as the proxy hands it over: realised, not yet stored. */
const realised = (overrides: Partial<RealisedDeviation> = {}): RealisedDeviation => ({
  category: 'DEVIATION',
  code: DEVIATION_SUBJECT_PER_DAY,
  params: { requirement: 'Matematik för 7B', day: 2, maxPerDay: 1, count: 2, over: 1, needed: 2 },
  message: 'Matematik för 7B has 2 lessons on Tuesday, against a limit of 1 a day: 1 over.',
  requirementIds: ['req-1'],
  roomIds: [],
  constraintIds: [],
  resourceIds: [],
  resourceNames: [],
  ...overrides,
});

const cap = (overrides: Partial<RealisedDeviation> = {}): RealisedDeviation =>
  realised({
    code: DEVIATION_TEACHER_DAILY_CAP,
    params: { rule: RULE, day: 3, minutes: 360, taught: 400, over: 40, needed: 400 },
    message: `The cap of 360 minutes of teaching a day that the teacher working-time rule ${RULE} sets gave way on Wednesday.`,
    resourceIds: [RULE],
    subjectIds: [ANNA],
    ...overrides,
  });

const days = (overrides: Partial<RealisedDeviation> = {}): RealisedDeviation =>
  realised({
    code: DEVIATION_TEACHER_WORK_DAYS,
    params: { limit: POST, days: 3, taught: 4, over: 1, needed: 4 },
    message: `The teacher's post ${POST} allows teaching on at most 3 days a week`,
    resourceIds: [POST],
    subjectIds: [ANNA],
    ...overrides,
  });

describe('deviations: what gave way in a timetable that was placed', () => {
  describe('the codes', () => {
    it('are the five the engine reports, and the one about a post’s days is held to the rule of every sentence about it', () => {
      expect([...DEVIATION_CODES].sort()).toEqual(
        [
          'DEVIATION_ROOM_LOCK',
          'DEVIATION_SUBJECT_DAYS_APART',
          'DEVIATION_SUBJECT_PER_DAY',
          'DEVIATION_TEACHER_DAILY_CAP',
          'DEVIATION_TEACHER_WORK_DAYS',
        ],
      );
      expect(DEVIATION_CODES.filter(isDaysBearing)).toEqual([DEVIATION_TEACHER_WORK_DAYS]);
      // The mask is by name in the code: a code that carries WORK_DAYS and is not on the list is a figure shown to everyone.
      expect(DEVIATION_CODES.filter((code) => code.includes('WORK_DAYS'))).toEqual([DEVIATION_TEACHER_WORK_DAYS]);
    });
  });

  describe('storedDeviationOf', () => {
    it('keeps the engine’s line with its names, the category DEVIATION, and nothing that is an id array', () => {
      expect(storedDeviationOf(realised({ resourceNames: ['Sal 1'] }))).toEqual({
        category: 'DEVIATION',
        code: DEVIATION_SUBJECT_PER_DAY,
        params: { requirement: 'Matematik för 7B', day: 2, maxPerDay: 1, count: 2, over: 1, needed: 2 },
        message: 'Matematik för 7B has 2 lessons on Tuesday, against a limit of 1 a day: 1 over.',
        resourceNames: ['Sal 1'],
      });
    });

    it('keeps a cap’s teacher as a server-only id and names nobody', () => {
      const stored = storedDeviationOf(cap());
      expect(stored.subjectIds).toEqual([ANNA]);
      expect(stored.resourceNames).toEqual([]);
      expect(JSON.stringify(stored)).not.toMatch(/Anna|Svensson/);
    });

    it('keeps no teacher on any other deviation, even if the line was handed one', () => {
      for (const code of [DEVIATION_SUBJECT_PER_DAY, DEVIATION_SUBJECT_DAYS_APART, DEVIATION_ROOM_LOCK]) {
        expect(storedDeviationOf(realised({ code, subjectIds: [ANNA] }))).not.toHaveProperty('subjectIds');
      }
    });

    it('stores a part-timer’s days in the hidden form WHOLE: no figure, no post, no teacher, the category kept', () => {
      const stored = storedDeviationOf(days());
      expect(stored).toEqual({
        category: 'DEVIATION',
        code: TEACHER_WORK_DAYS_HIDDEN,
        params: {},
        message: DEVIATION_WORK_DAYS_HIDDEN_MESSAGE,
        resourceNames: [],
      });
      // `taught` less `over` would give the limit back, so not only `days` is gone.
      const text = JSON.stringify(stored);
      expect(text).not.toContain(POST);
      expect(text).not.toContain(ANNA);
      expect(text).not.toMatch(/"(days|taught|over|needed|limit)"/);
    });

    it('says the hidden sentence as a deviation, not as the refusal “one of the reasons the timetable could not be made”', () => {
      const { message } = storedDeviationOf(days());
      expect(message).toBe(DEVIATION_WORK_DAYS_HIDDEN_MESSAGE);
      expect(message).not.toBe(WORK_DAYS_HIDDEN_MESSAGE);
      expect(message).not.toMatch(/could not be made/);
      expect(message).not.toMatch(/\d/);
    });

    it('stores a part-timer’s days hidden whichever fields the line carried', () => {
      const stored = storedDeviationOf(days({ resourceNames: ['Anna Svensson'], params: { limit: POST } }));
      expect(stored.resourceNames).toEqual([]);
      expect(stored.params).toEqual({});
    });

    it('stores every deviation of a list, in order, and two hidden lines stay two (each is a post)', () => {
      const list = storedDeviationsOf([realised(), days(), days(), cap()]);
      expect(list.map((entry) => entry.code)).toEqual([
        DEVIATION_SUBJECT_PER_DAY,
        TEACHER_WORK_DAYS_HIDDEN,
        TEACHER_WORK_DAYS_HIDDEN,
        DEVIATION_TEACHER_DAILY_CAP,
      ]);
    });
  });

  describe('deviationsViewOf', () => {
    const names = new Map([[ANNA, 'Anna Svensson']]);

    it('is null for a column that holds no list — a candidate that is not the mode’s says nothing, and none is not that', () => {
      expect(deviationsViewOf(null, names)).toBeNull();
      expect(deviationsViewOf(undefined, names)).toBeNull();
      expect(deviationsViewOf({ not: 'a list' }, names)).toBeNull();
      expect(deviationsViewOf([], names)).toEqual([]);
    });

    it('names the teacher a cap is about in the sentence’s `rule` and in its fallback, and in no list of ids', () => {
      const [view] = deviationsViewOf(storedDeviationsOf([cap()]), names)!;
      expect(view!.params!['rule']).toBe('Anna Svensson');
      expect(view!.message).toContain('Anna Svensson');
      expect(view!.message).not.toContain(RULE);
      expect(view!.params).toMatchObject({ day: 3, minutes: 360, taught: 400, over: 40, needed: 400 });
      expect(JSON.stringify(view)).not.toContain(ANNA);
      expect(view).not.toHaveProperty('subjectIds');
    });

    it('leaves the id where it was for a teacher nobody names — since removed, or marked, whom the caller left out', () => {
      const [view] = deviationsViewOf(storedDeviationsOf([cap()]), new Map())!;
      expect(view!.params!['rule']).toBe(RULE);
      expect(view!.message).toContain(RULE);
      expect(JSON.stringify(view)).not.toContain(ANNA);
    });

    it('names a teacher only for the cap: another sentence that somehow holds a teacher id gets no name', () => {
      const tampered = [{ ...storedDeviationOf(realised()), subjectIds: [ANNA] }];
      const [view] = deviationsViewOf(tampered, names)!;
      expect(JSON.stringify(view)).not.toContain('Anna');
    });

    it('is a whitelist: a field a hand-edited row carries beyond the five is not passed on', () => {
      const [view] = deviationsViewOf([{ ...storedDeviationOf(realised()), secret: 'x', subjectIds: [ANNA] }], names)!;
      expect(Object.keys(view!).sort()).toEqual(['category', 'code', 'message', 'params', 'resourceNames']);
    });

    it('keeps a part-timer’s days as the hidden sentence it was stored as', () => {
      const [view] = deviationsViewOf(storedDeviationsOf([days()]), names)!;
      expect(view).toEqual({ category: 'DEVIATION', code: TEACHER_WORK_DAYS_HIDDEN, params: {}, message: DEVIATION_WORK_DAYS_HIDDEN_MESSAGE, resourceNames: [] });
    });

    it('drops a param that is not a scalar, as a stored note does', () => {
      const [view] = deviationsViewOf([{ ...storedDeviationOf(realised()), params: { day: 2, nested: { a: 1 }, list: [1] } }], names)!;
      expect(view!.params).toEqual({ day: 2 });
    });
  });

  describe('deviationTeachersOf', () => {
    it('lists the teachers of the caps and nobody else', () => {
      const stored = [...storedDeviationsOf([cap(), realised(), days()]), { ...storedDeviationOf(realised()), subjectIds: ['intruder'] }];
      expect(deviationTeachersOf(stored)).toEqual([ANNA]);
      expect(deviationTeachersOf(null)).toEqual([]);
      expect(deviationTeachersOf('nonsense')).toEqual([]);
    });
  });

  describe('the digest: what an administrator accepts', () => {
    const list = () => storedDeviationsOf([realised(), cap()]);

    it('is null when there is nothing to accept, and a sha256 in hex when there is', () => {
      expect(deviationsDigestOf(CANDIDATE, null)).toBeNull();
      expect(deviationsDigestOf(CANDIDATE, [])).toBeNull();
      expect(deviationsDigestOf(CANDIDATE, 'x')).toBeNull();
      expect(deviationsDigestOf(CANDIDATE, list())).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is the same for the same list, whatever order the keys of an entry were written in', () => {
      const [first, second] = list();
      const reordered = [
        { resourceNames: first!.resourceNames, message: first!.message, params: Object.fromEntries(Object.entries(first!.params!).reverse()), code: first!.code, category: first!.category },
        second,
      ];
      expect(deviationsDigestOf(CANDIDATE, reordered)).toBe(deviationsDigestOf(CANDIDATE, list()));
    });

    it('moves with the candidate: a digest accepted for one candidate is accepted for no other', () => {
      expect(deviationsDigestOf(OTHER_CANDIDATE, list())).not.toBe(deviationsDigestOf(CANDIDATE, list()));
    });

    it.each([
      ['a value of a param', (entries: ReturnType<typeof list>) => [{ ...entries[0]!, params: { ...entries[0]!.params, over: 2 } }, entries[1]]],
      ['a code', (entries: ReturnType<typeof list>) => [{ ...entries[0]!, code: DEVIATION_ROOM_LOCK }, entries[1]]],
      ['a name beside the sentence', (entries: ReturnType<typeof list>) => [{ ...entries[0]!, resourceNames: ['Sal 9'] }, entries[1]]],
      ['the order of the list', (entries: ReturnType<typeof list>) => [entries[1], entries[0]]],
      ['one deviation fewer', (entries: ReturnType<typeof list>) => [entries[0]]],
      ['one deviation more', (entries: ReturnType<typeof list>) => [...entries, entries[0]]],
    ])('moves with %s', (_label, change) => {
      expect(deviationsDigestOf(CANDIDATE, change(list()))).not.toBe(deviationsDigestOf(CANDIDATE, list()));
    });

    it('does not move with the English fallback or the teacher’s id: the first is the code and params said another way, the second a person the page names when it reads', () => {
      const [first, second] = list();
      const same = deviationsDigestOf(CANDIDATE, list());
      expect(deviationsDigestOf(CANDIDATE, [{ ...first!, message: 'something else' }, second])).toBe(same);
      expect(deviationsDigestOf(CANDIDATE, [first, { ...second!, subjectIds: ['someone else'] }])).toBe(same);
    });
  });

  describe('acceptedDeviationsOf: what the change log keeps', () => {
    it('is the whitelist of a stored entry without the teacher’s id, and no name', () => {
      const accepted = acceptedDeviationsOf(storedDeviationsOf([cap(), realised({ resourceNames: ['Sal 1'] })]));
      expect(accepted).toHaveLength(2);
      expect(JSON.stringify(accepted)).not.toContain(ANNA);
      expect(JSON.stringify(accepted)).not.toContain('subjectIds');
      expect(accepted[1]).toMatchObject({ category: 'DEVIATION', code: DEVIATION_SUBJECT_PER_DAY, resourceNames: ['Sal 1'] });
    });

    it('keeps a part-timer’s days hidden and says nothing for a column that is no list', () => {
      expect(acceptedDeviationsOf(storedDeviationsOf([days()]))[0]).toMatchObject({ code: TEACHER_WORK_DAYS_HIDDEN, params: {} });
      expect(acceptedDeviationsOf(null)).toEqual([]);
    });
  });

  it('counts a list’s deviations, and a value that is no list holds none', () => {
    expect(deviationCountOf(storedDeviationsOf([realised(), cap()]))).toBe(2);
    expect(deviationCountOf([])).toBe(0);
    expect(deviationCountOf(null)).toBe(0);
    expect(deviationCountOf({ length: 3 })).toBe(0);
  });
});
